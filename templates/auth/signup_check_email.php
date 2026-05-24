<?php /** @var ?array $flash */ ?>
<div class="auth-card">
    <h1><?= __('signup.check_email.heading') ?></h1>
    <?php if ($flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endif; ?>
    <p><?= __('signup.check_email.body') ?></p>
    <p class="muted"><?= __('signup.check_email.spam') ?></p>
    <form method="post" action="/signup/resend" class="form">
        <input type="hidden" name="_csrf" value="<?= e(\App\Csrf::token()) ?>">
        <label>
            <?= __('signup.check_email.email') ?>
            <input type="email" name="email" required>
        </label>
        <button type="submit" class="btn"><?= __('signup.check_email.resend') ?></button>
    </form>
    <p class="muted"><a href="/login"><?= __('signup.check_email.back') ?></a></p>
</div>
