package database

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenLogsDatabaseMigrationsAtInfoLevel(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	config := Config{SQLitePath: filepath.Join(t.TempDir(), "migration-logging.sqlite3")}
	for range 2 {
		store, err := Open(context.Background(), config)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}

	output := logs.String()
	for _, expected := range []string{
		`level=INFO msg="checking database migrations" database=sqlite`,
		`level=INFO msg="database migration" database=sqlite`,
		`level=INFO msg="database migrations applied" database=sqlite`,
		`level=INFO msg="database migrations are up to date" database=sqlite`,
	} {
		if !strings.Contains(output, expected) {
			t.Errorf("migration logs did not contain %q:\n%s", expected, output)
		}
	}
}

func TestSQLiteStoreContract(t *testing.T) {
	store, err := Open(context.Background(), Config{SQLitePath: filepath.Join(t.TempDir(), "contract.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	runStoreContract(t, store, "sqlite-contract-workspace")
}

func TestLegacyStagingIsTransactionalAndIdempotent(t *testing.T) {
	store, err := Open(context.Background(), Config{SQLitePath: filepath.Join(t.TempDir(), "legacy.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	archive := LegacyArchive{
		Workspaces:   []LegacyWorkspace{{LegacyID: "1234abcd", Documents: []LegacyDocument{{DocumentID: "abc12345", Ciphertext: "encrypted", DocumentHash: "bb33cf65"}}}},
		Publications: []LegacyPublication{{PublicID: "abcd1234", LegacyID: "1234abcd", DocumentID: "abc12345", Title: "Public", Content: "# Snapshot", ContentMode: "markdown"}},
	}
	result, err := store.StageLegacyArchive(context.Background(), archive, true)
	if err != nil || result.WorkspacesImported != 1 || result.DocumentsImported != 1 || result.PublicationsImported != 1 {
		t.Fatalf("dry-run result = %#v err=%v", result, err)
	}
	if _, err := store.GetLegacyWorkspace(context.Background(), "1234abcd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("dry run wrote legacy workspace: %v", err)
	}
	result, err = store.StageLegacyArchive(context.Background(), archive, false)
	if err != nil || result.WorkspacesImported != 1 || result.DocumentsImported != 1 || result.PublicationsImported != 1 {
		t.Fatalf("stage result = %#v err=%v", result, err)
	}
	result, err = store.StageLegacyArchive(context.Background(), archive, false)
	if err != nil || result.WorkspacesSkipped != 1 || result.DocumentsSkipped != 1 || result.PublicationsSkipped != 1 {
		t.Fatalf("replay result = %#v err=%v", result, err)
	}
	collision := archive
	collision.Workspaces = []LegacyWorkspace{{LegacyID: "1234abcd", Documents: []LegacyDocument{{DocumentID: "abc12345", Ciphertext: "different", DocumentHash: "bb33cf65"}}}}
	if _, err := store.StageLegacyArchive(context.Background(), collision, false); !errors.Is(err, ErrExists) {
		t.Fatalf("collision error = %v", err)
	}
	workspace, err := store.GetLegacyWorkspace(context.Background(), "1234abcd")
	if err != nil || workspace.Documents[0].Ciphertext != "encrypted" {
		t.Fatalf("collision changed staged data: %#v err=%v", workspace, err)
	}
}

func TestPostgreSQLStoreContract(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	store, err := Open(context.Background(), Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	const workspaceID = "postgres-contract-workspace"
	defer store.db.ExecContext(context.Background(), `DELETE FROM workspaces WHERE id=$1`, workspaceID)
	runStoreContract(t, store, workspaceID)
}

func runStoreContract(t *testing.T, store *Store, workspaceID string) {
	t.Helper()
	ctx := context.Background()
	workspace := Workspace{ID: workspaceID, KDFVersion: 1, KDFSalt: "salt", KDFMemory: 65536, KDFIterations: 3, KDFParallelism: 1, AuthPublicKey: "old-key"}
	created, err := store.CreateWorkspace(ctx, workspace)
	if err != nil || !created {
		t.Fatalf("create workspace: created=%v err=%v", created, err)
	}
	if created, err = store.CreateWorkspace(ctx, workspace); err != nil || created {
		t.Fatalf("duplicate workspace: created=%v err=%v", created, err)
	}
	document := Document{WorkspaceID: workspaceID, DocumentID: "document-one", Ciphertext: "ciphertext-1", CiphertextHash: "hash-1"}
	saved, err := store.PutDocument(ctx, document, 0)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("create document: revision=%d err=%v", saved.Revision, err)
	}
	if current, err := store.PutDocument(ctx, document, 0); !errors.Is(err, ErrConflict) || current.Revision != 1 {
		t.Fatalf("expected create conflict, revision=%d err=%v", current.Revision, err)
	}
	document.Ciphertext, document.CiphertextHash = "ciphertext-2", "hash-2"
	saved, err = store.PutDocument(ctx, document, 1)
	if err != nil || saved.Revision != 2 {
		t.Fatalf("update document: revision=%d err=%v", saved.Revision, err)
	}
	publication := Publication{PublicID: "public-document-one", WorkspaceID: workspaceID, DocumentID: document.DocumentID, Title: "Snapshot", Content: "# Public", ContentMode: "markdown"}
	if err := store.PutPublication(ctx, publication); err != nil {
		t.Fatal(err)
	}
	if got, err := store.GetPublication(ctx, publication.PublicID); err != nil || got.Content != publication.Content {
		t.Fatalf("publication = %#v err=%v", got, err)
	}
	document.Deleted, document.Ciphertext, document.CiphertextHash = true, "", ""
	saved, err = store.PutDocument(ctx, document, 2)
	if err != nil || !saved.Deleted || saved.Revision != 3 {
		t.Fatalf("tombstone document: %#v err=%v", saved, err)
	}
	document.Deleted = false
	if current, err := store.PutDocument(ctx, document, 3); !errors.Is(err, ErrConflict) || !current.Deleted {
		t.Fatalf("permanent tombstone could be overwritten: %#v err=%v", current, err)
	}
	active := Document{WorkspaceID: workspaceID, DocumentID: "document-two", Ciphertext: "ciphertext-a", CiphertextHash: "hash-a"}
	active, err = store.PutDocument(ctx, active, 0)
	if err != nil {
		t.Fatal(err)
	}
	next := Workspace{ID: workspaceID, KDFSalt: "next-salt", KDFMemory: 32768, KDFIterations: 2, KDFParallelism: 1, AuthPublicKey: "new-key"}
	if err := store.RotateCredentials(ctx, workspaceID, workspace.AuthPublicKey, next, []RotationDocument{{DocumentID: active.DocumentID, Ciphertext: "rotated", CiphertextHash: "rotated-hash", Revision: active.Revision}}); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetWorkspace(ctx, workspaceID)
	if err != nil || got.AuthPublicKey != "new-key" {
		t.Fatalf("rotated workspace = %#v err=%v", got, err)
	}
}
