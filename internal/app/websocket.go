package app

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/schollz/offlinenotepad/internal/database"
)

const maxWebsocketMessage = 2 << 20
const authenticationContext = "offlinenotepad websocket authentication v2\x00"

type socketClient struct {
	conn        *websocket.Conn
	ctx         context.Context
	cancel      context.CancelFunc
	writeMu     sync.Mutex
	workspaceID string
}

func (c *socketClient) write(message socketMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	return wsjson.Write(ctx, c.conn, message)
}
func (c *socketClient) close() {
	c.cancel()
	_ = c.conn.Close(websocket.StatusNormalClosure, "connection closed")
}

func (a *App) handleWebsocket(w http.ResponseWriter, r *http.Request) {
	if !a.originAllowed(r) {
		http.Error(w, "websocket origin denied", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxWebsocketMessage)
	ctx, cancel := context.WithCancel(context.Background())
	client := &socketClient{conn: conn, ctx: ctx, cancel: cancel}
	defer client.close()
	challengeBytes := make([]byte, 32)
	if _, err := randRead(challengeBytes); err != nil {
		return
	}
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes)
	if err := client.write(socketMessage{Type: messageChallenge, Challenge: challenge}); err != nil {
		return
	}
	authCtx, authCancel := context.WithTimeout(ctx, 15*time.Second)
	var authentication socketMessage
	err = wsjson.Read(authCtx, conn, &authentication)
	authCancel()
	if err != nil || authentication.Type != messageAuthenticate || !encoded32Pattern.MatchString(authentication.WorkspaceID) {
		client.write(socketMessage{Type: messageError, Error: "authentication required", ErrorCode: "authentication-required"})
		return
	}
	workspace, err := a.store.GetWorkspace(ctx, authentication.WorkspaceID)
	if err != nil || !verifyAuthentication(workspace.AuthPublicKey, challengeBytes, authentication.Signature) {
		client.write(socketMessage{Type: messageError, Error: "authentication failed", ErrorCode: "authentication-failed"})
		return
	}
	client.workspaceID = workspace.ID
	documents, err := a.store.ListDocuments(ctx, workspace.ID)
	if err != nil {
		client.write(socketMessage{Type: messageError, Error: "could not load documents"})
		return
	}
	publications := make([]database.Publication, 0)
	for _, d := range documents {
		if p, e := a.store.GetPublicationByDocument(ctx, workspace.ID, d.DocumentID); e == nil {
			publications = append(publications, p)
		}
	}
	manifest := make([]manifestEntry, len(documents))
	for i, d := range documents {
		manifest[i] = manifestEntry{DocumentID: d.DocumentID, CiphertextHash: d.CiphertextHash, Revision: d.Revision, Deleted: d.Deleted}
	}
	a.hub.add(client)
	defer a.hub.remove(client)
	if err := client.write(socketMessage{Type: messageAuthenticated, Manifest: manifest, Documents: documents, Publications: publications}); err != nil {
		return
	}
	for {
		var message socketMessage
		if err := wsjson.Read(ctx, conn, &message); err != nil {
			return
		}
		if err := a.handleSocketMessage(client, workspace, &message); err != nil {
			code := "invalid-message"
			if errors.Is(err, database.ErrNotFound) {
				code = "not-found"
			}
			_ = client.write(socketMessage{Type: messageError, Error: err.Error(), ErrorCode: code})
		}
		if message.Type == messageRotate {
			if latest, e := a.store.GetWorkspace(ctx, workspace.ID); e == nil {
				workspace = latest
			}
		}
	}
}

func (a *App) handleSocketMessage(client *socketClient, workspace database.Workspace, m *socketMessage) error {
	switch m.Type {
	case messagePull:
		items := make([]database.Document, 0, len(m.DocumentIDs))
		for _, id := range m.DocumentIDs {
			if !documentIDPattern.MatchString(id) {
				return errors.New("invalid document id")
			}
			d, err := a.store.GetDocument(client.ctx, client.workspaceID, id)
			if err != nil {
				return err
			}
			items = append(items, d)
		}
		return client.write(socketMessage{Type: messageDocuments, Documents: items})
	case messageUpsert, messageDelete:
		if !documentIDPattern.MatchString(m.DocumentID) {
			return errors.New("invalid document id")
		}
		if len(m.Ciphertext) > maxWebsocketMessage/2 {
			return errors.New("document is too large")
		}
		deleted := m.Type == messageDelete || m.Deleted
		if !deleted || m.Ciphertext != "" {
			sum := sha256.Sum256([]byte(m.Ciphertext))
			actual := base64.RawURLEncoding.EncodeToString(sum[:])
			if subtle.ConstantTimeCompare([]byte(actual), []byte(m.CiphertextHash)) != 1 {
				return errors.New("ciphertext hash mismatch")
			}
		}
		saved, err := a.store.PutDocument(client.ctx, database.Document{WorkspaceID: client.workspaceID, DocumentID: m.DocumentID, Ciphertext: m.Ciphertext, CiphertextHash: m.CiphertextHash, Deleted: deleted}, m.BaseRevision)
		if errors.Is(err, database.ErrConflict) {
			return client.write(socketMessage{Type: messageConflict, Documents: []database.Document{saved}})
		}
		if err != nil {
			return err
		}
		response := socketMessage{Type: messageAck, Documents: []database.Document{saved}}
		if err := client.write(response); err != nil {
			return err
		}
		a.hub.broadcast(client, socketMessage{Type: messageDocuments, Documents: []database.Document{saved}})
		return nil
	case messagePublish:
		if m.RenderMode == "" {
			m.RenderMode = "document"
		}
		if m.RenderMode != "document" && m.RenderMode != "html" && m.RenderMode != "markdown-html" {
			return errors.New("invalid publication format")
		}
		if !documentIDPattern.MatchString(m.DocumentID) || len(m.Title) > 300 || len(m.Content) > maxPublishedBody || (m.ContentMode != "markdown" && m.ContentMode != "plaintext") {
			return errors.New("invalid publication")
		}
		doc, err := a.store.GetDocument(client.ctx, client.workspaceID, m.DocumentID)
		if err != nil || doc.Deleted {
			return errors.New("document not found")
		}
		id := m.PublicID
		if id == "" {
			id, err = randomID(16)
			if err != nil {
				return err
			}
		}
		if !publicIDPattern.MatchString(id) && !legacyPublicPattern.MatchString(id) {
			return errors.New("invalid public id")
		}
		publication := database.Publication{PublicID: id, WorkspaceID: client.workspaceID, DocumentID: m.DocumentID, Title: strings.TrimSpace(m.Title), Content: m.Content, ContentMode: m.ContentMode, RenderMode: m.RenderMode}
		if publication.Title == "" {
			publication.Title = "Untitled note"
		}
		if err := a.store.PutPublication(client.ctx, publication); err != nil {
			return err
		}
		publication, err = a.store.GetPublicationByDocument(client.ctx, client.workspaceID, m.DocumentID)
		if err != nil {
			return err
		}
		return client.write(socketMessage{Type: messageAck, Publication: &publication})
	case messageUnpublish:
		if !documentIDPattern.MatchString(m.DocumentID) {
			return errors.New("invalid document id")
		}
		_, err := a.store.DeletePublication(client.ctx, client.workspaceID, m.DocumentID)
		if err != nil {
			return err
		}
		return client.write(socketMessage{Type: messageAck, DocumentID: m.DocumentID})
	case messageRotate:
		next := database.Workspace{ID: client.workspaceID, KDFVersion: 1, KDFSalt: m.KDFSalt, KDFMemory: m.KDFMemory, KDFIterations: m.KDFIterations, KDFParallelism: m.KDFParallelism, AuthPublicKey: m.AuthPublicKey}
		if !validWorkspace(next) {
			return errors.New("invalid credential rotation")
		}
		current, err := a.store.ListDocuments(client.ctx, client.workspaceID)
		if err != nil {
			return err
		}
		active := make([]string, 0)
		for _, d := range current {
			if !d.Deleted {
				active = append(active, d.DocumentID)
			}
		}
		rotated := make([]string, 0, len(m.RotationDocuments))
		for _, d := range m.RotationDocuments {
			if !documentIDPattern.MatchString(d.DocumentID) || d.Revision < 1 || len(d.Ciphertext) > maxWebsocketMessage/2 {
				return errors.New("invalid rotation document")
			}
			rotated = append(rotated, d.DocumentID)
			sum := sha256.Sum256([]byte(d.Ciphertext))
			if base64.RawURLEncoding.EncodeToString(sum[:]) != d.CiphertextHash {
				return errors.New("rotation ciphertext hash mismatch")
			}
		}
		slices.Sort(active)
		slices.Sort(rotated)
		if !slices.Equal(active, rotated) {
			return errors.New("rotation must include every active document")
		}
		if err := a.store.RotateCredentials(client.ctx, client.workspaceID, workspace.AuthPublicKey, next, m.RotationDocuments); err != nil {
			return err
		}
		a.hub.rotate(client)
		return client.write(socketMessage{Type: messageAck})
	default:
		return fmt.Errorf("unsupported websocket message type %q", m.Type)
	}
}

func verifyAuthentication(publicKey string, challenge []byte, signature string) bool {
	pub, err := base64.RawURLEncoding.Strict().DecodeString(publicKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	message := append([]byte(authenticationContext), challenge...)
	return ed25519.Verify(ed25519.PublicKey(pub), message, sig)
}

func (a *App) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	candidate := parsed.Scheme + "://" + parsed.Host
	if candidate == a.origin(r) {
		return true
	}
	for _, allowed := range a.config.AllowedOrigins {
		if candidate == strings.TrimRight(allowed, "/") {
			return true
		}
	}
	return false
}

var randRead = func(value []byte) (int, error) { return rand.Read(value) }
