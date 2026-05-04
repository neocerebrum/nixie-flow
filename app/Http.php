<?php
declare(strict_types=1);

namespace App;

final class Http
{
    public static function isHttps(): bool
    {
        if (Config::bool('APP_FORCE_HTTPS', false)) {
            return true;
        }
        if (($_SERVER['HTTPS'] ?? '') === 'on') {
            return true;
        }
        if ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443) {
            return true;
        }
        if (self::trustProxy()) {
            $proto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
            if ($proto !== '' && strcasecmp(trim(explode(',', $proto)[0]), 'https') === 0) {
                return true;
            }
        }
        return false;
    }

    public static function trustProxy(): bool
    {
        $list = Config::get('TRUSTED_PROXIES');
        if ($list === null || $list === '') {
            return false;
        }
        $remote = $_SERVER['REMOTE_ADDR'] ?? '';
        if ($remote === '') {
            return false;
        }
        foreach (array_map('trim', explode(',', $list)) as $cidr) {
            if ($cidr === '') {
                continue;
            }
            if (self::ipInCidr($remote, $cidr)) {
                return true;
            }
        }
        return false;
    }

    public static function clientIp(): string
    {
        $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        if (!self::trustProxy()) {
            return $remote;
        }
        $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if ($xff === '') {
            return $remote;
        }
        $parts = array_map('trim', explode(',', $xff));
        $candidate = $parts[0] ?? '';
        if ($candidate !== '' && filter_var($candidate, FILTER_VALIDATE_IP) !== false) {
            return $candidate;
        }
        return $remote;
    }

    private static function ipInCidr(string $ip, string $cidr): bool
    {
        if ($ip === $cidr) {
            return true;
        }
        if (!str_contains($cidr, '/')) {
            return false;
        }
        [$subnet, $bitsStr] = explode('/', $cidr, 2);
        $bits = (int) $bitsStr;
        $ipBin = @inet_pton($ip);
        $netBin = @inet_pton($subnet);
        if ($ipBin === false || $netBin === false || strlen($ipBin) !== strlen($netBin)) {
            return false;
        }
        $bytes = intdiv($bits, 8);
        $rem = $bits % 8;
        if ($bytes > 0 && substr($ipBin, 0, $bytes) !== substr($netBin, 0, $bytes)) {
            return false;
        }
        if ($rem === 0) {
            return true;
        }
        $mask = chr((0xff << (8 - $rem)) & 0xff);
        return (($ipBin[$bytes] & $mask) === ($netBin[$bytes] & $mask));
    }
}
