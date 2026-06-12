<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Scepter (edit holder) on a diagram. Presence-driven: the scepter is valid
 * while the holder has a fresh `diagram_viewers` row. See {@see Presence}
 * for ensure/promotion logic. This class only handles the column-level
 * read/write on `diagrams.edit_lock_user` / `edit_lock_at`.
 */
final class Lock
{
    /**
     * Public DTO for the scepter on a diagram row.
     * is_active is true iff edit_lock_user is set; freshness (presence) is
     * enforced separately via Presence::ensureHolder before relying on this.
     */
    public static function state(array $diagram): array
    {
        $userId = isset($diagram['edit_lock_user']) && $diagram['edit_lock_user'] !== null
            ? (int) $diagram['edit_lock_user'] : null;
        $since  = isset($diagram['edit_lock_at']) && $diagram['edit_lock_at'] !== null
            ? (string) $diagram['edit_lock_at'] : null;
        // When set, the holder is an agent (MCP) and this is its display label
        // (the API-token name). NULL means a human holds it (or no one).
        $agentLabel = isset($diagram['edit_lock_agent_label']) && $diagram['edit_lock_agent_label'] !== null
            ? (string) $diagram['edit_lock_agent_label'] : null;

        return [
            'user_id'     => $userId,
            'since'       => $since,
            'is_active'   => $userId !== null,
            'agent_label' => $agentLabel,
        ];
    }

    /** True iff the diagram row records this user as the current holder. */
    public static function heldBy(array $diagram, int $userId): bool
    {
        return isset($diagram['edit_lock_user'])
            && $diagram['edit_lock_user'] !== null
            && (int) $diagram['edit_lock_user'] === $userId;
    }

    /**
     * Agent (MCP) claim: take the scepter for a presence-less caller only if it
     * is currently free or already held by the same user. On success stamps the
     * agent label and refreshes edit_lock_at, which doubles as the hold's lease
     * (see {@see Presence::ensureHolder}, which keeps a fresh agent hold and
     * reclaims a stale one). Returns true iff the scepter is now ours.
     */
    public static function tryClaimAgent(int $diagramId, int $userId, ?string $label): bool
    {
        $pdo = db();
        $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
            $forUpdate = '';
        } else {
            $pdo->beginTransaction();
            $forUpdate = ' FOR UPDATE';
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT edit_lock_user FROM diagrams WHERE id = ?' . $forUpdate
            );
            $stmt->execute([$diagramId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                $pdo->rollBack();
                return false;
            }
            $current = $row['edit_lock_user'];
            $free = $current === null || (int) $current === $userId;
            if ($free) {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_user = ?, edit_lock_at = CURRENT_TIMESTAMP,
                            edit_lock_agent_label = ? WHERE id = ?'
                );
                $stmt->execute([$userId, $label, $diagramId]);
            }
            $pdo->commit();
            return $free;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Release an agent hold: clear the scepter only if this user currently
     * holds it AS an agent (edit_lock_agent_label set). Returns true iff it was
     * ours and is now cleared. The caller should run {@see Presence::ensureHolder}
     * afterwards to promote a waiting human. A human-held scepter is never
     * touched by this.
     */
    public static function releaseIfHeldByAgent(int $diagramId, int $userId): bool
    {
        $pdo = db();
        $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
            $forUpdate = '';
        } else {
            $pdo->beginTransaction();
            $forUpdate = ' FOR UPDATE';
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT edit_lock_user, edit_lock_agent_label FROM diagrams WHERE id = ?' . $forUpdate
            );
            $stmt->execute([$diagramId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                $pdo->rollBack();
                return false;
            }
            $mine = $row['edit_lock_user'] !== null
                && (int) $row['edit_lock_user'] === $userId
                && $row['edit_lock_agent_label'] !== null;
            if ($mine) {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_user = NULL, edit_lock_at = NULL,
                            edit_lock_agent_label = NULL WHERE id = ?'
                );
                $stmt->execute([$diagramId]);
            }
            $pdo->commit();
            return $mine;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Atomically set a new scepter holder (or clear it with $userId === null).
     * Pass $agentLabel when transferring to an agent — the label is stamped on
     * edit_lock_agent_label so the browser banner updates immediately. Omit (or
     * pass null) for human-to-human transfers, which always clear the label.
     * Caller is expected to hold any necessary outer transaction; this runs a
     * short self-contained one when none is open.
     */
    public static function transfer(int $diagramId, ?int $userId, ?string $agentLabel = null): void
    {
        $pdo = db();
        $owns = !$pdo->inTransaction();
        if ($owns) $pdo->beginTransaction();
        try {
            if ($userId === null) {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_user = NULL, edit_lock_at = NULL,
                            edit_lock_agent_label = NULL WHERE id = ?'
                );
                $stmt->execute([$diagramId]);
            } else {
                $stmt = $pdo->prepare(
                    'UPDATE diagrams SET edit_lock_user = ?, edit_lock_at = CURRENT_TIMESTAMP,
                            edit_lock_agent_label = ? WHERE id = ?'
                );
                $stmt->execute([$userId, $agentLabel, $diagramId]);
            }
            if ($owns) $pdo->commit();
        } catch (\Throwable $e) {
            if ($owns && $pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }
}
