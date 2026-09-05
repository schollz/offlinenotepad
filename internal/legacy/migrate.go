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
type Result struct{ DocumentsImported, DocumentsSkipped, PublicationsImported, PublicationsSkipped int }

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
			hash := hashes.Get(k)
			if hash == nil {
				return fmt.Errorf("document %s has no legacy hash", k)
			}
			records = append(records, encryptedRecord{id: string(k), value: string(append([]byte(nil), v...)), hash: string(append([]byte(nil), hash...))})
			return nil
		}); err != nil {
			return err
		}
		if err := hashes.ForEach(func(k, v []byte) error {
			if v != nil && data.Get(k) == nil {
				return fmt.Errorf("legacy hash %s has no document", k)
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
		return Result{}, err
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
	for _, record := range records {
		plaintext, err := decryptLegacy(record.value, options.Password)
		if err != nil {
			return Result{}, fmt.Errorf("decrypt document %s: %w", record.id, err)
		}
		var old legacyDocument
		if err := json.Unmarshal([]byte(plaintext), &old); err != nil {
			return Result{}, fmt.Errorf("parse document %s: %w", record.id, err)
		}
		if old.UUID != record.id {
			return Result{}, fmt.Errorf("document %s UUID mismatch", record.id)
		}
		if !legacyDocumentIDPattern.MatchString(old.UUID) {
			return Result{}, fmt.Errorf("document %s has invalid UUID", record.id)
		}
		if legacyDocumentHash(old) != record.hash || old.Hash != record.hash {
			return Result{}, fmt.Errorf("document %s hash mismatch", record.id)
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
				return Result{}, fmt.Errorf("parse publication %s: %w", publicID, err)
			}
			if p.ID != publicID {
				return Result{}, fmt.Errorf("publication %s ID mismatch", publicID)
			}
			publications = append(publications, database.Publication{PublicID: publicID, WorkspaceID: workspaceID, DocumentID: old.UUID, Title: p.Title, Content: p.Markdown, ContentMode: mode, Legacy: true})
		}
	}
	if options.DryRun {
		result := Result{}
		newDocuments := make(map[string]struct{}, len(documents))
		for _, document := range documents {
			_, err := store.GetDocument(ctx, workspaceID, document.DocumentID)
			switch {
			case errors.Is(err, database.ErrNotFound):
				result.DocumentsImported++
				newDocuments[document.DocumentID] = struct{}{}
			case err != nil:
				return Result{}, err
			default:
				result.DocumentsSkipped++
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
				return Result{}, err
			case existing.WorkspaceID != workspaceID || existing.DocumentID != publication.DocumentID:
				return Result{}, fmt.Errorf("publication id collision: %w", database.ErrExists)
			default:
				result.PublicationsSkipped++
			}
		}
		return result, nil
	}
	imported, err := store.ImportLegacy(ctx, workspace, documents, publications)
	if err != nil {
		return Result{}, err
	}
	return Result(imported), nil
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
	decoded, err = unpadPKCS7(decoded, aes.BlockSize)
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
func unpadPKCS7(value []byte, size int) ([]byte, error) {
	if len(value) == 0 {
		return nil, errors.New("empty padded value")
	}
	padding := int(value[len(value)-1])
	if padding == 0 || padding > size || padding > len(value) {
		return nil, errors.New("invalid password or padding")
	}
	for _, b := range value[len(value)-padding:] {
		if int(b) != padding {
			return nil, errors.New("invalid password or padding")
		}
	}
	return value[:len(value)-padding], nil
}
