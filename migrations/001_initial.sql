-- Aquata initial schema (Phase 0).
-- Common SQL subset compatible with SQLite and MySQL/MariaDB.
-- Adapt for MySQL: replace "INTEGER PRIMARY KEY" with "INT AUTO_INCREMENT PRIMARY KEY".

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE diagrams (
  id               INTEGER PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  title            TEXT,
  owner_id         INTEGER NOT NULL,
  head_revision_id INTEGER,
  edit_lock_user   INTEGER,
  edit_lock_at     TIMESTAMP,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX idx_diagrams_owner ON diagrams(owner_id);

CREATE TABLE diagram_revisions (
  id          INTEGER PRIMARY KEY,
  diagram_id  INTEGER NOT NULL,
  parent_id   INTEGER,
  source      TEXT NOT NULL,
  layout      TEXT,
  author_id   INTEGER NOT NULL,
  message     TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (diagram_id) REFERENCES diagrams(id),
  FOREIGN KEY (parent_id)  REFERENCES diagram_revisions(id),
  FOREIGN KEY (author_id)  REFERENCES users(id)
);

CREATE INDEX idx_rev_diagram ON diagram_revisions(diagram_id);
CREATE INDEX idx_rev_parent  ON diagram_revisions(parent_id);

CREATE TABLE branches (
  id              INTEGER PRIMARY KEY,
  diagram_id      INTEGER NOT NULL,
  name            TEXT NOT NULL,
  tip_revision_id INTEGER NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(diagram_id, name),
  FOREIGN KEY (diagram_id)      REFERENCES diagrams(id),
  FOREIGN KEY (tip_revision_id) REFERENCES diagram_revisions(id)
);

CREATE TABLE diagram_shares (
  diagram_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  permission TEXT NOT NULL,
  shared_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (diagram_id, user_id),
  FOREIGN KEY (diagram_id) REFERENCES diagrams(id),
  FOREIGN KEY (user_id)    REFERENCES users(id)
);

CREATE TABLE edit_requests (
  id           INTEGER PRIMARY KEY,
  diagram_id   INTEGER NOT NULL,
  requester_id INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at  TIMESTAMP,
  FOREIGN KEY (diagram_id)   REFERENCES diagrams(id),
  FOREIGN KEY (requester_id) REFERENCES users(id)
);

CREATE INDEX idx_edit_req_diagram ON edit_requests(diagram_id, status);

CREATE TABLE api_tokens (
  token_hash   CHAR(64) PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  label        TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_tokens_user ON api_tokens(user_id);
