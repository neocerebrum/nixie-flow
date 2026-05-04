<?php
declare(strict_types=1);

namespace App;

final class Response
{
    public static function applySecurityHeaders(): void
    {
        if (PHP_SAPI === 'cli' || headers_sent()) {
            return;
        }
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: strict-origin-when-cross-origin');
        header('Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()');
        header('Cross-Origin-Opener-Policy: same-origin');

        if (Http::isHttps()) {
            $maxAge = Config::int('HSTS_MAX_AGE', 15552000);
            $hsts = "max-age=$maxAge; includeSubDomains";
            if (Config::bool('HSTS_PRELOAD', false)) {
                $hsts .= '; preload';
            }
            header("Strict-Transport-Security: $hsts");
        }

        $csp = Config::get('CSP_POLICY');
        if ($csp === null) {
            $csp = "default-src 'self'; "
                 . "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
                 . "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
                 . "img-src 'self' data: blob:; "
                 . "font-src 'self' data: https://cdnjs.cloudflare.com; "
                 . "connect-src 'self'; "
                 . "frame-ancestors 'none'; "
                 . "base-uri 'self'; "
                 . "form-action 'self'; "
                 . "object-src 'none'";
        }
        if ($csp !== '') {
            $reportOnly = Config::bool('CSP_REPORT_ONLY', false);
            $hdr = $reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
            header("$hdr: $csp");
        }
    }

    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function html(string $body, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: text/html; charset=utf-8');
        echo $body;
        exit;
    }

    public static function text(string $body, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: text/plain; charset=utf-8');
        echo $body;
        exit;
    }

    public static function redirect(string $location, int $status = 302): never
    {
        http_response_code($status);
        header('Cache-Control: no-store');
        header('Location: ' . $location);
        exit;
    }

    public static function notFound(string $msg = 'Not Found'): never
    {
        self::text($msg, 404);
    }

    public static function error(string $msg, int $status = 500): never
    {
        self::json(['error' => $msg], $status);
    }
}
