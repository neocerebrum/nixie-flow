<?php
declare(strict_types=1);

namespace App;

final class I18n
{
    private const SUPPORTED  = ['en', 'it', 'fr', 'de', 'es', 'pt', 'zh', 'ja', 'ko'];
    private const FALLBACK   = 'en';
    private const COOKIE     = 'nixieflow_lang';
    private const COOKIE_TTL = 365 * 86400;

    private static string $locale  = self::FALLBACK;
    private static array  $strings = [];

    public static function init(): void
    {
        self::$locale  = self::detectLocale();
        self::$strings = self::loadStrings(self::$locale);
    }

    public static function locale(): string
    {
        return self::$locale;
    }

    public static function setLocale(string $locale): void
    {
        if (!in_array($locale, self::SUPPORTED, true)) {
            return;
        }
        self::$locale  = $locale;
        self::$strings = self::loadStrings($locale);
        setcookie(self::COOKIE, $locale, [
            'expires'  => time() + self::COOKIE_TTL,
            'path'     => '/',
            'httponly'  => false,
            'samesite' => 'Lax',
            'secure'   => Http::isHttps(),
        ]);
    }

    public static function get(string $key, mixed ...$args): string
    {
        $str = self::$strings[$key] ?? self::fallback($key);
        return $args ? sprintf($str, ...$args) : $str;
    }

    /** All keys starting with "js." — prefix stripped for the frontend. */
    public static function jsStrings(): array
    {
        $out = [];
        foreach (self::$strings as $k => $v) {
            if (str_starts_with($k, 'js.')) {
                $out[substr($k, 3)] = $v;
            }
        }
        return $out;
    }

    public static function supportedLocales(): array
    {
        return self::SUPPORTED;
    }

    // ── private ──────────────────────────────────────────────────

    private static function detectLocale(): string
    {
        $cookie = $_COOKIE[self::COOKIE] ?? null;
        if ($cookie !== null && in_array($cookie, self::SUPPORTED, true)) {
            return $cookie;
        }

        $header = $_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '';
        if ($header !== '') {
            $langs = [];
            foreach (explode(',', $header) as $part) {
                $part = trim($part);
                if ($part === '') continue;
                $bits = explode(';', $part, 2);
                $tag  = strtolower(trim($bits[0]));
                $q    = 1.0;
                if (isset($bits[1]) && preg_match('/q\s*=\s*([\d.]+)/', $bits[1], $m)) {
                    $q = (float) $m[1];
                }
                $langs[] = [$tag, $q];
            }
            usort($langs, fn($a, $b) => $b[1] <=> $a[1]);

            foreach ($langs as [$tag]) {
                if (in_array($tag, self::SUPPORTED, true)) {
                    return $tag;
                }
                $prefix = explode('-', $tag)[0];
                if (in_array($prefix, self::SUPPORTED, true)) {
                    return $prefix;
                }
            }
        }

        return self::FALLBACK;
    }

    private static function loadStrings(string $locale): array
    {
        $path = NIXIEFLOW_ROOT . '/lang/' . $locale . '.php';
        return is_file($path) ? require $path : [];
    }

    private static function fallback(string $key): string
    {
        if (self::$locale !== self::FALLBACK) {
            static $fb = null;
            $fb ??= self::loadStrings(self::FALLBACK);
            if (isset($fb[$key])) {
                return $fb[$key];
            }
        }
        return $key;
    }
}
