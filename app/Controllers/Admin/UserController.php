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
        ], ['title' => __('admin.users.title'), 'active' => 'admin']);
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
        ], ['title' => __('admin.user.new_title'), 'active' => 'admin']);
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
            $this->flash('error', __('error.email_invalid'));
            Response::redirect('/admin/users/new');
        }
        if (!in_array($role, ['admin', 'user'], true)) {
            $this->flash('error', __('error.role_invalid'));
            Response::redirect('/admin/users/new');
        }
        if (strlen($password) < 8) {
            $this->flash('error', __('error.password_min_8'));
            Response::redirect('/admin/users/new');
        }
        if (User::byEmail($email) !== null) {
            $this->flash('error', __('error.email_exists'));
            Response::redirect('/admin/users/new');
        }
        if ($displayName === '') {
            $displayName = strstr($email, '@', true) ?: $email;
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        $newId = User::create($email, $hash, $displayName, $role);
        // Admin-provisioned accounts skip the email-verification round-trip.
        User::markEmailVerified($newId);

        $this->flash('success', __('error.user_created'));
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
        ], ['title' => __('admin.user.edit_title'), 'active' => 'admin']);
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
            $this->flash('error', __('error.role_invalid'));
            Response::redirect('/admin/users/' . $id);
        }
        if ($displayName === '') {
            $displayName = strstr((string) $user['email'], '@', true) ?: $user['email'];
        }

        if ((int) $current['id'] === $id && $role !== 'admin') {
            $this->flash('error', __('error.cannot_remove_self_admin'));
            Response::redirect('/admin/users/' . $id);
        }
        if ($user['role'] === 'admin' && $role !== 'admin' && User::countActiveAdmins() <= 1) {
            $this->flash('error', __('error.need_one_admin'));
            Response::redirect('/admin/users/' . $id);
        }

        User::updateProfile($id, $displayName);
        if ($role !== $user['role']) {
            User::updateRole($id, $role);
        }
        if ($newPassword !== '') {
            if (strlen($newPassword) < 8) {
                $this->flash('error', __('error.password_min_8'));
                Response::redirect('/admin/users/' . $id);
            }
            User::updatePassword($id, password_hash($newPassword, PASSWORD_BCRYPT));
        }

        $this->flash('success', __('error.user_updated'));
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
            $this->flash('error', __('error.cannot_disable_self'));
            Response::redirect('/admin/users');
        }

        if ($user['role'] === 'admin' && User::countActiveAdmins() <= 1 && empty($user['disabled_at'])) {
            $this->flash('error', __('error.need_one_admin'));
            Response::redirect('/admin/users');
        }

        User::setDisabled($id);
        $this->flash('success', __('error.user_disabled'));
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
        $this->flash('success', __('error.user_restored'));
        Response::redirect('/admin/users');
    }

    public function deleteUser(array $args): never
    {
        $current = Auth::requireAdmin();
        Csrf::requireValid();

        $id = (int) $args['id'];
        $user = User::byId($id);
        if ($user === null) {
            Response::notFound('User not found');
        }
        if ((int) $current['id'] === $id) {
            $this->flash('error', __('error.cannot_delete_self'));
            Response::redirect('/admin/users');
        }
        if (empty($user['disabled_at'])) {
            $this->flash('error', __('error.must_disable_before_delete'));
            Response::redirect('/admin/users');
        }
        if ($user['role'] === 'admin') {
            $this->flash('error', __('error.cannot_delete_admin'));
            Response::redirect('/admin/users');
        }

        User::purge($id);
        $this->flash('success', __('admin.users.deleted', e($user['email'])));
        Response::redirect('/admin/users');
    }

    public function promote(array $args): never
    {
        Auth::requireAdmin();
        Csrf::requireValid();

        $id = (int) $args['id'];
        $user = User::byId($id);
        if ($user === null) {
            Response::notFound('User not found');
        }

        User::promoteToFull($id);
        $this->flash('success', __('admin.users.promoted'));
        Response::redirect('/admin/users');
    }

    private function flash(string $type, string $msg): void
    {
        $_SESSION['flash'] = ['type' => $type, 'msg' => $msg];
    }
}
