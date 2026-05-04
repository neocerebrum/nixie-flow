<?php
declare(strict_types=1);

namespace App;

use App\Models\ApiToken;
use App\Models\User;

final class Auth
{
    private const SESSION_KEY = '_user_id';
    private const FAILURE_WINDOW_SEC = 900;   // 15 minutes
    private const IP_FAILURE_LIMIT = 10;
    private const EMAIL_FAILURE_LIMIT = 10;
    private const KNOWN_GOOD_IP_WINDOW_SEC = 2592000; // 30 days

    /** Returns the current logged-in user row, or null. Re-checks disabled status on every call. */
    public static function currentUser(): ?array
    {
        $id = $_SESSION[self::SESSION_KEY] ?? null;
        if (!is_int($id)) {
            return null;
        }
        $user = User::byId($id);
        if ($user === null || User::isDisabled($user)) {
            self::logout();
            return null;
        }
        return $user;
    }

    public static function isLoggedIn(): bool
    {
        return self::currentUser() !== null;
    }

    public static function isAdmin(): bool
    {
        $u = self::currentUser();
        return $u !== null && ($u['role'] ?? null) === 'admin';
    }

    public static function requireLogin(): array
    {
        $u = self::currentUser();
        if ($u === null) {
            $next = $_SERVER['REQUEST_URI'] ?? '/';
            Response::redirect('/login?next=' . urlencode($next));
        }
        return $u;
    }

    public static function requireAdmin(): array
    {
        $u = self::requireLogin();
        if (($u['role'] ?? null) !== 'admin') {
            http_response_code(403);
            header('Content-Type: text/html; charset=utf-8');
            echo '<h1>403 Forbidden</h1><p>Admin access required.</p>';
            exit;
        }
        return $u;
    }

    /** Like requireLogin but returns JSON 401 instead of HTML redirect. */
    public static function requireLoginApi(): array
    {
        $u = self::currentUser();
        if ($u === null) {
            Response::error('Authentication required', 401);
        }
        return $u;
    }

    /**
     * Reads `Authorization: Bearer <token>` and returns the matching user, or null.
     * Used by the MCP endpoint and other token-authenticated APIs.
     */
    public static function bearerUser(): ?array
    {
        $header = self::readBearerHeader();
        if ($header === null) return null;
        return ApiToken::authenticate($header);
    }

    /** Like requireLoginApi but accepts session OR Bearer token. */
    public static function requireUserAny(): array
    {
        $u = self::bearerUser();
        if ($u !== null) return $u;
        return self::requireLoginApi();
    }

    private static function readBearerHeader(): ?string
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
        if (!$h && function_exists('apache_request_headers')) {
            $hdrs = apache_request_headers();
            foreach ($hdrs as $k => $v) {
                if (strcasecmp($k, 'Authorization') === 0) { $h = $v; break; }
            }
        }
        if (!is_string($h)) return null;
        if (stripos($h, 'Bearer ') !== 0) return null;
        $token = trim(substr($h, 7));
        return $token !== '' ? $token : null;
    }

    /** Like requireAdmin but returns JSON 401/403. */
    public static function requireAdminApi(): array
    {
        $u = self::requireLoginApi();
        if (($u['role'] ?? null) !== 'admin') {
            Response::error('Admin access required', 403);
        }
        return $u;
    }

    /**
     * Attempt login. Returns one of:
     *   'ok' | 'invalid' | 'disabled' | 'unverified' | 'rate_limited'.
     */
    public static function login(string $email, string $password): string
    {
        $email = trim($email);
        $ip = RateLimit::clientIp();

        $ipLimit    = Config::int('LOGIN_IP_FAILURE_LIMIT', self::IP_FAILURE_LIMIT);
        $emailLimit = Config::int('LOGIN_EMAIL_FAILURE_LIMIT', self::EMAIL_FAILURE_LIMIT);
        $window     = Config::int('LOGIN_FAILURE_WINDOW_SEC', self::FAILURE_WINDOW_SEC);

        if (RateLimit::recentFailuresByIp($ip, $window) >= $ipLimit) {
            return 'rate_limited';
        }
        if (RateLimit::recentFailuresByEmail($email, $window) >= $emailLimit
            && !RateLimit::isKnownGoodIp($email, $ip, self::KNOWN_GOOD_IP_WINDOW_SEC)
        ) {
            return 'rate_limited';
        }

        $user = User::byEmail($email);
        if ($user === null || !password_verify($password, $user['password_hash'])) {
            RateLimit::recordLoginAttempt($ip, $email, false);
            return 'invalid';
        }

        if (User::isDisabled($user)) {
            RateLimit::recordLoginAttempt($ip, $email, false);
            return 'disabled';
        }

        // Self-service signups are pending until email is verified. Admin-
        // provisioned accounts skip the email round-trip (email_verified_at
        // can be set at creation by Admin\UserController, see #signup-flow).
        if (Config::bool('REQUIRE_EMAIL_VERIFY', true) && !User::isEmailVerified($user)) {
            // Don't burn the brute-force counter for unverified-but-correct creds.
            return 'unverified';
        }

        RateLimit::recordLoginAttempt($ip, $email, true);
        User::recordLogin((int) $user['id']);

        session_regenerate_id(true);
        Csrf::rotate();
        $_SESSION[self::SESSION_KEY] = (int) $user['id'];

        return 'ok';
    }

    public static function logout(): void
    {
        $_SESSION = [];
        if (PHP_SAPI !== 'cli' && session_status() === PHP_SESSION_ACTIVE) {
            if (ini_get('session.use_cookies')) {
                $params = session_get_cookie_params();
                setcookie(
                    session_name(),
                    '',
                    time() - 42000,
                    $params['path'],
                    $params['domain'] ?? '',
                    (bool) ($params['secure'] ?? false),
                    (bool) ($params['httponly'] ?? false)
                );
            }
            session_destroy();
        }
    }

    public static function failureWindowMinutes(): int
    {
        return (int) ceil(self::FAILURE_WINDOW_SEC / 60);
    }
}
