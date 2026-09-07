package app

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/coder/websocket/wsjson"
	"github.com/schollz/offlinenotepad/internal/database"
)

func TestPublishProtocolFormats(t *testing.T) {
	store, server := testServer(t)
	workspace, keys := createTestWorkspace(t, store)
	_, err := store.PutDocument(context.Background(), database.Document{WorkspaceID: workspace.ID, DocumentID: "format-note-1234", Ciphertext: "encrypted", CiphertextHash: "hash"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	conn, ctx, cancel := authenticatedConnection(t, server, workspace, keys)
	defer cancel()
	defer conn.CloseNow()
	for _, mode := range []string{"", "html", "markdown-html", "document", "unsupported"} {
		request := socketMessage{Type: messagePublish, DocumentID: "format-note-1234", PublicID: "publication-formats-1234", ContentMode: "markdown", RenderMode: mode, Title: "Format test", Content: "<script>example()</script>"}
		if err := wsjson.Write(ctx, conn, request); err != nil {
			t.Fatal(err)
		}
		var response socketMessage
		if err := wsjson.Read(ctx, conn, &response); err != nil {
			t.Fatal(err)
		}
		if mode == "unsupported" {
			if response.Type != messageError {
				t.Fatal("unsupported format accepted")
			}
		} else {
			if mode == "" {
				mode = "document"
			}
			if response.Type != messageAck || response.Publication == nil || response.Publication.RenderMode != mode {
				t.Fatalf("incorrect publication acknowledgment for %s", mode)
			}
		}
	}
}

func TestExecutablePublicationsRequireOptInAndRemainSandboxed(t *testing.T) {
	for _, id := range []string{"interactive-note-1234", "abcd1234"} {
		t.Run(id, func(t *testing.T) {
			store, server := testServer(t)
			workspace, _ := createTestWorkspace(t, store)
			ctx := context.Background()
			_, err := store.PutDocument(ctx, database.Document{WorkspaceID: workspace.ID, DocumentID: "html-note-1234", Ciphertext: "encrypted", CiphertextHash: "hash"}, 0)
			if err != nil {
				t.Fatal(err)
			}
			source := "<style>button { color: red }</style><button onclick=\"this.textContent='working'\">Run</button><script>window.example = 1</script>"
			p := database.Publication{PublicID: id, WorkspaceID: workspace.ID, DocumentID: "html-note-1234", Title: "<script>unsafe title</script>", Content: source, ContentMode: "plaintext"}
			get := func(path string) (*http.Response, string) {
				t.Helper()
				response, err := http.Get(server.URL + path)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, _ := io.ReadAll(response.Body)
				return response, string(body)
			}
			if err := store.PutPublication(ctx, p); err != nil {
				t.Fatal(err)
			}
			path := "/p/" + id
			if len(id) == 8 {
				path = "/" + id
			}
			response, _ := get("/p/" + id + "/render")
			if response.StatusCode != http.StatusNotFound {
				t.Fatal("ordinary publication became executable")
			}
			for _, mode := range []string{"html", "markdown-html"} {
				p.RenderMode = mode
				p.Content = source
				if mode == "markdown-html" {
					p.Content = "# Mixed note\n\n" + source + "\n\n```html\n<script>fenced()</script>\n```"
				}
				if err := store.PutPublication(ctx, p); err != nil {
					t.Fatal(err)
				}
				outer, body := get(path)
				if !strings.Contains(body, `sandbox="allow-scripts allow-forms"`) || strings.Contains(body, source) || strings.Contains(body, "<script>unsafe title") {
					t.Fatal("executable content escaped the frame")
				}
				if outer.Header.Get("Cache-Control") != "no-store" || strings.Contains(outer.Header.Get("Content-Security-Policy"), "script-src 'unsafe-inline'") {
					t.Fatal("outer response policy weakened")
				}
				response, body = get("/p/" + id + "/render")
				if response.StatusCode != http.StatusOK || response.Header.Get("Content-Security-Policy") != executablePublicationCSP || response.Header.Get("Cache-Control") != "no-store" {
					t.Fatal("missing executable response protection")
				}
				if !strings.Contains(body, source) {
					t.Fatal("HTML was altered")
				}
				if mode == "html" && body != source {
					t.Fatal("HTML source changed")
				}
				if mode == "markdown-html" && (!strings.Contains(body, "<h1>Mixed note</h1>") || strings.Contains(body, "<script>fenced()")) {
					t.Fatal("incorrect mixed Markdown rendering")
				}
				raw, rawBody := get(path + "/raw")
				if raw.Header.Get("Content-Type") != "text/plain; charset=utf-8" || rawBody != p.Content {
					t.Fatal("raw source changed")
				}
			}
			if _, err := store.DeletePublication(ctx, workspace.ID, p.DocumentID); err != nil {
				t.Fatal(err)
			}
			response, _ = get("/p/" + id + "/render")
			if response.StatusCode != http.StatusNotFound {
				t.Fatal("unpublished executable still available")
			}
		})
	}
}
