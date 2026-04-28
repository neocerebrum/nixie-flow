<?php
declare(strict_types=1);

namespace App\Controllers\Admin;

use App\Auth;
use App\Csrf;
use App\Models\User;
use App\Response;
use App\View;

final class UserController
{
    public function index(array $args): never
    {
        $current = Auth::requireAdmin();
        $users = User::listAll();
        $flash = $_SESSION['flash'] ?? null;
        unset($_SESSION['flash']);
        View::render('admin/users_list', [
            'users'     => $users,
            'current'   => $current,
            'csrfToken' => Csrf::token(),
            'flash'     => $flash,
        ], ['title' => 'Utenti — Aquata', 'active' => 'admin']);
    }

    public function newForm(array $args): never
    {
        Auth::requireAdmin();
        $flash = $_SESSION['flash'] ?? null;
        unset($_SESSION['flash']);
        View::render('admin/user_form', [
            'mode'      => 'new',
            'user'      => ['email' => '', 'display_name' => '', 'role' => 'user'],
            'csrfToken' => Csrf::token(),
            'flash'     => $flash,
        ], ['title' => 'Nuovo utente — Aquata', 'active' => 'admin']);
    }

    public function create(array $args): never
    {
        Auth::requireAdmin();
        Csrf::requireValid();

        $email       = strtolower(trim((string) ($_POST['email'] ?? '')));
        $displayName = trim((string) ($_POST['display_name'] ?? ''));
        $role        = (string) ($_POST['role'] ?? 'user');
        $password    = (string) ($_POST['password'] ?? '');

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->flash('error', 'Email non valida.');
            Response::redirect('/admin/users/new');
        }
        if (!in_array($role, ['admin', 'user'], true)) {
            $this->flash('error', 'Ruolo non valido.');
            Response::redirect('/admin/users/new');
        }
        if (strlen($password) < 8) {
            $this->flash('error', 'La password deve avere almeno 8 caratteri.');
            Response::redirect('/admin/users/new');
        }
        if (User::byEmail($email) !== null) {
            $this->flash('error', 'Esiste già un utente con questa email.');
            Response::redirect('/admin/users/new');
        }
        if ($displayName === '') {
            $displayName = strstr($email, '@', true) ?: $email;
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        User::create($email, $hash, $displayName, $role);

        $this->flash('success', 'Utente creato.');
        Response::redirect('/admin/users');
    }

    public function editForm(array $args): never
    {
        Auth::requireAdmin();
        $user = User::byId((int) $args['id']);
        if ($user === null) {
            Response::notFound('User not found');
        }
        $flash = $_SESSION['flash'] ?? null;
        unset($_SESSION['flash']);
        View::render('admin/user_form', [
            'mode'      => 'edit',
            'user'      => $user,
            'csrfToken' => Csrf::token(),
            'flash'     => $flash,
        ], ['title' => 'Modifica utente — Aquata', 'active' => 'admin']);
    }

    public function update(array $args): never
    {
        $current = Auth::requireAdmin();
        Csrf::requireValid();

        $id = (int) $args['id'];
        $user = User::byId($id);
        if ($user === null) {
            Response::notFound('User not found');
        }

        $displayName = trim((string) ($_POST['display_name'] ?? ''));
        $role        = (string) ($_POST['role'] ?? $user['role']);
        $newPassword = (string) ($_POST['new_password'] ?? '');

        if (!in_array($role, ['admin', 'user'], true)) {
            $this->flash('error', 'Ruolo non valido.');
            Response::redirect('/admin/users/' . $id);
        }
        if ($displayName === '') {
            $displayName = strstr((string) $user['email'], '@', true) ?: $user['email'];
        }

        if ((int) $current['id'] === $id && $role !== 'admin') {
            $this->flash('error', 'Non puoi togliere a te stesso il ruolo admin.');
            Response::redirect('/admin/users/' . $id);
        }
        if ($user['role'] === 'admin' && $role !== 'admin' && User::countActiveAdmins() <= 1) {
            $this->flash('error', 'Deve esistere almeno un admin attivo.');
            Response::redirect('/admin/users/' . $id);
        }

        User::updateProfile($id, $displayName);
        if ($role !== $user['role']) {
            User::updateRole($id, $role);
        }
        if ($newPassword !== '') {
            if (strlen($newPassword) < 8) {
                $this->flash('error', 'La password deve avere almeno 8 caratteri.');
                Response::redirect('/admin/users/' . $id);
            }
            User::updatePassword($id, password_hash($newPassword, PASSWORD_BCRYPT));
        }

        $this->flash('success', 'Utente aggiornato.');
        Response::redirect('/admin/users');
    }

    public function disable(array $args): never
    {
        $current = Auth::requireAdmin();
        Csrf::requireValid();

        $id = (int) $args['id'];
        $user = User::byId($id);
        if ($user === null) {
            Response::notFound('User not found');
        }

        if ((int) $current['id'] === $id) {
            $this->flash('error', 'Non puoi disabilitare il tuo account.');
            Response::redirect('/admin/users');
        }

        if ($user['role'] === 'admin' && User::countActiveAdmins() <= 1 && empty($user['disabled_at'])) {
            $this->flash('error', 'Deve esistere almeno un admin attivo.');
            Response::redirect('/admin/users');
        }

        User::setDisabled($id);
        $this->flash('success', 'Utente disabilitato.');
        Response::redirect('/admin/users');
    }

    public function restore(array $args): never
    {
        Auth::requireAdmin();
        Csrf::requireValid();

        $id = (int) $args['id'];
        $user = User::byId($id);
        if ($user === null) {
            Response::notFound('User not found');
        }

        User::setEnabled($id);
        $this->flash('success', 'Utente riattivato.');
        Response::redirect('/admin/users');
    }

    private function flash(string $type, string $msg): void
    {
        $_SESSION['flash'] = ['type' => $type, 'msg' => $msg];
    }
}
