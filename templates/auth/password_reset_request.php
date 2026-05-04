<?php
/** @var string $csrfToken */
/** @var ?array $flash */
?>
<div class="auth-card">
    <h1>Recupero password</h1>
    <p class="muted">Inserisci la tua email per ricevere un link di reset.</p>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <form method="post" action="/password-reset" class="form">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <label>
            Email
            <input type="email" name="email" required autofocus autocomplete="email">
        </label>
        <button type="submit" class="btn btn-primary">Invia link</button>
    </form>
    <p class="muted"><a href="/login">Torna al login</a></p>
</div>
