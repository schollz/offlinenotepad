package database

import (
	"context"
	"database/sql"
	"errors"

	"github.com/schollz/offlinenotepad/internal/database/postgresdb"
	"github.com/schollz/offlinenotepad/internal/database/sqlitedb"
)

type postgresAdapter struct{ q *postgresdb.Queries }

func (a postgresAdapter) CreateWorkspace(ctx context.Context, w Workspace) (bool, error) {
	n, err := a.q.CreateWorkspace(ctx, postgresdb.CreateWorkspaceParams{ID: w.ID, KdfVersion: w.KDFVersion, KdfSalt: w.KDFSalt, KdfMemory: w.KDFMemory, KdfIterations: w.KDFIterations, KdfParallelism: w.KDFParallelism, AuthPublicKey: w.AuthPublicKey})
	return n == 1, err
}
func (a postgresAdapter) GetWorkspace(ctx context.Context, id string) (Workspace, error) {
	w, err := a.q.GetWorkspace(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, err
	}
	return Workspace{ID: w.ID, KDFVersion: w.KdfVersion, KDFSalt: w.KdfSalt, KDFMemory: w.KdfMemory, KDFIterations: w.KdfIterations, KDFParallelism: w.KdfParallelism, AuthPublicKey: w.AuthPublicKey, CreatedAt: w.CreatedAt, UpdatedAt: w.UpdatedAt}, nil
}
func postgresDocument(d postgresdb.Document) Document {
	return Document{WorkspaceID: d.WorkspaceID, DocumentID: d.DocumentID, Ciphertext: d.Ciphertext, CiphertextHash: d.CiphertextHash, Revision: d.Revision, Deleted: d.Deleted, ImportedLegacy: d.ImportedLegacy, UpdatedAt: d.UpdatedAt}
}
func (a postgresAdapter) ListDocuments(ctx context.Context, id string) ([]Document, error) {
	rows, err := a.q.ListDocuments(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]Document, len(rows))
	for i, d := range rows {
		out[i] = postgresDocument(d)
	}
	return out, nil
}
func (a postgresAdapter) GetDocument(ctx context.Context, wid, did string) (Document, error) {
	d, err := a.q.GetDocument(ctx, postgresdb.GetDocumentParams{WorkspaceID: wid, DocumentID: did})
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	return postgresDocument(d), nil
}
func (a postgresAdapter) CreateDocument(ctx context.Context, d Document) (bool, error) {
	n, err := a.q.CreateDocument(ctx, postgresdb.CreateDocumentParams{WorkspaceID: d.WorkspaceID, DocumentID: d.DocumentID, Ciphertext: d.Ciphertext, CiphertextHash: d.CiphertextHash, Deleted: d.Deleted, ImportedLegacy: d.ImportedLegacy})
	return n == 1, err
}
func (a postgresAdapter) UpdateDocument(ctx context.Context, d Document, rev int64) (bool, error) {
	n, err := a.q.UpdateDocument(ctx, postgresdb.UpdateDocumentParams{WorkspaceID: d.WorkspaceID, DocumentID: d.DocumentID, Ciphertext: d.Ciphertext, CiphertextHash: d.CiphertextHash, Deleted: d.Deleted, Revision: rev})
	return n == 1, err
}
func (a postgresAdapter) PutPublication(ctx context.Context, p Publication) error {
	return a.q.PutPublication(ctx, postgresdb.PutPublicationParams{PublicID: p.PublicID, WorkspaceID: p.WorkspaceID, DocumentID: p.DocumentID, Title: p.Title, Content: p.Content, ContentMode: p.ContentMode, Legacy: p.Legacy})
}
func (a postgresAdapter) DeletePublication(ctx context.Context, wid, did string) (bool, error) {
	n, err := a.q.DeletePublication(ctx, postgresdb.DeletePublicationParams{WorkspaceID: wid, DocumentID: did})
	return n == 1, err
}
func postgresPublication(p postgresdb.Publication) Publication {
	return Publication{PublicID: p.PublicID, WorkspaceID: p.WorkspaceID, DocumentID: p.DocumentID, Title: p.Title, Content: p.Content, ContentMode: p.ContentMode, Legacy: p.Legacy, UpdatedAt: p.UpdatedAt}
}
func (a postgresAdapter) GetPublication(ctx context.Context, id string) (Publication, error) {
	p, err := a.q.GetPublication(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Publication{}, ErrNotFound
	}
	if err != nil {
		return Publication{}, err
	}
	return postgresPublication(p), nil
}
func (a postgresAdapter) GetPublicationByDocument(ctx context.Context, wid, did string) (Publication, error) {
	p, err := a.q.GetPublicationByDocument(ctx, postgresdb.GetPublicationByDocumentParams{WorkspaceID: wid, DocumentID: did})
	if errors.Is(err, sql.ErrNoRows) {
		return Publication{}, ErrNotFound
	}
	if err != nil {
		return Publication{}, err
	}
	return postgresPublication(p), nil
}

type sqliteAdapter struct{ q *sqlitedb.Queries }

func (a sqliteAdapter) CreateWorkspace(ctx context.Context, w Workspace) (bool, error) {
	n, err := a.q.CreateWorkspace(ctx, sqlitedb.CreateWorkspaceParams{ID: w.ID, KdfVersion: int64(w.KDFVersion), KdfSalt: w.KDFSalt, KdfMemory: int64(w.KDFMemory), KdfIterations: int64(w.KDFIterations), KdfParallelism: int64(w.KDFParallelism), AuthPublicKey: w.AuthPublicKey})
	return n == 1, err
}
func (a sqliteAdapter) GetWorkspace(ctx context.Context, id string) (Workspace, error) {
	w, err := a.q.GetWorkspace(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, err
	}
	return Workspace{ID: w.ID, KDFVersion: int32(w.KdfVersion), KDFSalt: w.KdfSalt, KDFMemory: int32(w.KdfMemory), KDFIterations: int32(w.KdfIterations), KDFParallelism: int32(w.KdfParallelism), AuthPublicKey: w.AuthPublicKey, CreatedAt: parseSQLiteTime(w.CreatedAt), UpdatedAt: parseSQLiteTime(w.UpdatedAt)}, nil
}
func sqliteDocument(d sqlitedb.Document) Document {
	return Document{WorkspaceID: d.WorkspaceID, DocumentID: d.DocumentID, Ciphertext: d.Ciphertext, CiphertextHash: d.CiphertextHash, Revision: d.Revision, Deleted: d.Deleted != 0, ImportedLegacy: d.ImportedLegacy != 0, UpdatedAt: parseSQLiteTime(d.UpdatedAt)}
}
func (a sqliteAdapter) ListDocuments(ctx context.Context, id string) ([]Document, error) {
	rows, err := a.q.ListDocuments(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]Document, len(rows))
	for i, d := range rows {
		out[i] = sqliteDocument(d)
	}
	return out, nil
}
func (a sqliteAdapter) GetDocument(ctx context.Context, wid, did string) (Document, error) {
	d, err := a.q.GetDocument(ctx, sqlitedb.GetDocumentParams{WorkspaceID: wid, DocumentID: did})
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	return sqliteDocument(d), nil
}
func (a sqliteAdapter) CreateDocument(ctx context.Context, d Document) (bool, error) {
	deleted, legacy := int64(0), int64(0)
	if d.Deleted {
		deleted = 1
	}
	if d.ImportedLegacy {
		legacy = 1
	}
	n, err := a.q.CreateDocument(ctx, sqlitedb.CreateDocumentParams{WorkspaceID: d.WorkspaceID, DocumentID: d.DocumentID, Ciphertext: d.Ciphertext, CiphertextHash: d.CiphertextHash, Deleted: deleted, ImportedLegacy: legacy})
	return n == 1, err
}
func (a sqliteAdapter) UpdateDocument(ctx context.Context, d Document, rev int64) (bool, error) {
	deleted := int64(0)
	if d.Deleted {
		deleted = 1
	}
	n, err := a.q.UpdateDocument(ctx, sqlitedb.UpdateDocumentParams{WorkspaceID: d.WorkspaceID, DocumentID: d.DocumentID, Ciphertext: d.Ciphertext, CiphertextHash: d.CiphertextHash, Deleted: deleted, Revision: rev})
	return n == 1, err
}
func (a sqliteAdapter) PutPublication(ctx context.Context, p Publication) error {
	legacy := int64(0)
	if p.Legacy {
		legacy = 1
	}
	return a.q.PutPublication(ctx, sqlitedb.PutPublicationParams{PublicID: p.PublicID, WorkspaceID: p.WorkspaceID, DocumentID: p.DocumentID, Title: p.Title, Content: p.Content, ContentMode: p.ContentMode, Legacy: legacy})
}
func (a sqliteAdapter) DeletePublication(ctx context.Context, wid, did string) (bool, error) {
	n, err := a.q.DeletePublication(ctx, sqlitedb.DeletePublicationParams{WorkspaceID: wid, DocumentID: did})
	return n == 1, err
}
func sqlitePublication(p sqlitedb.Publication) Publication {
	return Publication{PublicID: p.PublicID, WorkspaceID: p.WorkspaceID, DocumentID: p.DocumentID, Title: p.Title, Content: p.Content, ContentMode: p.ContentMode, Legacy: p.Legacy != 0, UpdatedAt: parseSQLiteTime(p.UpdatedAt)}
}
func (a sqliteAdapter) GetPublication(ctx context.Context, id string) (Publication, error) {
	p, err := a.q.GetPublication(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Publication{}, ErrNotFound
	}
	if err != nil {
		return Publication{}, err
	}
	return sqlitePublication(p), nil
}
func (a sqliteAdapter) GetPublicationByDocument(ctx context.Context, wid, did string) (Publication, error) {
	p, err := a.q.GetPublicationByDocument(ctx, sqlitedb.GetPublicationByDocumentParams{WorkspaceID: wid, DocumentID: did})
	if errors.Is(err, sql.ErrNoRows) {
		return Publication{}, ErrNotFound
	}
	if err != nil {
		return Publication{}, err
	}
	return sqlitePublication(p), nil
}
