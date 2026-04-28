<?php
declare(strict_types=1);

namespace App;

final class Slug
{
    public const PATTERN = '/^[a-z0-9][a-z0-9-]{0,119}$/';
    public const MAX_LEN = 120;

    public static function validate(string $slug): bool
    {
        return preg_match(self::PATTERN, $slug) === 1;
    }

    /**
     * Convert a free-form title into a valid slug.
     * Returns "diagram-XXXXXXXX" if the title produces an empty result.
     */
    public static function fromTitle(string $title): string
    {
        $s = trim($title);

        // Best-effort transliteration unicode → ASCII
        if (function_exists('transliterator_transliterate')) {
            $t = transliterator_transliterate('Any-Latin; Latin-ASCII; [:Nonspacing Mark:] Remove; Lower();', $s);
            if ($t !== false) {
                $s = $t;
            } else {
                $s = strtolower($s);
            }
        } else {
            $s = strtolower($s);
            if (function_exists('iconv')) {
                $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
                if ($t !== false) {
                    $s = $t;
                }
            }
        }

        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        $s = trim($s, '-');
        $s = substr($s, 0, self::MAX_LEN);
        $s = trim($s, '-');

        if ($s === '' || !self::validate($s)) {
            return 'diagram-' . bin2hex(random_bytes(4));
        }
        return $s;
    }

    /**
     * Append a numeric suffix to make slug unique among existing slugs.
     * `$exists` is a callback that returns true if the slug already exists.
     */
    public static function ensureUnique(string $base, callable $exists): string
    {
        if (!$exists($base)) {
            return $base;
        }
        for ($i = 2; $i <= 1000; $i++) {
            $candidate = substr($base, 0, self::MAX_LEN - strlen("-$i")) . "-$i";
            if (!$exists($candidate)) {
                return $candidate;
            }
        }
        // extremely unlikely fallback
        return $base . '-' . bin2hex(random_bytes(4));
    }
}
