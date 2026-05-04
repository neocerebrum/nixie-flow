<?php
/** @var string $csrfToken */
/** @var ?array $flash */
$form = $_SESSION['_signup_form'] ?? ['email' => '', 'display_name' => ''];
unset($_SESSION['_signup_form']);
?>
<div class="auth-card">
    <h1>Crea il tuo account</h1>
    <p class="muted">Registrati per usare l'editor Aquata.</p>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <form method="post" action="/signup" class="form" autocomplete="on">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <label>
            Email
            <input type="email" name="email" required autofocus
                   value="<?= e($form['email']) ?>" autocomplete="email">
        </label>
        <label>
            Nome visualizzato
            <input type="text" name="display_name" required maxlength="100"
                   value="<?= e($form['display_name']) ?>" autocomplete="name">
        </label>
        <label>
            Password
            <input type="password" name="password" required minlength="8"
                   autocomplete="new-password">
        </label>
        <label class="hp-field" aria-hidden="true" tabindex="-1">
            Lascia vuoto questo campo
            <input type="text" name="website" tabindex="-1" autocomplete="off">
        </label>
        <label class="checkbox">
            <input type="checkbox" name="accept_tos" required>
            Accetto i termini di servizio
        </label>
        <button type="submit" class="btn btn-primary">Registrati</button>
    </form>
    <p class="muted">
        Hai già un account? <a href="/login">Accedi</a>
    </p>
</div>
