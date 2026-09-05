package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/schollz/offlinenotepad/internal/cryptov2"
	"github.com/schollz/offlinenotepad/internal/database"
)

func testServer(t *testing.T) (*database.Store, *httptest.Server) {
	return testServerWithConfig(t, Config{LegacyMigrationEnabled: true})
}

func testServerWithConfig(t *testing.T, config Config) (*database.Store, *httptest.Server) {
	t.Helper()
	store, err := database.Open(context.Background(), database.Config{SQLitePath: filepath.Join(t.TempDir(), "app.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	content := fstest.MapFS{
		"index.html":                     &fstest.MapFile{Data: []byte(`<title>{{.PageTitle}}</title><main>app</main>`)},
		"public.html":                    &fstest.MapFile{Data: []byte(`<title>{{.Title}}</title><a href="{{.RawURL}}">raw</a><article>{{.Content}}</article>`)},
		"static/app.js":                  &fstest.MapFile{Data: []byte(`console.log("app")`)},
		"fonts/OpenAISans-Regular.woff2": &fstest.MapFile{Data: []byte("font")},
	}
	application, err := New(store, fs.FS(content), slog.New(slog.NewTextHandler(io.Discard, nil)), config)
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	server := httptest.NewServer(application.Handler())
	t.Cleanup(func() { server.Close(); store.Close() })
	return store, server
}

func TestEmbeddedFontRoute(t *testing.T) {
	_, server := testServer(t)
	response, err := http.Get(server.URL + "/fonts/OpenAISans-Regular.woff2")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || string(body) != "font" {
		t.Fatalf("font response status=%d body=%q", response.StatusCode, body)
	}
}

func createTestWorkspace(t *testing.T, store *database.Store) (database.Workspace, cryptov2.Keys) {
	t.Helper()
	salt := "AAECAwQFBgcICQoLDA0ODw"
	keys, err := cryptov2.DeriveKeys([]byte("correct horse battery staple"), salt, 32*1024, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := cryptov2.WorkspaceID("websocket test")
	workspace := database.Workspace{ID: id, KDFVersion: 1, KDFSalt: salt, KDFMemory: 32 * 1024, KDFIterations: 1, KDFParallelism: 1, AuthPublicKey: cryptov2.EncodePublicKey(keys.PublicKey)}
	if created, err := store.CreateWorkspace(context.Background(), workspace); err != nil || !created {
		t.Fatalf("create workspace: created=%v err=%v", created, err)
	}
	return workspace, keys
}

func authenticatedConnection(t *testing.T, server *httptest.Server, workspace database.Workspace, keys cryptov2.Keys) (*websocket.Conn, context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{server.URL}}})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var challenge socketMessage
	if err := wsjson.Read(ctx, conn, &challenge); err != nil {
		conn.CloseNow()
		cancel()
		t.Fatal(err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge.Challenge)
	if err != nil {
		conn.CloseNow()
		cancel()
		t.Fatal(err)
	}
	signature := ed25519.Sign(keys.PrivateKey, append([]byte(authenticationContext), decoded...))
	if err := wsjson.Write(ctx, conn, socketMessage{Type: messageAuthenticate, WorkspaceID: workspace.ID, Signature: base64.RawURLEncoding.EncodeToString(signature)}); err != nil {
		conn.CloseNow()
		cancel()
		t.Fatal(err)
	}
	var authenticated socketMessage
	if err := wsjson.Read(ctx, conn, &authenticated); err != nil || authenticated.Type != messageAuthenticated {
		conn.CloseNow()
		cancel()
		t.Fatalf("authentication response = %#v err=%v", authenticated, err)
	}
	return conn, ctx, cancel
}

func TestWebsocketAuthenticationAndMutation(t *testing.T) {
	store, server := testServer(t)
	workspace, keys := createTestWorkspace(t, store)
	conn, ctx, cancel := authenticatedConnection(t, server, workspace, keys)
	defer cancel()
	defer conn.CloseNow()
	ciphertext, hash, err := cryptov2.EncryptDocument(keys.ContentKey, workspace.ID, "document-one", []byte(`{"id":"document-one"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(ctx, conn, socketMessage{Type: messageUpsert, DocumentID: "document-one", Ciphertext: ciphertext, CiphertextHash: hash}); err != nil {
		t.Fatal(err)
	}
	var ack socketMessage
	if err := wsjson.Read(ctx, conn, &ack); err != nil || ack.Type != messageAck || len(ack.Documents) != 1 || ack.Documents[0].Revision != 1 {
		t.Fatalf("upsert response = %#v err=%v", ack, err)
	}
	if err := wsjson.Write(ctx, conn, socketMessage{Type: messageUpsert, DocumentID: "document-one", Ciphertext: ciphertext, CiphertextHash: hash, BaseRevision: 0}); err != nil {
		t.Fatal(err)
	}
	var conflict socketMessage
	if err := wsjson.Read(ctx, conn, &conflict); err != nil || conflict.Type != messageConflict || len(conflict.Documents) != 1 || conflict.Documents[0].Revision != 1 {
		t.Fatalf("conflict response = %#v err=%v", conflict, err)
	}
	if err := wsjson.Write(ctx, conn, socketMessage{Type: messageUpsert, DocumentID: "document-one", Ciphertext: ciphertext, CiphertextHash: "wrong", BaseRevision: 1}); err != nil {
		t.Fatal(err)
	}
	var failure socketMessage
	if err := wsjson.Read(ctx, conn, &failure); err != nil || failure.Type != messageError || failure.ErrorCode != "invalid-message" {
		t.Fatalf("invalid mutation response = %#v err=%v", failure, err)
	}
}

func TestWebsocketRejectsMalformedAndOversizedMessages(t *testing.T) {
	t.Run("malformed authentication", func(t *testing.T) {
		_, server := testServer(t)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
		conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{server.URL}}})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow()
		var challenge socketMessage
		if err := wsjson.Read(ctx, conn, &challenge); err != nil {
			t.Fatal(err)
		}
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":`)); err != nil {
			t.Fatal(err)
		}
		var failure socketMessage
		if err := wsjson.Read(ctx, conn, &failure); websocket.CloseStatus(err) != websocket.StatusInvalidFramePayloadData {
			t.Fatalf("malformed message close status = %v, err=%v", websocket.CloseStatus(err), err)
		}
	})

	t.Run("oversized document", func(t *testing.T) {
		store, server := testServer(t)
		workspace, keys := createTestWorkspace(t, store)
		conn, ctx, cancel := authenticatedConnection(t, server, workspace, keys)
		defer cancel()
		defer conn.CloseNow()
		if err := wsjson.Write(ctx, conn, socketMessage{Type: messageUpsert, DocumentID: "document-one", Ciphertext: strings.Repeat("x", maxWebsocketMessage/2+1), CiphertextHash: "unused"}); err != nil {
			t.Fatal(err)
		}
		var failure socketMessage
		if err := wsjson.Read(ctx, conn, &failure); err != nil || failure.Type != messageError || !strings.Contains(failure.Error, "too large") {
			t.Fatalf("oversized response = %#v err=%v", failure, err)
		}
	})
}

func TestWebsocketRejectsForeignOrigin(t *testing.T) {
	_, server := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	_, response, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://attacker.invalid"}}})
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: response=%v err=%v", response, err)
	}
}

func TestPublicSnapshotIsSanitizedAndNotAppCached(t *testing.T) {
	store, server := testServer(t)
	workspace, _ := createTestWorkspace(t, store)
	document := database.Document{WorkspaceID: workspace.ID, DocumentID: "document-one", Ciphertext: "encrypted", CiphertextHash: base64.RawURLEncoding.EncodeToString(sha256.New().Sum(nil))}
	if _, err := store.PutDocument(context.Background(), document, 0); err != nil {
		t.Fatal(err)
	}
	publication := database.Publication{PublicID: "public-document-one", WorkspaceID: workspace.ID, DocumentID: document.DocumentID, Title: "Snapshot", Content: "# Safe\n\n<script>alert(1)</script>", ContentMode: "markdown"}
	if err := store.PutPublication(context.Background(), publication); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(server.URL + "/p/" + url.PathEscape(publication.PublicID))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.Header.Get("Cache-Control") != "public, max-age=60" || strings.Contains(string(body), "<script") || !strings.Contains(string(body), "Safe") {
		t.Fatalf("public response headers=%v body=%q", response.Header, body)
	}
	appResponse, err := http.Get(server.URL + "/app/notes/document-one")
	if err != nil {
		t.Fatal(err)
	}
	defer appResponse.Body.Close()
	if appResponse.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("app Cache-Control = %q", appResponse.Header.Get("Cache-Control"))
	}
}

func TestStagedLegacyWorkspaceAndPublicationRoutes(t *testing.T) {
	store, server := testServer(t)
	const (
		username   = "legacy account"
		documentID = "v9y7fxgx"
	)
	legacyID := legacyWorkspaceID(username)
	archive := database.LegacyArchive{
		Workspaces:   []database.LegacyWorkspace{{LegacyID: legacyID, Documents: []database.LegacyDocument{{DocumentID: documentID, Ciphertext: "legacy ciphertext", DocumentHash: "bb33cf65"}}}},
		Publications: []database.LegacyPublication{{PublicID: "abcd1234", LegacyID: legacyID, DocumentID: documentID, Title: "Legacy snapshot", Content: "# Safe\n\n<script>alert(1)</script>", ContentMode: "markdown"}},
	}
	if _, err := store.StageLegacyArchive(context.Background(), archive, false); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(server.URL + "/api/v1/legacy/workspaces/" + legacyID)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" || !strings.Contains(string(body), "legacy ciphertext") {
		t.Fatalf("legacy workspace response status=%d headers=%v body=%q", response.StatusCode, response.Header, body)
	}
	publicResponse, err := http.Get(server.URL + "/abcd1234")
	if err != nil {
		t.Fatal(err)
	}
	publicBody, _ := io.ReadAll(publicResponse.Body)
	publicResponse.Body.Close()
	if publicResponse.StatusCode != http.StatusOK || strings.Contains(string(publicBody), "<script") || !strings.Contains(string(publicBody), "Safe") {
		t.Fatalf("legacy publication response status=%d body=%q", publicResponse.StatusCode, publicBody)
	}

	workspaceID, _ := cryptov2.WorkspaceID(username)
	salt := "AAECAwQFBgcICQoLDA0ODw"
	keys, err := cryptov2.DeriveKeys([]byte("tiny"), salt, 32*1024, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	workspace := database.Workspace{ID: workspaceID, KDFVersion: 1, KDFSalt: salt, KDFMemory: 32 * 1024, KDFIterations: 1, KDFParallelism: 1, AuthPublicKey: cryptov2.EncodePublicKey(keys.PublicKey)}
	ciphertext, ciphertextHash, err := cryptov2.EncryptDocument(keys.ContentKey, workspaceID, documentID, []byte(`{"id":"v9y7fxgx"}`))
	if err != nil {
		t.Fatal(err)
	}
	invalidPayload, err := json.Marshal(legacyPromotionRequest{Username: username, Workspace: workspace, Documents: []database.Document{}})
	if err != nil {
		t.Fatal(err)
	}
	invalidResponse, err := http.Post(server.URL+"/api/v1/legacy/workspaces/"+legacyID, "application/json", bytes.NewReader(invalidPayload))
	if err != nil {
		t.Fatal(err)
	}
	invalidResponse.Body.Close()
	if invalidResponse.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid promotion status = %d", invalidResponse.StatusCode)
	}
	if _, err := store.GetWorkspace(context.Background(), workspaceID); err != database.ErrNotFound {
		t.Fatalf("invalid promotion wrote workspace: %v", err)
	}
	payload, err := json.Marshal(legacyPromotionRequest{Username: username, Workspace: workspace, Documents: []database.Document{{DocumentID: documentID, Ciphertext: ciphertext, CiphertextHash: ciphertextHash}}})
	if err != nil {
		t.Fatal(err)
	}
	promotionResponse, err := http.Post(server.URL+"/api/v1/legacy/workspaces/"+legacyID, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	promotionResponse.Body.Close()
	if promotionResponse.StatusCode != http.StatusCreated {
		t.Fatalf("promotion status = %d", promotionResponse.StatusCode)
	}
	if document, err := store.GetDocument(context.Background(), workspaceID, documentID); err != nil || document.CiphertextHash != ciphertextHash {
		t.Fatalf("promoted document = %#v err=%v", document, err)
	}
	if publication, err := store.GetPublication(context.Background(), "abcd1234"); err != nil || publication.WorkspaceID != workspaceID {
		t.Fatalf("promoted publication = %#v err=%v", publication, err)
	}
}
