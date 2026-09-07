package app

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testUmamiWebsiteID = "94db1cb1-74f4-4a40-ad6c-962362670409"

func TestAnalyticsConfiguration(t *testing.T) {
	var emptyLogs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&emptyLogs, nil))
	if relay := newAnalyticsRelay("", "", logger); relay != nil {
		t.Fatal("empty Umami configuration enabled analytics")
	}
	if strings.Count(emptyLogs.String(), "Umami analytics disabled") != 1 {
		t.Fatalf("empty configuration warning = %q", emptyLogs.String())
	}
	if relay := newAnalyticsRelay("https://analytics.example/", testUmamiWebsiteID, logger); relay == nil || relay.endpoint != "https://analytics.example/api/send" {
		t.Fatalf("valid Umami configuration = %#v", relay)
	}

	for _, test := range []struct {
		name      string
		url       string
		websiteID string
	}{
		{name: "missing website ID", url: "https://analytics.example"},
		{name: "missing URL", websiteID: testUmamiWebsiteID},
		{name: "path", url: "https://analytics.example/tracker", websiteID: testUmamiWebsiteID},
		{name: "query", url: "https://analytics.example?bad=true", websiteID: testUmamiWebsiteID},
		{name: "empty query", url: "https://analytics.example?", websiteID: testUmamiWebsiteID},
		{name: "fragment", url: "https://analytics.example#bad", websiteID: testUmamiWebsiteID},
		{name: "encoded path", url: "https://analytics.example/%2f", websiteID: testUmamiWebsiteID},
		{name: "credentials", url: "https://user:pass@analytics.example", websiteID: testUmamiWebsiteID},
		{name: "scheme", url: "javascript:alert(1)", websiteID: testUmamiWebsiteID},
		{name: "non-RFC UUID", url: "https://analytics.example", websiteID: "00000000-0000-0000-0000-000000000000"},
		{name: "website ID", url: "https://analytics.example", websiteID: `"></script><script>alert(1)</script>`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			logged := slog.New(slog.NewTextHandler(&logs, nil))
			if relay := newAnalyticsRelay(test.url, test.websiteID, logged); relay != nil {
				t.Fatalf("invalid Umami configuration enabled analytics: %#v", relay)
			}
			if (test.url != "" && strings.Contains(logs.String(), test.url)) || (test.websiteID != "" && strings.Contains(logs.String(), test.websiteID)) {
				t.Fatalf("configuration values appeared in log: %q", logs.String())
			}
		})
	}
}

func TestAnalyticsDisabledIsANoop(t *testing.T) {
	_, server := testServer(t)
	response := postAnalytics(t, server.URL, server.URL, analyticsSubmission{Kind: "pageview", Page: "landing"})
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent || response.Header.Get("X-Analytics-Status") != "disabled" {
		t.Fatalf("disabled analytics status=%d headers=%v", response.StatusCode, response.Header)
	}
}

func TestAnalyticsRequiresAllowedOriginAndJSON(t *testing.T) {
	_, server := testServer(t)

	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("missing origin status = %d", response.StatusCode)
	}

	request, err = http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://attacker.invalid")
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin status = %d", response.StatusCode)
	}

	request, err = http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", server.URL+"/not-an-origin")
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("malformed origin status = %d", response.StatusCode)
	}

	request, err = http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", server.URL)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("missing content type status = %d", response.StatusCode)
	}
}

func TestAnalyticsSubmissionAllowlist(t *testing.T) {
	valid := []analyticsSubmission{
		{Kind: "pageview", Page: "landing"},
		{Kind: "pageview", Page: "notebook", Language: "en-US", Screen: "1440x900"},
		{Kind: "event", Page: "landing", Event: "notebook-create", Outcome: "success"},
		{Kind: "event", Page: "landing", Event: "notebook-unlock", Outcome: "error", Reason: "incorrect-password"},
		{Kind: "event", Page: "note", Event: "note-create", Outcome: "success"},
		{Kind: "event", Page: "note", Event: "note-delete", Outcome: "error", Reason: "local-storage"},
		{Kind: "event", Page: "note", Event: "snapshot-publish", Outcome: "success", Variant: "create"},
		{Kind: "event", Page: "note", Event: "snapshot-unpublish", Outcome: "success"},
		{Kind: "event", Page: "notebook", Event: "archive-export", Outcome: "success", Variant: "encrypted"},
		{Kind: "event", Page: "notebook", Event: "archive-import", Outcome: "success", Variant: "legacy"},
		{Kind: "event", Page: "notebook", Event: "password-rotate", Outcome: "error", Reason: "offline-unavailable"},
	}
	for _, submission := range valid {
		if _, _, ok := validateAnalyticsSubmission(submission); !ok {
			t.Errorf("valid submission rejected: %#v", submission)
		}
	}

	invalid := []analyticsSubmission{
		{Kind: "pageview", Page: "private-id"},
		{Kind: "pageview", Page: "landing", Event: "notebook-create"},
		{Kind: "event", Page: "landing", Event: "unknown", Outcome: "success"},
		{Kind: "event", Page: "landing", Event: "notebook-create", Outcome: "maybe"},
		{Kind: "event", Page: "landing", Event: "notebook-create", Outcome: "error", Reason: "password-value"},
		{Kind: "event", Page: "landing", Event: "notebook-create", Outcome: "success", Reason: "unknown"},
		{Kind: "event", Page: "note", Event: "snapshot-publish", Outcome: "success", Variant: "secret-id"},
		{Kind: "event", Page: "note", Event: "note-create", Outcome: "success", Variant: "markdown"},
		{Kind: "pageview", Page: "landing", Language: "not a language"},
		{Kind: "pageview", Page: "landing", Screen: "huge"},
		{Kind: "pageview", Page: "landing", Cache: "has spaces"},
	}
	for _, submission := range invalid {
		if _, _, ok := validateAnalyticsSubmission(submission); ok {
			t.Errorf("invalid submission accepted: %#v", submission)
		}
	}
}

func TestAnalyticsRelaysSanitizedPayloadAndCache(t *testing.T) {
	upstreamRequest := make(chan struct {
		envelope umamiEnvelope
		headers  http.Header
		raw      string
	}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		var envelope umamiEnvelope
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Error(err)
			return
		}
		upstreamRequest <- struct {
			envelope umamiEnvelope
			headers  http.Header
			raw      string
		}{envelope: envelope, headers: r.Header.Clone(), raw: string(raw)}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"cache":"new.cache-token"}`)
	}))
	defer upstream.Close()

	_, server := testServerWithConfig(t, Config{UmamiURL: upstream.URL, UmamiWebsiteID: testUmamiWebsiteID})
	submission := analyticsSubmission{
		Kind: "event", Page: "note", Event: "snapshot-publish", Outcome: "success", Variant: "update",
		Language: "en-US", Screen: "1440x900",
		Referrer: server.URL + "/app/notes/private-document-id?password=never-forward#secret",
		Cache:    "old.cache-token",
	}
	requestBody, err := json.Marshal(submission)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", server.URL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "Example Browser/1.0")
	request.Header.Set("CF-Connecting-IP", "203.0.113.42")
	request.Header.Set("Cookie", "session=must-not-forward")
	request.Header.Set("Authorization", "Bearer must-not-forward")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("relay status=%d body=%q", response.StatusCode, body)
	}
	var relayResponse umamiResponse
	if err := json.NewDecoder(response.Body).Decode(&relayResponse); err != nil || relayResponse.Cache != "new.cache-token" {
		t.Fatalf("relay response = %#v, %v", relayResponse, err)
	}

	forwarded := <-upstreamRequest
	if forwarded.envelope.Type != "event" {
		t.Fatalf("Umami type = %q", forwarded.envelope.Type)
	}
	payload := forwarded.envelope.Payload
	if payload.Website != testUmamiWebsiteID || payload.URL != "/app/notes/:id" || payload.Title != "Note · Offline Notepad" || payload.Name != "snapshot-publish" {
		t.Fatalf("Umami payload = %#v", payload)
	}
	if payload.Language != "en-US" || payload.Screen != "1440x900" || payload.Referrer != server.URL+"/app/notes/:id" {
		t.Fatalf("visitor payload = %#v", payload)
	}
	if payload.Data["outcome"] != "success" || payload.Data["variant"] != "update" {
		t.Fatalf("event data = %#v", payload.Data)
	}
	if forwarded.headers.Get("User-Agent") != "Example Browser/1.0" || forwarded.headers.Get("X-Forwarded-For") != "203.0.113.42" || forwarded.headers.Get("X-Umami-Cache") != "old.cache-token" {
		t.Fatalf("forwarded headers = %v", forwarded.headers)
	}
	if forwarded.headers.Get("Cookie") != "" || forwarded.headers.Get("Authorization") != "" {
		t.Fatalf("private headers were forwarded: %v", forwarded.headers)
	}
	for _, secret := range []string{"private-document-id", "password", "never-forward", "#secret"} {
		if strings.Contains(forwarded.raw, secret) {
			t.Errorf("forwarded payload contains %q: %s", secret, forwarded.raw)
		}
	}
}

func TestAnalyticsRejectsUnknownFieldsAndDropsUpstreamFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	_, server := testServerWithConfig(t, Config{UmamiURL: upstream.URL, UmamiWebsiteID: testUmamiWebsiteID})

	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing","password":"secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", server.URL)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d", response.StatusCode)
	}

	response = postAnalytics(t, server.URL, server.URL, analyticsSubmission{Kind: "pageview", Page: "landing"})
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent || response.Header.Get("X-Analytics-Status") != "dropped" {
		t.Fatalf("upstream failure status=%d headers=%v", response.StatusCode, response.Header)
	}
}

func TestAnalyticsBoundsBodiesConcurrencyAndUpstreamTime(t *testing.T) {
	t.Run("body limit", func(t *testing.T) {
		_, server := testServer(t)
		request, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing","referrer":"`+strings.Repeat("x", maxAnalyticsBody)+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", server.URL)
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("oversized body status = %d", response.StatusCode)
		}
	})

	t.Run("concurrency", func(t *testing.T) {
		relay := &analyticsRelay{slots: make(chan struct{}, maxAnalyticsConcurrency), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
		for range maxAnalyticsConcurrency {
			relay.slots <- struct{}{}
		}
		application := &App{analytics: relay, config: Config{}}
		request := httptest.NewRequest(http.MethodPost, "http://app.example/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing"}`))
		request.Header.Set("Origin", "http://app.example")
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		application.handleAnalytics(response, request)
		if response.Code != http.StatusNoContent || response.Header().Get("X-Analytics-Status") != "dropped" {
			t.Fatalf("saturated relay status=%d headers=%v", response.Code, response.Header())
		}
	})

	t.Run("timeout", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(100 * time.Millisecond)
			w.WriteHeader(http.StatusOK)
		}))
		defer upstream.Close()
		relay := newAnalyticsRelay(upstream.URL, testUmamiWebsiteID, slog.New(slog.NewTextHandler(io.Discard, nil)))
		relay.client.Timeout = 10 * time.Millisecond
		application := &App{analytics: relay, config: Config{}}
		request := httptest.NewRequest(http.MethodPost, "http://app.example/api/v1/analytics", strings.NewReader(`{"kind":"pageview","page":"landing"}`))
		request.Header.Set("Origin", "http://app.example")
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		application.handleAnalytics(response, request)
		if response.Code != http.StatusNoContent || response.Header().Get("X-Analytics-Status") != "dropped" {
			t.Fatalf("timed-out relay status=%d headers=%v", response.Code, response.Header())
		}
	})
}

func TestAnalyticsReferrerAndClientIPSanitization(t *testing.T) {
	if got := sanitizeAnalyticsReferrer("https://search.example/private/path?token=secret#fragment", "https://notes.example"); got != "https://search.example/" {
		t.Fatalf("external referrer = %q", got)
	}
	if got := sanitizeAnalyticsReferrer("https://notes.example/p/public-id?secret=yes", "https://notes.example"); got != "https://notes.example/p/:id" {
		t.Fatalf("same-origin referrer = %q", got)
	}
	if got := sanitizeAnalyticsReferrer("http://notes.example/app/notes/private-id", "https://notes.example"); got != "http://notes.example/" {
		t.Fatalf("cross-scheme referrer = %q", got)
	}
	request := httptest.NewRequest(http.MethodPost, "https://notes.example/api/v1/analytics", nil)
	request.Header.Set("CF-Connecting-IP", "not-an-ip")
	request.Header.Set("X-Forwarded-For", "203.0.113.8, 10.0.0.1")
	if got := clientIPAddress(request); got != "203.0.113.8" {
		t.Fatalf("client IP = %q", got)
	}
}

func postAnalytics(t *testing.T, serverURL, origin string, submission analyticsSubmission) *http.Response {
	t.Helper()
	body, err := json.Marshal(submission)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, serverURL+"/api/v1/analytics", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
