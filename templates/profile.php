<?php /** @var array $user */
/** @var string $csrfToken */
/** @var ?array $flash */
?>
<section class="page">
    <h1><?= __('profile.heading') ?></h1>
    <?php include __DIR__ . '/partials/flash.php'; ?>

    <form method="post" action="/profile" class="form card">
        <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">

        <h2><?= __('profile.account') ?></h2>
        <label>
            <?= __('profile.email') ?>
            <input type="email" value="<?= e($user['email']) ?>" disabled>
            <small class="muted"><?= __('profile.email_hint') ?></small>
        </label>
        <label>
            <?= __('profile.display_name') ?>
            <input type="text" name="display_name" value="<?= e($user['display_name'] ?? '') ?>" maxlength="120">
        </label>

        <h2><?= __('profile.change_password') ?></h2>
        <p class="muted"><?= __('profile.password_hint') ?></p>
        <label>
            <?= __('profile.current_password') ?>
            <input type="password" name="current_password" autocomplete="current-password">
        </label>
        <label>
            <?= __('profile.new_password') ?>
            <input type="password" name="new_password" autocomplete="new-password" minlength="8">
        </label>
        <label>
            <?= __('profile.confirm_password') ?>
            <input type="password" name="confirm_password" autocomplete="new-password" minlength="8">
        </label>

        <div class="form-actions">
            <button type="submit" class="btn btn-primary"><?= __('profile.save') ?></button>
        </div>
    </form>

    <section class="card">
        <h2><?= __('profile.tokens.heading') ?></h2>
        <p class="muted-small"><?= __('profile.tokens.hint') ?></p>
        <a class="btn" href="/profile/tokens"><?= __('profile.tokens.manage') ?></a>
    </section>
</section>
