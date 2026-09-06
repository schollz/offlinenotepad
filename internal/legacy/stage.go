package legacy

import (
	"context"
	"crypto/aes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/schollz/offlinenotepad/internal/database"
	bolt "go.etcd.io/bbolt"
)

type ArchiveOptions struct {
	Source   string
	DryRun   bool
	Progress ArchiveProgressFunc
}

type ArchiveProgressPhase string

const (
	ArchiveProgressInspect          ArchiveProgressPhase = "inspect"
	ArchiveProgressReadDocuments    ArchiveProgressPhase = "read_documents"
	ArchiveProgressValidateHashes   ArchiveProgressPhase = "validate_hashes"
	ArchiveProgressReadPublications ArchiveProgressPhase = "read_publications"
	ArchiveProgressStageRecords     ArchiveProgressPhase = "stage_records"
)

type ArchiveProgress struct {
	Phase            ArchiveProgressPhase
	Completed, Total int
	Diagnostics      ArchiveDiagnostics
}

type ArchiveProgressFunc func(ArchiveProgress)

// ArchiveDiagnostics contains aggregate, identifier-free details about legacy
// records that could not be used exactly as stored. Missing or malformed sync
// hashes are recoverable because the encrypted document contains its own hash,
// which is checked in the browser after decryption.
type ArchiveDiagnostics struct {
	WorkspacesSkippedIncomplete       int
	DocumentsRecoveredMissingHash     int
	DocumentsRecoveredInvalidHash     int
	DocumentsSkippedInvalidID         int
	DocumentsSkippedInvalidCiphertext int
	HashesSkippedWithoutDocument      int
	PublicationsSkippedInvalidID      int
	PublicationsSkippedInvalidJSON    int
	PublicationsSkippedIDMismatch     int
}

type ArchiveResult struct {
	database.LegacyArchiveResult
	Diagnostics ArchiveDiagnostics
}

var (
	legacyBucketPattern = regexp.MustCompile(`^([a-f0-9]{8})-(data|hashes)$`)
	legacyHashPattern   = regexp.MustCompile(`^[a-f0-9]{8}$`)
)

func StageArchive(ctx context.Context, store *database.Store, options ArchiveOptions) (ArchiveResult, error) {
	if store.Backend() != database.BackendPostgreSQL {
		return ArchiveResult{}, errors.New("legacy migration requires DATABASE_URL")
	}
	if strings.TrimSpace(options.Source) == "" {
		return ArchiveResult{}, errors.New("legacy database path is required")
	}
	archive, diagnostics, err := readArchiveWithProgress(ctx, options.Source, options.Progress)
	if err != nil {
		return ArchiveResult{Diagnostics: diagnostics}, err
	}
	stageTotal := len(archive.Workspaces) + len(archive.Publications)
	for _, workspace := range archive.Workspaces {
		stageTotal += len(workspace.Documents)
	}
	reportArchiveProgress(options.Progress, ArchiveProgressStageRecords, 0, stageTotal, diagnostics)
	staged, err := store.StageLegacyArchiveWithProgress(ctx, archive, options.DryRun, func(completed, total int) {
		reportArchiveProgress(options.Progress, ArchiveProgressStageRecords, completed, total, diagnostics)
	})
	result := ArchiveResult{LegacyArchiveResult: staged, Diagnostics: diagnostics}
	if err != nil {
		return result, safeStageArchiveError(err)
	}
	return result, nil
}

func readArchive(source string) (database.LegacyArchive, error) {
	archive, _, err := readArchiveWithProgress(context.Background(), source, nil)
	return archive, err
}

func readArchiveWithProgress(ctx context.Context, source string, progress ArchiveProgressFunc) (database.LegacyArchive, ArchiveDiagnostics, error) {
	diagnostics := ArchiveDiagnostics{}
	reportArchiveProgress(progress, ArchiveProgressInspect, 0, 0, diagnostics)
	info, err := os.Stat(source)
	if err != nil {
		return database.LegacyArchive{}, diagnostics, fmt.Errorf("inspect legacy database: %w", err)
	}
	if !info.Mode().IsRegular() {
		return database.LegacyArchive{}, diagnostics, errors.New("legacy database must be a regular file")
	}
	db, err := bolt.Open(source, 0444, &bolt.Options{ReadOnly: true, Timeout: 2 * time.Second})
	if err != nil {
		return database.LegacyArchive{}, diagnostics, fmt.Errorf("open legacy database read-only: %w", err)
	}
	defer db.Close()
	type bucketPair struct{ data, hashes bool }
	pairs := make(map[string]bucketPair)
	if err := db.View(func(tx *bolt.Tx) error {
		return tx.ForEach(func(name []byte, _ *bolt.Bucket) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			match := legacyBucketPattern.FindStringSubmatch(string(name))
			if match == nil {
				return nil
			}
			pair := pairs[match[1]]
			if match[2] == "data" {
				pair.data = true
			} else {
				pair.hashes = true
			}
			pairs[match[1]] = pair
			return nil
		})
	}); err != nil {
		return database.LegacyArchive{}, diagnostics, err
	}
	legacyIDs := make([]string, 0, len(pairs))
	for id, pair := range pairs {
		if !pair.data || !pair.hashes {
			diagnostics.WorkspacesSkippedIncomplete++
			continue
		}
		legacyIDs = append(legacyIDs, id)
	}
	sort.Strings(legacyIDs)
	archive := database.LegacyArchive{Workspaces: make([]database.LegacyWorkspace, 0, len(legacyIDs))}
	err = db.View(func(tx *bolt.Tx) error {
		type publicationOwner struct{ legacyID, documentID string }
		publicationOwners := make(map[string][]publicationOwner)
		documentTotal, hashTotal := 0, 0
		for _, legacyID := range legacyIDs {
			documentTotal += tx.Bucket([]byte(legacyID + "-data")).Stats().KeyN
			hashTotal += tx.Bucket([]byte(legacyID + "-hashes")).Stats().KeyN
		}
		documentsCompleted := 0
		reportArchiveProgress(progress, ArchiveProgressReadDocuments, documentsCompleted, documentTotal, diagnostics)
		for _, legacyID := range legacyIDs {
			data := tx.Bucket([]byte(legacyID + "-data"))
			hashes := tx.Bucket([]byte(legacyID + "-hashes"))
			workspace := database.LegacyWorkspace{LegacyID: legacyID, Documents: []database.LegacyDocument{}}
			if err := data.ForEach(func(k, v []byte) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				documentsCompleted++
				defer func() {
					reportArchiveProgress(progress, ArchiveProgressReadDocuments, documentsCompleted, documentTotal, diagnostics)
				}()
				if v == nil || !legacyDocumentIDPattern.Match(k) {
					diagnostics.DocumentsSkippedInvalidID++
					return nil
				}
				hash := hashes.Get(k)
				storedHash := ""
				if hash == nil {
					diagnostics.DocumentsRecoveredMissingHash++
				} else if !legacyHashPattern.Match(hash) {
					diagnostics.DocumentsRecoveredInvalidHash++
				} else {
					storedHash = string(append([]byte(nil), hash...))
				}
				if err := validateLegacyCiphertext(string(v)); err != nil {
					diagnostics.DocumentsSkippedInvalidCiphertext++
					return nil
				}
				workspace.Documents = append(workspace.Documents, database.LegacyDocument{
					DocumentID: string(append([]byte(nil), k...)), DocumentHash: storedHash, Ciphertext: string(append([]byte(nil), v...)),
				})
				return nil
			}); err != nil {
				return err
			}
			archive.Workspaces = append(archive.Workspaces, workspace)
			for _, document := range workspace.Documents {
				publicID := legacyPublicID(document.DocumentID)
				publicationOwners[publicID] = append(publicationOwners[publicID], publicationOwner{legacyID: legacyID, documentID: document.DocumentID})
			}
		}
		hashesCompleted := 0
		reportArchiveProgress(progress, ArchiveProgressValidateHashes, hashesCompleted, hashTotal, diagnostics)
		for _, legacyID := range legacyIDs {
			data := tx.Bucket([]byte(legacyID + "-data"))
			hashes := tx.Bucket([]byte(legacyID + "-hashes"))
			if err := hashes.ForEach(func(k, v []byte) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				hashesCompleted++
				if v == nil || data.Get(k) == nil {
					diagnostics.HashesSkippedWithoutDocument++
				}
				reportArchiveProgress(progress, ArchiveProgressValidateHashes, hashesCompleted, hashTotal, diagnostics)
				return nil
			}); err != nil {
				return err
			}
		}
		published := tx.Bucket([]byte("published"))
		if published == nil {
			reportArchiveProgress(progress, ArchiveProgressReadPublications, 0, 0, diagnostics)
			return nil
		}
		publicationTotal := published.Stats().KeyN
		publicationsCompleted := 0
		reportArchiveProgress(progress, ArchiveProgressReadPublications, publicationsCompleted, publicationTotal, diagnostics)
		return published.ForEach(func(k, v []byte) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			publicationsCompleted++
			defer func() {
				reportArchiveProgress(progress, ArchiveProgressReadPublications, publicationsCompleted, publicationTotal, diagnostics)
			}()
			if v == nil || !legacyHashPattern.Match(k) {
				diagnostics.PublicationsSkippedInvalidID++
				return nil
			}
			var publication legacyPublication
			if err := json.Unmarshal(v, &publication); err != nil {
				diagnostics.PublicationsSkippedInvalidJSON++
				return nil
			}
			if publication.ID != string(k) {
				diagnostics.PublicationsSkippedIDMismatch++
				return nil
			}
			mode := "markdown"
			if strings.Contains(publication.Title, ".") {
				mode = "plaintext"
			}
			staged := database.LegacyPublication{
				PublicID: publication.ID, Title: publication.Title, Content: publication.Markdown, ContentMode: mode,
			}
			if owners := publicationOwners[publication.ID]; len(owners) == 1 {
				staged.LegacyID, staged.DocumentID = owners[0].legacyID, owners[0].documentID
			}
			archive.Publications = append(archive.Publications, staged)
			return nil
		})
	})
	if err != nil {
		return database.LegacyArchive{}, diagnostics, err
	}
	sort.Slice(archive.Publications, func(i, j int) bool { return archive.Publications[i].PublicID < archive.Publications[j].PublicID })
	return archive, diagnostics, nil
}

func reportArchiveProgress(progress ArchiveProgressFunc, phase ArchiveProgressPhase, completed, total int, diagnostics ArchiveDiagnostics) {
	if progress != nil {
		progress(ArchiveProgress{Phase: phase, Completed: completed, Total: total, Diagnostics: diagnostics})
	}
}

type sqlStateError interface {
	SQLState() string
}

func safeStageArchiveError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, database.ErrExists) {
		return errors.New("destination contains a conflicting legacy record")
	}
	var stateError sqlStateError
	if errors.As(err, &stateError) {
		return fmt.Errorf("destination database rejected the legacy archive (SQLSTATE %s)", stateError.SQLState())
	}
	return errors.New("destination database could not stage the legacy archive")
}

func validateLegacyCiphertext(value string) error {
	if len(value) <= 64 {
		return errors.New("ciphertext is too short")
	}
	if _, err := hex.DecodeString(value[:64]); err != nil {
		return errors.New("invalid salt or IV")
	}
	encrypted, err := base64.StdEncoding.Strict().DecodeString(value[64:])
	if err != nil {
		return errors.New("invalid base64 payload")
	}
	if len(encrypted) == 0 || len(encrypted)%aes.BlockSize != 0 {
		return errors.New("invalid AES-CBC length")
	}
	return nil
}
