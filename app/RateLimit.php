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
     * Count failed attempts from this IP in the window. Used to block
     * brute-force from a single source. Self-DoS-safe: an attacker on a
     * different IP cannot raise this counter for the victim.
     */
    public static function recentFailuresByIp(string $ip, int $windowSec): int
    {
        $since = date('Y-m-d H:i:s', time() - $windowSec);
        $stmt = db()->prepare(
            'SELECT COUNT(*) FROM login_attempts
             WHERE attempted_at >= ? AND success = 0 AND ip = ?'
        );
        $stmt->execute([$since, $ip]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Count failed attempts on this email since the most recent successful
     * login on the same email (within the window). A successful login resets
     * the counter; a legitimate user typing the right password clears any
     * lockout that an attacker (from another IP) caused.
     */
    public static function recentFailuresByEmail(string $email, int $windowSec): int
    {
        $since = date('Y-m-d H:i:s', time() - $windowSec);
        $pdo = db();
        $stmt = $pdo->prepare(
            'SELECT MAX(attempted_at) FROM login_attempts
             WHERE LOWER(email) = LOWER(?) AND success = 1 AND attempted_at >= ?'
        );
        $stmt->execute([$email, $since]);
        $lastSuccess = $stmt->fetchColumn();
        $cutoff = is_string($lastSuccess) && $lastSuccess !== '' ? $lastSuccess : $since;

        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM login_attempts
             WHERE attempted_at > ? AND success = 0 AND LOWER(email) = LOWER(?)'
        );
        $stmt->execute([$cutoff, $email]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * True if this email has ever logged in successfully from this IP within
     * the trust window (default 30d). Lets us bypass the email lockout for
     * the legitimate owner's known device, neutralising the rotating-IP DoS.
     */
    public static function isKnownGoodIp(string $email, string $ip, int $windowSec): bool
    {
        $since = date('Y-m-d H:i:s', time() - $windowSec);
        $stmt = db()->prepare(
            'SELECT 1 FROM login_attempts
             WHERE LOWER(email) = LOWER(?) AND ip = ? AND success = 1 AND attempted_at >= ?
             LIMIT 1'
        );
        $stmt->execute([$email, $ip, $since]);
        return $stmt->fetchColumn() !== false;
    }

    public static function cleanupOld(int $olderThanSec = 86400): void
    {
        $cutoff = date('Y-m-d H:i:s', time() - $olderThanSec);
        $stmt = db()->prepare('DELETE FROM login_attempts WHERE attempted_at < ?');
        $stmt->execute([$cutoff]);
    }

    public static function clientIp(): string
    {
        return Http::clientIp();
    }

    /**
     * Fixed-window counter: increments the bucket for ($scope, current window)
     * and returns ['count' => N, 'limit' => L, 'allowed' => bool, 'retry_after' => sec].
     * limit <= 0 means unlimited (always allowed).
     */
    public static function hit(string $scope, int $windowSec, int $limit): array
    {
        if ($limit <= 0 || $windowSec <= 0) {
            return ['count' => 0, 'limit' => $limit, 'allowed' => true, 'retry_after' => 0];
        }
        $now = time();
        $window = intdiv($now, $windowSec) * $windowSec;
        $pdo = db();

        if (Db::driver() === 'mysql') {
            $sql = 'INSERT INTO rate_buckets (scope_key, window_start, hits) VALUES (?, ?, 1)
                    ON DUPLICATE KEY UPDATE hits = hits + 1';
        } else {
            $sql = 'INSERT INTO rate_buckets (scope_key, window_start, hits) VALUES (?, ?, 1)
                    ON CONFLICT(scope_key, window_start) DO UPDATE SET hits = hits + 1';
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$scope, $window]);

        $stmt = $pdo->prepare(
            'SELECT hits FROM rate_buckets WHERE scope_key = ? AND window_start = ?'
        );
        $stmt->execute([$scope, $window]);
        $count = (int) $stmt->fetchColumn();

        if (random_int(1, 200) === 1) {
            self::cleanupBuckets($windowSec);
        }

        $allowed = $count <= $limit;
        $retryAfter = $allowed ? 0 : max(1, ($window + $windowSec) - $now);
        return ['count' => $count, 'limit' => $limit, 'allowed' => $allowed, 'retry_after' => $retryAfter];
    }

    public static function cleanupBuckets(int $windowSec): void
    {
        $cutoff = time() - max($windowSec * 4, 600);
        $stmt = db()->prepare('DELETE FROM rate_buckets WHERE window_start < ?');
        $stmt->execute([$cutoff]);
    }

    /**
     * High-level throttle for /api and /mcp.
     * Applies IP, user (or token), and (if write) write-counter limits.
     * Sets X-RateLimit-* headers and aborts with 429 when over.
     *
     * @param 'api'|'mcp' $context
     */
    public static function throttle(string $context, ?array $user, ?string $tokenHash, bool $isWrite): void
    {
        $window = 60;
        $ip = self::clientIp();
        $checks = [];

        $ipLimit = Config::int('RATE_API_PER_IP_PER_MIN', 600);
        $checks[] = ["$context:ip:$ip", $ipLimit];

        if ($tokenHash !== null) {
            $tokLimit = $context === 'mcp'
                ? Config::int('RATE_MCP_PER_TOKEN_PER_MIN', 120)
                : Config::int('RATE_API_PER_TOKEN_PER_MIN', 120);
            $tokKey = substr($tokenHash, 0, 16);
            $checks[] = ["$context:token:$tokKey", $tokLimit];
            if ($isWrite) {
                $wLimit = $context === 'mcp'
                    ? Config::int('RATE_MCP_WRITE_PER_TOKEN_PER_MIN', 30)
                    : Config::int('RATE_API_WRITE_PER_TOKEN_PER_MIN', 30);
                $checks[] = ["$context:write:token:$tokKey", $wLimit];
            }
        } elseif ($user !== null) {
            $userLimit = Config::int('RATE_API_PER_USER_PER_MIN', 300);
            $checks[] = ["$context:user:" . (int) $user['id'], $userLimit];
            if ($isWrite) {
                $wLimit = Config::int('RATE_API_WRITE_PER_USER_PER_MIN', 30);
                $checks[] = ["$context:write:user:" . (int) $user['id'], $wLimit];
            }
        }

        $worst = null;
        foreach ($checks as [$key, $limit]) {
            $r = self::hit($key, $window, $limit);
            if (!$r['allowed'] && ($worst === null || $r['retry_after'] > $worst['retry_after'])) {
                $worst = $r;
            }
        }

        if ($worst !== null && PHP_SAPI !== 'cli' && !headers_sent()) {
            header('Retry-After: ' . $worst['retry_after']);
            header('X-RateLimit-Limit: ' . $worst['limit']);
            header('X-RateLimit-Remaining: 0');
        }
        if ($worst !== null) {
            Response::json([
                'error'       => 'rate_limited',
                'retry_after' => $worst['retry_after'],
                'limit'       => $worst['limit'],
            ], 429);
        }
    }
}
