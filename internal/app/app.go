package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/schollz/offlinenotepad/internal/cryptov2"
	"github.com/schollz/offlinenotepad/internal/database"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
)

const (
	maxJSONBody            = 128 << 10
	maxLegacyPromotionBody = 128 << 20
	maxLegacyPromotionDocs = 100_000
	maxLegacyDocumentBody  = 8 << 20
	maxPublishedBody       = 1 << 20
)

var (
	encoded32Pattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	documentIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	legacyDocumentPattern = regexp.MustCompile(`^[a-z0-9]{8}$`)
	legacyPublicPattern   = regexp.MustCompile(`^[a-f0-9]{8}$`)
	publicIDPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
)

type Config struct {
	SiteURL                string
	AllowedOrigins         []string
	LegacyMigrationEnabled bool
	UmamiURL               string
	UmamiWebsiteID         string
}

type App struct {
	store     *database.Store
	logger    *slog.Logger
	content   fs.FS
	index     *template.Template
	about     *template.Template
	contact   *template.Template
	public    *template.Template
	blog      *template.Template
	markdown  goldmark.Markdown
	sanitizer *bluemonday.Policy
	hub       *hub
	config    Config
	analytics *analyticsRelay
}

func New(store *database.Store, content fs.FS, logger *slog.Logger, config Config) (*App, error) {
	if config.SiteURL != "" {
		origin, err := parseOrigin(config.SiteURL)
		if err != nil {
			return nil, fmt.Errorf("site URL: %w", err)
		}
		config.SiteURL = origin
	}
	for i, value := range config.AllowedOrigins {
		origin, err := parseOrigin(value)
		if err != nil {
			return nil, fmt.Errorf("allowed origin %q: %w", value, err)
		}
		config.AllowedOrigins[i] = origin
	}
	index, err := template.ParseFS(content, "index.html")
	if err != nil {
		return nil, fmt.Errorf("parse app template: %w", err)
	}
	about, err := template.ParseFS(content, "about.html")
	if err != nil {
		return nil, fmt.Errorf("parse about template: %w", err)
	}
	contact, err := template.ParseFS(content, "contact.html")
	if err != nil {
		return nil, fmt.Errorf("parse contact template: %w", err)
	}
	public, err := template.ParseFS(content, "public.html")
	if err != nil {
		return nil, fmt.Errorf("parse public template: %w", err)
	}
	blog, err := template.ParseFS(content, "blog.html")
	if err != nil {
		return nil, fmt.Errorf("parse blog template: %w", err)
	}
	analytics := newAnalyticsRelay(config.UmamiURL, config.UmamiWebsiteID, logger)
	return &App{store: store, logger: logger, content: content, index: index, about: about, contact: contact, public: public, blog: blog, markdown: goldmark.New(goldmark.WithExtensions(extension.GFM)), sanitizer: bluemonday.UGCPolicy(), hub: newHub(), config: config, analytics: analytics}, nil
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /static/", http.FileServer(http.FS(a.content)))
	mux.Handle("GET /assets/", http.FileServer(http.FS(a.content)))
	mux.Handle("GET /fonts/", http.FileServer(http.FS(a.content)))
	mux.Handle("GET /manifest.webmanifest", http.FileServer(http.FS(a.content)))
	mux.Handle("GET /sw.js", http.FileServer(http.FS(a.content)))
	mux.HandleFunc("GET /healthz", a.handleHealth)
	mux.HandleFunc("GET /robots.txt", a.handleRobots)
	mux.HandleFunc("GET /sitemap.xml", a.handleSitemap)
	mux.HandleFunc("GET /about", a.handleAbout)
	mux.HandleFunc("GET /about/", a.handleAboutSlash)
	mux.HandleFunc("GET /contact", a.handleContact)
	mux.HandleFunc("GET /contact/", a.handleContactSlash)
	mux.HandleFunc("GET /blog", a.handleBlogIndex)
	mux.HandleFunc("GET /blog/{slug}", a.handleBlogPost)
	mux.HandleFunc("GET /blog/", a.handleBlogSlash)
	mux.HandleFunc("GET /api/v1/workspaces/{id}", a.handleGetWorkspace)
	mux.HandleFunc("POST /api/v1/workspaces", a.handleCreateWorkspace)
	mux.HandleFunc("POST /api/v1/analytics", a.handleAnalytics)
	if a.config.LegacyMigrationEnabled {
		mux.HandleFunc("GET /api/v1/legacy/workspaces/{id}", a.handleGetLegacyWorkspace)
		mux.HandleFunc("POST /api/v1/legacy/workspaces/{id}", a.handlePromoteLegacyWorkspace)
	}
	mux.HandleFunc("GET /p/{id}", a.handleNewPublication)
	mux.HandleFunc("GET /p/{id}/raw", a.handleNewPublicationRaw)
	mux.HandleFunc("GET /ws", a.handleWebsocket)
	mux.HandleFunc("/", a.handleFallback)
	return a.middleware(mux)
}

func (a *App) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		defer func() {
			if recovered := recover(); recovered != nil {
				a.logger.Error("request panic", "error", recovered, "path", r.URL.Path)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		nonce, err := randomID(18)
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), requestNonceKey{}, nonce))
		scriptSources := "'self' 'nonce-" + nonce + "'"
		connectSources := "'self' ws: wss:"
		formActionSources := "'self'"
		styleAttributeSources := "'none'"
		if r.URL.Path == "/contact" || r.URL.Path == "/contact/" {
			scriptSources += " https://subsnail.schollz.com"
			connectSources += " https://subsnail.schollz.com"
			formActionSources += " https://subsnail.schollz.com"
			styleAttributeSources = "'unsafe-inline'"
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src "+scriptSources+"; style-src 'self'; style-src-attr "+styleAttributeSources+"; img-src 'self' data:; connect-src "+connectSources+"; font-src 'self'; object-src 'none'; base-uri 'self'; form-action "+formActionSources+"; frame-ancestors 'none'")
		if strings.HasPrefix(a.origin(r), "https://") {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
		a.logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
	})
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.store.Ping(ctx); err != nil {
		http.Error(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, "ok\n")
}

type appTemplateData struct {
	metaTemplateData
	IsHomepage bool
}

func (a *App) renderApp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	isHomepage := r.URL.Path == "/" || r.URL.Path == "/index.html"
	meta := a.pageMetadata(r, "/", homeTitle, homeDescription,
		"offline notepad, private notes, encrypted notes, offline notes, secure notepad, local-first notes",
		"index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1", "website", "", "", homeStructuredData(a.origin(r)))
	if !isHomepage {
		meta = a.pageMetadata(r, "/app", "Notebook · Offline Notepad", "Open your private Offline Notepad notebook.", "", "noindex, nofollow, noarchive", "website", "", "", nil)
	}
	if err := a.index.Execute(w, appTemplateData{metaTemplateData: meta, IsHomepage: isHomepage}); err != nil {
		a.logger.Error("render app", "error", err)
	}
}

func (a *App) handleFallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.Trim(r.URL.Path, "/")
	if path != "index.html" && path != "public.html" && !strings.Contains(path, "/") {
		if info, err := fs.Stat(a.content, path); err == nil && info.Mode().IsRegular() {
			http.FileServer(http.FS(a.content)).ServeHTTP(w, r)
			return
		}
	}
	if path == "" || path == "index.html" || path == "app" || strings.HasPrefix(path, "app/notes/") {
		a.renderApp(w, r)
		return
	}
	if legacyPublicPattern.MatchString(path) {
		a.renderPublication(w, r, path, false)
		return
	}
	if strings.HasSuffix(path, "/raw") {
		id := strings.TrimSuffix(path, "/raw")
		if legacyPublicPattern.MatchString(id) {
			a.renderPublication(w, r, id, true)
			return
		}
	}
	http.NotFound(w, r)
}

func (a *App) handleNewPublication(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !publicIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	a.renderPublication(w, r, id, false)
}
func (a *App) handleNewPublicationRaw(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !publicIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	a.renderPublication(w, r, id, true)
}

type publicTemplateData struct {
	metaTemplateData
	Title        string
	Content      template.HTML
	RawURL       string
	CanonicalURL string
	Plaintext    bool
}

func (a *App) renderPublication(w http.ResponseWriter, r *http.Request, id string, raw bool) {
	p, err := a.store.GetPublication(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) && legacyPublicPattern.MatchString(id) {
		legacyPublication, legacyErr := a.store.GetLegacyPublication(r.Context(), id)
		if legacyErr == nil {
			p = database.Publication{PublicID: legacyPublication.PublicID, Title: legacyPublication.Title, Content: legacyPublication.Content, ContentMode: legacyPublication.ContentMode, Legacy: true, UpdatedAt: legacyPublication.ImportedAt}
			err = nil
		} else {
			err = legacyErr
		}
	}
	if errors.Is(err, database.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "database unavailable", http.StatusInternalServerError)
		return
	}
	if raw {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		io.WriteString(w, p.Content)
		return
	}
	var rendered strings.Builder
	if p.ContentMode == "plaintext" {
		rendered.WriteString("<pre>")
		template.HTMLEscape(&rendered, []byte(p.Content))
		rendered.WriteString("</pre>")
	} else if err := a.markdown.Convert([]byte(p.Content), &rendered); err != nil {
		http.Error(w, "could not render note", http.StatusInternalServerError)
		return
	}
	safe := a.sanitizer.Sanitize(rendered.String())
	canonical := a.origin(r) + r.URL.Path
	modifiedAt := ""
	if !p.UpdatedAt.IsZero() {
		modifiedAt = p.UpdatedAt.UTC().Format(time.RFC3339)
	}
	description := publicationDescription(p.Title)
	meta := a.pageMetadata(r, r.URL.Path, strings.TrimSpace(p.Title)+" · Offline Notepad", description,
		"public note, shared note, Offline Notepad", "index, follow, max-image-preview:large, max-snippet:-1", "article", "", modifiedAt,
		publicStructuredData(a.origin(r), canonical, p.Title, description, modifiedAt))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60")
	if err := a.public.Execute(w, publicTemplateData{metaTemplateData: meta, Title: p.Title, Content: template.HTML(safe), RawURL: r.URL.Path + "/raw", CanonicalURL: canonical, Plaintext: p.ContentMode == "plaintext"}); err != nil {
		a.logger.Error("render publication", "error", err)
	}
}

func (a *App) handleGetLegacyWorkspace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !legacyPublicPattern.MatchString(id) {
		writeJSONError(w, http.StatusBadRequest, "invalid legacy workspace id")
		return
	}
	workspace, err := a.store.GetLegacyWorkspace(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "legacy workspace not found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, workspace)
}

type legacyPromotionRequest struct {
	Username             string              `json:"username"`
	Workspace            database.Workspace  `json:"workspace"`
	Documents            []database.Document `json:"documents"`
	RejectedDocumentIDs  []string            `json:"rejected_document_ids"`
	DiscardedDocumentIDs []string            `json:"discarded_document_ids"`
}

func (a *App) handlePromoteLegacyWorkspace(w http.ResponseWriter, r *http.Request) {
	legacyID := r.PathValue("id")
	if !legacyPublicPattern.MatchString(legacyID) {
		writeJSONError(w, http.StatusBadRequest, "invalid legacy workspace id")
		return
	}
	var request legacyPromotionRequest
	if err := decodeJSON(w, r, &request, maxLegacyPromotionBody); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(request.Username) == "" || len(request.Username) > 200 || legacyWorkspaceID(request.Username) != legacyID {
		writeJSONError(w, http.StatusBadRequest, "legacy username does not match workspace")
		return
	}
	workspaceID, err := cryptov2.WorkspaceID(request.Username)
	if err != nil || request.Workspace.ID != workspaceID || !validWorkspace(request.Workspace) {
		writeJSONError(w, http.StatusBadRequest, "invalid migrated workspace")
		return
	}
	if len(request.Documents)+len(request.RejectedDocumentIDs)+len(request.DiscardedDocumentIDs) > maxLegacyPromotionDocs {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "too many legacy documents")
		return
	}
	for i := range request.Documents {
		document := &request.Documents[i]
		if !legacyDocumentPattern.MatchString(document.DocumentID) || document.Deleted || len(document.Ciphertext) == 0 || len(document.Ciphertext) > maxLegacyDocumentBody || !validCiphertextHash(document.Ciphertext, document.CiphertextHash) {
			writeJSONError(w, http.StatusBadRequest, "invalid migrated document")
			return
		}
		document.WorkspaceID = workspaceID
	}
	for _, documentID := range request.RejectedDocumentIDs {
		if !legacyDocumentPattern.MatchString(documentID) {
			writeJSONError(w, http.StatusBadRequest, "invalid rejected legacy document")
			return
		}
	}
	for _, documentID := range request.DiscardedDocumentIDs {
		if !legacyDocumentPattern.MatchString(documentID) {
			writeJSONError(w, http.StatusBadRequest, "invalid discarded legacy document")
			return
		}
	}
	result, err := a.store.PromoteLegacyWorkspace(r.Context(), legacyID, request.Workspace, request.Documents, request.RejectedDocumentIDs, request.DiscardedDocumentIDs)
	if errors.Is(err, database.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "legacy workspace not found")
		return
	}
	if errors.Is(err, database.ErrExists) {
		writeJSONError(w, http.StatusConflict, "legacy workspace was already migrated")
		return
	}
	if errors.Is(err, database.ErrInvalid) {
		writeJSONError(w, http.StatusBadRequest, "legacy document manifest does not match")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "legacy migration failed")
		return
	}
	a.logger.Info("legacy workspace migration complete",
		"documents_imported", result.DocumentsImported,
		"documents_skipped", result.DocumentsSkipped,
		"documents_rejected", len(request.RejectedDocumentIDs),
		"documents_skipped_deleted", len(request.DiscardedDocumentIDs),
		"publications_imported", result.PublicationsImported,
		"publications_skipped", result.PublicationsSkipped,
	)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, result)
}

func legacyWorkspaceID(username string) string {
	sum := sha256.Sum256([]byte("offlinenotepad" + username))
	return hex.EncodeToString(sum[:])[:8]
}

func validCiphertextHash(ciphertext, encodedHash string) bool {
	if !isRawBase64(encodedHash, sha256.Size) {
		return false
	}
	sum := sha256.Sum256([]byte(ciphertext))
	return base64.RawURLEncoding.EncodeToString(sum[:]) == encodedHash
}

func (a *App) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !encoded32Pattern.MatchString(id) {
		writeJSONError(w, http.StatusBadRequest, "invalid workspace id")
		return
	}
	workspace, err := a.store.GetWorkspace(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "workspace not found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, workspace)
}

func (a *App) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var workspace database.Workspace
	if err := decodeJSON(w, r, &workspace, maxJSONBody); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !validWorkspace(workspace) {
		writeJSONError(w, http.StatusBadRequest, "invalid workspace registration")
		return
	}
	created, err := a.store.CreateWorkspace(r.Context(), workspace)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database unavailable")
		return
	}
	if !created {
		writeJSONError(w, http.StatusConflict, "workspace already exists")
		return
	}
	writeJSON(w, http.StatusCreated, workspace)
}

func validWorkspace(w database.Workspace) bool {
	return encoded32Pattern.MatchString(w.ID) && encoded32Pattern.MatchString(w.AuthPublicKey) && isRawBase64(w.KDFSalt, 16) && w.KDFVersion == 1 && w.KDFMemory >= 32768 && w.KDFMemory <= 262144 && w.KDFIterations >= 1 && w.KDFIterations <= 10 && w.KDFParallelism >= 1 && w.KDFParallelism <= 4
}
func isRawBase64(value string, size int) bool {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) == size && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, max int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return errors.New("request must contain valid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON value")
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (a *App) origin(r *http.Request) string {
	if configured := strings.TrimRight(a.config.SiteURL, "/"); configured != "" {
		return configured
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
func randomID(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
func parseOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("invalid origin")
	}
	return u.Scheme + "://" + u.Host, nil
}
