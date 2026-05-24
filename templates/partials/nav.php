<?php /** @var array $currentUser */
/** @var string $active */
$isAdmin = ($currentUser['role'] ?? null) === 'admin';
$displayName = $currentUser['display_name'] ?? '';
?>
<header class="topnav">
    <div class="topnav-brand">
        <a href="/dashboard">Aquata</a>
    </div>
    <nav class="topnav-links">
        <a href="/dashboard" class="<?= $active === 'dashboard' ? 'is-active' : '' ?>"><?= __('nav.dashboard') ?></a>
        <a href="/profile" class="<?= $active === 'profile' ? 'is-active' : '' ?>"><?= __('nav.profile') ?></a>
        <?php if ($isAdmin): ?>
            <a href="/admin/users" class="<?= $active === 'admin' ? 'is-active' : '' ?>"><?= __('nav.admin') ?></a>
        <?php endif; ?>
    </nav>
    <div class="topnav-user">
        <select class="lang-switch" onchange="document.cookie='aquata_lang='+this.value+';path=/;max-age=31536000';location.reload()">
            <?php foreach (App\I18n::supportedLocales() as $loc): ?>
                <option value="<?= $loc ?>" <?= App\I18n::locale() === $loc ? 'selected' : '' ?>><?= strtoupper($loc) ?></option>
            <?php endforeach; ?>
        </select>
        <span class="topnav-name"><?= e($displayName) ?></span>
        <form method="post" action="/logout" class="inline-form">
            <input type="hidden" name="_csrf" value="<?= e(\App\Csrf::token()) ?>">
            <button type="submit" class="btn-link"><?= __('nav.logout') ?></button>
        </form>
    </div>
</header>
