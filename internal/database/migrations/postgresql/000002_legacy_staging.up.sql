CREATE TABLE legacy_workspaces (
    legacy_id TEXT PRIMARY KEY CHECK (legacy_id ~ '^[a-f0-9]{8}$'),
    migrated_workspace_id TEXT UNIQUE REFERENCES workspaces(id) ON DELETE SET NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE legacy_documents (
    legacy_id TEXT NOT NULL REFERENCES legacy_workspaces(legacy_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (legacy_id, document_id)
);

CREATE TABLE legacy_publications (
    public_id TEXT PRIMARY KEY CHECK (public_id ~ '^[a-f0-9]{8}$'),
    legacy_id TEXT,
    document_id TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_mode TEXT NOT NULL CHECK (content_mode IN ('markdown', 'plaintext')),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (legacy_id, document_id)
        REFERENCES legacy_documents(legacy_id, document_id) ON DELETE SET NULL
);
