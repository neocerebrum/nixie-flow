<?php
declare(strict_types=1);

/**
 * Router for PHP's built-in dev server (local development ONLY — never deployed;
 * production uses Apache + .htaccess instead).
 *
 *   php -S localhost:8080 scripts/dev_router.php
 *
 * The built-in server has no mod_rewrite: without this file every request,
 * including /static/*, would be handed to index.php and 404. Static assets are
 * served directly; everything else goes through the front controller.
 */

$root = dirname(__DIR__);
$path = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Only /static/ is ever served as-is — mirrors what .htaccess exposes in
// production (and keeps .env, data/, app/ unreachable over HTTP).
if (str_starts_with($path, '/static/') && is_file($root . $path)) {
    return false; // let the built-in server serve the file
}

require $root . '/index.php';
