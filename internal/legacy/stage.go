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
}

type ArchiveProgressFunc func(ArchiveProgress)

var (
	legacyBucketPattern = regexp.MustCompile(`^([a-f0-9]{8})-(data|hashes)$`)
	legacyHashPattern   = regexp.MustCompile(`^[a-f0-9]{8}$`)
)

func StageArchive(ctx context.Context, store *database.Store, options ArchiveOptions) (database.LegacyArchiveResult, error) {
	if store.Backend() != database.BackendPostgreSQL {
		return database.LegacyArchiveResult{}, errors.New("legacy migration requires DATABASE_URL")
	}
	if strings.TrimSpace(options.Source) == "" {
		return database.LegacyArchiveResult{}, errors.New("legacy database path is required")
	}
	archive, err := readArchiveWithProgress(ctx, options.Source, options.Progress)
	if err != nil {
		return database.LegacyArchiveResult{}, err
	}
	return store.StageLegacyArchiveWithProgress(ctx, archive, options.DryRun, func(completed, total int) {
		reportArchiveProgress(options.Progress, ArchiveProgressStageRecords, completed, total)
	})
}

func readArchive(source string) (database.LegacyArchive, error) {
	return readArchiveWithProgress(context.Background(), source, nil)
}

func readArchiveWithProgress(ctx context.Context, source string, progress ArchiveProgressFunc) (database.LegacyArchive, error) {
	reportArchiveProgress(progress, ArchiveProgressInspect, 0, 0)
	info, err := os.Stat(source)
	if err != nil {
		return database.LegacyArchive{}, fmt.Errorf("inspect legacy database: %w", err)
	}
	if !info.Mode().IsRegular() {
		return database.LegacyArchive{}, errors.New("legacy database must be a regular file")
	}
	db, err := bolt.Open(source, 0444, &bolt.Options{ReadOnly: true, Timeout: 2 * time.Second})
	if err != nil {
		return database.LegacyArchive{}, fmt.Errorf("open legacy database read-only: %w", err)
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
		return database.LegacyArchive{}, err
	}
	legacyIDs := make([]string, 0, len(pairs))
	for id, pair := range pairs {
		if !pair.data || !pair.hashes {
			return database.LegacyArchive{}, errors.New("legacy workspace has an incomplete data/hash bucket pair")
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
		reportArchiveProgress(progress, ArchiveProgressReadDocuments, documentsCompleted, documentTotal)
		for _, legacyID := range legacyIDs {
			data := tx.Bucket([]byte(legacyID + "-data"))
			hashes := tx.Bucket([]byte(legacyID + "-hashes"))
			workspace := database.LegacyWorkspace{LegacyID: legacyID, Documents: []database.LegacyDocument{}}
			if err := data.ForEach(func(k, v []byte) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				if v == nil || !legacyDocumentIDPattern.Match(k) {
					return errors.New("legacy workspace contains an invalid document ID")
				}
				hash := hashes.Get(k)
				if hash == nil || !legacyHashPattern.Match(hash) {
					return errors.New("legacy document is missing a valid hash")
				}
				if err := validateLegacyCiphertext(string(v)); err != nil {
					return fmt.Errorf("legacy document has invalid ciphertext: %w", err)
				}
				workspace.Documents = append(workspace.Documents, database.LegacyDocument{
					DocumentID: string(append([]byte(nil), k...)), DocumentHash: string(append([]byte(nil), hash...)), Ciphertext: string(append([]byte(nil), v...)),
				})
				documentsCompleted++
				reportArchiveProgress(progress, ArchiveProgressReadDocuments, documentsCompleted, documentTotal)
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
		reportArchiveProgress(progress, ArchiveProgressValidateHashes, hashesCompleted, hashTotal)
		for _, legacyID := range legacyIDs {
			data := tx.Bucket([]byte(legacyID + "-data"))
			hashes := tx.Bucket([]byte(legacyID + "-hashes"))
			if err := hashes.ForEach(func(k, v []byte) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				if v == nil || data.Get(k) == nil {
					return errors.New("legacy hash has no matching document")
				}
				hashesCompleted++
				reportArchiveProgress(progress, ArchiveProgressValidateHashes, hashesCompleted, hashTotal)
				return nil
			}); err != nil {
				return err
			}
		}
		published := tx.Bucket([]byte("published"))
		if published == nil {
			reportArchiveProgress(progress, ArchiveProgressReadPublications, 0, 0)
			return nil
		}
		publicationTotal := published.Stats().KeyN
		publicationsCompleted := 0
		reportArchiveProgress(progress, ArchiveProgressReadPublications, publicationsCompleted, publicationTotal)
		return published.ForEach(func(k, v []byte) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if v == nil || !legacyHashPattern.Match(k) {
				return errors.New("legacy publication has an invalid public ID")
			}
			var publication legacyPublication
			if err := json.Unmarshal(v, &publication); err != nil {
				return errors.New("legacy publication contains invalid JSON")
			}
			if publication.ID != string(k) {
				return errors.New("legacy publication ID mismatch")
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
			publicationsCompleted++
			reportArchiveProgress(progress, ArchiveProgressReadPublications, publicationsCompleted, publicationTotal)
			return nil
		})
	})
	if err != nil {
		return database.LegacyArchive{}, err
	}
	sort.Slice(archive.Publications, func(i, j int) bool { return archive.Publications[i].PublicID < archive.Publications[j].PublicID })
	return archive, nil
}

func reportArchiveProgress(progress ArchiveProgressFunc, phase ArchiveProgressPhase, completed, total int) {
	if progress != nil {
		progress(ArchiveProgress{Phase: phase, Completed: completed, Total: total})
	}
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
