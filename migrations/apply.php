<?php
declare(strict_types=1);

require __DIR__ . '/../app/bootstrap.php';

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "apply.php must run from CLI\n");
    exit(1);
}

$pdo = db();

$pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)');

$applied = [];
foreach ($pdo->query('SELECT version FROM schema_migrations') as $row) {
    $applied[$row['version']] = true;
}

$files = glob(__DIR__ . '/[0-9][0-9][0-9]_*.sql') ?: [];
sort($files);

$ranAny = false;
foreach ($files as $file) {
    $name = basename($file, '.sql');
    [$version] = explode('_', $name, 2);
    if (isset($applied[$version])) {
        continue;
    }

    $sql = file_get_contents($file);
    if ($sql === false) {
        fwrite(STDERR, "Cannot read $file\n");
        exit(1);
    }

    echo "Applying migration $name...\n";
    $pdo->beginTransaction();
    try {
        $pdo->exec($sql);
        $stmt = $pdo->prepare('INSERT INTO schema_migrations (version) VALUES (?)');
        $stmt->execute([$version]);
        $pdo->commit();
        echo "  OK\n";
        $ranAny = true;
    } catch (\Throwable $e) {
        $pdo->rollBack();
        fwrite(STDERR, "FAILED applying $name: " . $e->getMessage() . "\n");
        exit(1);
    }
}

if (!$ranAny) {
    echo "All migrations up to date.\n";
}
