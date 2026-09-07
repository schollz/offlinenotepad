package app

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/schollz/offlinenotepad/internal/database"
)

// This policy must be a response header: an iframe attribute alone does not
// protect someone who visits its URL directly. Never grant allow-same-origin.
const executablePublicationCSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https:; form-action https:; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'self'"

func (a *App) handleExecutablePublication(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet")
	if !publicIDPattern.MatchString(id) && !legacyPublicPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	// Staged legacy snapshots have no executable opt-in. Only an authenticated
	// owner's explicit publication can create an executable response.
	p, err := a.store.GetPublication(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) || (err == nil && p.RenderMode != "html" && p.RenderMode != "markdown-html") {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "database unavailable", http.StatusInternalServerError)
		return
	}
	content := p.Content
	if p.RenderMode == "markdown-html" {
		var rendered strings.Builder
		if err := a.interactiveMarkdown.Convert([]byte(content), &rendered); err != nil {
			http.Error(w, "could not render note", http.StatusInternalServerError)
			return
		}
		content = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>" + rendered.String() + "</body></html>"
	}
	w.Header().Set("Content-Security-Policy", executablePublicationCSP)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, content)
}
