<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

final class User
{
    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function byEmail(string $email): ?array
    {
        $stmt = db()->prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)');
        $stmt->execute([$email]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function create(string $email, string $passwordHash, string $displayName, string $role): int
    {
        $stmt = db()->prepare(
            'INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([strtolower($email), $passwordHash, $displayName, $role]);
        return (int) db()->lastInsertId();
    }

    public static function updateProfile(int $id, string $displayName): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$displayName, $id]);
    }

    public static function updatePassword(int $id, string $passwordHash): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$passwordHash, $id]);
    }

    public static function updateRole(int $id, string $role): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$role, $id]);
    }

    public static function setDisabled(int $id): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$id]);
    }

    public static function setEnabled(int $id): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET disabled_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$id]);
    }

    public static function recordLogin(int $id): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$id]);
    }

    /** @return array<int, array<string, mixed>> */
    public static function listAll(): array
    {
        return db()->query(
            'SELECT id, email, display_name, role, tier, disabled_at, last_login_at, created_at
             FROM users ORDER BY id ASC'
        )->fetchAll(PDO::FETCH_ASSOC);
    }

    public static function countActiveAdmins(): int
    {
        return (int) db()->query(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL"
        )->fetchColumn();
    }

    public static function isDisabled(array $user): bool
    {
        return !empty($user['disabled_at']);
    }

    public static function isEmailVerified(array $user): bool
    {
        return !empty($user['email_verified_at']);
    }

    public static function markEmailVerified(int $id): void
    {
        $stmt = db()->prepare(
            'UPDATE users SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND email_verified_at IS NULL'
        );
        $stmt->execute([$id]);
    }

    public static function createSelfService(string $email, string $passwordHash, string $displayName): int
    {
        $stmt = db()->prepare(
            "INSERT INTO users (email, password_hash, display_name, role, tier, email_verified_at)
             VALUES (?, ?, ?, 'user', 'demo', NULL)"
        );
        $stmt->execute([strtolower($email), $passwordHash, $displayName]);
        return (int) db()->lastInsertId();
    }

    /**
     * Hard-delete a user and all content they own. Only call after disabling.
     * Disables FK enforcement for the operation (SQLite / MySQL) to handle
     * author_id references in revisions authored on other users' diagrams.
     */
    public static function purge(int $id): void
    {
        $pdo    = db();
        $isMysql = \App\Db::driver() === 'mysql';

        if ($isMysql) {
            $pdo->exec('SET foreign_key_checks = 0');
        } else {
            $pdo->exec('PRAGMA foreign_keys = OFF');
        }

        try {
            $pdo->beginTransaction();

            // Diagram-level cascade (own diagrams)
            foreach ([
                'DELETE FROM diagram_prepare  WHERE diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?)',
                'DELETE FROM diagram_viewers  WHERE diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?)',
                'DELETE FROM diagram_shares   WHERE diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?)',
                'DELETE FROM edit_requests    WHERE diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?)',
                'DELETE FROM merge_requests   WHERE source_diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?) OR target_diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?)',
                'DELETE FROM diagram_revisions WHERE diagram_id IN (SELECT id FROM diagrams WHERE owner_id = ?)',
                'DELETE FROM diagrams          WHERE owner_id = ?',
            ] as $sql) {
                $count = substr_count($sql, '?');
                $pdo->prepare($sql)->execute(array_fill(0, $count, $id));
            }

            // Project-level cascade (own projects)
            $pdo->prepare('DELETE FROM project_shares WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)')->execute([$id]);
            $pdo->prepare('DELETE FROM projects        WHERE owner_id = ?')->execute([$id]);

            // Cross-diagram data (user as participant, not owner)
            $pdo->prepare('DELETE FROM diagram_viewers  WHERE user_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM diagram_shares   WHERE user_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM project_shares   WHERE user_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM edit_requests    WHERE requester_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM merge_requests   WHERE requester_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM diagram_revisions WHERE author_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM diagram_prepare  WHERE user_id = ?')->execute([$id]);

            // Tokens and session data
            $pdo->prepare('DELETE FROM api_tokens   WHERE user_id = ?')->execute([$id]);
            $pdo->prepare('DELETE FROM email_tokens WHERE user_id = ?')->execute([$id]);

            // Release any edit lock held on shared diagrams
            $pdo->prepare(
                'UPDATE diagrams SET edit_lock_user = NULL, edit_lock_at = NULL, edit_lock_agent_label = NULL WHERE edit_lock_user = ?'
            )->execute([$id]);

            $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        } finally {
            if ($isMysql) {
                $pdo->exec('SET foreign_key_checks = 1');
            } else {
                $pdo->exec('PRAGMA foreign_keys = ON');
            }
        }
    }

    public static function isDemo(array $user): bool
    {
        return ($user['tier'] ?? 'full') === 'demo';
    }

    public static function promoteToFull(int $id): void
    {
        db()->prepare(
            "UPDATE users SET tier = 'full', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )->execute([$id]);
        db()->prepare(
            'UPDATE diagrams SET expires_at = NULL WHERE owner_id = ? AND expires_at IS NOT NULL'
        )->execute([$id]);
    }
}
