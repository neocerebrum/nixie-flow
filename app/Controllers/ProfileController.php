<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Csrf;
use App\Models\ApiToken;
use App\Models\User;
use App\Response;
use App\View;

final class ProfileController
{
    public function show(array $args): never
    {
        $user = Auth::requireLogin();
        $flash = $_SESSION['flash'] ?? null;
        unset($_SESSION['flash']);
        View::render('profile', [
            'user'      => $user,
            'csrfToken' => Csrf::token(),
            'flash'     => $flash,
        ], ['title' => 'Profilo — Aquata', 'active' => 'profile']);
    }

    public function save(array $args): never
    {
        $user = Auth::requireLogin();
        Csrf::requireValid();

        $displayName = trim((string) ($_POST['display_name'] ?? ''));
        if ($displayName === '') {
            $displayName = strstr((string) $user['email'], '@', true) ?: $user['email'];
        }

        $currentPass = (string) ($_POST['current_password'] ?? '');
        $newPass     = (string) ($_POST['new_password'] ?? '');
        $confirmPass = (string) ($_POST['confirm_password'] ?? '');

        $wantsPasswordChange = $newPass !== '' || $confirmPass !== '' || $currentPass !== '';

        if ($wantsPasswordChange) {
            if (!password_verify($currentPass, $user['password_hash'])) {
                $this->flash('error', 'Password attuale errata.');
                Response::redirect('/profile');
            }
            if (strlen($newPass) < 8) {
                $this->flash('error', 'La nuova password deve avere almeno 8 caratteri.');
                Response::redirect('/profile');
            }
            if ($newPass !== $confirmPass) {
                $this->flash('error', 'Le due password non coincidono.');
                Response::redirect('/profile');
            }
            User::updatePassword((int) $user['id'], password_hash($newPass, PASSWORD_BCRYPT));
        }

        if ($displayName !== $user['display_name']) {
            User::updateProfile((int) $user['id'], $displayName);
        }

        $this->flash('success', 'Profilo aggiornato.');
        Response::redirect('/profile');
    }

    public function tokens(array $args): never
    {
        $user = Auth::requireLogin();
        $flash = $_SESSION['flash'] ?? null;
        unset($_SESSION['flash']);
        $newTokenPlaintext = $_SESSION['new_token_plaintext'] ?? null;
        unset($_SESSION['new_token_plaintext']);

        $tokens = ApiToken::listForUser((int) $user['id']);
        $host = $_SERVER['HTTP_HOST'] ?? 'aquata.example.com';
        View::render('profile_tokens', [
            'user'              => $user,
            'tokens'            => $tokens,
            'csrfToken'         => Csrf::token(),
            'flash'             => $flash,
            'newTokenPlaintext' => $newTokenPlaintext,
            'mcpEndpoint'       => 'https://' . $host . '/mcp',
        ], ['title' => 'Token API — Aquata', 'active' => 'profile']);
    }

    public function createToken(array $args): never
    {
        $user = Auth::requireLogin();
        Csrf::requireValid();

        $label = trim((string) ($_POST['label'] ?? ''));
        if ($label === '') $label = 'token-' . date('Ymd-His');
        if (strlen($label) > 100) $label = substr($label, 0, 100);

        $plaintext = ApiToken::create((int) $user['id'], $label);
        $_SESSION['new_token_plaintext'] = $plaintext;
        $this->flash('success', 'Token creato. Copialo subito: non sarà più mostrato.');
        Response::redirect('/profile/tokens');
    }

    public function revokeToken(array $args): never
    {
        $user = Auth::requireLogin();
        Csrf::requireValid();

        $hash = (string) ($_POST['token_hash'] ?? '');
        if ($hash === '' || strlen($hash) !== 64 || !ctype_xdigit($hash)) {
            $this->flash('error', 'Token non valido.');
            Response::redirect('/profile/tokens');
        }

        $ok = ApiToken::revokeByHash((int) $user['id'], $hash);
        $this->flash($ok ? 'success' : 'error', $ok ? 'Token revocato.' : 'Token non trovato.');
        Response::redirect('/profile/tokens');
    }

    private function flash(string $type, string $msg): void
    {
        $_SESSION['flash'] = ['type' => $type, 'msg' => $msg];
    }
}
