<?php
declare(strict_types=1);

namespace App;

final class Json
{
    /** Max accepted body size for JSON requests (1 MiB). 413 if exceeded. */
    public const MAX_BODY_BYTES = 1048576;

    /**
     * Parse the request body as JSON object. Aborts with 400 / 413 on error.
     * Returns [] for empty body. Always returns associative array.
     */
    public static function readBody(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false) {
            Response::error('Cannot read request body', 400);
        }
        if (strlen($raw) > self::MAX_BODY_BYTES) {
            Response::error('Request body too large', 413);
        }
        if ($raw === '') {
            return [];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            Response::error('Invalid JSON body', 400);
        }
        return $data;
    }

    /** Read a string field with required/length validation. */
    public static function requireString(array $data, string $key, int $maxLen, bool $required = true): ?string
    {
        $v = $data[$key] ?? null;
        if ($v === null || $v === '') {
            if ($required) {
                Response::error("Missing required field: $key", 400);
            }
            return null;
        }
        if (!is_string($v)) {
            Response::error("Field $key must be a string", 400);
        }
        if (strlen($v) > $maxLen) {
            Response::error("Field $key too long (max $maxLen bytes)", 413);
        }
        return $v;
    }

    /** Read an int field with optional default. */
    public static function readInt(array $data, string $key, ?int $default = null): ?int
    {
        $v = $data[$key] ?? null;
        if ($v === null) {
            return $default;
        }
        if (!is_int($v) && !(is_string($v) && ctype_digit($v))) {
            Response::error("Field $key must be an integer", 400);
        }
        return (int) $v;
    }

    /** Read a JSON-encodable layout (any nested array/scalar/null). */
    public static function readLayout(array $data, string $key = 'layout'): ?string
    {
        $v = $data[$key] ?? null;
        if ($v === null) {
            return null;
        }
        // Force `positions` to always serialize as an object, never as [].
        // PHP turns empty assoc arrays into JSON arrays; JS then loses
        // custom string keys on subsequent JSON.stringify of that array.
        if (is_array($v) && array_key_exists('positions', $v)) {
            if (is_array($v['positions']) && $v['positions'] === []) {
                $v['positions'] = new \stdClass();
            }
        }
        if (is_array($v) && array_key_exists('edgeAnchors', $v)) {
            if (is_array($v['edgeAnchors']) && $v['edgeAnchors'] === []) {
                $v['edgeAnchors'] = new \stdClass();
            }
        }
        if (is_array($v) && array_key_exists('edgeBend', $v)) {
            if (is_array($v['edgeBend']) && $v['edgeBend'] === []) {
                $v['edgeBend'] = new \stdClass();
            }
        }
        $encoded = json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded === false) {
            Response::error("Field $key is not JSON-encodable", 400);
        }
        if (strlen($encoded) > 262144) {
            Response::error("Field $key too large (max 256 KiB)", 413);
        }
        return $encoded;
    }
}
