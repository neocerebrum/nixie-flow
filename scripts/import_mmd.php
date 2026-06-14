<?php
declare(strict_types=1);

/**
 * One-shot: import `.mmd` files (with optional `.mmd.layout.json`
 * sidecars) into the Nixie Flow DB as fresh diagrams owned by a given user.
 *
 * Usage:
 *   php scripts/import_mmd.php --source=/path/to/diagrams --owner=admin@example.com
 *
 * Optional flags:
 *   --dry-run       parse + report what would be created, no DB writes
 *   --prefix=foo    prepend "foo-" to every imported slug (avoids collisions)
 *   --overwrite     if a slug already exists, append a new revision instead of skipping
 *
 * On hosts with multiple PHP versions (e.g. Plesk), use the per-version binary:
 *   /opt/plesk/php/8.4/bin/php scripts/import_mmd.php --source=... --owner=...
 */

require __DIR__ . '/../app/bootstrap.php';

use App\Models\Diagram;
use App\Models\Revision;
use App\Models\User;
use App\Slug;

$opts = getopt('', ['source:', 'owner:', 'dry-run', 'prefix::', 'overwrite']);
$source = $opts['source'] ?? null;
$owner  = $opts['owner']  ?? null;
$dryRun = array_key_exists('dry-run', $opts);
$prefix = isset($opts['prefix']) && $opts['prefix'] !== '' ? trim((string) $opts['prefix'], '-') . '-' : '';
$overwrite = array_key_exists('overwrite', $opts);

if (!$source || !$owner) {
    fwrite(STDERR, "Usage: php scripts/import_mmd.php --source=<dir> --owner=<email> [--dry-run] [--prefix=<str>] [--overwrite]\n");
    exit(2);
}

if (!is_dir($source)) {
    fwrite(STDERR, "Source directory not found: $source\n");
    exit(2);
}

$user = User::byEmail($owner);
if ($user === null) {
    fwrite(STDERR, "Owner not found in users table: $owner\n");
    exit(2);
}
if (User::isDisabled($user)) {
    fwrite(STDERR, "Owner is disabled: $owner\n");
    exit(2);
}

$files = glob(rtrim($source, '/') . '/*.mmd');
if (!$files) {
    fwrite(STDERR, "No .mmd files in $source\n");
    exit(0);
}

$created = $skipped = $updated = $failed = 0;
$mode = $dryRun ? 'DRY-RUN' : 'IMPORT';
fwrite(STDOUT, "[$mode] " . count($files) . " files, owner={$user['email']}, prefix='$prefix'\n");

foreach ($files as $mmdPath) {
    $base = basename($mmdPath, '.mmd');
    $slugCandidate = $prefix . Slug::fromTitle($base);
    if (!Slug::validate($slugCandidate)) {
        fwrite(STDERR, "  ! invalid slug derived from '$base' -> '$slugCandidate' (skipped)\n");
        $failed++;
        continue;
    }

    $sourceText = file_get_contents($mmdPath);
    if ($sourceText === false || $sourceText === '') {
        fwrite(STDERR, "  ! cannot read $mmdPath (skipped)\n");
        $failed++;
        continue;
    }

    $layoutJson = null;
    $layoutPath = $mmdPath . '.layout.json';
    if (is_file($layoutPath)) {
        $raw = file_get_contents($layoutPath);
        $decoded = $raw !== false ? json_decode($raw, true) : null;
        if (is_array($decoded)) {
            $positions = $decoded['positions'] ?? null;
            if (is_array($positions)) {
                $layoutJson = json_encode(
                    ['version' => 1, 'positions' => $positions === [] ? new stdClass() : $positions],
                    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                );
            }
        }
    }

    $existing = Diagram::bySlug($slugCandidate);
    if ($existing !== null) {
        if (!$overwrite) {
            fwrite(STDOUT, "  ~ $slugCandidate exists (skipped; use --overwrite to append)\n");
            $skipped++;
            continue;
        }
        if ($dryRun) {
            fwrite(STDOUT, "  + $slugCandidate (would append a new revision)\n");
            $updated++;
            continue;
        }
        try {
            Revision::createAndAdvanceHead(
                (int) $existing['id'],
                $existing['head_revision_id'] !== null ? (int) $existing['head_revision_id'] : null,
                $sourceText,
                $layoutJson,
                (int) $user['id'],
                'imported from filesystem'
            );
            fwrite(STDOUT, "  + $slugCandidate (new revision)\n");
            $updated++;
        } catch (\Throwable $e) {
            fwrite(STDERR, "  ! $slugCandidate failed: " . $e->getMessage() . "\n");
            $failed++;
        }
        continue;
    }

    if ($dryRun) {
        fwrite(STDOUT, "  + $slugCandidate (would create)\n");
        $created++;
        continue;
    }

    try {
        Diagram::createWithFirstRevision(
            $slugCandidate,
            $base,
            (int) $user['id'],
            $sourceText,
            $layoutJson
        );
        fwrite(STDOUT, "  + $slugCandidate created\n");
        $created++;
    } catch (\Throwable $e) {
        fwrite(STDERR, "  ! $slugCandidate failed: " . $e->getMessage() . "\n");
        $failed++;
    }
}

fwrite(STDOUT, sprintf(
    "[%s] done: %d created, %d updated, %d skipped, %d failed\n",
    $mode, $created, $updated, $skipped, $failed
));
exit($failed > 0 ? 1 : 0);
