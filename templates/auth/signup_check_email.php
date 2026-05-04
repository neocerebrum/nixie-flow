<?php /** @var ?array $flash */ ?>
<div class="auth-card">
    <h1>Controlla la tua email</h1>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <p>Ti abbiamo inviato un link di conferma. Clicca il link per attivare l'account.</p>
    <p class="muted">Non hai ricevuto l'email? Controlla anche lo spam.</p>
    <form method="post" action="/signup/resend" class="form">
        <input type="hidden" name="_csrf" value="<?= e(\App\Csrf::token()) ?>">
        <label>
            Email
            <input type="email" name="email" required>
        </label>
        <button type="submit" class="btn">Reinvia link</button>
    </form>
    <p class="muted"><a href="/login">Torna al login</a></p>
</div>
