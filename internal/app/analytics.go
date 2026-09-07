package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	maxAnalyticsBody        = 4 << 10
	maxAnalyticsResponse    = 8 << 10
	maxAnalyticsConcurrency = 8
	analyticsTimeout        = 2 * time.Second
)

var (
	umamiWebsiteIDPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
	analyticsLanguagePattern = regexp.MustCompile(`^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$`)
	analyticsScreenPattern   = regexp.MustCompile(`^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$`)
	analyticsCachePattern    = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
)

type analyticsRelay struct {
	endpoint  string
	websiteID string
	client    *http.Client
	slots     chan struct{}
	logger    *slog.Logger
}

type analyticsSubmission struct {
	Kind     string `json:"kind"`
	Page     string `json:"page"`
	Event    string `json:"event,omitempty"`
	Outcome  string `json:"outcome,omitempty"`
	Variant  string `json:"variant,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Language string `json:"language,omitempty"`
	Screen   string `json:"screen,omitempty"`
	Referrer string `json:"referrer,omitempty"`
	Cache    string `json:"cache,omitempty"`
}

type analyticsPage struct {
	URL   string
	Title string
}

var analyticsPages = map[string]analyticsPage{
	"landing":                {URL: "/", Title: "Offline Notepad"},
	"notebook":               {URL: "/app", Title: "Notebook · Offline Notepad"},
	"note":                   {URL: "/app/notes/:id", Title: "Note · Offline Notepad"},
	"public-snapshot":        {URL: "/p/:id", Title: "Public snapshot · Offline Notepad"},
	"legacy-public-snapshot": {URL: "/:legacy-id", Title: "Public snapshot · Offline Notepad"},
}

type analyticsEventRule struct {
	variants map[string]bool
	reasons  map[string]bool
}

func analyticsValues(values ...string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

var analyticsEventRules = map[string]analyticsEventRule{
	"notebook-create": {
		reasons: analyticsValues("validation", "already-exists", "server", "crypto", "unknown"),
	},
	"notebook-unlock": {
		reasons: analyticsValues("validation", "not-found", "incorrect-password", "offline-unavailable", "server", "crypto", "unknown"),
	},
	"note-create": {
		reasons: analyticsValues("local-storage", "unknown"),
	},
	"note-delete": {
		reasons: analyticsValues("local-storage", "unknown"),
	},
	"snapshot-publish": {
		variants: analyticsValues("create", "update"),
		reasons:  analyticsValues("offline-unavailable", "server", "unknown"),
	},
	"snapshot-unpublish": {
		reasons: analyticsValues("offline-unavailable", "server", "unknown"),
	},
	"archive-export": {
		variants: analyticsValues("encrypted", "plaintext"),
		reasons:  analyticsValues("local-storage", "unknown"),
	},
	"archive-import": {
		variants: analyticsValues("encrypted", "plaintext", "legacy"),
		reasons:  analyticsValues("validation", "crypto", "local-storage", "unknown"),
	},
	"password-rotate": {
		reasons: analyticsValues("offline-unavailable", "validation", "server", "crypto", "local-storage", "unknown"),
	},
}

type umamiEnvelope struct {
	Type    string       `json:"type"`
	Payload umamiPayload `json:"payload"`
}

type umamiPayload struct {
	Website  string            `json:"website"`
	Hostname string            `json:"hostname"`
	Language string            `json:"language,omitempty"`
	Referrer string            `json:"referrer,omitempty"`
	Screen   string            `json:"screen,omitempty"`
	Title    string            `json:"title"`
	URL      string            `json:"url"`
	Name     string            `json:"name,omitempty"`
	Data     map[string]string `json:"data,omitempty"`
}

type umamiResponse struct {
	Cache string `json:"cache"`
}

func newAnalyticsRelay(rawURL, rawWebsiteID string, logger *slog.Logger) *analyticsRelay {
	configuredURL := strings.TrimSpace(rawURL)
	websiteID := strings.TrimSpace(rawWebsiteID)
	if configuredURL == "" && websiteID == "" {
		logger.Warn("Umami analytics disabled because its configuration is incomplete or invalid")
		return nil
	}
	parsed, err := url.Parse(configuredURL)
	if err != nil ||
		(!strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https")) ||
		parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		(parsed.RawPath != "" && parsed.RawPath != "/") ||
		parsed.ForceQuery || parsed.RawQuery != "" || parsed.Fragment != "" ||
		!umamiWebsiteIDPattern.MatchString(websiteID) {
		logger.Warn("Umami analytics disabled because its configuration is incomplete or invalid")
		return nil
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	return &analyticsRelay{
		endpoint:  parsed.Scheme + "://" + parsed.Host + "/api/send",
		websiteID: websiteID,
		client:    &http.Client{Timeout: analyticsTimeout},
		slots:     make(chan struct{}, maxAnalyticsConcurrency),
		logger:    logger,
	}
}

func (a *App) handleAnalytics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.analyticsOriginAllowed(r) {
		http.Error(w, "analytics origin denied", http.StatusForbidden)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	var submission analyticsSubmission
	if err := decodeJSON(w, r, &submission, maxAnalyticsBody); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	page, data, ok := validateAnalyticsSubmission(submission)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "invalid analytics event")
		return
	}
	if a.analytics == nil {
		w.Header().Set("X-Analytics-Status", "disabled")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	select {
	case a.analytics.slots <- struct{}{}:
		defer func() { <-a.analytics.slots }()
	default:
		w.Header().Set("X-Analytics-Status", "dropped")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	origin := a.origin(r)
	hostname := ""
	if parsed, parseErr := url.Parse(origin); parseErr == nil {
		hostname = parsed.Hostname()
	}
	payload := umamiPayload{
		Website:  a.analytics.websiteID,
		Hostname: hostname,
		Language: submission.Language,
		Referrer: sanitizeAnalyticsReferrer(submission.Referrer, origin),
		Screen:   submission.Screen,
		Title:    page.Title,
		URL:      page.URL,
		Name:     submission.Event,
		Data:     data,
	}
	cache, sent := a.analytics.send(r.Context(), payload, submission.Cache, r.UserAgent(), clientIPAddress(r))
	if !sent {
		w.Header().Set("X-Analytics-Status", "dropped")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, umamiResponse{Cache: cache})
}

func (a *App) analyticsOriginAllowed(r *http.Request) bool {
	raw := r.Header.Get("Origin")
	origin, err := url.Parse(raw)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.User != nil ||
		origin.Path != "" || origin.RawPath != "" || origin.ForceQuery || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	return a.originAllowed(r)
}

func validateAnalyticsSubmission(submission analyticsSubmission) (analyticsPage, map[string]string, bool) {
	page, ok := analyticsPages[submission.Page]
	if !ok ||
		(submission.Language != "" && !analyticsLanguagePattern.MatchString(submission.Language)) ||
		(submission.Screen != "" && !analyticsScreenPattern.MatchString(submission.Screen)) ||
		len(submission.Referrer) > 2048 ||
		len(submission.Cache) > 4096 ||
		(submission.Cache != "" && !analyticsCachePattern.MatchString(submission.Cache)) {
		return analyticsPage{}, nil, false
	}
	if submission.Kind == "pageview" {
		if submission.Event != "" || submission.Outcome != "" || submission.Variant != "" || submission.Reason != "" {
			return analyticsPage{}, nil, false
		}
		return page, nil, true
	}
	if submission.Kind != "event" {
		return analyticsPage{}, nil, false
	}
	rule, ok := analyticsEventRules[submission.Event]
	if !ok || (submission.Outcome != "success" && submission.Outcome != "error") {
		return analyticsPage{}, nil, false
	}
	if len(rule.variants) == 0 {
		if submission.Variant != "" {
			return analyticsPage{}, nil, false
		}
	} else if !rule.variants[submission.Variant] {
		return analyticsPage{}, nil, false
	}
	if submission.Outcome == "success" {
		if submission.Reason != "" {
			return analyticsPage{}, nil, false
		}
	} else if !rule.reasons[submission.Reason] {
		return analyticsPage{}, nil, false
	}
	data := map[string]string{"outcome": submission.Outcome}
	if submission.Variant != "" {
		data["variant"] = submission.Variant
	}
	if submission.Reason != "" {
		data["reason"] = submission.Reason
	}
	return page, data, true
}

func (relay *analyticsRelay) send(ctx context.Context, payload umamiPayload, cache, userAgent, clientIP string) (string, bool) {
	body, err := json.Marshal(umamiEnvelope{Type: "event", Payload: payload})
	if err != nil {
		return "", false
	}
	requestCtx, cancel := context.WithTimeout(ctx, analyticsTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, relay.endpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", false
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	// Preserve an absent browser User-Agent instead of letting net/http invent a Go client identity.
	request.Header["User-Agent"] = []string{userAgent}
	if clientIP != "" {
		request.Header.Set("X-Forwarded-For", clientIP)
	}
	if cache != "" {
		request.Header.Set("X-Umami-Cache", cache)
	}
	response, err := relay.client.Do(request)
	if err != nil {
		relay.logger.Debug("Umami analytics delivery failed")
		return "", false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxAnalyticsResponse))
		relay.logger.Debug("Umami analytics delivery was rejected", "status", response.StatusCode)
		return "", false
	}
	var decoded umamiResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxAnalyticsResponse))
	if err := decoder.Decode(&decoded); err != nil && err != io.EOF {
		return "", true
	}
	if len(decoded.Cache) > 4096 || (decoded.Cache != "" && !analyticsCachePattern.MatchString(decoded.Cache)) {
		return "", true
	}
	return decoded.Cache, true
}

func sanitizeAnalyticsReferrer(raw, siteOrigin string) string {
	if raw == "" {
		return ""
	}
	referrer, err := url.Parse(raw)
	if err != nil || (referrer.Scheme != "http" && referrer.Scheme != "https") || referrer.Host == "" || referrer.User != nil {
		return ""
	}
	referrer.RawQuery = ""
	referrer.Fragment = ""
	referrer.RawFragment = ""
	site, err := url.Parse(siteOrigin)
	if err == nil && strings.EqualFold(referrer.Scheme, site.Scheme) && strings.EqualFold(referrer.Host, site.Host) {
		referrer.Path = normalizedAnalyticsPath(referrer.Path)
		return referrer.String()
	}
	referrer.Path = "/"
	referrer.RawPath = ""
	return referrer.String()
}

func normalizedAnalyticsPath(path string) string {
	trimmed := strings.Trim(path, "/")
	switch {
	case trimmed == "":
		return "/"
	case trimmed == "app":
		return "/app"
	case strings.HasPrefix(trimmed, "app/notes/"):
		return "/app/notes/:id"
	case strings.HasPrefix(trimmed, "p/"):
		return "/p/:id"
	case legacyPublicPattern.MatchString(trimmed):
		return "/:legacy-id"
	default:
		return "/"
	}
}

func clientIPAddress(r *http.Request) string {
	for _, header := range []string{"CF-Connecting-IP", "True-Client-IP", "X-Real-IP"} {
		if value := validIPAddress(r.Header.Get(header)); value != "" {
			return value
		}
	}
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		for _, value := range strings.Split(forwarded, ",") {
			if ip := validIPAddress(value); ip != "" {
				return ip
			}
		}
	}
	if forwarded := r.Header.Get("Forwarded"); forwarded != "" {
		for _, part := range strings.Split(forwarded, ";") {
			key, value, found := strings.Cut(strings.TrimSpace(part), "=")
			if found && strings.EqualFold(key, "for") {
				if ip := validIPAddress(strings.Trim(value, `"`)); ip != "" {
					return ip
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil {
		return validIPAddress(host)
	}
	return validIPAddress(r.RemoteAddr)
}

func validIPAddress(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		value = strings.TrimSuffix(strings.TrimPrefix(value, "["), "]")
	}
	if ip := net.ParseIP(value); ip != nil {
		return ip.String()
	}
	return ""
}
