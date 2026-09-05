package app

import "github.com/schollz/offlinenotepad/internal/database"

const (
	messageChallenge          = "challenge"
	messageAuthenticate       = "authenticate"
	messageAuthenticated      = "authenticated"
	messagePull               = "pull"
	messageDocuments          = "documents"
	messageUpsert             = "upsert"
	messageDelete             = "delete"
	messagePublish            = "publish"
	messageUnpublish          = "unpublish"
	messageRotate             = "rotate-credentials"
	messageCredentialsRotated = "credentials-rotated"
	messageAck                = "ack"
	messageConflict           = "conflict"
	messageError              = "error"
)

type socketMessage struct {
	Type              string                      `json:"type"`
	Challenge         string                      `json:"challenge,omitempty"`
	WorkspaceID       string                      `json:"workspace_id,omitempty"`
	Signature         string                      `json:"signature,omitempty"`
	DocumentID        string                      `json:"document_id,omitempty"`
	DocumentIDs       []string                    `json:"document_ids,omitempty"`
	Ciphertext        string                      `json:"ciphertext,omitempty"`
	CiphertextHash    string                      `json:"ciphertext_hash,omitempty"`
	BaseRevision      int64                       `json:"base_revision,omitempty"`
	Deleted           bool                        `json:"deleted,omitempty"`
	Documents         []database.Document         `json:"documents,omitempty"`
	Publications      []database.Publication      `json:"publications,omitempty"`
	Manifest          []manifestEntry             `json:"manifest,omitempty"`
	Publication       *database.Publication       `json:"publication,omitempty"`
	PublicID          string                      `json:"public_id,omitempty"`
	Title             string                      `json:"title,omitempty"`
	Content           string                      `json:"content,omitempty"`
	ContentMode       string                      `json:"content_mode,omitempty"`
	KDFSalt           string                      `json:"kdf_salt,omitempty"`
	KDFMemory         int32                       `json:"kdf_memory,omitempty"`
	KDFIterations     int32                       `json:"kdf_iterations,omitempty"`
	KDFParallelism    int32                       `json:"kdf_parallelism,omitempty"`
	AuthPublicKey     string                      `json:"auth_public_key,omitempty"`
	RotationDocuments []database.RotationDocument `json:"rotation_documents,omitempty"`
	Error             string                      `json:"error,omitempty"`
	ErrorCode         string                      `json:"error_code,omitempty"`
}

type manifestEntry struct {
	DocumentID     string `json:"document_id"`
	CiphertextHash string `json:"ciphertext_hash"`
	Revision       int64  `json:"revision"`
	Deleted        bool   `json:"deleted"`
}
