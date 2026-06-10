<?php /** @var string $body */
/** @var string $title */
/** @var string $active */
/** @var ?array $currentUser */
/** @var bool $noNav */
$noNav = $noNav ?? false;
?><!doctype html>
<html lang="<?= App\I18n::locale() ?>">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e($title) ?></title>
    <link rel="icon" type="image/svg+xml" href="<?= e(asset('/static/aquata_favicon.svg')) ?>">
    <?php if ($currentUser !== null): ?>
        <meta name="csrf-token" content="<?= e(\App\Csrf::token()) ?>">
    <?php endif; ?>
    <link rel="stylesheet" href="<?= e(asset('/static/app.css')) ?>">
    <script>window.__i18n=<?= json_encode(App\I18n::jsStrings(), JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?>;</script>
</head>
<body>
<?php include __DIR__ . '/partials/icons.php'; ?>
<?php if (!$noNav && $currentUser !== null): ?>
    <?php include __DIR__ . '/partials/nav.php'; ?>
<?php endif; ?>
<main>
    <?= $body ?>
</main>
<?php if ($noNav || $currentUser === null): ?>
    <div class="lang-footer">
        <?php foreach (App\I18n::supportedLocales() as $loc): ?>
            <?php if (App\I18n::locale() === $loc): ?>
                <strong><?= strtoupper($loc) ?></strong>
            <?php else: ?>
                <a href="#" onclick="document.cookie='aquata_lang=<?= $loc ?>;path=/;max-age=31536000';location.reload();return false"><?= strtoupper($loc) ?></a>
            <?php endif; ?>
        <?php endforeach; ?>
    </div>
<?php endif; ?>
</body>
</html>
