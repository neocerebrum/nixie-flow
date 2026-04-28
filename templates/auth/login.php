<?php /** @var string $next */
/** @var string $csrfToken */
/** @var ?string $error */
?>
<div class="auth-card">
    <h1>Aquata</h1>
    <p class="muted">Accedi per gestire i tuoi diagrammi.</p>
    <?php if (!empty($error)): ?>
        <div class="flash flash-error"><?= e($error) ?></div>
    <?php endif; ?>
    <form method="post" action="/login" class="form">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <input type="hidden" name="next" value="<?= e($next) ?>">
        <label>
            Email
            <input type="email" name="email" autocomplete="username" required autofocus>
        </label>
        <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit" class="btn btn-primary">Accedi</button>
    </form>
</div>
