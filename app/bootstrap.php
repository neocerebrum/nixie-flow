<?php
declare(strict_types=1);

define('AQUATA_ROOT', dirname(__DIR__));

spl_autoload_register(function (string $class): void {
    if (!str_starts_with($class, 'App\\')) {
        return;
    }
    $relative = substr($class, 4);
    $path = AQUATA_ROOT . '/app/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

App\Config::load(AQUATA_ROOT . '/.env');

$debug = App\Config::bool('APP_DEBUG', false);
error_reporting(E_ALL);
ini_set('display_errors', $debug ? '1' : '0');
ini_set('log_errors', '1');

set_exception_handler(function (\Throwable $e) use ($debug): void {
    error_log('[Aquata] ' . $e::class . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (PHP_SAPI === 'cli') {
        fwrite(STDERR, $e::class . ': ' . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
        exit(1);
    }
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    $payload = ['error' => 'Internal Server Error'];
    if ($debug) {
        $payload['detail'] = $e::class . ': ' . $e->getMessage();
        $payload['trace'] = explode("\n", $e->getTraceAsString());
    }
    echo json_encode($payload);
    exit;
});

if (PHP_SAPI !== 'cli') {
    $sessionName = App\Config::get('SESSION_NAME', 'aquata_sid');
    $sessionLifetime = App\Config::int('SESSION_LIFETIME', 86400);
    $secureCookie = App\Http::isHttps();
    session_name($sessionName);
    session_set_cookie_params([
        'lifetime' => $sessionLifetime,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $secureCookie,
    ]);
    session_start();
    App\Response::applySecurityHeaders();
    App\I18n::init();
}

function db(): PDO
{
    return App\Db::connect();
}

function e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function __(string $key, mixed ...$args): string
{
    return App\I18n::get($key, ...$args);
}

/**
 * Static asset URL with a content-version query (file mtime) so browsers fetch
 * the new file after each deploy instead of serving a stale cached copy.
 * $path is web-absolute, e.g. "/static/editor.js".
 */
function asset(string $path): string
{
    $full = AQUATA_ROOT . $path;
    $v = is_file($full) ? (int) @filemtime($full) : 0;
    return $path . ($v ? ('?v=' . $v) : '');
}

App\View::init(AQUATA_ROOT . '/templates');
