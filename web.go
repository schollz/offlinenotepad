package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"html"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// Build with go generate before go build. Only Vite's production output is embedded.
//
//go:embed frontend/dist
var frontend embed.FS

func serveFrontend(w http.ResponseWriter, r *http.Request, doc *Document) error {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "sw.js" {
		w.Header().Set("Service-Worker-Allowed", "/")
	}
	if name == "static/images/favicon.ico" {
		name = "favicon.ico"
	}
	asset := strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "static/") ||
		name == "sw.js" || name == "favicon.ico"
	if !asset || doc != nil {
		name = "index.html"
	}
	data, err := frontend.ReadFile("frontend/dist/" + name)
	if err != nil {
		http.NotFound(w, r)
		return nil
	}
	if name == "index.html" && doc != nil {
		payload, err := json.Marshal(doc)
		if err != nil {
			return err
		}
		// JSON marshaling escapes HTML delimiters, including closing script tags in notes.
		bootstrap := append([]byte(`<script id="app-data" type="application/json">`), payload...)
		bootstrap = append(bootstrap, []byte(`</script>`)...)
		data = bytes.Replace(data, []byte("<!--app-data-->"), bootstrap, 1)
		data = bytes.Replace(data, []byte("<title>Offline Notepad</title>"), []byte("<title>"+html.EscapeString(doc.Title)+"</title>"), 1)
	}
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if kind := mime.TypeByExtension(path.Ext(name)); kind != "" {
		w.Header().Set("Content-Type", kind)
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	return nil
}
