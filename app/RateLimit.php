<?php
declare(strict_types=1);

namespace App;

final class RateLimit
{
    /**
     * Record a login attempt (success or failure).
     */
    public static function recordLoginAttempt(string $ip, string $email, bool $success): void
    {
        $stmt = db()->prepare(
            'INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, ?)'
        );
        $stmt->execute([$ip, strtolower($email), $success ? 1 : 0]);

        if (random_int(1, 50) === 1) {
            self::cleanupOld();
        }
    }

    /**
     * Count failed login attempts in the last $windowSec for the given email or IP.
     * Counts only failures since the last successful login (if any) within the window.
     */
    public static function recentFailures(string $ip, string $email, int $windowSec): int
    {
        $since = date('Y-m-d H:i:s', time() - $windowSec);
        $stmt = db()->prepare(
            'SELECT COUNT(*) FROM login_attempts
             WHERE attempted_at >= ?
               AND success = 0
               AND (LOWER(email) = LOWER(?) OR ip = ?)'
        );
        $stmt->execute([$since, $email, $ip]);
        return (int) $stmt->fetchColumn();
    }

    public static function cleanupOld(int $olderThanSec = 86400): void
    {
        $cutoff = date('Y-m-d H:i:s', time() - $olderThanSec);
        $stmt = db()->prepare('DELETE FROM login_attempts WHERE attempted_at < ?');
        $stmt->execute([$cutoff]);
    }

    public static function clientIp(): string
    {
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }
}
