<?php /** @var string $mode */
/** @var array $user */
/** @var string $csrfToken */
/** @var ?array $flash */
$isNew = $mode === 'new';
$action = $isNew ? '/admin/users' : '/admin/users/' . (int) $user['id'];
?>
<section class="page">
    <header class="page-header">
        <h1><?= $isNew ? __('admin.user.new_heading') : __('admin.user.edit_heading') ?></h1>
        <a href="/admin/users" class="btn-link"><?= __('admin.user.back') ?></a>
    </header>

    <?php include __DIR__ . '/../partials/flash.php'; ?>

    <form method="post" action="<?= e($action) ?>" class="form card">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">

        <label>
            <?= __('admin.user.email') ?>
            <?php if ($isNew): ?>
                <input type="email" name="email" required maxlength="255" autofocus>
            <?php else: ?>
                <input type="email" value="<?= e($user['email']) ?>" disabled>
            <?php endif; ?>
        </label>
        <label>
            <?= __('admin.user.display_name') ?>
            <input type="text" name="display_name" value="<?= e($user['display_name'] ?? '') ?>" maxlength="120">
        </label>
        <label>
            <?= __('admin.user.role') ?>
            <select name="role">
                <option value="user"  <?= ($user['role'] ?? 'user') === 'user'  ? 'selected' : '' ?>>user</option>
                <option value="admin" <?= ($user['role'] ?? '')     === 'admin' ? 'selected' : '' ?>>admin</option>
            </select>
        </label>
        <label>
            <?= $isNew ? __('admin.user.password_new') : __('admin.user.password_edit') ?>
            <input type="<?= $isNew ? 'password' : 'password' ?>"
                   name="<?= $isNew ? 'password' : 'new_password' ?>"
                   <?= $isNew ? 'required' : '' ?>
                   minlength="8" autocomplete="new-password">
        </label>

        <div class="form-actions">
            <button type="submit" class="btn btn-primary"><?= $isNew ? __('admin.user.create') : __('admin.user.save') ?></button>
        </div>
    </form>
</section>
