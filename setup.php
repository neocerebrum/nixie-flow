<?php
declare(strict_types=1);

/**
 * One-time admin setup for installs without SSH access.
 * Refuses to run if an admin already exists.
 * DELETE THIS FILE immediately after use.
 */

require __DIR__ . '/app/bootstrap.php';

$pdo = db();
$error = '';
$done  = false;

$existing = (int) $pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn();
if ($existing > 0) {
    die('<p style="font-family:sans-serif;color:red">An admin user already exists. Delete this file.</p>');
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $email       = trim($_POST['email'] ?? '');
    $name        = trim($_POST['display_name'] ?? '');
    $password    = $_POST['password'] ?? '';
    $confirm     = $_POST['confirm'] ?? '';

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $error = 'Invalid email address.';
    } elseif (strlen($password) < 8) {
        $error = 'Password must be at least 8 characters.';
    } elseif ($password !== $confirm) {
        $error = 'Passwords do not match.';
    } else {
        if ($name === '') {
            $name = strstr($email, '@', true) ?: $email;
        }
        $hash = password_hash($password, PASSWORD_BCRYPT);
        $stmt = $pdo->prepare(
            "INSERT INTO users (email, password_hash, display_name, role, tier, email_verified_at)
             VALUES (?, ?, ?, 'admin', 'full', CURRENT_TIMESTAMP)"
        );
        $stmt->execute([$email, $hash, $name]);
        @unlink(__FILE__);
        $done = true;
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nixie Flow — First admin setup</title>
<style>
  body { font-family: sans-serif; max-width: 420px; margin: 60px auto; padding: 0 1rem; }
  h1   { font-size: 1.2rem; }
  label { display: block; margin-top: 1rem; font-size: .9rem; }
  input { display: block; width: 100%; box-sizing: border-box; padding: .4rem .6rem;
          margin-top: .25rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; }
  button { margin-top: 1.5rem; padding: .5rem 1.2rem; background: #2563eb; color: #fff;
           border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  .error { color: red; margin-top: 1rem; }
  .ok    { color: green; }
</style>
</head>
<body>
<h1>Nixie Flow — First admin setup</h1>

<?php if ($done): ?>
  <p class="ok"><strong>Admin user created.</strong></p>
  <p>You can now <a href="/login">log in</a>.<br>
  <strong>Delete <code>setup.php</code> from the server immediately.</strong></p>
<?php else: ?>
  <?php if ($error): ?><p class="error"><?= htmlspecialchars($error) ?></p><?php endif; ?>
  <form method="post">
    <label>Email
      <input type="email" name="email" required value="<?= htmlspecialchars($_POST['email'] ?? '') ?>">
    </label>
    <label>Display name <span style="color:#888">(optional)</span>
      <input type="text" name="display_name" value="<?= htmlspecialchars($_POST['display_name'] ?? '') ?>">
    </label>
    <label>Password
      <input type="password" name="password" required>
    </label>
    <label>Confirm password
      <input type="password" name="confirm" required>
    </label>
    <button type="submit">Create admin</button>
  </form>
<?php endif; ?>
</body>
</html>
