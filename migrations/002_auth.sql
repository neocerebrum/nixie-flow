-- Aquata Phase 1: auth (login_attempts table + disabled_at / last_login_at on users)

ALTER TABLE users ADD COLUMN disabled_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL;

CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY,
  ip           TEXT NOT NULL,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  success      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, attempted_at);
CREATE INDEX idx_login_attempts_ip_time    ON login_attempts(ip, attempted_at);
