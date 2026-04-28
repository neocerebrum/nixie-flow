<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Turn-based edit lock on a diagram.
 *
 * Lock columns live on the `diagrams` table: edit_lock_user, edit_lock_at.
 * A lock is "active" while now - edit_lock_at <= TTL_SECONDS. Older = expired = free.
 * Clients are expected to heartbeat every HEARTBEAT_SECONDS.
 */
final class Lock
{
    public const TTL_SECONDS       = 90;
    public const HEARTBEAT_SECONDS = 30;

    /**
     * Public lock state for a diagram row. Returns:
     *   ['user_id' => int|null, 'since' => string|null, 'is_active' => bool, 'expires_at' => string|null]
     */
    public static function state(array $diagram): array
    {
        $userId = $diagram['edit_lock_user'] !== null ? (int) $diagram['edit_lock_user'] : null;
        $since  = $diagram['edit_lock_at'] !== null ? (string) $diagram['edit_lock_at'] : null;
        $active = false;
        $expires = null;

        if ($userId !== null && $since !== null) {
            $sinceTs = strtotime($since . ' UTC');
            if ($sinceTs !== false) {
                $expiresTs = $sinceTs + self::TTL_SECONDS;
                $active = time() < $expiresTs;
                $expires = gmdate('Y-m-d H:i:s', $expiresTs);
            }
        }

        return [
            'user_id'    => $userId,
            'since'      => $since,
            'is_active'  => $active,
            'expires_at' => $expires,
        ];
    }

    /**
     * Try to acquire the lock for a user. Atomic with optimistic check.
     * Succeeds when: free, expired, or already held by this user (refresh).
     * Returns updated state. If acquired, ['user_id'] === $userId and ['is_active'] === true.
     */
    public static function tryAcquire(int $diagramId, int $userId): array
    {
        $pdo = db();
        $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
        } else {
            $pdo->beginTransaction();
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT id, edit_lock_user, edit_lock_at FROM diagrams WHERE id = ?'
            );
            $stmt->execute([$diagramId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                $pdo->rollBack();
                throw new \RuntimeException('Diagram not found');
            }

            $current = self::state($row);
            $canTake = !$current['is_active']
                || $current['user_id'] === $userId;

            if ($canTake) {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_user = ?, edit_lock_at = CURRENT_TIMESTAMP WHERE id = ?'
                );
                $stmt->execute([$userId, $diagramId]);
            }

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $fresh = Diagram::byId($diagramId);
        return self::state($fresh ?? []);
    }

    /**
     * Refresh the lock heartbeat. Only acts if $userId currently holds the lock.
     * If not (expired or someone else has it), returns the current state unchanged.
     */
    public static function heartbeat(int $diagramId, int $userId): array
    {
        $pdo = db();
        $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
        } else {
            $pdo->beginTransaction();
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT id, edit_lock_user, edit_lock_at FROM diagrams WHERE id = ?'
            );
            $stmt->execute([$diagramId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                $pdo->rollBack();
                throw new \RuntimeException('Diagram not found');
            }

            $current = self::state($row);
            if ($current['user_id'] === $userId && $current['is_active']) {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_at = CURRENT_TIMESTAMP WHERE id = ?'
                );
                $stmt->execute([$diagramId]);
            }

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $fresh = Diagram::byId($diagramId);
        return self::state($fresh ?? []);
    }

    /**
     * Release the lock. By default only the holder can release; admins force-release.
     */
    public static function release(int $diagramId, int $userId, bool $force = false): void
    {
        $pdo = db();
        $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
        } else {
            $pdo->beginTransaction();
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT edit_lock_user FROM diagrams WHERE id = ?'
            );
            $stmt->execute([$diagramId]);
            $holder = $stmt->fetchColumn();

            if ($holder !== false && ($force || (int) $holder === $userId)) {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_user = NULL, edit_lock_at = NULL WHERE id = ?'
                );
                $stmt->execute([$diagramId]);
            }

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * True if $userId currently holds an active lock on the diagram row.
     * Pass a freshly-loaded diagram row (after acquire/save).
     */
    public static function heldBy(array $diagram, int $userId): bool
    {
        $s = self::state($diagram);
        return $s['is_active'] && $s['user_id'] === $userId;
    }
}
