<?php
declare(strict_types=1);

namespace App;

final class Csrf
{
    private const SESSION_KEY = '_csrf_token';

    public static function token(): string
    {
        if (empty($_SESSION[self::SESSION_KEY])) {
            $_SESSION[self::SESSION_KEY] = bin2hex(random_bytes(32));
        }
        return $_SESSION[self::SESSION_KEY];
    }

    public static function verify(?string $submitted): bool
    {
        if ($submitted === null || $submitted === '') {
            return false;
        }
        $expected = $_SESSION[self::SESSION_KEY] ?? '';
        if ($expected === '') {
            return false;
        }
        return hash_equals($expected, $submitted);
    }

    public static function rotate(): void
    {
        unset($_SESSION[self::SESSION_KEY]);
    }

    public static function requireValid(): void
    {
        $submitted = $_POST['_csrf'] ?? null;
        if (!self::verify(is_string($submitted) ? $submitted : null)) {
            Response::error('Invalid CSRF token', 403);
        }
    }

    /**
     * For JSON/REST endpoints. Reads from X-CSRF-Token header (preferred) or
     * _csrf in JSON body fallback. Always returns JSON 403 on failure.
     */
    public static function requireValidApi(): void
    {
        $submitted = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null;
        if ($submitted === null || !is_string($submitted)) {
            $submitted = $_POST['_csrf'] ?? null;
        }
        if (!self::verify(is_string($submitted) ? $submitted : null)) {
            Response::error('Invalid CSRF token', 403);
        }
    }
}
