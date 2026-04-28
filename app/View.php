<?php
declare(strict_types=1);

namespace App;

use RuntimeException;

final class View
{
    private static string $templateDir;

    public static function init(string $templateDir): void
    {
        self::$templateDir = rtrim($templateDir, '/');
    }

    /**
     * Render a template inside the layout. Echoes and exits.
     *
     * @param string $template  Path relative to templates/, without .php (e.g. "auth/login")
     * @param array  $vars      Vars extracted into the template scope
     * @param array  $layoutVars Extra vars for layout (e.g. page title, active nav)
     */
    public static function render(string $template, array $vars = [], array $layoutVars = []): never
    {
        $body = self::capture($template, $vars);
        $layoutVars['body'] = $body;
        $layoutVars['currentUser'] = Auth::currentUser();
        $layoutVars['title'] ??= 'Aquata';
        $layoutVars['active'] ??= '';
        $html = self::capture('layout', $layoutVars);

        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        echo $html;
        exit;
    }

    /** Render without layout wrapper (for fragments / partials called directly). */
    public static function renderRaw(string $template, array $vars = []): never
    {
        $html = self::capture($template, $vars);
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        echo $html;
        exit;
    }

    public static function capture(string $template, array $vars = []): string
    {
        $path = self::$templateDir . '/' . $template . '.php';
        if (!is_file($path)) {
            throw new RuntimeException("Template not found: $template");
        }
        ob_start();
        (function () use ($path, $vars) {
            extract($vars, EXTR_SKIP);
            include $path;
        })();
        return (string) ob_get_clean();
    }
}
