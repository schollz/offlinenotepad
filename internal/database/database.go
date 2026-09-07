package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/schollz/offlinenotepad/internal/database/postgresdb"
	"github.com/schollz/offlinenotepad/internal/database/sqlitedb"
)

type Backend string

const (
	BackendPostgreSQL Backend = "postgresql"
	BackendSQLite     Backend = "sqlite"
	DefaultSQLitePath         = "offlinenotepad.sqlite3"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("revision conflict")
	ErrExists   = errors.New("already exists")
	ErrInvalid  = errors.New("invalid input")
)

type Config struct{ DatabaseURL, SQLitePath string }

func ConfigFromEnv() Config {
	return Config{DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")), SQLitePath: strings.TrimSpace(os.Getenv("SQLITE_PATH"))}
}

func (c Config) Backend() Backend {
	if c.DatabaseURL != "" {
		return BackendPostgreSQL
	}
	return BackendSQLite
}

type Workspace struct {
	ID             string    `json:"id"`
	KDFVersion     int32     `json:"kdf_version"`
	KDFSalt        string    `json:"kdf_salt"`
	KDFMemory      int32     `json:"kdf_memory"`
	KDFIterations  int32     `json:"kdf_iterations"`
	KDFParallelism int32     `json:"kdf_parallelism"`
	AuthPublicKey  string    `json:"auth_public_key"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type Document struct {
	WorkspaceID    string    `json:"workspace_id,omitempty"`
	DocumentID     string    `json:"document_id"`
	Ciphertext     string    `json:"ciphertext"`
	CiphertextHash string    `json:"ciphertext_hash"`
	Revision       int64     `json:"revision"`
	Deleted        bool      `json:"deleted"`
	ImportedLegacy bool      `json:"-"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type Publication struct {
	PublicID    string    `json:"public_id"`
	WorkspaceID string    `json:"workspace_id,omitempty"`
	DocumentID  string    `json:"document_id,omitempty"`
	Title       string    `json:"title"`
	Content     string    `json:"content"`
	ContentMode string    `json:"content_mode"`
	RenderMode  string    `json:"render_mode"`
	Legacy      bool      `json:"legacy"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type SitemapPublication struct {
	PublicID  string
	Legacy    bool
	UpdatedAt time.Time
}

type RotationDocument struct {
	DocumentID     string `json:"document_id"`
	Ciphertext     string `json:"ciphertext"`
	CiphertextHash string `json:"ciphertext_hash"`
	Revision       int64  `json:"revision"`
}

type ImportResult struct{ DocumentsImported, DocumentsSkipped, PublicationsImported, PublicationsSkipped int }

type LegacyDocument struct {
	DocumentID   string `json:"document_id"`
	Ciphertext   string `json:"ciphertext"`
	DocumentHash string `json:"document_hash"`
}

type LegacyWorkspace struct {
	LegacyID  string           `json:"legacy_id"`
	Documents []LegacyDocument `json:"documents"`
}

type LegacyPublication struct {
	PublicID    string    `json:"public_id"`
	LegacyID    string    `json:"-"`
	DocumentID  string    `json:"-"`
	Title       string    `json:"title"`
	Content     string    `json:"content"`
	ContentMode string    `json:"content_mode"`
	ImportedAt  time.Time `json:"imported_at"`
}

type LegacyArchive struct {
	Workspaces   []LegacyWorkspace
	Publications []LegacyPublication
}

type LegacyArchiveResult struct {
	WorkspacesImported   int
	WorkspacesSkipped    int
	DocumentsImported    int
	DocumentsSkipped     int
	PublicationsImported int
	PublicationsSkipped  int
}

type LegacyArchiveProgressFunc func(completed, total int)

type queryAdapter interface {
	CreateWorkspace(context.Context, Workspace) (bool, error)
	GetWorkspace(context.Context, string) (Workspace, error)
	ListDocuments(context.Context, string) ([]Document, error)
	GetDocument(context.Context, string, string) (Document, error)
	CreateDocument(context.Context, Document) (bool, error)
	UpdateDocument(context.Context, Document, int64) (bool, error)
	PutPublication(context.Context, Publication) error
	DeletePublication(context.Context, string, string) (bool, error)
	GetPublication(context.Context, string) (Publication, error)
	GetPublicationByDocument(context.Context, string, string) (Publication, error)
	ListSitemapPublications(context.Context, int) ([]SitemapPublication, error)
}

type Store struct {
	db      *sql.DB
	backend Backend
	q       queryAdapter
}

func Open(ctx context.Context, config Config) (*Store, error) {
	backend, dsn := config.Backend(), config.DatabaseURL
	if backend == BackendSQLite {
		var err error
		dsn, err = sqliteDSN(config.SQLitePath)
		if err != nil {
			return nil, err
		}
	}
	if err := migrateSchema(backend, dsn); err != nil {
		return nil, fmt.Errorf("migrate %s: %w", backend, err)
	}
	driver := "pgx"
	if backend == BackendSQLite {
		driver = "sqlite"
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", backend, err)
	}
	if backend == BackendSQLite {
		db.SetMaxOpenConns(1)
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect %s: %w", backend, err)
	}
	s := &Store{db: db, backend: backend}
	if backend == BackendPostgreSQL {
		s.q = postgresAdapter{postgresdb.New(db)}
	} else {
		s.q = sqliteAdapter{sqlitedb.New(db)}
	}
	return s, nil
}

func sqliteDSN(path string) (string, error) {
	if path == "" {
		path = DefaultSQLitePath
	}
	if strings.HasPrefix(path, "file:") {
		return path, nil
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("sqlite path: %w", err)
	}
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(ON)")
	q.Add("_pragma", "journal_mode(WAL)")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (s *Store) Backend() Backend               { return s.backend }
func (s *Store) Close() error                   { return s.db.Close() }
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }
func (s *Store) CreateWorkspace(ctx context.Context, w Workspace) (bool, error) {
	return s.q.CreateWorkspace(ctx, w)
}
func (s *Store) GetWorkspace(ctx context.Context, id string) (Workspace, error) {
	return s.q.GetWorkspace(ctx, id)
}
func (s *Store) ListDocuments(ctx context.Context, id string) ([]Document, error) {
	return s.q.ListDocuments(ctx, id)
}
func (s *Store) GetDocument(ctx context.Context, wid, did string) (Document, error) {
	return s.q.GetDocument(ctx, wid, did)
}
func (s *Store) GetPublication(ctx context.Context, id string) (Publication, error) {
	return s.q.GetPublication(ctx, id)
}
func (s *Store) GetPublicationByDocument(ctx context.Context, wid, did string) (Publication, error) {
	return s.q.GetPublicationByDocument(ctx, wid, did)
}
func (s *Store) ListSitemapPublications(ctx context.Context, limit int) ([]SitemapPublication, error) {
	return s.q.ListSitemapPublications(ctx, limit)
}
func (s *Store) PutPublication(ctx context.Context, p Publication) error {
	if p.RenderMode == "" {
		p.RenderMode = "document"
	}
	if p.RenderMode != "document" && p.RenderMode != "html" && p.RenderMode != "markdown-html" {
		return ErrInvalid
	}
	return s.q.PutPublication(ctx, p)
}
func (s *Store) DeletePublication(ctx context.Context, wid, did string) (bool, error) {
	return s.q.DeletePublication(ctx, wid, did)
}

func (s *Store) PutDocument(ctx context.Context, d Document, baseRevision int64) (Document, error) {
	if baseRevision == 0 {
		created, err := s.q.CreateDocument(ctx, d)
		if err != nil {
			return Document{}, err
		}
		if created {
			d.Revision = 1
			d.UpdatedAt = time.Now().UTC()
			return d, nil
		}
	} else {
		updated, err := s.q.UpdateDocument(ctx, d, baseRevision)
		if err != nil {
			return Document{}, err
		}
		if updated {
			return s.q.GetDocument(ctx, d.WorkspaceID, d.DocumentID)
		}
	}
	current, err := s.q.GetDocument(ctx, d.WorkspaceID, d.DocumentID)
	if err != nil {
		return Document{}, err
	}
	return current, ErrConflict
}

func (s *Store) RotateCredentials(ctx context.Context, wid, oldPublicKey string, next Workspace, docs []RotationDocument) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	workspaceSQL := "UPDATE workspaces SET kdf_salt=$2,kdf_memory=$3,kdf_iterations=$4,kdf_parallelism=$5,auth_public_key=$6,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND auth_public_key=$7"
	documentSQL := "UPDATE documents SET ciphertext=$3,ciphertext_hash=$4,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=$1 AND document_id=$2 AND revision=$5 AND deleted=FALSE"
	if s.backend == BackendSQLite {
		workspaceSQL = "UPDATE workspaces SET kdf_salt=?2,kdf_memory=?3,kdf_iterations=?4,kdf_parallelism=?5,auth_public_key=?6,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND auth_public_key=?7"
		documentSQL = "UPDATE documents SET ciphertext=?3,ciphertext_hash=?4,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=?1 AND document_id=?2 AND revision=?5 AND deleted=FALSE"
	}
	result, err := tx.ExecContext(ctx, workspaceSQL, wid, next.KDFSalt, next.KDFMemory, next.KDFIterations, next.KDFParallelism, next.AuthPublicKey, oldPublicKey)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return ErrConflict
	}
	for _, d := range docs {
		result, err = tx.ExecContext(ctx, documentSQL, wid, d.DocumentID, d.Ciphertext, d.CiphertextHash, d.Revision)
		if err != nil {
			return err
		}
		rows, _ = result.RowsAffected()
		if rows != 1 {
			return ErrConflict
		}
	}
	return tx.Commit()
}

func (s *Store) ImportLegacy(ctx context.Context, workspace Workspace, documents []Document, publications []Publication) (ImportResult, error) {
	if s.backend != BackendPostgreSQL {
		return ImportResult{}, errors.New("legacy migration requires PostgreSQL")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback()
	result := ImportResult{}
	insertedDocuments := make(map[string]struct{}, len(documents))
	created, err := tx.ExecContext(ctx, `INSERT INTO workspaces (id,kdf_version,kdf_salt,kdf_memory,kdf_iterations,kdf_parallelism,auth_public_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, workspace.ID, workspace.KDFVersion, workspace.KDFSalt, workspace.KDFMemory, workspace.KDFIterations, workspace.KDFParallelism, workspace.AuthPublicKey)
	if err != nil {
		return result, err
	}
	rows, _ := created.RowsAffected()
	if rows == 0 {
		var publicKey string
		if err := tx.QueryRowContext(ctx, `SELECT auth_public_key FROM workspaces WHERE id=$1`, workspace.ID).Scan(&publicKey); err != nil {
			return result, err
		}
		if publicKey != workspace.AuthPublicKey {
			return result, ErrExists
		}
	}
	for _, d := range documents {
		r, err := tx.ExecContext(ctx, `INSERT INTO documents (workspace_id,document_id,ciphertext,ciphertext_hash,revision,deleted,imported_legacy) VALUES ($1,$2,$3,$4,1,$5,TRUE) ON CONFLICT (workspace_id,document_id) DO NOTHING`, workspace.ID, d.DocumentID, d.Ciphertext, d.CiphertextHash, d.Deleted)
		if err != nil {
			return result, err
		}
		n, _ := r.RowsAffected()
		if n == 1 {
			result.DocumentsImported++
			insertedDocuments[d.DocumentID] = struct{}{}
		} else {
			result.DocumentsSkipped++
		}
	}
	for _, p := range publications {
		if _, inserted := insertedDocuments[p.DocumentID]; !inserted {
			result.PublicationsSkipped++
			continue
		}
		r, err := tx.ExecContext(ctx, `INSERT INTO publications (public_id,workspace_id,document_id,title,content,content_mode,legacy) VALUES ($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT (public_id) DO NOTHING`, p.PublicID, workspace.ID, p.DocumentID, p.Title, p.Content, p.ContentMode)
		if err != nil {
			return result, err
		}
		n, _ := r.RowsAffected()
		if n == 1 {
			result.PublicationsImported++
		} else {
			var existingWorkspace, existingDocument string
			if err := tx.QueryRowContext(ctx, `SELECT workspace_id,document_id FROM publications WHERE public_id=$1`, p.PublicID).Scan(&existingWorkspace, &existingDocument); err != nil {
				return result, err
			}
			if existingWorkspace != workspace.ID || existingDocument != p.DocumentID {
				return result, fmt.Errorf("publication id collision: %w", ErrExists)
			}
			result.PublicationsSkipped++
		}
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Store) StageLegacyArchive(ctx context.Context, archive LegacyArchive, dryRun bool) (LegacyArchiveResult, error) {
	return s.stageLegacyArchive(ctx, archive, dryRun, nil)
}

func (s *Store) StageLegacyArchiveWithProgress(ctx context.Context, archive LegacyArchive, dryRun bool, progress LegacyArchiveProgressFunc) (LegacyArchiveResult, error) {
	return s.stageLegacyArchive(ctx, archive, dryRun, progress)
}

func (s *Store) stageLegacyArchive(ctx context.Context, archive LegacyArchive, dryRun bool, progress LegacyArchiveProgressFunc) (LegacyArchiveResult, error) {
	if s.backend == BackendPostgreSQL {
		return s.stageLegacyArchivePostgreSQL(ctx, archive, dryRun, progress)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return LegacyArchiveResult{}, err
	}
	defer tx.Rollback()
	workspaceInsert := `INSERT INTO legacy_workspaces (legacy_id) VALUES ($1) ON CONFLICT (legacy_id) DO NOTHING`
	documentInsert := `INSERT INTO legacy_documents (legacy_id,document_id,ciphertext,document_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (legacy_id,document_id) DO NOTHING`
	documentSelect := `SELECT ciphertext,document_hash FROM legacy_documents WHERE legacy_id=$1 AND document_id=$2`
	publicationInsert := `INSERT INTO legacy_publications (public_id,legacy_id,document_id,title,content,content_mode) VALUES ($1,NULLIF($2,''),NULLIF($3,''),$4,$5,$6) ON CONFLICT (public_id) DO NOTHING`
	publicationSelect := `SELECT COALESCE(legacy_id,''),COALESCE(document_id,''),title,content,content_mode FROM legacy_publications WHERE public_id=$1`
	if s.backend == BackendSQLite {
		workspaceInsert = `INSERT INTO legacy_workspaces (legacy_id) VALUES (?1) ON CONFLICT (legacy_id) DO NOTHING`
		documentInsert = `INSERT INTO legacy_documents (legacy_id,document_id,ciphertext,document_hash) VALUES (?1,?2,?3,?4) ON CONFLICT (legacy_id,document_id) DO NOTHING`
		documentSelect = `SELECT ciphertext,document_hash FROM legacy_documents WHERE legacy_id=?1 AND document_id=?2`
		publicationInsert = `INSERT INTO legacy_publications (public_id,legacy_id,document_id,title,content,content_mode) VALUES (?1,NULLIF(?2,''),NULLIF(?3,''),?4,?5,?6) ON CONFLICT (public_id) DO NOTHING`
		publicationSelect = `SELECT COALESCE(legacy_id,''),COALESCE(document_id,''),title,content,content_mode FROM legacy_publications WHERE public_id=?1`
	}
	result := LegacyArchiveResult{}
	total := len(archive.Workspaces) + len(archive.Publications)
	for _, workspace := range archive.Workspaces {
		total += len(workspace.Documents)
	}
	completed := 0
	reportProgress := func() {
		if progress != nil {
			progress(completed, total)
		}
	}
	reportProgress()
	for _, workspace := range archive.Workspaces {
		inserted, err := tx.ExecContext(ctx, workspaceInsert, workspace.LegacyID)
		if err != nil {
			return result, err
		}
		rows, _ := inserted.RowsAffected()
		if rows == 1 {
			result.WorkspacesImported++
		} else {
			result.WorkspacesSkipped++
		}
		completed++
		reportProgress()
		for _, document := range workspace.Documents {
			inserted, err = tx.ExecContext(ctx, documentInsert, workspace.LegacyID, document.DocumentID, document.Ciphertext, document.DocumentHash)
			if err != nil {
				return result, err
			}
			rows, _ = inserted.RowsAffected()
			if rows == 1 {
				result.DocumentsImported++
				completed++
				reportProgress()
				continue
			}
			var ciphertext, hash string
			if err := tx.QueryRowContext(ctx, documentSelect, workspace.LegacyID, document.DocumentID).Scan(&ciphertext, &hash); err != nil {
				return result, err
			}
			if ciphertext != document.Ciphertext || hash != document.DocumentHash {
				return result, fmt.Errorf("legacy document collision: %w", ErrExists)
			}
			result.DocumentsSkipped++
			completed++
			reportProgress()
		}
	}
	for _, publication := range archive.Publications {
		inserted, err := tx.ExecContext(ctx, publicationInsert, publication.PublicID, publication.LegacyID, publication.DocumentID, publication.Title, publication.Content, publication.ContentMode)
		if err != nil {
			return result, err
		}
		rows, _ := inserted.RowsAffected()
		if rows == 1 {
			result.PublicationsImported++
			completed++
			reportProgress()
			continue
		}
		var legacyID, documentID, title, content, mode string
		if err := tx.QueryRowContext(ctx, publicationSelect, publication.PublicID).Scan(&legacyID, &documentID, &title, &content, &mode); err != nil {
			return result, err
		}
		if legacyID != publication.LegacyID || documentID != publication.DocumentID || title != publication.Title || content != publication.Content || mode != publication.ContentMode {
			return result, fmt.Errorf("legacy publication collision: %w", ErrExists)
		}
		result.PublicationsSkipped++
		completed++
		reportProgress()
	}
	if dryRun {
		if err := tx.Rollback(); err != nil {
			return result, err
		}
		return result, nil
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Store) GetLegacyWorkspace(ctx context.Context, legacyID string) (LegacyWorkspace, error) {
	workspaceQuery := `SELECT legacy_id FROM legacy_workspaces WHERE legacy_id=$1`
	documentsQuery := `SELECT document_id,ciphertext,document_hash FROM legacy_documents WHERE legacy_id=$1 ORDER BY document_id`
	if s.backend == BackendSQLite {
		workspaceQuery = `SELECT legacy_id FROM legacy_workspaces WHERE legacy_id=?1`
		documentsQuery = `SELECT document_id,ciphertext,document_hash FROM legacy_documents WHERE legacy_id=?1 ORDER BY document_id`
	}
	workspace := LegacyWorkspace{LegacyID: legacyID, Documents: []LegacyDocument{}}
	if err := s.db.QueryRowContext(ctx, workspaceQuery, legacyID).Scan(&workspace.LegacyID); errors.Is(err, sql.ErrNoRows) {
		return LegacyWorkspace{}, ErrNotFound
	} else if err != nil {
		return LegacyWorkspace{}, err
	}
	rows, err := s.db.QueryContext(ctx, documentsQuery, legacyID)
	if err != nil {
		return LegacyWorkspace{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var document LegacyDocument
		if err := rows.Scan(&document.DocumentID, &document.Ciphertext, &document.DocumentHash); err != nil {
			return LegacyWorkspace{}, err
		}
		workspace.Documents = append(workspace.Documents, document)
	}
	return workspace, rows.Err()
}

func (s *Store) GetLegacyPublication(ctx context.Context, publicID string) (LegacyPublication, error) {
	query := `SELECT public_id,title,content,content_mode,imported_at FROM legacy_publications WHERE public_id=$1`
	if s.backend == BackendSQLite {
		query = `SELECT public_id,title,content,content_mode,imported_at FROM legacy_publications WHERE public_id=?1`
	}
	var publication LegacyPublication
	var importedAt any
	err := s.db.QueryRowContext(ctx, query, publicID).Scan(&publication.PublicID, &publication.Title, &publication.Content, &publication.ContentMode, &importedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return LegacyPublication{}, ErrNotFound
	}
	if err != nil {
		return LegacyPublication{}, err
	}
	switch value := importedAt.(type) {
	case time.Time:
		publication.ImportedAt = value.UTC()
	case string:
		publication.ImportedAt = parseSQLiteTime(value)
	}
	return publication, nil
}

func (s *Store) PromoteLegacyWorkspace(ctx context.Context, legacyID string, workspace Workspace, documents []Document, rejectedDocumentIDs, discardedDocumentIDs []string) (ImportResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback()
	legacyQuery := `SELECT COALESCE(migrated_workspace_id,'') FROM legacy_workspaces WHERE legacy_id=$1 FOR UPDATE`
	stagedQuery := `SELECT document_id FROM legacy_documents WHERE legacy_id=$1 ORDER BY document_id`
	workspaceInsert := `INSERT INTO workspaces (id,kdf_version,kdf_salt,kdf_memory,kdf_iterations,kdf_parallelism,auth_public_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`
	workspaceSelect := `SELECT kdf_version,kdf_salt,kdf_memory,kdf_iterations,kdf_parallelism,auth_public_key FROM workspaces WHERE id=$1`
	documentInsert := `INSERT INTO documents (workspace_id,document_id,ciphertext,ciphertext_hash,revision,deleted,imported_legacy) VALUES ($1,$2,$3,$4,1,FALSE,TRUE) ON CONFLICT (workspace_id,document_id) DO NOTHING`
	publicationQuery := `SELECT public_id,document_id,title,content,content_mode FROM legacy_publications WHERE legacy_id=$1 AND document_id IS NOT NULL`
	publicationInsert := `INSERT INTO publications (public_id,workspace_id,document_id,title,content,content_mode,legacy) VALUES ($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT (public_id) DO NOTHING`
	publicationSelect := `SELECT workspace_id,document_id,title,content,content_mode FROM publications WHERE public_id=$1`
	markMigrated := `UPDATE legacy_workspaces SET migrated_workspace_id=$2 WHERE legacy_id=$1 AND (migrated_workspace_id IS NULL OR migrated_workspace_id=$2)`
	if s.backend == BackendSQLite {
		legacyQuery = `SELECT COALESCE(migrated_workspace_id,'') FROM legacy_workspaces WHERE legacy_id=?1`
		stagedQuery = `SELECT document_id FROM legacy_documents WHERE legacy_id=?1 ORDER BY document_id`
		workspaceInsert = `INSERT INTO workspaces (id,kdf_version,kdf_salt,kdf_memory,kdf_iterations,kdf_parallelism,auth_public_key) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT (id) DO NOTHING`
		workspaceSelect = `SELECT kdf_version,kdf_salt,kdf_memory,kdf_iterations,kdf_parallelism,auth_public_key FROM workspaces WHERE id=?1`
		documentInsert = `INSERT INTO documents (workspace_id,document_id,ciphertext,ciphertext_hash,revision,deleted,imported_legacy) VALUES (?1,?2,?3,?4,1,FALSE,TRUE) ON CONFLICT (workspace_id,document_id) DO NOTHING`
		publicationQuery = `SELECT public_id,document_id,title,content,content_mode FROM legacy_publications WHERE legacy_id=?1 AND document_id IS NOT NULL`
		publicationInsert = `INSERT INTO publications (public_id,workspace_id,document_id,title,content,content_mode,legacy) VALUES (?1,?2,?3,?4,?5,?6,TRUE) ON CONFLICT (public_id) DO NOTHING`
		publicationSelect = `SELECT workspace_id,document_id,title,content,content_mode FROM publications WHERE public_id=?1`
		markMigrated = `UPDATE legacy_workspaces SET migrated_workspace_id=?2 WHERE legacy_id=?1 AND (migrated_workspace_id IS NULL OR migrated_workspace_id=?2)`
	}
	var migratedWorkspaceID string
	if err := tx.QueryRowContext(ctx, legacyQuery, legacyID).Scan(&migratedWorkspaceID); errors.Is(err, sql.ErrNoRows) {
		return ImportResult{}, ErrNotFound
	} else if err != nil {
		return ImportResult{}, err
	}
	if migratedWorkspaceID != "" && migratedWorkspaceID != workspace.ID {
		return ImportResult{}, ErrExists
	}
	rows, err := tx.QueryContext(ctx, stagedQuery, legacyID)
	if err != nil {
		return ImportResult{}, err
	}
	expected := make(map[string]struct{})
	for rows.Next() {
		var documentID string
		if err := rows.Scan(&documentID); err != nil {
			rows.Close()
			return ImportResult{}, err
		}
		expected[documentID] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return ImportResult{}, err
	}
	if len(documents)+len(rejectedDocumentIDs)+len(discardedDocumentIDs) != len(expected) || (len(expected) > 0 && len(documents) == 0 && len(discardedDocumentIDs) == 0) {
		return ImportResult{}, fmt.Errorf("legacy migration document manifest mismatch: %w", ErrInvalid)
	}
	seen := make(map[string]struct{}, len(documents))
	accepted := make(map[string]struct{}, len(documents))
	for _, document := range documents {
		if _, ok := expected[document.DocumentID]; !ok {
			return ImportResult{}, fmt.Errorf("legacy migration document manifest mismatch: %w", ErrInvalid)
		}
		if _, duplicate := seen[document.DocumentID]; duplicate {
			return ImportResult{}, fmt.Errorf("legacy migration contains a duplicate document: %w", ErrInvalid)
		}
		seen[document.DocumentID] = struct{}{}
		accepted[document.DocumentID] = struct{}{}
	}
	for _, documentID := range rejectedDocumentIDs {
		if _, ok := expected[documentID]; !ok {
			return ImportResult{}, fmt.Errorf("legacy migration rejected-document manifest mismatch: %w", ErrInvalid)
		}
		if _, duplicate := seen[documentID]; duplicate {
			return ImportResult{}, fmt.Errorf("legacy migration contains a duplicate document decision: %w", ErrInvalid)
		}
		seen[documentID] = struct{}{}
	}
	for _, documentID := range discardedDocumentIDs {
		if _, ok := expected[documentID]; !ok {
			return ImportResult{}, fmt.Errorf("legacy migration discarded-document manifest mismatch: %w", ErrInvalid)
		}
		if _, duplicate := seen[documentID]; duplicate {
			return ImportResult{}, fmt.Errorf("legacy migration contains a duplicate document decision: %w", ErrInvalid)
		}
		seen[documentID] = struct{}{}
	}
	created, err := tx.ExecContext(ctx, workspaceInsert, workspace.ID, workspace.KDFVersion, workspace.KDFSalt, workspace.KDFMemory, workspace.KDFIterations, workspace.KDFParallelism, workspace.AuthPublicKey)
	if err != nil {
		return ImportResult{}, err
	}
	createdRows, _ := created.RowsAffected()
	if createdRows == 0 {
		var current Workspace
		if err := tx.QueryRowContext(ctx, workspaceSelect, workspace.ID).Scan(&current.KDFVersion, &current.KDFSalt, &current.KDFMemory, &current.KDFIterations, &current.KDFParallelism, &current.AuthPublicKey); err != nil {
			return ImportResult{}, err
		}
		if current.KDFVersion != workspace.KDFVersion || current.KDFSalt != workspace.KDFSalt || current.KDFMemory != workspace.KDFMemory || current.KDFIterations != workspace.KDFIterations || current.KDFParallelism != workspace.KDFParallelism || current.AuthPublicKey != workspace.AuthPublicKey {
			return ImportResult{}, ErrExists
		}
	}
	result := ImportResult{}
	for _, document := range documents {
		inserted, err := tx.ExecContext(ctx, documentInsert, workspace.ID, document.DocumentID, document.Ciphertext, document.CiphertextHash)
		if err != nil {
			return result, err
		}
		count, _ := inserted.RowsAffected()
		if count == 1 {
			result.DocumentsImported++
		} else {
			result.DocumentsSkipped++
		}
	}
	publicationRows, err := tx.QueryContext(ctx, publicationQuery, legacyID)
	if err != nil {
		return result, err
	}
	publications := []LegacyPublication{}
	for publicationRows.Next() {
		var publication LegacyPublication
		if err := publicationRows.Scan(&publication.PublicID, &publication.DocumentID, &publication.Title, &publication.Content, &publication.ContentMode); err != nil {
			publicationRows.Close()
			return result, err
		}
		if _, ok := accepted[publication.DocumentID]; ok {
			publications = append(publications, publication)
		} else {
			result.PublicationsSkipped++
		}
	}
	if err := publicationRows.Close(); err != nil {
		return result, err
	}
	for _, publication := range publications {
		inserted, err := tx.ExecContext(ctx, publicationInsert, publication.PublicID, workspace.ID, publication.DocumentID, publication.Title, publication.Content, publication.ContentMode)
		if err != nil {
			return result, err
		}
		count, _ := inserted.RowsAffected()
		if count == 1 {
			result.PublicationsImported++
			continue
		}
		var currentWorkspaceID, currentDocumentID, title, content, mode string
		if err := tx.QueryRowContext(ctx, publicationSelect, publication.PublicID).Scan(&currentWorkspaceID, &currentDocumentID, &title, &content, &mode); err != nil {
			return result, err
		}
		if currentWorkspaceID != workspace.ID || currentDocumentID != publication.DocumentID || title != publication.Title || content != publication.Content || mode != publication.ContentMode {
			return result, fmt.Errorf("publication id collision: %w", ErrExists)
		}
		result.PublicationsSkipped++
	}
	marked, err := tx.ExecContext(ctx, markMigrated, legacyID, workspace.ID)
	if err != nil {
		return result, err
	}
	markedRows, _ := marked.RowsAffected()
	if markedRows != 1 {
		return result, ErrExists
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

func parseSQLiteTime(value string) time.Time {
	t, _ := time.Parse("2006-01-02 15:04:05", value)
	return t.UTC()
}
