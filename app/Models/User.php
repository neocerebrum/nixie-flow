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
            'SELECT id, email, display_name, role, disabled_at, last_login_at, created_at
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
            "INSERT INTO users (email, password_hash, display_name, role, email_verified_at)
             VALUES (?, ?, ?, 'user', NULL)"
        );
        $stmt->execute([strtolower($email), $passwordHash, $displayName]);
        return (int) db()->lastInsertId();
    }
}
