package legacy

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/schollz/offlinenotepad/internal/cryptov2"
	"github.com/schollz/offlinenotepad/internal/database"
	bolt "go.etcd.io/bbolt"
)

func TestReadArchiveDiscoversEveryWorkspaceWithoutCredentials(t *testing.T) {
	source := filepath.Join(t.TempDir(), "data.db")
	db, err := bolt.Open(source, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, username := range []string{"first user", "second user"} {
		legacyID := legacyUserID(username)
		err = db.Update(func(tx *bolt.Tx) error {
			data, err := tx.CreateBucket([]byte(legacyID + "-data"))
			if err != nil {
				return err
			}
			hashes, err := tx.CreateBucket([]byte(legacyID + "-hashes"))
			if err != nil {
				return err
			}
			if err := data.Put([]byte("abc12345"), []byte(legacyGolden)); err != nil {
				return err
			}
			return hashes.Put([]byte("abc12345"), []byte("bb33cf65"))
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	err = db.Update(func(tx *bolt.Tx) error {
		published, err := tx.CreateBucket([]byte("published"))
		if err != nil {
			return err
		}
		publicID := legacyPublicID("abc12345")
		value, err := json.Marshal(legacyPublication{ID: publicID, Title: "Public", Markdown: "# Safe"})
		if err != nil {
			return err
		}
		return published.Put([]byte(publicID), value)
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
	var progress []ArchiveProgress
	archive, err := readArchiveWithProgress(context.Background(), source, func(update ArchiveProgress) {
		progress = append(progress, update)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.Workspaces) != 2 || len(archive.Publications) != 1 {
		t.Fatalf("archive counts: workspaces=%d publications=%d", len(archive.Workspaces), len(archive.Publications))
	}
	for _, workspace := range archive.Workspaces {
		if len(workspace.Documents) != 1 || workspace.Documents[0].DocumentHash != "bb33cf65" {
			t.Fatalf("staged workspace = %#v", workspace)
		}
	}
	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("legacy source was modified")
	}
	wantCompleted := map[ArchiveProgressPhase]ArchiveProgress{
		ArchiveProgressInspect:          {Phase: ArchiveProgressInspect},
		ArchiveProgressReadDocuments:    {Phase: ArchiveProgressReadDocuments, Completed: 2, Total: 2},
		ArchiveProgressValidateHashes:   {Phase: ArchiveProgressValidateHashes, Completed: 2, Total: 2},
		ArchiveProgressReadPublications: {Phase: ArchiveProgressReadPublications, Completed: 1, Total: 1},
	}
	completed := make(map[ArchiveProgressPhase]ArchiveProgress)
	for _, update := range progress {
		completed[update.Phase] = update
	}
	for phase, want := range wantCompleted {
		if got, ok := completed[phase]; !ok || got != want {
			t.Errorf("final %s progress = %#v, want %#v", phase, got, want)
		}
	}
}

func TestReadArchiveRejectsIncompleteWorkspace(t *testing.T) {
	source := filepath.Join(t.TempDir(), "data.db")
	db, err := bolt.Open(source, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucket([]byte("1234abcd-data"))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := readArchive(source); err == nil {
		t.Fatal("incomplete legacy workspace unexpectedly accepted")
	}
}

func TestPostgreSQLStagesWholeArchiveTransactionally(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	const (
		username   = "archive-stage-integration"
		documentID = "stage001"
	)
	legacyID := legacyUserID(username)
	publicID := legacyPublicID(documentID)
	source := filepath.Join(t.TempDir(), "data.db")
	db, err := bolt.Open(source, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		data, err := tx.CreateBucket([]byte(legacyID + "-data"))
		if err != nil {
			return err
		}
		hashes, err := tx.CreateBucket([]byte(legacyID + "-hashes"))
		if err != nil {
			return err
		}
		published, err := tx.CreateBucket([]byte("published"))
		if err != nil {
			return err
		}
		if err := data.Put([]byte(documentID), []byte(legacyGolden)); err != nil {
			return err
		}
		if err := hashes.Put([]byte(documentID), []byte("1234abcd")); err != nil {
			return err
		}
		value, err := json.Marshal(legacyPublication{ID: publicID, Title: "Staged", Markdown: "# Snapshot"})
		if err != nil {
			return err
		}
		return published.Put([]byte(publicID), value)
	})
	if closeErr := db.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatal(err)
	}
	store, err := database.Open(context.Background(), database.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cleanup, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup.Close()
	defer cleanup.ExecContext(context.Background(), `DELETE FROM legacy_publications WHERE public_id=$1`, publicID)
	defer cleanup.ExecContext(context.Background(), `DELETE FROM legacy_workspaces WHERE legacy_id=$1`, legacyID)
	workspaceID, _ := cryptov2.WorkspaceID(username)
	defer cleanup.ExecContext(context.Background(), `DELETE FROM workspaces WHERE id=$1`, workspaceID)
	result, err := StageArchive(context.Background(), store, ArchiveOptions{Source: source, DryRun: true})
	if err != nil || result.WorkspacesImported != 1 || result.DocumentsImported != 1 || result.PublicationsImported != 1 {
		t.Fatalf("dry run result = %#v err=%v", result, err)
	}
	if _, err := store.GetLegacyWorkspace(context.Background(), legacyID); err != database.ErrNotFound {
		t.Fatalf("dry run wrote workspace: %v", err)
	}
	result, err = StageArchive(context.Background(), store, ArchiveOptions{Source: source})
	if err != nil || result.WorkspacesImported != 1 || result.DocumentsImported != 1 || result.PublicationsImported != 1 {
		t.Fatalf("stage result = %#v err=%v", result, err)
	}
	result, err = StageArchive(context.Background(), store, ArchiveOptions{Source: source})
	if err != nil || result.WorkspacesSkipped != 1 || result.DocumentsSkipped != 1 || result.PublicationsSkipped != 1 {
		t.Fatalf("replay result = %#v err=%v", result, err)
	}
	keys, err := cryptov2.DeriveKeys([]byte("tiny"), "AAECAwQFBgcICQoLDA0ODw", 32*1024, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	workspace := database.Workspace{ID: workspaceID, KDFVersion: 1, KDFSalt: "AAECAwQFBgcICQoLDA0ODw", KDFMemory: 32 * 1024, KDFIterations: 1, KDFParallelism: 1, AuthPublicKey: cryptov2.EncodePublicKey(keys.PublicKey)}
	promoted, err := store.PromoteLegacyWorkspace(context.Background(), legacyID, workspace, []database.Document{{DocumentID: documentID, Ciphertext: "modern encrypted", CiphertextHash: "modern hash"}})
	if err != nil || promoted.DocumentsImported != 1 || promoted.PublicationsImported != 1 {
		t.Fatalf("promotion result = %#v err=%v", promoted, err)
	}
	if document, err := store.GetDocument(context.Background(), workspaceID, documentID); err != nil || document.Ciphertext != "modern encrypted" {
		t.Fatalf("promoted document = %#v err=%v", document, err)
	}
}
