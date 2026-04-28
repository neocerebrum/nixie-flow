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
        <a href="/dashboard" class="<?= $active === 'dashboard' ? 'is-active' : '' ?>">Dashboard</a>
        <a href="/profile" class="<?= $active === 'profile' ? 'is-active' : '' ?>">Profilo</a>
        <?php if ($isAdmin): ?>
            <a href="/admin/users" class="<?= $active === 'admin' ? 'is-active' : '' ?>">Admin</a>
        <?php endif; ?>
    </nav>
    <div class="topnav-user">
        <span class="topnav-name"><?= e($displayName) ?></span>
        <form method="post" action="/logout" class="inline-form">
            <input type="hidden" name="_csrf" value="<?= e(\App\Csrf::token()) ?>">
            <button type="submit" class="btn-link">Logout</button>
        </form>
    </div>
</header>
