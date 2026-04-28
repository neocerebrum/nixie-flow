-- Aquata Phase 2: soft-delete for diagrams.
-- Diagrams with deleted_at IS NOT NULL are hidden from listings and accessible only to admins.

ALTER TABLE diagrams ADD COLUMN deleted_at TIMESTAMP NULL;

CREATE INDEX idx_diagrams_deleted ON diagrams(deleted_at);
