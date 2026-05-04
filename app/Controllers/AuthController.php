<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Csrf;
use App\Response;
use App\View;

final class AuthController
{
    public function loginForm(array $args): never
    {
        if (Auth::isLoggedIn()) {
            $next = $_GET['next'] ?? '/dashboard';
            Response::redirect(self::safeNext($next));
        }
        $next = $_GET['next'] ?? '';
        View::render('auth/login', [
            'next'      => $next,
            'csrfToken' => Csrf::token(),
            'error'     => $_SESSION['flash']['msg'] ?? null,
        ], ['title' => 'Login — Aquata', 'noNav' => true]);
        unset($_SESSION['flash']);
    }

    public function login(array $args): never
    {
        Csrf::requireValid();

        $email    = trim((string) ($_POST['email'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        $next     = self::safeNext((string) ($_POST['next'] ?? '/dashboard'));

        if ($email === '' || $password === '') {
            self::flash('error', 'Inserisci email e password.');
            Response::redirect('/login' . ($next !== '/dashboard' ? '?next=' . urlencode($next) : ''));
        }

        $result = Auth::login($email, $password);
        switch ($result) {
            case 'ok':
                Response::redirect($next);
            case 'rate_limited':
                self::flash('error', sprintf(
                    'Troppi tentativi falliti. Riprova tra %d minuti.',
                    Auth::failureWindowMinutes()
                ));
                Response::redirect('/login');
            case 'disabled':
                self::flash('error', 'Account disabilitato. Contatta un amministratore.');
                Response::redirect('/login');
            case 'unverified':
                self::flash('error', 'Email non verificata. Controlla la tua casella o richiedi un nuovo link.');
                Response::redirect('/signup/check-email');
            case 'invalid':
            default:
                self::flash('error', 'Email o password non corretti.');
                Response::redirect('/login');
        }
    }

    public function logout(array $args): never
    {
        Csrf::requireValid();
        Auth::logout();
        Response::redirect('/login');
    }

    private static function flash(string $type, string $msg): void
    {
        $_SESSION['flash'] = ['type' => $type, 'msg' => $msg];
    }

    /** Reject open-redirects: only allow same-origin paths starting with "/". */
    private static function safeNext(string $next): string
    {
        if ($next === '' || $next[0] !== '/' || str_starts_with($next, '//')) {
            return '/dashboard';
        }
        return $next;
    }
}
