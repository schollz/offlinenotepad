package legacy

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/schollz/offlinenotepad/internal/cryptov2"
	"github.com/schollz/offlinenotepad/internal/database"
	bolt "go.etcd.io/bbolt"
)

const legacyGolden = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fzfX6+lZfj1SrH6oQDTm/W0lUoUfyuss9ergu0hTHHSea7nzW7+XEdU6+7eeJyLYuek+ylZliq76lMbEo29ZEvCnYIhxq1pIh751Lbe3hEcMwyhSnlyIME8koPNGhl68UXIpdUJr7ykBwNKzEgarX2fpvuGbSWfYd78WGL4CFadM4iTGS71oXtM1a979lvO+BBhgbqCUsaTFNQlpy3QGKBPhQHXGGZZmbCq9K6Q/MOuY7cxRsQKXKLFlIf+Vjk1kK"
const legacyShortPasswordGolden = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fBdsehS8hkZAmv6Km/qNel77CgUp3GqVh+nkt82lzkfsCLhcozQ69iqUzGRmHxFxN1+VNYMOsJTuBNrR/AAJbuA1v2lG8Sinx3DFnFZYjpRT/VEEWhN+Y2/FuSlZ3MA+BgrnfNC/OWKlyQLPnOTR5qtjo8dF4leEIBhMGhQ/eb8hVx81pconDVtOG3RWvgsZ64assh4stogsFg1h9qbtsTdxcZZHHzEsp0DaUjLf1Wbf9hpC9j5tG/Vt+7VgdwhFO"

func TestDecryptLegacyCryptoJSGolden(t *testing.T) {
	got, err := decryptLegacy(legacyGolden, []byte("correct horse battery staple"))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"uuid":"abc12345","title":"Golden note","markdown":"# Hello\n\nlegacy","hash":"bb33cf65","created":"2020-01-02T03:04:05.000Z","modified":"2020-02-03T04:05:06.000Z","published":true}`
	if got != want {
		t.Fatalf("legacy plaintext = %q, want %q", got, want)
	}
}

func TestDecryptLegacyRejectsWrongPassword(t *testing.T) {
	if _, err := decryptLegacy(legacyGolden, []byte("definitely the wrong password")); err == nil {
		t.Fatal("wrong password unexpectedly decrypted the document")
	}
}

func TestDecryptLegacyAllowsShortPassword(t *testing.T) {
	got, err := decryptLegacy(legacyShortPasswordGolden, []byte("tiny"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `"uuid":"abc12345"`) {
		t.Fatalf("unexpected legacy plaintext: %q", got)
	}
}

func TestPostgreSQLLegacyMigration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	const (
		username   = "migration-integration-workspace"
		password   = "tiny"
		documentID = "abc12345"
	)
	source := filepath.Join(t.TempDir(), "data.db")
	db, err := bolt.Open(source, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		data, err := tx.CreateBucket([]byte(legacyUserID(username) + "-data"))
		if err != nil {
			return err
		}
		hashes, err := tx.CreateBucket([]byte(legacyUserID(username) + "-hashes"))
		if err != nil {
			return err
		}
		published, err := tx.CreateBucket([]byte("published"))
		if err != nil {
			return err
		}
		if err := data.Put([]byte(documentID), []byte(legacyShortPasswordGolden)); err != nil {
			return err
		}
		if err := hashes.Put([]byte(documentID), []byte("bb33cf65")); err != nil {
			return err
		}
		encoded, _ := json.Marshal(legacyPublication{ID: legacyPublicID(documentID), Title: "Published golden", Markdown: "# Stale public snapshot"})
		return published.Put([]byte(legacyPublicID(documentID)), encoded)
	})
	if closeErr := db.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	store, err := database.Open(context.Background(), database.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	workspaceID, _ := cryptov2.WorkspaceID(username)
	cleanup, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup.Close()
	defer cleanup.ExecContext(context.Background(), `DELETE FROM workspaces WHERE id=$1`, workspaceID)
	options := Options{Source: source, Username: username, Password: []byte("wrong password value")}
	if _, err := Migrate(context.Background(), store, options); err == nil {
		t.Fatal("wrong legacy password unexpectedly migrated")
	}
	if _, err := store.GetWorkspace(context.Background(), workspaceID); err != database.ErrNotFound {
		t.Fatalf("wrong-password migration wrote workspace: %v", err)
	}
	options.Password = []byte(password)
	options.DryRun = true
	dryResult, err := Migrate(context.Background(), store, options)
	if err != nil {
		t.Fatal(err)
	}
	if dryResult.DocumentsImported != 1 || dryResult.PublicationsImported != 1 {
		t.Fatalf("dry-run result = %#v", dryResult)
	}
	if _, err := store.GetWorkspace(context.Background(), workspaceID); err != database.ErrNotFound {
		t.Fatalf("dry run wrote workspace: %v", err)
	}
	options.DryRun = false
	result, err := Migrate(context.Background(), store, options)
	if err != nil {
		t.Fatal(err)
	}
	if result.DocumentsImported != 1 || result.PublicationsImported != 1 {
		t.Fatalf("first migration result = %#v", result)
	}
	result, err = Migrate(context.Background(), store, options)
	if err != nil {
		t.Fatal(err)
	}
	if result.DocumentsSkipped != 1 || result.PublicationsSkipped != 1 {
		t.Fatalf("repeated migration result = %#v", result)
	}
	publication, err := store.GetPublication(context.Background(), legacyPublicID(documentID))
	if err != nil || publication.Content != "# Stale public snapshot" || publication.ContentMode != "markdown" {
		t.Fatalf("migrated publication = %#v err=%v", publication, err)
	}
	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("legacy source file was modified")
	}
}
