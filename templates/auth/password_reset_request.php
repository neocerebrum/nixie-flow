<?php
/** @var string $csrfToken */
/** @var ?array $flash */
?>
<div class="auth-card">
    <h1><?= __('pwreset.request.heading') ?></h1>
    <p class="muted"><?= __('pwreset.request.subtitle') ?></p>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <form method="post" action="/password-reset" class="form">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <label>
            <?= __('pwreset.request.email') ?>
            <input type="email" name="email" required autofocus autocomplete="email">
        </label>
        <button type="submit" class="btn btn-primary"><?= __('pwreset.request.submit') ?></button>
    </form>
    <p class="muted"><a href="/login"><?= __('pwreset.request.back') ?></a></p>
</div>
