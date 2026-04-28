<?php /** @var array $user */
/** @var string $csrfToken */
/** @var ?array $flash */
?>
<section class="page">
    <h1>Profilo</h1>
    <?php include __DIR__ . '/partials/flash.php'; ?>

    <form method="post" action="/profile" class="form card">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">

        <h2>Dati account</h2>
        <label>
            Email
            <input type="email" value="<?= e($user['email']) ?>" disabled>
            <small class="muted">L'email non è modificabile.</small>
        </label>
        <label>
            Nome visualizzato
            <input type="text" name="display_name" value="<?= e($user['display_name'] ?? '') ?>" maxlength="120">
        </label>

        <h2>Cambia password</h2>
        <p class="muted">Lascia tutti i campi vuoti per non cambiarla.</p>
        <label>
            Password attuale
            <input type="password" name="current_password" autocomplete="current-password">
        </label>
        <label>
            Nuova password
            <input type="password" name="new_password" autocomplete="new-password" minlength="8">
        </label>
        <label>
            Conferma nuova password
            <input type="password" name="confirm_password" autocomplete="new-password" minlength="8">
        </label>

        <div class="form-actions">
            <button type="submit" class="btn btn-primary">Salva</button>
        </div>
    </form>

    <section class="card">
        <h2>Token API / MCP</h2>
        <p class="muted-small">Gestisci i Bearer token per accedere ad Aquata da Claude (MCP) e altri client.</p>
        <a class="btn" href="/profile/tokens">Gestisci token →</a>
    </section>
</section>
