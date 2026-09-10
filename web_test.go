package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func testServer(t *testing.T) *server {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.db.Close() })
	return s
}

func TestEmbeddedFrontend(t *testing.T) {
	s := testServer(t)
	for _, test := range []struct {
		path, mime, cache string
		status            int
	}{
		{"/", "text/html", "no-cache", 200},
		{"/my-note", "text/html", "no-cache", 200},
		{"/sw.js", "javascript", "no-cache", 200},
		{"/favicon.ico", "image/", "no-cache", 200},
		{"/static/manifest.json", "application/json", "no-cache", 200},
		{"/assets/missing.js", "text/plain", "", 404},
		{"/static/missing.css", "text/plain", "", 404},
	} {
		t.Run(test.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.handler(w, httptest.NewRequest(http.MethodGet, test.path, nil))
			if w.Code != test.status || !strings.Contains(w.Header().Get("Content-Type"), test.mime) {
				t.Fatalf("unexpected response: %d %v", w.Code, w.Header())
			}
			if w.Header().Get("Cache-Control") != test.cache {
				t.Fatal(w.Header())
			}
		})
	}
	index, _ := frontend.ReadFile("frontend/dist/index.html")
	asset := regexp.MustCompile(`src="(/assets/[^\"]+\.js)"`).FindSubmatch(index)
	if len(asset) != 2 {
		t.Fatal("Vite script missing")
	}
	w := httptest.NewRecorder()
	s.handler(w, httptest.NewRequest(http.MethodHead, string(asset[1]), nil))
	if w.Code != 200 || w.Body.Len() != 0 || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatal("invalid asset HEAD response", w)
	}
	worker, _ := frontend.ReadFile("frontend/dist/sw.js")
	if !strings.Contains(string(worker), string(asset[1])) || strings.Contains(string(worker), "__PRECACHE_URLS__") {
		t.Fatal("worker does not precache built assets")
	}
}

func TestPublishedReactPageAndRawDocument(t *testing.T) {
	s := testServer(t)
	doc := Document{ID: "12345678", Title: `A <title>`, HTML: `<p>Public content</p>`, Markdown: "</script><script>alert('test')</script>"}
	data, _ := json.Marshal(doc)
	if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket([]byte("published")).Put([]byte(doc.ID), data) }); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handler(w, httptest.NewRequest(http.MethodGet, "/12345678", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `id="app-data"`) || !strings.Contains(w.Body.String(), "A &lt;title&gt;") {
		t.Fatal(w.Body.String())
	}
	if strings.Contains(w.Body.String(), doc.Markdown) {
		t.Fatal("bootstrap data must escape closing script tags")
	}
	w = httptest.NewRecorder()
	s.handler(w, httptest.NewRequest(http.MethodGet, "/12345678/raw", nil))
	if w.Body.String() != doc.Markdown || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
		t.Fatal(w)
	}
	w = httptest.NewRecorder()
	s.handler(w, httptest.NewRequest(http.MethodGet, "/api/published/12345678", nil))
	var got Document
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got != doc {
		t.Fatal("published API mismatch", err)
	}
}
