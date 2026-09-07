CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    kdf_version INTEGER NOT NULL,
    kdf_salt TEXT NOT NULL,
    kdf_memory INTEGER NOT NULL,
    kdf_iterations INTEGER NOT NULL,
    kdf_parallelism INTEGER NOT NULL,
    auth_public_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE documents (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    ciphertext_hash TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    imported_legacy BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, document_id)
);

CREATE INDEX documents_workspace_updated_idx ON documents (workspace_id, updated_at DESC);

CREATE TABLE publications (
    public_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_mode TEXT NOT NULL CHECK (content_mode IN ('markdown', 'plaintext')),
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id, document_id)
        REFERENCES documents(workspace_id, document_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX publications_source_idx ON publications (workspace_id, document_id);
