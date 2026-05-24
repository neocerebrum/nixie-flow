<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Config;
use App\Csrf;
use App\Mailer;
use App\Models\EmailToken;
use App\Models\User;
use App\RateLimit;
use App\Response;
use App\View;

final class SignupController
{
    private const MIN_FORM_SECONDS = 2;
    private const MAX_DISPLAY_NAME = 100;
    private const MIN_PASSWORD     = 8;

    public function showForm(array $args): never
    {
        if (!Config::bool('SIGNUP_ENABLED', true)) {
            Response::notFound('Signup is disabled');
        }
        if (Auth::isLoggedIn()) {
            Response::redirect('/dashboard');
        }
        $_SESSION['_signup_started'] = time();
        View::render('auth/signup', [
            'csrfToken' => Csrf::token(),
            'flash'     => $this->popFlash(),
            'email'     => '',
            'name'      => '',
        ], ['title' => __('signup.title'), 'active' => '']);
    }

    public function submit(array $args): never
    {
        if (!Config::bool('SIGNUP_ENABLED', true)) {
            Response::notFound('Signup is disabled');
        }
        Csrf::requireValid();

        $ip = RateLimit::clientIp();
        $r = RateLimit::hit("signup:ip:$ip", 60, Config::int('RATE_SIGNUP_PER_IP_PER_MIN', 3));
        if (!$r['allowed']) {
            $this->flash('error', __('error.too_many_attempts'));
            Response::redirect('/signup');
        }

        // Honeypot — must be empty. Bots usually fill it.
        if (trim((string) ($_POST['website'] ?? '')) !== '') {
            // Pretend success to not tip off the bot.
            $this->flash('info', __('error.email_confirm_sent'));
            Response::redirect('/signup/check-email');
        }

        // Time-on-form: bots usually submit instantly.
        $started = (int) ($_SESSION['_signup_started'] ?? 0);
        if ($started > 0 && (time() - $started) < self::MIN_FORM_SECONDS) {
            $this->flash('error', __('error.form_too_fast'));
            Response::redirect('/signup');
        }

        $email    = strtolower(trim((string) ($_POST['email'] ?? '')));
        $name     = trim((string) ($_POST['display_name'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        $tos      = !empty($_POST['accept_tos']);

        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 255) {
            $this->flash('error', __('error.email_invalid'));
            $this->repopulate($email, $name);
            Response::redirect('/signup');
        }
        if ($name === '' || strlen($name) > self::MAX_DISPLAY_NAME) {
            $this->flash('error', __('error.name_required', self::MAX_DISPLAY_NAME));
            $this->repopulate($email, $name);
            Response::redirect('/signup');
        }
        if (strlen($password) < self::MIN_PASSWORD) {
            $this->flash('error', __('error.password_min', self::MIN_PASSWORD));
            $this->repopulate($email, $name);
            Response::redirect('/signup');
        }
        if (!$tos) {
            $this->flash('error', __('error.tos_required'));
            $this->repopulate($email, $name);
            Response::redirect('/signup');
        }

        // If the email already exists, do NOT reveal it. Pretend success.
        $existing = User::byEmail($email);
        if ($existing === null) {
            $hash = password_hash($password, PASSWORD_BCRYPT);
            $newId = User::createSelfService($email, $hash, $name);
            $this->sendVerificationEmail($newId, $email, $name);
        } else {
            // Optionally re-send a verification mail if still unverified.
            if (!User::isEmailVerified($existing)) {
                $this->sendVerificationEmail((int) $existing['id'], $existing['email'], (string) $existing['display_name']);
            }
            // If already verified, silently do nothing (no enumeration).
        }

        $this->flash('info', __('error.email_confirm_sent'));
        Response::redirect('/signup/check-email');
    }

    public function checkEmail(array $args): never
    {
        View::render('auth/signup_check_email', [
            'flash' => $this->popFlash(),
        ], ['title' => __('signup.check_email.title')]);
    }

    public function verify(array $args): never
    {
        $token = (string) ($_GET['token'] ?? '');
        $row = EmailToken::consume($token, EmailToken::KIND_VERIFY);
        if ($row === null) {
            View::render('auth/verify_failed', [
                'flash' => null,
            ], ['title' => __('verify.failed.title')]);
        }
        User::markEmailVerified((int) $row['user_id']);
        View::render('auth/verify_done', [
            'flash' => null,
        ], ['title' => __('verify.done.title')]);
    }

    public function resend(array $args): never
    {
        Csrf::requireValid();
        $ip = RateLimit::clientIp();
        $r = RateLimit::hit("signup-resend:ip:$ip", 60, Config::int('RATE_SIGNUP_PER_IP_PER_MIN', 3));
        if (!$r['allowed']) {
            $this->flash('error', __('error.too_many_attempts'));
            Response::redirect('/signup/check-email');
        }
        $email = strtolower(trim((string) ($_POST['email'] ?? '')));
        $user = User::byEmail($email);
        if ($user !== null && !User::isEmailVerified($user) && !User::isDisabled($user)) {
            $this->sendVerificationEmail((int) $user['id'], $user['email'], (string) $user['display_name']);
        }
        $this->flash('info', __('error.resend_confirm'));
        Response::redirect('/signup/check-email');
    }

    private function sendVerificationEmail(int $userId, string $email, string $name): void
    {
        $token = EmailToken::issue($userId, EmailToken::KIND_VERIFY, EmailToken::TTL_VERIFY_SEC);
        $url = Mailer::appUrl() . '/signup/verify?token=' . urlencode($token);
        $body = __('email.verify.body', $name, $url);
        Mailer::send($email, __('email.verify.subject'), $body);
    }

    private function flash(string $type, string $message): void
    {
        $_SESSION['_signup_flash'] = ['type' => $type, 'message' => $message];
    }

    private function popFlash(): ?array
    {
        $f = $_SESSION['_signup_flash'] ?? null;
        unset($_SESSION['_signup_flash']);
        return $f;
    }

    private function repopulate(string $email, string $name): void
    {
        $_SESSION['_signup_form'] = ['email' => $email, 'display_name' => $name];
    }
}
