package cryptov2

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

const goldenEnvelope = `-----BEGIN OFFLINE NOTEPAD DOCUMENT V2-----
{"v":2,"cipher":"xchacha20-poly1305","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","data":"FJ8z4ZRuUXjD0xryMcUo00w9B2HIiHMHY-FHW5xdGUksD0wtMnz20AwFK6TBh2xtuZ3D6RRTEpWCqt5N8WPWb8lcy44EbQV4LxIR4RJKliY16EuFTdOIFlmCz8XW4kU9RXtnyyQnf167ETKGNW7acBpENQnZu7vDHUDC0Kh3X4d5SMu441QvK6MSMjrDLVFDN39bG54OeDa2GhQoXW87pWg"}
-----END OFFLINE NOTEPAD DOCUMENT V2-----`

func TestCrossLanguageGolden(t *testing.T) {
	const (
		workspace = "ZKAbCLohP9bDxYv8F-5uXLSAD55bLNOQ-ZrNyeeV0qk"
		salt      = "AAECAwQFBgcICQoLDA0ODw"
		content   = "5riFm3YHip7fCvxVtHla8XgV2owKF4VGv-JFYtjjRTA"
		seed      = "2CUAduyNnuLMa0EgyQLDTR9t4WNJFreOoJ0nGh8mZv8"
		public    = "wonTPGWv1iVSbqQNuRN9RuUEiAJR0ToR05VF99uxAC0"
	)
	id, err := WorkspaceID("  Example Notebook  ")
	if err != nil {
		t.Fatal(err)
	}
	if id != workspace {
		t.Fatalf("workspace ID = %q, want %q", id, workspace)
	}
	keys, err := DeriveKeys([]byte("correct horse battery staple"), salt, KDFMemory, KDFIterations, KDFParallelism)
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.RawURLEncoding.EncodeToString(keys.ContentKey); got != content {
		t.Fatalf("content key = %q, want %q", got, content)
	}
	if got := base64.RawURLEncoding.EncodeToString(keys.PrivateKey.Seed()); got != seed {
		t.Fatalf("authentication seed = %q, want %q", got, seed)
	}
	if got := EncodePublicKey(keys.PublicKey); got != public {
		t.Fatalf("authentication public key = %q, want %q", got, public)
	}
	challenge, _ := base64.RawURLEncoding.DecodeString("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
	signature := ed25519.Sign(keys.PrivateKey, append([]byte("offlinenotepad websocket authentication v2\x00"), challenge...))
	if got, want := base64.RawURLEncoding.EncodeToString(signature), "4WpN3lRjpjSpblbDSC3BqVGWiQM5G3-uuY3rWIeQXUWu3Ej5wlBOpuFNskQqjRDsKF8NLob-lUmIpaLonDX_DQ"; got != want {
		t.Fatalf("authentication signature = %q, want %q", got, want)
	}
	plaintext := []byte(`{"id":"abc12345","title":"Private","content":"# Hello","mode":"markdown","created_at":"2020-01-01T00:00:00Z","updated_at":"2020-01-01T00:00:00Z"}`)
	nonce := make([]byte, 24)
	for i := range nonce {
		nonce[i] = byte(i)
	}
	got, hash, err := encryptDocumentWithNonce(keys.ContentKey, workspace, "abc12345", plaintext, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if got != goldenEnvelope || hash != "h5SKi9JSzYZ6I3aze1dJAnNsTI2O4nHhSKq1MSTrI0A" {
		t.Fatalf("encrypted envelope or hash differs from TypeScript golden")
	}
}

func TestDocumentEncryption(t *testing.T) {
	keys, err := DeriveKeys([]byte("correct horse battery staple"), "AAECAwQFBgcICQoLDA0ODw", 32*1024, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte(`{"id":"abc12345","title":"private"}`)
	ciphertext, hash, err := EncryptDocument(keys.ContentKey, "workspace", "abc12345", plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if ciphertext == string(plaintext) || hash == "" {
		t.Fatal("document was not encrypted and hashed")
	}
	got, err := DecryptDocument(keys.ContentKey, "workspace", "abc12345", ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(plaintext) {
		t.Fatalf("plaintext = %q, want %q", got, plaintext)
	}
	if _, err := DecryptDocument(keys.ContentKey, "workspace", "different", ciphertext); err == nil {
		t.Fatal("decrypting with a different document ID succeeded")
	}
}

func TestDeriveKeysAllowsShortLegacyPassword(t *testing.T) {
	keys, err := DeriveKeys([]byte("tiny"), "AAECAwQFBgcICQoLDA0ODw", 32*1024, 1, 1)
	if err != nil {
		t.Fatalf("derive keys with short legacy password: %v", err)
	}
	if len(keys.ContentKey) != 32 || len(keys.PrivateKey) != ed25519.PrivateKeySize || len(keys.PublicKey) != ed25519.PublicKeySize {
		t.Fatalf("unexpected derived key sizes: content=%d private=%d public=%d", len(keys.ContentKey), len(keys.PrivateKey), len(keys.PublicKey))
	}
	if _, err := DeriveKeys(nil, "AAECAwQFBgcICQoLDA0ODw", 32*1024, 1, 1); err == nil {
		t.Fatal("empty password unexpectedly accepted")
	}
}
