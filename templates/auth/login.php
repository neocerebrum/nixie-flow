<?php /** @var string $next */
/** @var string $csrfToken */
/** @var ?string $error */
?>
<div class="auth-card">
    <h1><?= __('login.heading') ?></h1>
    <p class="muted"><?= __('login.subtitle') ?></p>
    <?php if (!empty($error)): ?>
        <div class="flash flash-error"><?= e($error) ?></div>
    <?php endif; ?>
    <form method="post" action="/login" class="form">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <input type="hidden" name="next" value="<?= e($next) ?>">
        <label>
            <?= __('login.email') ?>
            <input type="email" name="email" autocomplete="username" required autofocus>
        </label>
        <label>
            <?= __('login.password') ?>
            <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit" class="btn btn-primary"><?= __('login.submit') ?></button>
    </form>
    <p class="muted" style="margin-top:1rem">
        <a href="/password-reset"><?= __('login.forgot_password') ?></a>
        <?php if (\App\Config::bool('SIGNUP_ENABLED', true)): ?>
            &nbsp;·&nbsp; <a href="/signup"><?= __('login.create_account') ?></a>
        <?php endif; ?>
    </p>
</div>
