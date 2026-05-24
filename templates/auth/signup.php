<?php
/** @var string $csrfToken */
/** @var ?array $flash */
$form = $_SESSION['_signup_form'] ?? ['email' => '', 'display_name' => ''];
unset($_SESSION['_signup_form']);
?>
<div class="auth-card">
    <h1><?= __('signup.heading') ?></h1>
    <p class="muted"><?= __('signup.subtitle') ?></p>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <form method="post" action="/signup" class="form" autocomplete="on">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <label>
            <?= __('signup.email') ?>
            <input type="email" name="email" required autofocus
                   value="<?= e($form['email']) ?>" autocomplete="email">
        </label>
        <label>
            <?= __('signup.display_name') ?>
            <input type="text" name="display_name" required maxlength="100"
                   value="<?= e($form['display_name']) ?>" autocomplete="name">
        </label>
        <label>
            <?= __('signup.password') ?>
            <input type="password" name="password" required minlength="8"
                   autocomplete="new-password">
        </label>
        <label class="hp-field" aria-hidden="true" tabindex="-1">
            <?= __('signup.honeypot') ?>
            <input type="text" name="website" tabindex="-1" autocomplete="off">
        </label>
        <label class="checkbox">
            <input type="checkbox" name="accept_tos" required>
            <?= __('signup.accept_tos') ?>
        </label>
        <button type="submit" class="btn btn-primary"><?= __('signup.submit') ?></button>
    </form>
    <p class="muted">
        <?= __('signup.has_account') ?> <a href="/login"><?= __('signup.login_link') ?></a>
    </p>
</div>
