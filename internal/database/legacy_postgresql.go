package database

import (
	"context"
	"database/sql"
	"fmt"
)

const (
	legacyStageBatchRows  = 1000
	legacyStageBatchBytes = 8 << 20
)

type legacyDocumentRow struct {
	legacyID, documentID, ciphertext, documentHash string
}

func (s *Store) stageLegacyArchivePostgreSQL(ctx context.Context, archive LegacyArchive, dryRun bool, progress LegacyArchiveProgressFunc) (LegacyArchiveResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return LegacyArchiveResult{}, err
	}
	defer tx.Rollback()

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

	for start := 0; start < len(archive.Workspaces); start += legacyStageBatchRows {
		end := min(start+legacyStageBatchRows, len(archive.Workspaces))
		legacyIDs := make([]string, end-start)
		for i, workspace := range archive.Workspaces[start:end] {
			legacyIDs[i] = workspace.LegacyID
		}
		inserted, err := stageLegacyWorkspaceBatch(ctx, tx, legacyIDs)
		if err != nil {
			return result, err
		}
		result.WorkspacesImported += inserted
		result.WorkspacesSkipped += len(legacyIDs) - inserted
		completed += len(legacyIDs)
		reportProgress()
	}

	documentBatch := make([]legacyDocumentRow, 0, legacyStageBatchRows)
	documentBytes := 0
	flushDocuments := func() error {
		if len(documentBatch) == 0 {
			return nil
		}
		inserted, err := stageLegacyDocumentBatch(ctx, tx, documentBatch)
		if err != nil {
			return err
		}
		result.DocumentsImported += inserted
		result.DocumentsSkipped += len(documentBatch) - inserted
		completed += len(documentBatch)
		reportProgress()
		documentBatch = documentBatch[:0]
		documentBytes = 0
		return nil
	}
	for _, workspace := range archive.Workspaces {
		for _, document := range workspace.Documents {
			rowBytes := len(workspace.LegacyID) + len(document.DocumentID) + len(document.Ciphertext) + len(document.DocumentHash)
			if len(documentBatch) > 0 && (len(documentBatch) >= legacyStageBatchRows || documentBytes+rowBytes > legacyStageBatchBytes) {
				if err := flushDocuments(); err != nil {
					return result, err
				}
			}
			documentBatch = append(documentBatch, legacyDocumentRow{
				legacyID: workspace.LegacyID, documentID: document.DocumentID,
				ciphertext: document.Ciphertext, documentHash: document.DocumentHash,
			})
			documentBytes += rowBytes
		}
	}
	if err := flushDocuments(); err != nil {
		return result, err
	}

	publicationBatch := make([]LegacyPublication, 0, legacyStageBatchRows)
	publicationBytes := 0
	flushPublications := func() error {
		if len(publicationBatch) == 0 {
			return nil
		}
		inserted, err := stageLegacyPublicationBatch(ctx, tx, publicationBatch)
		if err != nil {
			return err
		}
		result.PublicationsImported += inserted
		result.PublicationsSkipped += len(publicationBatch) - inserted
		completed += len(publicationBatch)
		reportProgress()
		publicationBatch = publicationBatch[:0]
		publicationBytes = 0
		return nil
	}
	for _, publication := range archive.Publications {
		rowBytes := len(publication.PublicID) + len(publication.LegacyID) + len(publication.DocumentID) + len(publication.Title) + len(publication.Content) + len(publication.ContentMode)
		if len(publicationBatch) > 0 && (len(publicationBatch) >= legacyStageBatchRows || publicationBytes+rowBytes > legacyStageBatchBytes) {
			if err := flushPublications(); err != nil {
				return result, err
			}
		}
		publicationBatch = append(publicationBatch, publication)
		publicationBytes += rowBytes
	}
	if err := flushPublications(); err != nil {
		return result, err
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

func stageLegacyWorkspaceBatch(ctx context.Context, tx *sql.Tx, legacyIDs []string) (int, error) {
	result, err := tx.ExecContext(ctx, `
		INSERT INTO legacy_workspaces (legacy_id)
		SELECT legacy_id FROM unnest($1::text[]) AS incoming(legacy_id)
		ON CONFLICT (legacy_id) DO NOTHING`, legacyIDs)
	if err != nil {
		return 0, err
	}
	inserted, err := result.RowsAffected()
	return int(inserted), err
}

func stageLegacyDocumentBatch(ctx context.Context, tx *sql.Tx, batch []legacyDocumentRow) (int, error) {
	legacyIDs := make([]string, len(batch))
	documentIDs := make([]string, len(batch))
	ciphertexts := make([]string, len(batch))
	documentHashes := make([]string, len(batch))
	for i, row := range batch {
		legacyIDs[i], documentIDs[i], ciphertexts[i], documentHashes[i] = row.legacyID, row.documentID, row.ciphertext, row.documentHash
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO legacy_documents (legacy_id, document_id, ciphertext, document_hash)
		SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
		ON CONFLICT (legacy_id, document_id) DO NOTHING`, legacyIDs, documentIDs, ciphertexts, documentHashes)
	if err != nil {
		return 0, err
	}
	inserted64, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	inserted := int(inserted64)
	if inserted == len(batch) {
		return inserted, nil
	}
	var matching int
	err = tx.QueryRowContext(ctx, `
		SELECT count(*)
		FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
			AS incoming(legacy_id, document_id, ciphertext, document_hash)
		JOIN legacy_documents AS existing USING (legacy_id, document_id)
		WHERE existing.ciphertext = incoming.ciphertext
			AND existing.document_hash = incoming.document_hash`, legacyIDs, documentIDs, ciphertexts, documentHashes).Scan(&matching)
	if err != nil {
		return 0, err
	}
	if matching != len(batch) {
		return 0, fmt.Errorf("legacy document collision: %w", ErrExists)
	}
	return inserted, nil
}

func stageLegacyPublicationBatch(ctx context.Context, tx *sql.Tx, batch []LegacyPublication) (int, error) {
	publicIDs := make([]string, len(batch))
	legacyIDs := make([]string, len(batch))
	documentIDs := make([]string, len(batch))
	titles := make([]string, len(batch))
	contents := make([]string, len(batch))
	contentModes := make([]string, len(batch))
	for i, publication := range batch {
		publicIDs[i], legacyIDs[i], documentIDs[i] = publication.PublicID, publication.LegacyID, publication.DocumentID
		titles[i], contents[i], contentModes[i] = publication.Title, publication.Content, publication.ContentMode
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO legacy_publications (public_id, legacy_id, document_id, title, content, content_mode)
		SELECT public_id, NULLIF(legacy_id, ''), NULLIF(document_id, ''), title, content, content_mode
		FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
			AS incoming(public_id, legacy_id, document_id, title, content, content_mode)
		ON CONFLICT (public_id) DO NOTHING`, publicIDs, legacyIDs, documentIDs, titles, contents, contentModes)
	if err != nil {
		return 0, err
	}
	inserted64, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	inserted := int(inserted64)
	if inserted == len(batch) {
		return inserted, nil
	}
	var matching int
	err = tx.QueryRowContext(ctx, `
		SELECT count(*)
		FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
			AS incoming(public_id, legacy_id, document_id, title, content, content_mode)
		JOIN legacy_publications AS existing USING (public_id)
		WHERE COALESCE(existing.legacy_id, '') = incoming.legacy_id
			AND COALESCE(existing.document_id, '') = incoming.document_id
			AND existing.title = incoming.title
			AND existing.content = incoming.content
			AND existing.content_mode = incoming.content_mode`, publicIDs, legacyIDs, documentIDs, titles, contents, contentModes).Scan(&matching)
	if err != nil {
		return 0, err
	}
	if matching != len(batch) {
		return 0, fmt.Errorf("legacy publication collision: %w", ErrExists)
	}
	return inserted, nil
}
