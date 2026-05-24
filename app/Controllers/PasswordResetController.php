<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Config;
use App\Csrf;
use App\Mailer;
use App\Models\EmailToken;
use App\Models\User;
use App\RateLimit;
use App\Response;
use App\View;

final class PasswordResetController
{
    private const MIN_PASSWORD = 8;

    public function requestForm(array $args): never
    {
        View::render('auth/password_reset_request', [
            'csrfToken' => Csrf::token(),
            'flash'     => $this->popFlash(),
        ], ['title' => __('pwreset.request.title')]);
    }

    public function requestSubmit(array $args): never
    {
        Csrf::requireValid();
        $ip = RateLimit::clientIp();
        $r = RateLimit::hit("pwreset:ip:$ip", 60, Config::int('RATE_RESET_PER_IP_PER_MIN', 3));
        if (!$r['allowed']) {
            $this->flash('error', __('error.too_many_attempts'));
            Response::redirect('/password-reset');
        }
        $email = strtolower(trim((string) ($_POST['email'] ?? '')));
        if (filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $user = User::byEmail($email);
            if ($user !== null && !User::isDisabled($user)) {
                $this->sendResetEmail((int) $user['id'], $user['email'], (string) $user['display_name']);
            }
        }
        $this->flash('info', __('error.pwreset_sent'));
        Response::redirect('/password-reset');
    }

    public function confirmForm(array $args): never
    {
        $token = (string) ($_GET['token'] ?? '');
        if ($token === '') {
            Response::redirect('/password-reset');
        }
        // Don't consume yet — only verify it exists/valid; the POST consumes it.
        // For UX: show form, accept new password, validate token on submit.
        View::render('auth/password_reset_confirm', [
            'csrfToken' => Csrf::token(),
            'token'     => $token,
            'flash'     => $this->popFlash(),
        ], ['title' => __('pwreset.confirm.title')]);
    }

    public function confirmSubmit(array $args): never
    {
        Csrf::requireValid();
        $token = (string) ($_POST['token'] ?? '');
        $password = (string) ($_POST['password'] ?? '');
        $confirm  = (string) ($_POST['password_confirm'] ?? '');

        if (strlen($password) < self::MIN_PASSWORD) {
            $this->flash('error', __('error.password_min', self::MIN_PASSWORD));
            Response::redirect('/password-reset/confirm?token=' . urlencode($token));
        }
        if ($password !== $confirm) {
            $this->flash('error', __('error.passwords_mismatch'));
            Response::redirect('/password-reset/confirm?token=' . urlencode($token));
        }

        $row = EmailToken::consume($token, EmailToken::KIND_RESET);
        if ($row === null) {
            $this->flash('error', __('error.link_invalid'));
            Response::redirect('/password-reset');
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        User::updatePassword((int) $row['user_id'], $hash);

        $this->flash('info', __('error.password_updated'));
        Response::redirect('/login');
    }

    private function sendResetEmail(int $userId, string $email, string $name): void
    {
        $token = EmailToken::issue($userId, EmailToken::KIND_RESET, EmailToken::TTL_RESET_SEC);
        $url = Mailer::appUrl() . '/password-reset/confirm?token=' . urlencode($token);
        $body = __('email.reset.body', $name, $url);
        Mailer::send($email, __('email.reset.subject'), $body);
    }

    private function flash(string $type, string $message): void
    {
        $_SESSION['_pwreset_flash'] = ['type' => $type, 'message' => $message];
    }

    private function popFlash(): ?array
    {
        $f = $_SESSION['_pwreset_flash'] ?? null;
        unset($_SESSION['_pwreset_flash']);
        return $f;
    }
}
