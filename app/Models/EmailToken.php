<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Single-use email tokens for self-service signup verification and
 * password reset. Plaintext is delivered via email and never stored;
 * the DB stores sha256(plaintext).
 *
 * Format: 32 base64url chars (192 bits entropy).
 */
final class EmailToken
{
    public const KIND_VERIFY = 'verify';
    public const KIND_RESET  = 'reset';

    public const TTL_VERIFY_SEC = 86400;  // 24h
    public const TTL_RESET_SEC  = 3600;   // 1h

    public static function issue(int $userId, string $kind, int $ttlSec): string
    {
        if (!in_array($kind, [self::KIND_VERIFY, self::KIND_RESET], true)) {
            throw new \InvalidArgumentException("Unknown token kind: $kind");
        }
        $plaintext = self::randomBase64Url(24);
        $hash = hash('sha256', $plaintext);
        $expires = date('Y-m-d H:i:s', time() + $ttlSec);

        // Invalidate older same-kind tokens for the user (only the latest is valid).
        $stmt = db()->prepare(
            'UPDATE email_tokens SET used_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND kind = ? AND used_at IS NULL'
        );
        $stmt->execute([$userId, $kind]);

        $stmt = db()->prepare(
            'INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$hash, $userId, $kind, $expires]);
        return $plaintext;
    }

    /**
     * Look up a token by plaintext and consume it atomically.
     * Returns the row on success, null if not found / expired / already used.
     */
    public static function consume(string $plaintext, string $kind): ?array
    {
        if ($plaintext === '' || strlen($plaintext) > 200) return null;
        $hash = hash('sha256', $plaintext);
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $forUpdate = (\App\Db::driver() === 'mysql') ? ' FOR UPDATE' : '';
            $stmt = $pdo->prepare(
                'SELECT * FROM email_tokens
                 WHERE token_hash = ? AND kind = ?' . $forUpdate
            );
            $stmt->execute([$hash, $kind]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                $pdo->commit();
                return null;
            }
            if ($row['used_at'] !== null) {
                $pdo->commit();
                return null;
            }
            if (strtotime((string) $row['expires_at'] . ' UTC') < time()) {
                $pdo->commit();
                return null;
            }
            $upd = $pdo->prepare(
                'UPDATE email_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?'
            );
            $upd->execute([$hash]);
            $pdo->commit();
            return $row;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /** Best-effort cleanup of expired/used rows. Call probabilistically. */
    public static function gc(): void
    {
        $cutoff = date('Y-m-d H:i:s', time() - 7 * 86400);
        $stmt = db()->prepare(
            'DELETE FROM email_tokens
             WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?'
        );
        $stmt->execute([$cutoff, date('Y-m-d H:i:s', time())]);
    }

    private static function randomBase64Url(int $bytes): string
    {
        $raw = random_bytes($bytes);
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}
