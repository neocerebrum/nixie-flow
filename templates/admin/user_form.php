<?php /** @var string $mode */
/** @var array $user */
/** @var string $csrfToken */
/** @var ?array $flash */
$isNew = $mode === 'new';
$action = $isNew ? '/admin/users' : '/admin/users/' . (int) $user['id'];
?>
<section class="page">
    <header class="page-header">
        <h1><?= $isNew ? 'Nuovo utente' : 'Modifica utente' ?></h1>
        <a href="/admin/users" class="btn-link">← Torna alla lista</a>
    </header>

    <?php include __DIR__ . '/../partials/flash.php'; ?>

    <form method="post" action="<?= e($action) ?>" class="form card">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">

        <label>
            Email
            <?php if ($isNew): ?>
                <input type="email" name="email" required maxlength="255" autofocus>
            <?php else: ?>
                <input type="email" value="<?= e($user['email']) ?>" disabled>
            <?php endif; ?>
        </label>
        <label>
            Nome visualizzato
            <input type="text" name="display_name" value="<?= e($user['display_name'] ?? '') ?>" maxlength="120">
        </label>
        <label>
            Ruolo
            <select name="role">
                <option value="user"  <?= ($user['role'] ?? 'user') === 'user'  ? 'selected' : '' ?>>user</option>
                <option value="admin" <?= ($user['role'] ?? '')     === 'admin' ? 'selected' : '' ?>>admin</option>
            </select>
        </label>
        <label>
            <?= $isNew ? 'Password (min 8 caratteri)' : 'Reset password (lascia vuoto per non cambiare)' ?>
            <input type="<?= $isNew ? 'password' : 'password' ?>"
                   name="<?= $isNew ? 'password' : 'new_password' ?>"
                   <?= $isNew ? 'required' : '' ?>
                   minlength="8" autocomplete="new-password">
        </label>

        <div class="form-actions">
            <button type="submit" class="btn btn-primary"><?= $isNew ? 'Crea utente' : 'Salva modifiche' ?></button>
        </div>
    </form>
</section>
