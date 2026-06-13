<?php /** @var string $token */ /** @var string $csrfToken */ ?>
<div class="auth-card">
    <h1><?= __('verify.confirm.heading') ?></h1>
    <p><?= __('verify.confirm.body') ?></p>
    <form method="post" action="/signup/verify">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
        <input type="hidden" name="token" value="<?= e($token) ?>">
        <button type="submit" class="btn btn-primary"><?= __('verify.confirm.submit') ?></button>
    </form>
</div>
