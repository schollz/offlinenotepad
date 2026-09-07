package cryptov2

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	KDFVersion     int32 = 1
	KDFMemory      int32 = 64 * 1024
	KDFIterations  int32 = 3
	KDFParallelism int32 = 1
	documentStart        = "-----BEGIN OFFLINE NOTEPAD DOCUMENT V2-----"
	documentEnd          = "-----END OFFLINE NOTEPAD DOCUMENT V2-----"
)

type Keys struct {
	ContentKey []byte
	PrivateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey
}

type envelope struct {
	Version int    `json:"v"`
	Cipher  string `json:"cipher"`
	Nonce   string `json:"nonce"`
	Data    string `json:"data"`
}

func NormalizeUsername(username string) string {
	return cases.Fold().String(norm.NFC.String(strings.TrimSpace(username)))
}

func WorkspaceID(username string) (string, error) {
	normalized := NormalizeUsername(username)
	if normalized == "" {
		return "", errors.New("username is required")
	}
	sum := sha256.Sum256([]byte("offlinenotepad workspace v2\x00" + normalized))
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

func NewSalt() (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(salt), nil
}

func DeriveKeys(password []byte, saltEncoded string, memory, iterations, parallelism int32) (Keys, error) {
	salt, err := base64.RawURLEncoding.Strict().DecodeString(saltEncoded)
	if err != nil || len(salt) != 16 {
		return Keys{}, errors.New("invalid KDF salt")
	}
	if len(password) == 0 {
		return Keys{}, errors.New("password is required")
	}
	normalizedPassword := []byte(norm.NFC.String(string(password)))
	defer clear(normalizedPassword)
	master := argon2.IDKey(normalizedPassword, salt, uint32(iterations), uint32(memory), uint8(parallelism), 32)
	defer clear(master)
	content, err := hkdf.Key(sha256.New, master, nil, "offlinenotepad content key v2", 32)
	if err != nil {
		return Keys{}, err
	}
	seed, err := hkdf.Key(sha256.New, master, nil, "offlinenotepad auth seed v2", ed25519.SeedSize)
	if err != nil {
		clear(content)
		return Keys{}, err
	}
	private := ed25519.NewKeyFromSeed(seed)
	clear(seed)
	public := append(ed25519.PublicKey(nil), private.Public().(ed25519.PublicKey)...)
	return Keys{ContentKey: content, PrivateKey: private, PublicKey: public}, nil
}

func EncryptDocument(key []byte, workspaceID, documentID string, plaintext []byte) (string, string, error) {
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return "", "", err
	}
	nonce := make([]byte, cipher.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", "", err
	}
	return encryptDocumentWithNonce(key, workspaceID, documentID, plaintext, nonce)
}

func encryptDocumentWithNonce(key []byte, workspaceID, documentID string, plaintext, nonce []byte) (string, string, error) {
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return "", "", err
	}
	if len(nonce) != cipher.NonceSize() {
		return "", "", errors.New("invalid document nonce")
	}
	data := cipher.Seal(nil, nonce, plaintext, additionalData(workspaceID, documentID))
	payload, err := json.Marshal(envelope{Version: 2, Cipher: "xchacha20-poly1305", Nonce: base64.RawURLEncoding.EncodeToString(nonce), Data: base64.RawURLEncoding.EncodeToString(data)})
	if err != nil {
		return "", "", err
	}
	document := documentStart + "\n" + string(payload) + "\n" + documentEnd
	sum := sha256.Sum256([]byte(document))
	return document, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

func DecryptDocument(key []byte, workspaceID, documentID, document string) ([]byte, error) {
	if !strings.HasPrefix(document, documentStart+"\n") || !strings.HasSuffix(document, "\n"+documentEnd) {
		return nil, errors.New("invalid encrypted document")
	}
	payload := strings.TrimSuffix(strings.TrimPrefix(document, documentStart+"\n"), "\n"+documentEnd)
	var env envelope
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&env); err != nil {
		return nil, err
	}
	if env.Version != 2 || env.Cipher != "xchacha20-poly1305" {
		return nil, errors.New("unsupported encrypted document")
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(env.Nonce)
	if err != nil {
		return nil, err
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(env.Data)
	if err != nil {
		return nil, err
	}
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := cipher.Open(nil, nonce, data, additionalData(workspaceID, documentID))
	if err != nil {
		return nil, fmt.Errorf("decrypt document: %w", err)
	}
	return plaintext, nil
}

func additionalData(workspaceID, documentID string) []byte {
	return []byte("offlinenotepad document v2\x00" + workspaceID + "\x00" + documentID)
}

func EncodePublicKey(key ed25519.PublicKey) string { return base64.RawURLEncoding.EncodeToString(key) }
