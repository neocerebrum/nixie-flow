<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Bearer-token credential for MCP/API access.
 * Plaintext is shown only at creation; DB stores sha256(plaintext).
 *
 * Format: "aqt_" + 32 base64url chars (≈192 bits entropy).
 */
final class ApiToken
{
    public const PREFIX = 'aqt_';

    /** Returns the user row associated with a plaintext bearer token, or null. */
    public static function authenticate(string $plaintext): ?array
    {
        if ($plaintext === '' || strlen($plaintext) > 200) return null;
        $hash = hash('sha256', $plaintext);
        $stmt = db()->prepare(
            'SELECT t.*, u.id AS uid, u.email, u.display_name, u.role, u.disabled_at
             FROM api_tokens t
             INNER JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ?'
        );
        $stmt->execute([$hash]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) return null;
        if (!empty($row['disabled_at'])) return null;

        // Bump last_used_at (best-effort, ignore errors).
        try {
            $stmt2 = db()->prepare(
                'UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?'
            );
            $stmt2->execute([$hash]);
        } catch (\Throwable $_) { /* ignore */ }

        return [
            'id'           => (int) $row['uid'],
            'email'        => $row['email'],
            'display_name' => $row['display_name'],
            'role'         => $row['role'],
            'disabled_at'  => $row['disabled_at'],
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public static function listForUser(int $userId): array
    {
        $stmt = db()->prepare(
            'SELECT token_hash, label, created_at, last_used_at
             FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
        );
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Create a token for a user. Returns the plaintext (must be shown once,
     * then discarded — it cannot be retrieved later).
     */
    public static function create(int $userId, string $label): string
    {
        $plaintext = self::PREFIX . self::randomBase64Url(24);
        $hash = hash('sha256', $plaintext);
        $stmt = db()->prepare(
            'INSERT INTO api_tokens (token_hash, user_id, label) VALUES (?, ?, ?)'
        );
        $stmt->execute([$hash, $userId, $label]);
        return $plaintext;
    }

    /** Revoke a token by its hash (lookup is by hash since plaintext isn't stored). */
    public static function revokeByHash(int $userId, string $tokenHash): bool
    {
        $stmt = db()->prepare(
            'DELETE FROM api_tokens WHERE token_hash = ? AND user_id = ?'
        );
        $stmt->execute([$tokenHash, $userId]);
        return $stmt->rowCount() > 0;
    }

    /** Short fingerprint suitable for UI display (last 8 chars of the hash). */
    public static function fingerprint(string $tokenHash): string
    {
        return substr($tokenHash, -8);
    }

    private static function randomBase64Url(int $bytes): string
    {
        $raw = random_bytes($bytes);
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}
