<?php
/** @var string $csrfToken */
/** @var string $token */
/** @var ?array $flash */
?>
<div class="auth-card">
    <h1>Imposta nuova password</h1>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <form method="post" action="/password-reset/confirm" class="form" autocomplete="off">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <input type="hidden" name="token" value="<?= e($token) ?>">
        <label>
            Nuova password
            <input type="password" name="password" required minlength="8" autocomplete="new-password" autofocus>
        </label>
        <label>
            Conferma password
            <input type="password" name="password_confirm" required minlength="8" autocomplete="new-password">
        </label>
        <button type="submit" class="btn btn-primary">Aggiorna</button>
    </form>
</div>
