<?php
declare(strict_types=1);

// CLI escape hatch: reset any user's password by email.
// Usage:
//   /opt/plesk/php/8.X/bin/php scripts/reset_password.php user@example.com
//
// Use this only when no admin can log in (lost admin password).

require __DIR__ . '/../app/bootstrap.php';

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "reset_password.php must run from CLI\n");
    exit(1);
}

if ($argc < 2) {
    fwrite(STDERR, "Usage: php scripts/reset_password.php <email>\n");
    exit(1);
}

$email = trim((string) $argv[1]);
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fwrite(STDERR, "Invalid email\n");
    exit(1);
}

$pdo = db();
$stmt = $pdo->prepare('SELECT id, email, role, disabled_at FROM users WHERE LOWER(email) = LOWER(?)');
$stmt->execute([$email]);
$user = $stmt->fetch(PDO::FETCH_ASSOC);

if ($user === false) {
    fwrite(STDERR, "User not found: $email\n");
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

echo "Resetting password for: {$user['email']} (role={$user['role']})";
if (!empty($user['disabled_at'])) {
    echo " [DISABLED at {$user['disabled_at']}]";
}
echo "\n";

$password = ask('New password (input hidden): ', true);
if (strlen($password) < 8) {
    fwrite(STDERR, "Password must be at least 8 characters\n");
    exit(1);
}
$confirm = ask('Confirm: ', true);
if ($password !== $confirm) {
    fwrite(STDERR, "Passwords do not match\n");
    exit(1);
}

$hash = password_hash($password, PASSWORD_BCRYPT);
$update = $pdo->prepare(
    'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
);
$update->execute([$hash, (int) $user['id']]);

echo "Password updated for {$user['email']}.\n";
