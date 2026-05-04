<?php
declare(strict_types=1);

require __DIR__ . '/../app/bootstrap.php';

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "seed_admin.php must run from CLI\n");
    exit(1);
}

$pdo = db();

$existing = (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn();
if ($existing > 0) {
    fwrite(STDERR, "An admin user already exists. To create more users, use the admin UI (Phase 1+).\n");
    exit(1);
}

function ask(string $prompt, bool $hidden = false): string
{
    fwrite(STDOUT, $prompt);
    if ($hidden && function_exists('shell_exec')) {
        shell_exec('stty -echo');
        $line = fgets(STDIN);
        shell_exec('stty echo');
        fwrite(STDOUT, "\n");
    } else {
        $line = fgets(STDIN);
    }
    return trim((string) $line);
}

$email = ask('Admin email: ');
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fwrite(STDERR, "Invalid email\n");
    exit(1);
}

$displayName = ask('Display name: ');
if ($displayName === '') {
    $displayName = strstr($email, '@', true) ?: $email;
}

$password = ask('Password (input hidden): ', true);
if (strlen($password) < 8) {
    fwrite(STDERR, "Password must be at least 8 characters\n");
    exit(1);
}

$confirm = ask('Confirm password: ', true);
if ($password !== $confirm) {
    fwrite(STDERR, "Passwords do not match\n");
    exit(1);
}

$hash = password_hash($password, PASSWORD_BCRYPT);

$stmt = $pdo->prepare(
    "INSERT INTO users (email, password_hash, display_name, role, email_verified_at)
     VALUES (?, ?, ?, 'admin', CURRENT_TIMESTAMP)"
);
$stmt->execute([$email, $hash, $displayName]);

$id = (int) $pdo->lastInsertId();
echo "Admin user created (id=$id, email=$email, verified=yes)\n";
