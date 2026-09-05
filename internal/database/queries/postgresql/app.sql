-- name: CreateWorkspace :execrows
INSERT INTO workspaces (id, kdf_version, kdf_salt, kdf_memory, kdf_iterations, kdf_parallelism, auth_public_key)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO NOTHING;

-- name: GetWorkspace :one
SELECT id, kdf_version, kdf_salt, kdf_memory, kdf_iterations, kdf_parallelism, auth_public_key, created_at, updated_at
FROM workspaces WHERE id = $1;

-- name: ListDocuments :many
SELECT workspace_id, document_id, ciphertext, ciphertext_hash, revision, deleted, imported_legacy, updated_at
FROM documents WHERE workspace_id = $1 ORDER BY document_id;

-- name: GetDocument :one
SELECT workspace_id, document_id, ciphertext, ciphertext_hash, revision, deleted, imported_legacy, updated_at
FROM documents WHERE workspace_id = $1 AND document_id = $2;

-- name: CreateDocument :execrows
INSERT INTO documents (workspace_id, document_id, ciphertext, ciphertext_hash, revision, deleted, imported_legacy)
VALUES ($1, $2, $3, $4, 1, $5, $6)
ON CONFLICT (workspace_id, document_id) DO NOTHING;

-- name: UpdateDocument :execrows
UPDATE documents
SET ciphertext = $3, ciphertext_hash = $4, revision = revision + 1, deleted = $5, updated_at = CURRENT_TIMESTAMP
WHERE workspace_id = $1 AND document_id = $2 AND revision = $6 AND deleted = FALSE;

-- name: PutPublication :exec
INSERT INTO publications (public_id, workspace_id, document_id, title, content, content_mode, legacy)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (public_id) DO UPDATE SET
    title = EXCLUDED.title, content = EXCLUDED.content, content_mode = EXCLUDED.content_mode,
    updated_at = CURRENT_TIMESTAMP
WHERE publications.workspace_id = EXCLUDED.workspace_id
  AND publications.document_id = EXCLUDED.document_id;

-- name: DeletePublication :execrows
DELETE FROM publications WHERE workspace_id = $1 AND document_id = $2;

-- name: GetPublication :one
SELECT public_id, workspace_id, document_id, title, content, content_mode, legacy, updated_at
FROM publications WHERE public_id = $1;

-- name: GetPublicationByDocument :one
SELECT public_id, workspace_id, document_id, title, content, content_mode, legacy, updated_at
FROM publications WHERE workspace_id = $1 AND document_id = $2;

-- name: ListSitemapPublications :many
SELECT public_id, legacy, updated_at
FROM (
    SELECT public_id, legacy, updated_at FROM publications
    UNION ALL
    SELECT legacy_publications.public_id, TRUE AS legacy, legacy_publications.imported_at AS updated_at
    FROM legacy_publications
    WHERE NOT EXISTS (SELECT 1 FROM publications WHERE publications.public_id = legacy_publications.public_id)
) AS crawlable_publications
ORDER BY updated_at DESC, public_id
LIMIT $1;

-- name: RotateWorkspace :execrows
UPDATE workspaces SET kdf_salt = $2, kdf_memory = $3, kdf_iterations = $4, kdf_parallelism = $5,
    auth_public_key = $6, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND auth_public_key = $7;

-- name: RotateDocument :execrows
UPDATE documents SET ciphertext = $3, ciphertext_hash = $4, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
WHERE workspace_id = $1 AND document_id = $2 AND revision = $5 AND deleted = FALSE;

-- name: GetStagedLegacyWorkspace :one
SELECT legacy_id, migrated_workspace_id, imported_at
FROM legacy_workspaces WHERE legacy_id = $1;

-- name: ListStagedLegacyDocuments :many
SELECT legacy_id, document_id, ciphertext, document_hash, imported_at
FROM legacy_documents WHERE legacy_id = $1 ORDER BY document_id;

-- name: GetStagedLegacyPublication :one
SELECT public_id, legacy_id, document_id, title, content, content_mode, imported_at
FROM legacy_publications WHERE public_id = $1;
