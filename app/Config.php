<?php
declare(strict_types=1);

namespace App;

final class Config
{
    private static array $values = [];
    private static bool $loaded = false;

    public static function load(string $envFile): void
    {
        if (self::$loaded) {
            return;
        }
        self::$loaded = true;

        if (!is_file($envFile)) {
            return;
        }

        $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            $eq = strpos($line, '=');
            if ($eq === false) {
                continue;
            }
            $key = trim(substr($line, 0, $eq));
            $value = ltrim(substr($line, $eq + 1));
            // Quoted values: keep the contents verbatim (allows # inside).
            if (strlen($value) >= 2
                && (($value[0] === '"' && ($end = strpos($value, '"', 1)) !== false)
                    || ($value[0] === "'" && ($end = strpos($value, "'", 1)) !== false))
            ) {
                $quote = $value[0];
                $value = substr($value, 1, $end - 1);
            } else {
                // Unquoted: strip inline " #..." comments (must be preceded by whitespace).
                if (preg_match('/^([^#]*?)\s+#.*$/', $value, $m)) {
                    $value = $m[1];
                }
                $value = rtrim($value);
            }
            self::$values[$key] = $value;
            $_ENV[$key] = $value;
            putenv("$key=$value");
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        if (array_key_exists($key, self::$values)) {
            return self::$values[$key];
        }
        $env = getenv($key);
        return $env === false ? $default : $env;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $v = self::get($key);
        if ($v === null) {
            return $default;
        }
        return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
    }

    public static function int(string $key, int $default = 0): int
    {
        $v = self::get($key);
        return $v === null ? $default : (int) $v;
    }
}
