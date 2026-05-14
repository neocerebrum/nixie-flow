<?php
declare(strict_types=1);

namespace App;

use PDO;
use RuntimeException;

final class Schema
{
    private const BASELINE_VERSION = 13;

    private const BASELINE_SQL = <<<'SQL'
CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  display_name      TEXT,
  role              TEXT NOT NULL DEFAULT 'user',
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  disabled_at       TIMESTAMP NULL,
  last_login_at     TIMESTAMP NULL,
  email_verified_at TIMESTAMP NULL
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
  id                 INTEGER PRIMARY KEY,
  diagram_id         INTEGER NOT NULL,
  parent_id          INTEGER,
  source             TEXT NOT NULL,
  layout             TEXT,
  author_id          INTEGER NOT NULL,
  message            TEXT,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_current         INTEGER NOT NULL DEFAULT 0,
  source_revision_id INTEGER,
  FOREIGN KEY (diagram_id)         REFERENCES diagrams(id),
  FOREIGN KEY (parent_id)          REFERENCES diagram_revisions(id),
  FOREIGN KEY (author_id)          REFERENCES users(id),
  FOREIGN KEY (source_revision_id) REFERENCES diagram_revisions(id)
);
CREATE INDEX idx_rev_diagram ON diagram_revisions(diagram_id);
CREATE INDEX idx_rev_parent  ON diagram_revisions(parent_id);
CREATE INDEX idx_rev_current ON diagram_revisions(diagram_id, is_current);

CREATE TABLE branches (
  id              INTEGER PRIMARY KEY,
  diagram_id      INTEGER NOT NULL,
  name            VARCHAR(100) NOT NULL,
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
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
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
  ip           VARCHAR(45) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  success      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, attempted_at);
CREATE INDEX idx_login_attempts_ip_time    ON login_attempts(ip, attempted_at);

CREATE TABLE rate_buckets (
  scope_key    VARCHAR(128) NOT NULL,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_key, window_start)
);
CREATE INDEX idx_rate_buckets_window ON rate_buckets(window_start);

CREATE TABLE email_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  used_at    TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, kind);
CREATE INDEX idx_email_tokens_expires ON email_tokens(expires_at);

CREATE TABLE diagram_viewers (
  diagram_id       INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  joined_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  active_tab_id    VARCHAR(64),
  selection_json   TEXT,
  selection_at     TIMESTAMP NULL,
  view_state       TEXT,
  is_following     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (diagram_id, user_id),
  FOREIGN KEY (diagram_id) REFERENCES diagrams(id),
  FOREIGN KEY (user_id)    REFERENCES users(id)
);
CREATE INDEX idx_viewers_diagram_seen ON diagram_viewers(diagram_id, last_seen_at);
SQL;

    // BRIDGE: one-shot upgrade from previous baseline to current. Set both
    // constants when a schema change ships, then delete after every running
    // instance is on BASELINE_VERSION.
    private const BRIDGE_FROM = 12;
    // v13: per-viewer viewport sync for the "follow holder" feature.
    // `view_state` stores the holder's last broadcast {x,y,w,h}; `is_following`
    // marks viewers who are currently mirroring the holder's pan/zoom.
    private const BRIDGE_SQL  = <<<'SQL'
ALTER TABLE diagram_viewers ADD COLUMN view_state TEXT;
ALTER TABLE diagram_viewers ADD COLUMN is_following INTEGER NOT NULL DEFAULT 0;
SQL;

    private static bool $checked = false;

    public static function ensure(PDO $pdo): void
    {
        if (self::$checked) {
            return;
        }
        self::$checked = true;

        $isMysql = Db::driver() === 'mysql';
        if ($isMysql) {
            $pdo->exec('CREATE TABLE IF NOT EXISTS schema_version (
                version    INT PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
        } else {
            $pdo->exec('CREATE TABLE IF NOT EXISTS schema_version (
                version    INTEGER PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )');
        }

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
            self::execMulti($pdo, self::adapt(self::BASELINE_SQL, $isMysql));
            self::recordVersion($pdo, self::BASELINE_VERSION);
            return;
        }

        if (self::BRIDGE_SQL !== null && $current === self::BRIDGE_FROM) {
            self::execMulti($pdo, self::adapt(self::BRIDGE_SQL, $isMysql));
            self::recordVersion($pdo, self::BASELINE_VERSION);
            return;
        }

        throw new RuntimeException(
            'DB schema at version ' . $current
            . '; no upgrade path to baseline ' . self::BASELINE_VERSION
        );
    }

    /**
     * Adapt the canonical SQL (SQLite-flavoured) for the target driver.
     * For MySQL/MariaDB:
     *   - INTEGER PRIMARY KEY → INT PRIMARY KEY AUTO_INCREMENT
     *   - TEXT UNIQUE         → VARCHAR(255) UNIQUE  (utf8mb4 max-key-len safe)
     *   - append InnoDB + utf8mb4 to every CREATE TABLE
     *   - quote reserved name `count` (used in rate_buckets)
     */
    private static function adapt(string $sql, bool $isMysql): string
    {
        if (!$isMysql) {
            return $sql;
        }
        $sql = preg_replace('/\bINTEGER\s+PRIMARY\s+KEY\b/', 'INT PRIMARY KEY AUTO_INCREMENT', $sql);
        $sql = preg_replace('/\bTEXT\s+UNIQUE\s+NOT\s+NULL\b/i', 'VARCHAR(255) UNIQUE NOT NULL', $sql);
        // Stop MariaDB legacy implicit ON UPDATE CURRENT_TIMESTAMP on nullable timestamps.
        $sql = preg_replace('/\bTIMESTAMP\s+NULL(?!\s+DEFAULT)/i', 'TIMESTAMP NULL DEFAULT NULL', $sql);
        // Append engine/charset to every CREATE TABLE ... ); block.
        $sql = preg_replace_callback(
            '/(CREATE\s+TABLE\s+\w+\s*\([^;]*?\))\s*;/is',
            fn($m) => $m[1] . ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
            $sql
        );
        return $sql;
    }

    /**
     * Execute a multi-statement SQL block one statement at a time.
     * PDO::exec multi-statement on MySQL is unreliable (silently stops on
     * some drivers/configs); splitting + running individually is safer.
     */
    private static function execMulti(PDO $pdo, string $sql): void
    {
        foreach (self::splitStatements($sql) as $stmt) {
            $pdo->exec($stmt);
        }
    }

    /** Naive ;-splitter. Our DDL has no ;-inside-quotes so this is safe. */
    private static function splitStatements(string $sql): array
    {
        $parts = preg_split('/;\s*(?:\r?\n|$)/', $sql);
        $out = [];
        foreach ($parts as $p) {
            $p = trim($p);
            if ($p !== '') $out[] = $p;
        }
        return $out;
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
