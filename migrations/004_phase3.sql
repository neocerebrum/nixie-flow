-- Aquata Phase 3: collaborative editing (lock + edit-requests + sharing).
-- Note: diagrams.edit_lock_user/edit_lock_at, diagram_shares, edit_requests
-- already exist from migration 001. This migration only adds:
--   * an optional note on edit_requests so requesters can explain context
--   * indexes that support lock-cleanup and share-list queries

ALTER TABLE edit_requests ADD COLUMN note TEXT NULL;

CREATE INDEX idx_diagrams_lock_user ON diagrams(edit_lock_user);
CREATE INDEX idx_shares_user        ON diagram_shares(user_id);
