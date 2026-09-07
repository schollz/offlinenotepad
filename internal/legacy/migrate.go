package legacy

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/schollz/offlinenotepad/internal/cryptov2"
	"github.com/schollz/offlinenotepad/internal/database"
	bolt "go.etcd.io/bbolt"
	"golang.org/x/crypto/pbkdf2"
)

type Options struct {
	Source, Username string
	Password         []byte
	DryRun           bool
}
type Result struct {
	DocumentsImported, DocumentsSkipped, DocumentsVerified int
	DocumentsRead, DocumentsRejectedDecrypt                int
	DocumentsRejectedInvalid, DocumentsRecoveredHash       int
	DocumentsSkippedDeleted                                int
	HashesSkippedWithoutDocument                           int
	PublicationsImported, PublicationsSkipped              int
	PublicationsRejected                                   int
}

type legacyDocument struct {
	UUID      string `json:"uuid"`
	Title     string `json:"title"`
	Markdown  string `json:"markdown"`
	Hash      string `json:"hash"`
	Created   any    `json:"created"`
	Modified  any    `json:"modified"`
	Published bool   `json:"published"`
}
type modernDocument struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	Mode      string `json:"mode"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}
type legacyPublication struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Markdown string `json:"markdown"`
}

var legacyDocumentIDPattern = regexp.MustCompile(`^[a-z0-9]{8}$`)

func Migrate(ctx context.Context, store *database.Store, options Options) (Result, error) {
	if store.Backend() != database.BackendPostgreSQL {
		return Result{}, errors.New("legacy migration requires DATABASE_URL")
	}
	if options.Source == "" || options.Username == "" || len(options.Password) == 0 {
		return Result{}, errors.New("source, username, and password are required")
	}
	info, err := os.Stat(options.Source)
	if err != nil {
		return Result{}, fmt.Errorf("inspect legacy database: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Result{}, errors.New("legacy database must be a regular file")
	}
	legacyID := legacyUserID(options.Username)
	db, err := bolt.Open(options.Source, 0444, &bolt.Options{ReadOnly: true, Timeout: 2 * time.Second})
	if err != nil {
		return Result{}, fmt.Errorf("open legacy database read-only: %w", err)
	}
	defer db.Close()
	type encryptedRecord struct{ id, value, hash string }
	records := make([]encryptedRecord, 0)
	publishedRaw := make(map[string][]byte)
	result := Result{}
	err = db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket([]byte(legacyID + "-data"))
		hashes := tx.Bucket([]byte(legacyID + "-hashes"))
		if data == nil || hashes == nil {
			return fmt.Errorf("no legacy workspace matches username")
		}
		if err := data.ForEach(func(k, v []byte) error {
			if v == nil {
				return nil
			}
			result.DocumentsRead++
			hash := hashes.Get(k)
			storedHash := ""
			if hash != nil {
				storedHash = string(append([]byte(nil), hash...))
			}
			records = append(records, encryptedRecord{id: string(k), value: string(append([]byte(nil), v...)), hash: storedHash})
			return nil
		}); err != nil {
			return err
		}
		if err := hashes.ForEach(func(k, v []byte) error {
			if v != nil && data.Get(k) == nil {
				result.HashesSkippedWithoutDocument++
			}
			return nil
		}); err != nil {
			return err
		}
		if bucket := tx.Bucket([]byte("published")); bucket != nil {
			return bucket.ForEach(func(k, v []byte) error {
				if v != nil {
					publishedRaw[string(k)] = append([]byte(nil), v...)
				}
				return nil
			})
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	workspaceID, err := cryptov2.WorkspaceID(options.Username)
	if err != nil {
		return Result{}, err
	}
	workspace, err := store.GetWorkspace(ctx, workspaceID)
	if errors.Is(err, database.ErrNotFound) {
		salt, e := cryptov2.NewSalt()
		if e != nil {
			return Result{}, e
		}
		workspace = database.Workspace{ID: workspaceID, KDFVersion: cryptov2.KDFVersion, KDFSalt: salt, KDFMemory: cryptov2.KDFMemory, KDFIterations: cryptov2.KDFIterations, KDFParallelism: cryptov2.KDFParallelism}
	} else if err != nil {
		return Result{}, err
	}
	keys, err := cryptov2.DeriveKeys(options.Password, workspace.KDFSalt, workspace.KDFMemory, workspace.KDFIterations, workspace.KDFParallelism)
	if err != nil {
		return Result{}, err
	}
	defer clear(keys.ContentKey)
	defer clear(keys.PrivateKey)
	publicKey := cryptov2.EncodePublicKey(keys.PublicKey)
	if workspace.AuthPublicKey != "" && workspace.AuthPublicKey != publicKey {
		return Result{}, errors.New("workspace exists with different credentials")
	}
	workspace.AuthPublicKey = publicKey
	documents := make([]database.Document, 0, len(records))
	publications := make([]database.Publication, 0)
	documentsAuthenticated := 0
	for _, record := range records {
		plaintext, err := decryptLegacy(record.value, options.Password)
		if err != nil {
			result.DocumentsRejectedDecrypt++
			continue
		}
		var old legacyDocument
		if err := json.Unmarshal([]byte(plaintext), &old); err != nil {
			result.DocumentsRejectedInvalid++
			continue
		}
		calculatedHash := legacyDocumentHash(old)
		if old.UUID != record.id || !legacyDocumentIDPattern.MatchString(old.UUID) || old.Hash != calculatedHash {
			result.DocumentsRejectedInvalid++
			continue
		}
		if record.hash != calculatedHash {
			result.DocumentsRecoveredHash++
		}
		documentsAuthenticated++
		if isLegacyDeletedTitle(old.Title) {
			result.DocumentsSkippedDeleted++
			if _, published := publishedRaw[legacyPublicID(old.UUID)]; published {
				result.PublicationsSkipped++
			}
			continue
		}
		mode := "markdown"
		if strings.Contains(old.Title, ".") {
			mode = "plaintext"
		}
		modern := modernDocument{ID: old.UUID, Title: old.Title, Content: old.Markdown, Mode: mode, CreatedAt: stringValue(old.Created), UpdatedAt: stringValue(old.Modified)}
		encoded, err := json.Marshal(modern)
		if err != nil {
			return Result{}, err
		}
		ciphertext, hash, err := cryptov2.EncryptDocument(keys.ContentKey, workspaceID, old.UUID, encoded)
		clear(encoded)
		if err != nil {
			return Result{}, err
		}
		documents = append(documents, database.Document{WorkspaceID: workspaceID, DocumentID: old.UUID, Ciphertext: ciphertext, CiphertextHash: hash, ImportedLegacy: true})
		publicID := legacyPublicID(old.UUID)
		if raw, ok := publishedRaw[publicID]; ok {
			var p legacyPublication
			if err := json.Unmarshal(raw, &p); err != nil {
				result.PublicationsRejected++
				continue
			}
			if p.ID != publicID {
				result.PublicationsRejected++
				continue
			}
			publications = append(publications, database.Publication{PublicID: publicID, WorkspaceID: workspaceID, DocumentID: old.UUID, Title: p.Title, Content: p.Markdown, ContentMode: mode, Legacy: true})
		}
	}
	if len(records) > 0 && documentsAuthenticated == 0 {
		return result, errors.New("no legacy documents could be authenticated with the supplied credentials")
	}
	if options.DryRun {
		newDocuments := make(map[string]struct{}, len(documents))
		for _, document := range documents {
			existing, err := store.GetDocument(ctx, workspaceID, document.DocumentID)
			switch {
			case errors.Is(err, database.ErrNotFound):
				result.DocumentsImported++
				newDocuments[document.DocumentID] = struct{}{}
			case err != nil:
				return result, err
			default:
				plaintext, decryptErr := cryptov2.DecryptDocument(keys.ContentKey, workspaceID, existing.DocumentID, existing.Ciphertext)
				if decryptErr != nil {
					return result, errors.New("an existing migrated document could not be decrypted with these credentials")
				}
				var current modernDocument
				parseErr := json.Unmarshal(plaintext, &current)
				clear(plaintext)
				if parseErr != nil || current.ID != existing.DocumentID {
					return result, errors.New("an existing migrated document has an invalid encrypted payload")
				}
				result.DocumentsSkipped++
				result.DocumentsVerified++
			}
		}
		for _, publication := range publications {
			if _, isNew := newDocuments[publication.DocumentID]; !isNew {
				result.PublicationsSkipped++
				continue
			}
			existing, err := store.GetPublication(ctx, publication.PublicID)
			switch {
			case errors.Is(err, database.ErrNotFound):
				result.PublicationsImported++
			case err != nil:
				return result, err
			case existing.WorkspaceID != workspaceID || existing.DocumentID != publication.DocumentID:
				return result, fmt.Errorf("publication id collision: %w", database.ErrExists)
			default:
				result.PublicationsSkipped++
			}
		}
		return result, nil
	}
	imported, err := store.ImportLegacy(ctx, workspace, documents, publications)
	if err != nil {
		return result, err
	}
	result.DocumentsImported = imported.DocumentsImported
	result.DocumentsSkipped = imported.DocumentsSkipped
	result.PublicationsImported = imported.PublicationsImported
	result.PublicationsSkipped = imported.PublicationsSkipped
	return result, nil
}

func legacyUserID(username string) string {
	sum := sha256.Sum256([]byte("offlinenotepad" + username))
	return hex.EncodeToString(sum[:])[:8]
}
func legacyPublicID(id string) string {
	sum := sha256.Sum256([]byte("offlinenotepad" + id))
	return hex.EncodeToString(sum[:])[:8]
}
func legacyDocumentHash(d legacyDocument) string {
	sum := sha256.Sum256([]byte("offlinenotepad" + d.UUID + d.Title + d.Markdown))
	return hex.EncodeToString(sum[:])[:8]
}
func isLegacyDeletedTitle(title string) bool {
	return strings.EqualFold(strings.TrimSpace(title), "deleted")
}
func stringValue(v any) string {
	switch value := v.(type) {
	case string:
		return value
	default:
		b, _ := json.Marshal(value)
		return string(b)
	}
}

func decryptLegacy(value string, password []byte) (string, error) {
	if len(value) <= 64 {
		return "", errors.New("ciphertext is too short")
	}
	salt, err := hex.DecodeString(value[:32])
	if err != nil {
		return "", err
	}
	iv, err := hex.DecodeString(value[32:64])
	if err != nil {
		return "", err
	}
	encrypted, err := base64.StdEncoding.DecodeString(value[64:])
	if err != nil {
		return "", err
	}
	if len(encrypted) == 0 || len(encrypted)%aes.BlockSize != 0 {
		return "", errors.New("invalid AES-CBC length")
	}
	key := pbkdf2.Key(password, salt, 10, 16, sha1.New)
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	decoded := make([]byte, len(encrypted))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(decoded, encrypted)
	decoded, err = unpadCryptoJSPKCS7(decoded)
	if err != nil {
		return "", err
	}
	if len(decoded)%2 != 0 {
		return "", errors.New("invalid UTF-16 payload")
	}
	units := make([]uint16, len(decoded)/2)
	for i := range units {
		units[i] = binary.BigEndian.Uint16(decoded[i*2:])
	}
	return decompressUTF16(units)
}

// CryptoJS's historical PKCS#7 unpad implementation trusted the final byte
// instead of checking every padding byte. Some legacy records depend on that
// behavior. The decrypted document's internal hash is still verified before
// migration, so accepting this padding form cannot authenticate bad plaintext.
func unpadCryptoJSPKCS7(value []byte) ([]byte, error) {
	if len(value) == 0 {
		return nil, errors.New("empty padded value")
	}
	padding := int(value[len(value)-1])
	if padding > len(value) {
		return nil, errors.New("invalid password or padding")
	}
	return value[:len(value)-padding], nil
}
