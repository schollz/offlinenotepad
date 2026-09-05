package app

import (
	"encoding/json"
	"encoding/xml"
	"html/template"
	"net/http"
	"strings"
	"time"
)

const (
	homeTitle       = "Offline Notepad — Private Notes That Work Offline"
	homeDescription = "Write private encrypted notes that work offline. Offline Notepad saves locally first and securely syncs your notebook when you reconnect."
	blogTitle       = "Offline Notepad Blog — News and Release Notes"
	blogDescription = "Plainspoken notes about Offline Notepad releases, offline-first writing, browser encryption, and private note synchronization."
	howItWorksSlug  = "how-offline-notepad-works"
	howItWorksTitle = "How Offline Notepad Works: Offline, Encrypted Notes"
	howItWorksDesc  = "Learn how Offline Notepad saves encrypted notes locally, works without internet, syncs safely, and keeps passwords and plaintext out of the server."
	howPublishedAt  = "2026-09-04T00:00:00Z"
	blogPostSlug    = "offline-notepad-v2"
	blogPostTitle   = "Offline Notepad v2: Private Notes That Work Offline"
	blogPostSummary = "Offline Notepad v2 is a private encrypted notepad that saves locally, works without internet, and securely syncs when you reconnect."
	blogPublishedAt = "2026-09-05T00:00:00Z"
)

type requestNonceKey struct{}

type metaTemplateData struct {
	SiteURL              string
	PageTitle            string
	Description          string
	Keywords             string
	CanonicalURL         string
	Robots               string
	OpenGraphType        string
	SocialImageURL       string
	SocialImageSecureURL string
	SocialImageAlt       string
	PublishedAt          string
	ModifiedAt           string
	StructuredData       template.JS
	Nonce                string
}

type blogPost struct {
	Slug             string
	Title            string
	Description      string
	PublishedAt      string
	PublishedDisplay string
	ReadingTime      string
	Section          string
	Keywords         string
	Body             template.HTML
}

var howItWorksPost = blogPost{
	Slug:             howItWorksSlug,
	Title:            howItWorksTitle,
	Description:      howItWorksDesc,
	PublishedAt:      howPublishedAt,
	PublishedDisplay: "September 4, 2026",
	ReadingTime:      "5 minute read",
	Section:          "Guide",
	Keywords:         "how Offline Notepad works, offline notepad, encrypted notes, local-first notes, private notepad, open source notes app",
	Body: template.HTML(`<p>Offline Notepad is a small place to write private notes in a web browser. It works online, it keeps working when the connection drops, and it does not ask the server to hold a readable copy of your notebook.</p>
<p>You start with a notebook name and password. The same form opens a notebook that already exists or creates a new one. The notebook name identifies the encrypted workspace. Your password is used inside the browser to unlock it, but the password itself is never sent to the server.</p>
<p>On the first online visit, the browser downloads the app and caches the files it needs to open again. That makes Offline Notepad an installable web app. Once it has been loaded on a device, you can reopen the app, read cached notes, write, edit, search, and delete while the device is offline.</p>
<p>Local storage comes first. When you change a note, Offline Notepad encrypts it and saves the encrypted record to an IndexedDB database in your browser before it attempts to synchronize. Closing a tab or losing a connection does not make the app wait on a server before preserving the change.</p>
<p>When a connection is available, an outbox sends those encrypted records to the server over a WebSocket. The server acknowledges a revision before the interface says “Synced.” If it has not done that yet, the note says “Saved offline.” Reconnecting starts the queue again.</p>
<p>More than one device can open the same notebook. Revisions keep normal changes in order. If two devices make incompatible changes while disconnected, the app preserves the extra edit as a timestamped conflict copy instead of silently choosing one and losing the other.</p>
<p>The security boundary is the browser. A password is processed with Argon2id, then separate encryption and authentication keys are derived. Private notes are encrypted with XChaCha20-Poly1305. The encrypted record is also tied to its notebook and document identifiers so it cannot simply be moved somewhere else and treated as valid.</p>
<p>The server receives a public authentication key, encrypted note records, revisions, and tombstones for deleted notes. It does not receive the password, the private authentication key, or the readable content of a private note. To connect, the browser signs a fresh challenge. That proves it has the right key without handing the key to the server.</p>
<p>A saved login keeps the derived keys in this browser so the notebook can reopen offline. That is convenient on a personal device, but it also means you should log out on a shared one. There is intentionally no password recovery or key escrow. If you forget the notebook name or password and have no open device or backup, the server cannot decrypt the notes for you.</p>
<p>Public notes are different by design. Publishing creates a separate, read-only plaintext snapshot of the one note you chose. Later private edits do not change it automatically. Removing the snapshot does not remove the private note.</p>
<p>Offline Notepad is open source under the MIT license. You can read the <a href="https://github.com/schollz/offlinenotepad">source code on GitHub</a>, run it yourself as one Go binary, use SQLite for a standalone installation, or select PostgreSQL for a hosted deployment.</p>
<p>The short version is that the browser does the sensitive work, the device saves first, and the server synchronizes ciphertext. If that is the kind of notepad you want, <a href="/">open Offline Notepad</a> and create a notebook.</p>`),
}

var releasePost = blogPost{
	Slug:             blogPostSlug,
	Title:            blogPostTitle,
	Description:      blogPostSummary,
	PublishedAt:      blogPublishedAt,
	PublishedDisplay: "September 5, 2026",
	ReadingTime:      "4 minute read",
	Section:          "Release notes",
	Keywords:         "Offline Notepad v2, offline notepad, encrypted notes, private notes, offline-first app, secure note sync",
	Body: template.HTML(`<p>Offline Notepad v2 is out. It is a small, private place to write that keeps working when your internet connection does not.</p>
<p>The idea is simple: your notes should belong to you, and opening a notebook should not depend on a live server. Enter a notebook name and password to sign in. If that notebook does not exist yet, the same form creates it. There are no accounts to manage and no recovery flow pretending that someone else can unlock your private writing.</p>
<p>Every private note is encrypted in your browser. Your password, master keys, and readable note content do not go to the server. The server stores encrypted records so the same notebook can be synchronized across your devices without learning what you wrote.</p>
<p>V2 is local-first. The app saves an encrypted change to IndexedDB on your device before it tries the network. If you are on a train, lose Wi-Fi, close the tab, or come back later, the local copy is still there. Once a connection returns, queued changes are sent to the server and the status changes from “Saved offline” to “Synced” only after the server acknowledges them.</p>
<p>The website is also an installable web app. After one successful online visit, its app shell is cached so it can open without internet. You can keep writing, editing, searching, and deleting notes offline. Synchronization resumes when the browser reconnects.</p>
<p>Sync was rebuilt around encrypted records, optimistic revisions, and permanent tombstones. Those details mostly stay out of the way. What matters is that an unsent edit is not silently discarded. When two devices make incompatible offline changes, Offline Notepad keeps the extra version as a timestamped conflict copy so you can decide what to keep.</p>
<p>Public sharing remains deliberate. You can publish a read-only snapshot of one note, but later private edits do not update that snapshot automatically. A public page contains the content you chose to publish; the rest of the notebook remains encrypted and private.</p>
<p>The new version is simpler to run, too. Offline Notepad ships as one Go binary with the frontend embedded inside it. SQLite is the standalone default. A PostgreSQL database can be selected for a hosted installation. The browser-side privacy model stays the same in either case.</p>
<p>V2 also brings a clearer sign-in screen, a calmer writing interface, reliable hot reload for local development, and better support for light, dark, mobile, and reduced-motion preferences. The changes are practical. The goal is not to turn a notepad into a complicated workspace.</p>
<p>For a closer look at the local-first storage, encrypted synchronization, and browser-side security model, read <a href="/blog/how-offline-notepad-works">how Offline Notepad works</a>.</p>
<p>If you want a private online notepad that works offline and syncs without sending readable notes to the server, <a href="/">open Offline Notepad</a> and create a notebook. Just remember the password. There is intentionally no password recovery.</p>`),
}

var blogPosts = []blogPost{howItWorksPost, releasePost}

type blogTemplateData struct {
	metaTemplateData
	IsIndex bool
	Posts   []blogPost
	Post    blogPost
}

type sitemapURLSet struct {
	XMLName xml.Name     `xml:"urlset"`
	XMLNS   string       `xml:"xmlns,attr"`
	URLs    []sitemapURL `xml:"url"`
}

type sitemapURL struct {
	Location        string `xml:"loc"`
	LastModified    string `xml:"lastmod,omitempty"`
	ChangeFrequency string `xml:"changefreq,omitempty"`
	Priority        string `xml:"priority,omitempty"`
}

func requestNonce(r *http.Request) string {
	nonce, _ := r.Context().Value(requestNonceKey{}).(string)
	return nonce
}

func jsonStructuredData(value any) template.JS {
	if value == nil {
		return ""
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return template.JS(encoded)
}

func (a *App) pageMetadata(r *http.Request, path, title, description, keywords, robots, pageType, publishedAt, modifiedAt string, structuredData any) metaTemplateData {
	origin := a.origin(r)
	socialImageURL := origin + "/social-card.png"
	secureSocialImageURL := ""
	if strings.HasPrefix(socialImageURL, "https://") {
		secureSocialImageURL = socialImageURL
	}
	return metaTemplateData{
		SiteURL:              origin,
		PageTitle:            truncateSEOText(title, 70),
		Description:          truncateSEOText(description, 160),
		Keywords:             keywords,
		CanonicalURL:         origin + path,
		Robots:               robots,
		OpenGraphType:        pageType,
		SocialImageURL:       socialImageURL,
		SocialImageSecureURL: secureSocialImageURL,
		SocialImageAlt:       "Offline Notepad — private notes saved locally and synced securely",
		PublishedAt:          publishedAt,
		ModifiedAt:           modifiedAt,
		StructuredData:       jsonStructuredData(structuredData),
		Nonce:                requestNonce(r),
	}
}

func truncateSEOText(value string, maximum int) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) <= maximum {
		return value
	}
	shortened := string(runes[:maximum-1])
	if space := strings.LastIndex(shortened, " "); space > maximum*2/3 {
		shortened = shortened[:space]
	}
	return strings.TrimSpace(shortened) + "…"
}

func homeStructuredData(origin string) map[string]any {
	return map[string]any{
		"@context": "https://schema.org",
		"@graph": []any{
			map[string]any{
				"@type": "Organization", "@id": origin + "/#organization", "name": "Offline Notepad", "url": origin,
				"logo": map[string]any{"@type": "ImageObject", "url": origin + "/icon.svg"}, "sameAs": []string{"https://github.com/schollz/offlinenotepad"},
			},
			map[string]any{
				"@type": "WebSite", "@id": origin + "/#website", "name": "Offline Notepad", "url": origin,
				"description": homeDescription, "inLanguage": "en", "publisher": map[string]any{"@id": origin + "/#organization"},
			},
			map[string]any{
				"@type": "WebApplication", "@id": origin + "/#application", "name": "Offline Notepad", "url": origin,
				"description": homeDescription, "applicationCategory": "ProductivityApplication", "operatingSystem": "Any",
				"browserRequirements": "Requires a modern web browser with IndexedDB and Web Crypto support",
				"isAccessibleForFree": true,
				"offers":              map[string]any{"@type": "Offer", "price": "0", "priceCurrency": "USD"},
				"image":               origin + "/social-card.png",
				"softwareVersion":     "2",
				"sameAs":              []string{"https://github.com/schollz/offlinenotepad"},
				"featureList":         []string{"Browser-side encryption", "Offline note editing", "Encrypted synchronization", "Optional read-only public snapshots"},
				"publisher":           map[string]any{"@id": origin + "/#organization"},
			},
			map[string]any{
				"@type": "SoftwareSourceCode", "name": "Offline Notepad source code", "codeRepository": "https://github.com/schollz/offlinenotepad",
				"license": "https://opensource.org/license/mit", "programmingLanguage": []string{"Go", "TypeScript"},
				"targetProduct": map[string]any{"@id": origin + "/#application"},
			},
		},
	}
}

func blogIndexStructuredData(origin string) map[string]any {
	blogURL := origin + "/blog"
	postReferences := make([]any, 0, len(blogPosts))
	for _, post := range blogPosts {
		postReferences = append(postReferences, map[string]any{"@id": origin + "/blog/" + post.Slug + "#article"})
	}
	return map[string]any{
		"@context": "https://schema.org",
		"@graph": []any{
			map[string]any{
				"@type": "Blog", "@id": blogURL + "#blog", "name": "Offline Notepad Blog", "url": blogURL,
				"description": blogDescription, "inLanguage": "en", "publisher": map[string]any{"@type": "Organization", "name": "Offline Notepad", "url": origin}, "blogPost": postReferences,
			},
			map[string]any{
				"@type": "CollectionPage", "@id": blogURL + "#webpage", "name": blogTitle, "url": blogURL,
				"description": blogDescription, "isPartOf": map[string]any{"@id": origin + "/#website"}, "mainEntity": map[string]any{"@id": blogURL + "#blog"}, "hasPart": postReferences,
			},
		},
	}
}

func blogPostStructuredData(origin string, post blogPost) map[string]any {
	articleURL := origin + "/blog/" + post.Slug
	return map[string]any{
		"@context": "https://schema.org",
		"@graph": []any{
			map[string]any{
				"@type": "BlogPosting", "@id": articleURL + "#article", "headline": post.Title, "description": post.Description,
				"url": articleURL, "datePublished": post.PublishedAt, "dateModified": post.PublishedAt, "inLanguage": "en",
				"articleSection": post.Section, "keywords": post.Keywords,
				"mainEntityOfPage": map[string]any{"@type": "WebPage", "@id": articleURL},
				"author":           map[string]any{"@type": "Organization", "name": "Offline Notepad", "url": origin},
				"publisher":        map[string]any{"@type": "Organization", "name": "Offline Notepad", "url": origin},
				"image":            map[string]any{"@type": "ImageObject", "url": origin + "/social-card.png", "width": 1200, "height": 630},
			},
			map[string]any{
				"@type": "BreadcrumbList", "itemListElement": []any{
					map[string]any{"@type": "ListItem", "position": 1, "name": "Home", "item": origin + "/"},
					map[string]any{"@type": "ListItem", "position": 2, "name": "Blog", "item": origin + "/blog"},
					map[string]any{"@type": "ListItem", "position": 3, "name": post.Title, "item": articleURL},
				},
			},
		},
	}
}

func publicStructuredData(origin, canonical, title, description, modifiedAt string) map[string]any {
	document := map[string]any{
		"@type": "DigitalDocument", "@id": canonical + "#document", "name": title, "headline": title,
		"description": description, "url": canonical, "inLanguage": "en", "isPartOf": map[string]any{"@id": origin + "/#website"},
		"publisher": map[string]any{"@type": "Organization", "name": "Offline Notepad", "url": origin},
	}
	if modifiedAt != "" {
		document["dateModified"] = modifiedAt
	}
	return map[string]any{"@context": "https://schema.org", "@type": "WebPage", "@id": canonical, "url": canonical, "name": title, "mainEntity": document}
}

func (a *App) handleBlogIndex(w http.ResponseWriter, r *http.Request) {
	meta := a.pageMetadata(r, "/blog", blogTitle, blogDescription,
		"offline notepad blog, encrypted notes, offline-first notes, private notepad, release notes",
		"index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1", "website", "", "", blogIndexStructuredData(a.origin(r)))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	if err := a.blog.Execute(w, blogTemplateData{metaTemplateData: meta, IsIndex: true, Posts: blogPosts}); err != nil {
		a.logger.Error("render blog", "error", err)
	}
}

func (a *App) handleBlogPost(w http.ResponseWriter, r *http.Request) {
	post, found := findBlogPost(r.PathValue("slug"))
	if !found {
		http.NotFound(w, r)
		return
	}
	path := "/blog/" + post.Slug
	meta := a.pageMetadata(r, path, post.Title, post.Description, post.Keywords,
		"index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1", "article", post.PublishedAt, post.PublishedAt,
		blogPostStructuredData(a.origin(r), post))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	if err := a.blog.Execute(w, blogTemplateData{metaTemplateData: meta, Post: post}); err != nil {
		a.logger.Error("render blog post", "error", err)
	}
}

func findBlogPost(slug string) (blogPost, bool) {
	for _, post := range blogPosts {
		if post.Slug == slug {
			return post, true
		}
	}
	return blogPost{}, false
}

func (a *App) handleBlogSlash(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/blog/" {
		http.Redirect(w, r, "/blog", http.StatusPermanentRedirect)
		return
	}
	http.NotFound(w, r)
}

func (a *App) handleRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = strings.NewReader("User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nDisallow: /ws\nDisallow: /healthz\nDisallow: /*/raw\n\nSitemap: " + a.origin(r) + "/sitemap.xml\n").WriteTo(w)
}

func (a *App) handleSitemap(w http.ResponseWriter, r *http.Request) {
	origin := a.origin(r)
	urls := []sitemapURL{
		{Location: origin + "/", ChangeFrequency: "weekly", Priority: "1.0"},
		{Location: origin + "/blog", ChangeFrequency: "weekly", Priority: "0.8"},
	}
	for _, post := range blogPosts {
		urls = append(urls, sitemapURL{Location: origin + "/blog/" + post.Slug, LastModified: post.PublishedAt, ChangeFrequency: "monthly", Priority: "0.7"})
	}
	publications, err := a.store.ListSitemapPublications(r.Context(), 50_000-len(urls))
	if err != nil {
		http.Error(w, "database unavailable", http.StatusInternalServerError)
		return
	}
	for _, publication := range publications {
		path := ""
		switch {
		case legacyPublicPattern.MatchString(publication.PublicID):
			path = "/" + publication.PublicID
		case publicIDPattern.MatchString(publication.PublicID):
			path = "/p/" + publication.PublicID
		default:
			continue
		}
		lastModified := ""
		if !publication.UpdatedAt.IsZero() {
			lastModified = publication.UpdatedAt.UTC().Format(time.RFC3339)
		}
		urls = append(urls, sitemapURL{Location: origin + path, LastModified: lastModified, ChangeFrequency: "weekly", Priority: "0.5"})
	}
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(xml.Header))
	encoder := xml.NewEncoder(w)
	encoder.Indent("", "  ")
	if err := encoder.Encode(sitemapURLSet{XMLNS: "http://www.sitemaps.org/schemas/sitemap/0.9", URLs: urls}); err != nil {
		a.logger.Error("render sitemap", "error", err)
	}
}

func publicationDescription(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return "Read a public, read-only note shared with Offline Notepad."
	}
	return "Read “" + title + "”, a public, read-only note shared with Offline Notepad."
}
