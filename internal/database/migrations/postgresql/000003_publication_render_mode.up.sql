ALTER TABLE publications ADD COLUMN render_mode TEXT NOT NULL DEFAULT 'document'
    CHECK (render_mode IN ('document', 'html', 'markdown-html'));
