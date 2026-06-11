<?php
declare(strict_types=1);

namespace App;

use RuntimeException;

/**
 * Pluggable mailer.
 *
 * Transports (selectable via MAIL_TRANSPORT env):
 *   - "mail"  → PHP's mail() function (default)
 *   - "smtp"  → raw SMTP client (no external dep). See SMTP_* env below.
 *   - "log"   → write the rendered RFC822 message to data/mail/<timestamp>.eml
 *               and skip actual delivery. Useful for local dev / testing.
 *   - "null"  → silently drop (won't error; for tests).
 *
 * SMTP env:
 *   SMTP_HOST       (required)
 *   SMTP_PORT       (default 587)
 *   SMTP_USER       (optional; if set, AUTH is attempted)
 *   SMTP_PASS       (optional)
 *   SMTP_ENCRYPTION tls (STARTTLS, default) | ssl (implicit TLS, port 465) | none
 *   SMTP_TIMEOUT    seconds (default 15)
 *   SMTP_HELO       hostname for EHLO/HELO (default APP_URL host or "localhost")
 */
final class Mailer
{
    public static function send(string $to, string $subject, string $textBody): bool
    {
        // Defense in depth against header injection: a CR/LF in the recipient or
        // subject would let it smuggle extra mail/SMTP headers. Callers already
        // validate emails (FILTER_VALIDATE_EMAIL) and subjects come from i18n,
        // but reject here too so the Mailer is safe regardless of the caller.
        if (preg_match('/[\r\n]/', $to) || preg_match('/[\r\n]/', $subject)) {
            error_log('[Aquata Mailer] refused: CR/LF in recipient or subject');
            return false;
        }

        $from   = self::fromAddress();
        $appUrl = self::appUrl();
        $headers = [
            "From: $from",
            "Reply-To: $from",
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: 8bit',
            'X-Mailer: Aquata',
            'X-Aquata-Origin: ' . $appUrl,
        ];

        $transport = strtolower((string) Config::get('MAIL_TRANSPORT', 'mail'));
        switch ($transport) {
            case 'null':
                return true;
            case 'log':
                return self::writeEmlFile($to, $subject, $textBody, $headers, $from);
            case 'smtp':
                return self::deliverViaSmtp($to, $subject, $textBody, $headers, $from);
            case 'mail':
            default:
                return self::deliverViaMail($to, $subject, $textBody, $headers);
        }
    }

    public static function fromAddress(): string
    {
        $addr = Config::get('MAIL_FROM');
        if ($addr === null || $addr === '') {
            $host = $_SERVER['HTTP_HOST'] ?? 'aquata.local';
            $addr = 'no-reply@' . preg_replace('/[^a-z0-9.\-]/i', '', $host);
        }
        $name = Config::get('MAIL_FROM_NAME', 'Aquata');
        return $name !== null && $name !== '' ? "$name <$addr>" : $addr;
    }

    public static function appUrl(): string
    {
        $configured = Config::get('APP_URL');
        if ($configured !== null && $configured !== '') {
            return rtrim($configured, '/');
        }
        $scheme = Http::isHttps() ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        return "$scheme://$host";
    }

    private static function deliverViaMail(string $to, string $subject, string $body, array $headers): bool
    {
        $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
        $headerStr = implode("\r\n", $headers);
        $ok = @mail($to, $encodedSubject, $body, $headerStr);
        if (!$ok) {
            error_log("[Aquata Mailer] mail() failed for $to / $subject");
        }
        return $ok;
    }

    private static function deliverViaSmtp(string $to, string $subject, string $body, array $headers, string $from): bool
    {
        $host = (string) (Config::get('SMTP_HOST') ?? '');
        if ($host === '') {
            error_log('[Aquata Mailer] SMTP_HOST not set');
            return false;
        }
        $port      = Config::int('SMTP_PORT', 587);
        $user      = Config::get('SMTP_USER');
        $pass      = Config::get('SMTP_PASS');
        $encrypt   = strtolower(trim((string) (Config::get('SMTP_ENCRYPTION') ?? '')));
        if ($encrypt === '') {
            $encrypt = 'tls';
        }
        $timeout   = Config::int('SMTP_TIMEOUT', 15);
        $helo      = (string) (Config::get('SMTP_HELO') ?? '');
        if ($helo === '') {
            $helo = parse_url(self::appUrl(), PHP_URL_HOST) ?: 'localhost';
        }

        $fromAddr = self::extractAddress($from);
        $rcptAddr = self::extractAddress($to);
        if ($fromAddr === '' || $rcptAddr === '') {
            error_log('[Aquata Mailer] missing from/to address');
            return false;
        }

        $connectHost = $encrypt === 'ssl' ? "ssl://$host" : $host;
        $errno = 0; $errstr = '';
        $sock = @stream_socket_client(
            "$connectHost:$port",
            $errno, $errstr, $timeout,
            STREAM_CLIENT_CONNECT
        );
        if (!$sock) {
            error_log("[Aquata Mailer] SMTP connect $host:$port failed: $errstr");
            return false;
        }
        stream_set_timeout($sock, $timeout);

        try {
            self::smtpExpect($sock, 220);
            self::smtpCmd($sock, "EHLO $helo", 250, $ehloLines);

            $hasStartTls = false;
            foreach ($ehloLines as $l) {
                if (preg_match('/^\d{3}[ -]STARTTLS\b/i', $l)) { $hasStartTls = true; break; }
            }
            if ($encrypt === 'tls' && !$hasStartTls) {
                error_log('[Aquata Mailer] SMTP_ENCRYPTION=tls but server does not advertise STARTTLS');
            }
            if ($encrypt === 'tls') {
                self::smtpCmd($sock, 'STARTTLS', 220);
                $crypto = STREAM_CRYPTO_METHOD_TLS_CLIENT
                    | (defined('STREAM_CRYPTO_METHOD_TLSv1_1_CLIENT') ? STREAM_CRYPTO_METHOD_TLSv1_1_CLIENT : 0)
                    | (defined('STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT') ? STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT : 0)
                    | (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT') ? STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT : 0);
                if (!@stream_socket_enable_crypto($sock, true, $crypto)) {
                    throw new \RuntimeException('STARTTLS handshake failed');
                }
                self::smtpCmd($sock, "EHLO $helo", 250, $ehloLines);
            }

            if ($user !== null && $user !== '') {
                $authMechs = self::parseAuthMechanisms($ehloLines);
                $forced = strtoupper((string) (Config::get('SMTP_AUTH', '') ?? ''));
                $tryPlain = $forced === 'PLAIN' || ($forced === '' && in_array('PLAIN', $authMechs, true));
                $tryLogin = $forced === 'LOGIN' || ($forced === '' && in_array('LOGIN', $authMechs, true));

                if ($tryPlain) {
                    $payload = base64_encode("\0" . $user . "\0" . (string) $pass);
                    self::smtpCmd($sock, "AUTH PLAIN $payload", 235);
                } elseif ($tryLogin) {
                    self::smtpCmd($sock, 'AUTH LOGIN', 334);
                    self::smtpCmd($sock, base64_encode($user), 334);
                    self::smtpCmd($sock, base64_encode((string) $pass), 235);
                } else {
                    error_log('[Aquata Mailer] EHLO did not advertise PLAIN/LOGIN. Server lines: '
                        . implode(' | ', $ehloLines));
                    throw new \RuntimeException('No supported AUTH mechanism (advertised: '
                        . (empty($authMechs) ? 'none' : implode(',', $authMechs))
                        . '). Set SMTP_AUTH=PLAIN or LOGIN to force.');
                }
            }

            self::smtpCmd($sock, "MAIL FROM:<$fromAddr>", 250);
            self::smtpCmd($sock, "RCPT TO:<$rcptAddr>", [250, 251]);
            self::smtpCmd($sock, 'DATA', 354);

            $msgIdDomain = (strpos($fromAddr, '@') !== false)
                ? substr($fromAddr, strpos($fromAddr, '@') + 1)
                : $helo;
            $messageId = '<' . bin2hex(random_bytes(8)) . '.'
                . dechex((int) (microtime(true) * 1000)) . '@' . $msgIdDomain . '>';

            $hdrLines = [
                'Message-ID: ' . $messageId,
                'Date: ' . date('r'),
                'To: ' . $to,
                'Subject: =?UTF-8?B?' . base64_encode($subject) . '?=',
            ];
            foreach ($headers as $h) {
                $hdrLines[] = $h;
            }
            $msg = implode("\r\n", $hdrLines) . "\r\n\r\n" . self::dotStuff($body) . "\r\n.";
            self::smtpCmd($sock, $msg, 250);

            self::smtpCmd($sock, 'QUIT', 221);
            return true;
        } catch (\Throwable $e) {
            error_log('[Aquata Mailer] SMTP: ' . $e->getMessage());
            return false;
        } finally {
            @fclose($sock);
        }
    }

    private static function smtpCmd($sock, string $cmd, int|array $expected, ?array &$lines = null): void
    {
        if (fwrite($sock, $cmd . "\r\n") === false) {
            throw new \RuntimeException('SMTP write failed');
        }
        self::smtpExpect($sock, $expected, $lines);
    }

    private static function smtpExpect($sock, int|array $expected, ?array &$lines = null): void
    {
        $expectedArr = is_array($expected) ? $expected : [$expected];
        $lines = [];
        $code = 0;
        while (!feof($sock)) {
            $line = fgets($sock, 1024);
            if ($line === false) {
                throw new \RuntimeException('SMTP read failed');
            }
            $lines[] = rtrim($line, "\r\n");
            $code = (int) substr($line, 0, 3);
            // Multi-line responses use "<code>-..." for continuation, "<code> ..." for last.
            if (strlen($line) < 4 || $line[3] !== '-') break;
        }
        if (!in_array($code, $expectedArr, true)) {
            throw new \RuntimeException("SMTP expected " . implode('/', $expectedArr) . ", got: " . implode(' | ', $lines));
        }
    }

    private static function parseAuthMechanisms(array $ehloLines): array
    {
        foreach ($ehloLines as $line) {
            // Handles both modern "250-AUTH PLAIN LOGIN" and legacy "250-AUTH=LOGIN PLAIN".
            if (preg_match('/^\d{3}[ -]AUTH[\s=]+(.+)$/i', $line, $m)) {
                return array_map('strtoupper', preg_split('/[\s,]+/', trim($m[1])) ?: []);
            }
        }
        return [];
    }

    private static function extractAddress(string $combined): string
    {
        if (preg_match('/<([^>]+)>/', $combined, $m)) return trim($m[1]);
        return trim($combined);
    }

    /** RFC 5321 §4.5.2: lines starting with "." get an extra "." prefixed. */
    private static function dotStuff(string $body): string
    {
        $body = str_replace("\r\n", "\n", $body);
        $body = str_replace("\n", "\r\n", $body);
        return preg_replace('/^\./m', '..', $body);
    }

    private static function writeEmlFile(string $to, string $subject, string $body, array $headers, string $from): bool
    {
        $dir = AQUATA_ROOT . '/data/mail';
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            error_log("[Aquata Mailer] cannot create $dir");
            return false;
        }
        $headers[] = "To: $to";
        $headers[] = "Subject: $subject";
        $headers[] = 'Date: ' . date('r');
        $msg = implode("\r\n", $headers) . "\r\n\r\n" . $body . "\r\n";
        $name = sprintf('%s-%s.eml', date('Ymd-His'), substr(hash('sha256', $to . $subject), 0, 8));
        $path = $dir . '/' . $name;
        return file_put_contents($path, $msg) !== false;
    }
}
