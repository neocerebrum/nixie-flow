<?php /** @var string $body */
/** @var string $title */
/** @var string $active */
/** @var ?array $currentUser */
/** @var bool $noNav */
$noNav = $noNav ?? false;
?><!doctype html>
<html lang="it">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e($title) ?></title>
    <?php if ($currentUser !== null): ?>
        <meta name="csrf-token" content="<?= e(\App\Csrf::token()) ?>">
    <?php endif; ?>
    <link rel="stylesheet" href="/static/app.css">
</head>
<body>
<?php include __DIR__ . '/partials/icons.php'; ?>
<?php if (!$noNav && $currentUser !== null): ?>
    <?php include __DIR__ . '/partials/nav.php'; ?>
<?php endif; ?>
<main>
    <?= $body ?>
</main>
</body>
</html>
