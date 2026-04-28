<?php
declare(strict_types=1);

namespace App;

use PDO;
use RuntimeException;

final class Schema
{
    private const BASELINE_VERSION = 4;

    private const BASELINE_SQL = <<<'SQL'
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  disabled_at   TIMESTAMP NULL,
  last_login_at TIMESTAMP NULL
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
  deleted_at       TIMESTAMP NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE INDEX idx_diagrams_owner     ON diagrams(owner_id);
CREATE INDEX idx_diagrams_deleted   ON diagrams(deleted_at);
CREATE INDEX idx_diagrams_lock_user ON diagrams(edit_lock_user);

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
CREATE INDEX idx_shares_user ON diagram_shares(user_id);

CREATE TABLE edit_requests (
  id           INTEGER PRIMARY KEY,
  diagram_id   INTEGER NOT NULL,
  requester_id INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at  TIMESTAMP,
  note         TEXT NULL,
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

CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY,
  ip           TEXT NOT NULL,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  success      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, attempted_at);
CREATE INDEX idx_login_attempts_ip_time    ON login_attempts(ip, attempted_at);
SQL;

    // BRIDGE: one-shot upgrade from previous baseline to current. Set both
    // constants when a schema change ships, then delete after every running
    // instance is on BASELINE_VERSION.
    private const BRIDGE_FROM = null;
    private const BRIDGE_SQL  = null;

    private static bool $checked = false;

    public static function ensure(PDO $pdo): void
    {
        if (self::$checked) {
            return;
        }
        self::$checked = true;

        $pdo->exec('CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )');

        $current = self::currentVersion($pdo);

        if ($current === self::BASELINE_VERSION) {
            return;
        }

        if ($current === 0) {
            // Either a brand-new DB, or a legacy DB that pre-dates schema_version.
            // If core tables already exist, adopt the existing schema as baseline.
            if (self::usersTableExists($pdo)) {
                self::recordVersion($pdo, self::BASELINE_VERSION);
                return;
            }
            $pdo->exec(self::BASELINE_SQL);
            self::recordVersion($pdo, self::BASELINE_VERSION);
            return;
        }

        if (self::BRIDGE_SQL !== null && $current === self::BRIDGE_FROM) {
            $pdo->exec(self::BRIDGE_SQL);
            self::recordVersion($pdo, self::BASELINE_VERSION);
            return;
        }

        throw new RuntimeException(
            'DB schema at version ' . $current
            . '; no upgrade path to baseline ' . self::BASELINE_VERSION
        );
    }

    private static function currentVersion(PDO $pdo): int
    {
        $row = $pdo->query('SELECT MAX(version) AS v FROM schema_version')->fetch();
        return (int) ($row['v'] ?? 0);
    }

    private static function recordVersion(PDO $pdo, int $version): void
    {
        $stmt = $pdo->prepare('INSERT INTO schema_version (version) VALUES (?)');
        $stmt->execute([$version]);
    }

    private static function usersTableExists(PDO $pdo): bool
    {
        if (Db::driver() === 'sqlite') {
            $stmt = $pdo->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'");
        } else {
            $stmt = $pdo->query("SHOW TABLES LIKE 'users'");
        }
        return (bool) $stmt->fetchColumn();
    }
}
