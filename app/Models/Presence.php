<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Per-diagram viewer presence + scepter (edit holder) management.
 *
 * Invariant: while at least one viewer with write permission is connected,
 * exactly one of them holds the scepter (`diagrams.edit_lock_user`). The
 * scepter is presence-driven: a holder is "alive" only while they have a
 * fresh `diagram_viewers` row.
 *
 * Promotion priority when the holder is gone:
 *   1) oldest pending edit_request from a present writer
 *   2) owner (if present)
 *   3) shared-edit users (oldest joined_at first)
 *   4) no holder (clear edit_lock_user/at)
 *
 * Shared-view users never hold the scepter.
 */
final class Presence
{
    public const TTL_SECONDS          = 60;
    public const HEARTBEAT_SECONDS    = 15;
    public const SELECTION_MAX        = 4096;
    public const VIEW_STATE_MAX       = 256;
    public const IDLE_TIMEOUT_SECONDS = 600; // 10 min — after this the holder can be evicted by a pending request
    private const TAB_ID_MAX          = 64;

    /**
     * Upsert presence for the user. If `claim_active` is true (or no active
     * tab is recorded), set this tab as active. After upsert, ensure a holder
     * is in place (will promote the joiner if scepter is vacant).
     *
     * Returns the post-state DTO from {@see self::stateFor()}.
     */
    public static function join(int $diagramId, int $userId, string $tabId, bool $claimActive = true): array
    {
        self::upsert($diagramId, $userId, $tabId, $claimActive);
        // Reset any stale selection from a previous session — joining means
        // starting fresh, even if the row was kept alive by a stray heartbeat.
        $stmt = db()->prepare(
            'UPDATE diagram_viewers SET selection_json = NULL, selection_at = NULL
             WHERE diagram_id = ? AND user_id = ?'
        );
        $stmt->execute([$diagramId, $userId]);
        self::ensureHolder($diagramId);
        return self::stateFor($diagramId, $userId);
    }

    /**
     * Refresh `last_seen_at` (and active_tab_id when claimActive) and run
     * promotion if the current holder has gone stale.
     */
    public static function heartbeat(int $diagramId, int $userId, string $tabId, bool $claimActive = false): array
    {
        self::upsert($diagramId, $userId, $tabId, $claimActive);
        self::ensureHolder($diagramId);
        return self::stateFor($diagramId, $userId);
    }

    /**
     * Mark this user's presence stale so a peer's next heartbeat triggers
     * promotion. If the user has another tab still beating, that tab will
     * refresh the row again before the cutoff and they remain holder.
     */
    public static function leave(int $diagramId, int $userId, string $tabId): void
    {
        $pdo = db();
        // Push last_seen_at past the TTL so the row is "expired" immediately,
        // unless another tab heartbeats it back to fresh.
        $past = gmdate('Y-m-d H:i:s', time() - self::TTL_SECONDS - 1);
        $stmt = $pdo->prepare(
            'UPDATE diagram_viewers SET last_seen_at = ? WHERE diagram_id = ? AND user_id = ? AND active_tab_id = ?'
        );
        $stmt->execute([$past, $diagramId, $userId, substr($tabId, 0, self::TAB_ID_MAX)]);

        // Also: if this was the active tab, clear it so no save can be issued
        // before promotion.
        $stmt = $pdo->prepare(
            'UPDATE diagram_viewers SET active_tab_id = NULL
             WHERE diagram_id = ? AND user_id = ? AND active_tab_id = ?'
        );
        $stmt->execute([$diagramId, $userId, substr($tabId, 0, self::TAB_ID_MAX)]);

        self::ensureHolder($diagramId);
    }

    /**
     * Write this viewer's current selection (a JSON-encoded blob, opaque to
     * the server: validated for size + parseability only). Returns the post-
     * state DTO so the caller can refresh peers in one round-trip.
     *
     * Skips ensureHolder() — selection updates are high-frequency and must
     * not contend with scepter promotion locks. The row is only updated if
     * the viewer is already present (no insert).
     */
    public static function setSelection(
        int $diagramId,
        int $userId,
        string $tabId,
        ?string $selectionJson,
        ?string $viewJson = null,
        ?bool $isFollowing = null
    ): array {
        if ($selectionJson !== null && strlen($selectionJson) > self::SELECTION_MAX) {
            $selectionJson = null; // too large → drop, treat as cleared
        }
        if ($viewJson !== null && strlen($viewJson) > self::VIEW_STATE_MAX) {
            $viewJson = null;
        }
        $pdo = db();
        // Note: deliberately does NOT bump last_activity_at. The client polls
        // this endpoint every ~1.5s to fetch peer selections (force=true),
        // even with no user interaction — counting it as activity would keep
        // an AFK holder forever non-idle. Real selection changes already
        // trigger claim_active=true via pointerdown, so true activity is
        // captured through the heartbeat path. The explicit self-assign
        // defeats MariaDB's implicit ON UPDATE CURRENT_TIMESTAMP (see upsert
        // for context).
        $setClauses = [
            'selection_json = ?',
            'selection_at = CURRENT_TIMESTAMP',
            'last_seen_at = CURRENT_TIMESTAMP',
            'last_activity_at = last_activity_at',
        ];
        $params = [$selectionJson];
        if ($viewJson !== null) {
            $setClauses[] = 'view_state = ?';
            $params[] = $viewJson;
        }
        if ($isFollowing !== null) {
            $setClauses[] = 'is_following = ?';
            $params[] = $isFollowing ? 1 : 0;
        }
        $params[] = $diagramId;
        $params[] = $userId;
        $stmt = $pdo->prepare(
            'UPDATE diagram_viewers SET ' . implode(', ', $setClauses)
            . ' WHERE diagram_id = ? AND user_id = ?'
        );
        $stmt->execute($params);
        // No row → caller hasn't joined yet; quietly ignore.
        return self::stateFor($diagramId, $userId);
    }

    /**
     * Insert or update the viewer row. With one row per (diagram, user),
     * heartbeats from any tab refresh `last_seen_at`. `active_tab_id` is
     * updated when the caller claims active (focus/keypress/etc), or when
     * the previous active tab is empty.
     */
    private static function upsert(int $diagramId, int $userId, string $tabId, bool $claimActive): void
    {
        $tabId = substr($tabId, 0, self::TAB_ID_MAX);
        $pdo = db();
        $isMysql = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';

        // Try a "claim" update: refresh last_seen and possibly set active tab.
        // Only `claim_active=true` is treated as real user activity — it's the
        // signal the client sends on focus/typing/canvas-click. Passive
        // background heartbeats (claim=false) must not refresh last_activity_at
        // or the idle eviction (see ensureHolder) becomes a no-op.
        if ($claimActive) {
            $sqlUpdate = 'UPDATE diagram_viewers
                          SET last_seen_at = CURRENT_TIMESTAMP,
                              last_activity_at = CURRENT_TIMESTAMP,
                              active_tab_id = ?
                          WHERE diagram_id = ? AND user_id = ?';
            $params = [$tabId, $diagramId, $userId];
        } else {
            // Refresh seen-time, but only set active_tab_id if currently NULL or
            // already this tab. Explicit self-assignment of last_activity_at
            // defeats MariaDB's implicit ON UPDATE CURRENT_TIMESTAMP that may
            // be attached to the column when it was ADDed under
            // explicit_defaults_for_timestamp=OFF — otherwise every passive
            // heartbeat would silently bump last_activity_at to NOW and the
            // idle eviction would never trigger.
            $sqlUpdate = 'UPDATE diagram_viewers
                          SET last_seen_at = CURRENT_TIMESTAMP,
                              active_tab_id = COALESCE(active_tab_id, ?),
                              last_activity_at = last_activity_at
                          WHERE diagram_id = ? AND user_id = ?';
            $params = [$tabId, $diagramId, $userId];
        }
        $stmt = $pdo->prepare($sqlUpdate);
        $stmt->execute($params);
        if ($stmt->rowCount() > 0) {
            return;
        }

        // No row → insert.
        if ($isMysql) {
            $sqlInsert = 'INSERT INTO diagram_viewers (diagram_id, user_id, joined_at, last_seen_at, active_tab_id)
                          VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
                          ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at),
                                                  active_tab_id = COALESCE(VALUES(active_tab_id), active_tab_id)';
        } else {
            $sqlInsert = 'INSERT OR IGNORE INTO diagram_viewers
                          (diagram_id, user_id, joined_at, last_seen_at, active_tab_id)
                          VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)';
        }
        $stmt = $pdo->prepare($sqlInsert);
        $stmt->execute([$diagramId, $userId, $tabId]);
    }

    /**
     * Atomically: lock the diagram row, prune stale viewers, and reassign
     * the scepter if the current holder is no longer eligible.
     */
    public static function ensureHolder(int $diagramId): void
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
            $stmt = $pdo->prepare('SELECT id, owner_id, edit_lock_user FROM diagrams WHERE id = ?' . $forUpdate);
            $stmt->execute([$diagramId]);
            $diagram = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($diagram === false) {
                $pdo->rollBack();
                return;
            }

            // Drop expired viewer rows so the rest of this txn sees the truth.
            $cutoff = gmdate('Y-m-d H:i:s', time() - self::TTL_SECONDS);
            $stmt = $pdo->prepare(
                'DELETE FROM diagram_viewers WHERE diagram_id = ? AND last_seen_at < ?'
            );
            $stmt->execute([$diagramId, $cutoff]);

            $writers = self::eligibleWritersInTxn($pdo, $diagramId);

            $currentHolder = $diagram['edit_lock_user'] !== null
                ? (int) $diagram['edit_lock_user'] : null;
            $holderPresent = $currentHolder !== null && isset($writers[$currentHolder]);

            // Idle eviction: if the holder is present but has been inactive
            // beyond IDLE_TIMEOUT and another *present* writer has a pending
            // request, treat the holder as ineligible so pickHolderInTxn can
            // promote the requester. The presence guard matters because
            // pickHolderInTxn skips non-present requesters and would then fall
            // back to owner/oldest-joined — which could re-elect the idle
            // holder, defeating the eviction.
            $evictIdle = false;
            if ($holderPresent && self::holderIsIdle($writers[$currentHolder])) {
                foreach ($writers as $uid => $_) {
                    if ($uid === $currentHolder) continue;
                    $stmt = $pdo->prepare(
                        "SELECT 1 FROM edit_requests
                         WHERE diagram_id = ? AND requester_id = ? AND status = 'pending'
                         LIMIT 1"
                    );
                    $stmt->execute([$diagramId, $uid]);
                    if ($stmt->fetchColumn() !== false) {
                        $evictIdle = true;
                        break;
                    }
                }
            }

            if ($holderPresent && !$evictIdle) {
                $pdo->commit();
                return;
            }

            $newHolder = self::pickHolderInTxn($pdo, $diagramId, (int) $diagram['owner_id'], $writers);

            $stmt = $pdo->prepare(
                'UPDATE diagrams SET edit_lock_user = ?, edit_lock_at = ' .
                ($newHolder === null ? 'NULL' : 'CURRENT_TIMESTAMP') .
                ' WHERE id = ?'
            );
            $stmt->execute([$newHolder, $diagramId]);

            // If we just promoted someone who had a pending request, mark it granted.
            if ($newHolder !== null) {
                $stmt = $pdo->prepare(
                    "UPDATE edit_requests SET status = 'granted', resolved_at = CURRENT_TIMESTAMP
                     WHERE diagram_id = ? AND requester_id = ? AND status = 'pending'"
                );
                $stmt->execute([$diagramId, $newHolder]);

                // Give the new holder a fresh activity window. Without this, a
                // user promoted from a stale (backdated/idle) row would be
                // immediately re-evictable by the next pending request.
                $stmt = $pdo->prepare(
                    'UPDATE diagram_viewers SET last_activity_at = CURRENT_TIMESTAMP
                     WHERE diagram_id = ? AND user_id = ?'
                );
                $stmt->execute([$diagramId, $newHolder]);
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
     * Map of present users with write permission, keyed by user_id.
     * Each value: ['user_id', 'joined_at', 'is_owner']
     * Excludes shared-view-only users.
     *
     * @return array<int, array<string,mixed>>
     */
    private static function eligibleWritersInTxn(PDO $pdo, int $diagramId): array
    {
        $stmt = $pdo->prepare(
            "SELECT v.user_id, v.joined_at, v.last_activity_at,
                    d.owner_id AS owner_id,
                    s.permission AS share_permission,
                    ps.permission AS project_permission,
                    u.role AS user_role
             FROM diagram_viewers v
             INNER JOIN diagrams d ON d.id = v.diagram_id
             LEFT JOIN diagram_shares s ON s.diagram_id = v.diagram_id AND s.user_id = v.user_id
             LEFT JOIN project_shares ps ON ps.project_id = d.project_id AND ps.user_id = v.user_id
             LEFT JOIN users u ON u.id = v.user_id
             WHERE v.diagram_id = ?"
        );
        $stmt->execute([$diagramId]);

        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $uid = (int) $row['user_id'];
            $isOwner = $uid === (int) $row['owner_id'];
            // Scepter eligibility follows write permission only: owner or an
            // edit share (direct or cascaded from a shared project, mirroring
            // Diagram::sharedPermission()). Admins are not elevated — on content
            // they don't own they participate exactly as their share allows.
            $canEdit = $isOwner
                || ($row['share_permission'] === 'edit')
                || ($row['project_permission'] === 'edit');
            if (!$canEdit) {
                continue;
            }
            $out[$uid] = [
                'user_id'          => $uid,
                'joined_at'        => $row['joined_at'],
                'last_activity_at' => $row['last_activity_at'] ?? null,
                'is_owner'         => $isOwner,
            ];
        }
        return $out;
    }

    /**
     * @param array<string,mixed> $writerRow row from eligibleWritersInTxn
     */
    private static function holderIsIdle(array $writerRow): bool
    {
        $ts = $writerRow['last_activity_at'] ?? null;
        if ($ts === null || $ts === '') {
            // Legacy row with no activity timestamp: fall back to joined_at so
            // we don't evict someone who just arrived on an upgraded DB.
            $ts = $writerRow['joined_at'] ?? null;
        }
        if ($ts === null || $ts === '') return false;
        $epoch = strtotime((string) $ts . ' UTC');
        if ($epoch === false) return false;
        return (time() - $epoch) >= self::IDLE_TIMEOUT_SECONDS;
    }

    /**
     * Promotion policy:
     *   1) oldest pending edit_request from an eligible writer
     *   2) owner if present
     *   3) shared-edit (or admin) by oldest joined_at
     *   4) null
     *
     * @param array<int, array<string,mixed>> $writers
     */
    private static function pickHolderInTxn(PDO $pdo, int $diagramId, int $ownerId, array $writers): ?int
    {
        if ($writers === []) {
            return null;
        }

        $stmt = $pdo->prepare(
            "SELECT requester_id FROM edit_requests
             WHERE diagram_id = ? AND status = 'pending'
             ORDER BY id ASC"
        );
        $stmt->execute([$diagramId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rid = (int) $row['requester_id'];
            if (isset($writers[$rid])) {
                return $rid;
            }
        }

        if (isset($writers[$ownerId])) {
            return $ownerId;
        }

        // Oldest joined_at among remaining writers.
        $best = null;
        foreach ($writers as $uid => $info) {
            if ($best === null || strcmp((string) $info['joined_at'], (string) $best['joined_at']) < 0) {
                $best = $info;
            }
        }
        return $best !== null ? (int) $best['user_id'] : null;
    }

    /**
     * True if user holds the scepter AND their request is coming from the
     * tab they currently have marked active.
     */
    public static function heldByActiveTab(int $diagramId, int $userId, string $tabId): bool
    {
        $stmt = db()->prepare(
            'SELECT v.active_tab_id, d.edit_lock_user, v.last_seen_at
             FROM diagrams d
             LEFT JOIN diagram_viewers v ON v.diagram_id = d.id AND v.user_id = ?
             WHERE d.id = ?'
        );
        $stmt->execute([$userId, $diagramId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) return false;
        if ((int) ($row['edit_lock_user'] ?? 0) !== $userId) return false;
        if ($row['active_tab_id'] === null) return false;
        if ($row['active_tab_id'] !== substr($tabId, 0, self::TAB_ID_MAX)) return false;
        if ($row['last_seen_at'] === null) return false;
        $seen = strtotime((string) $row['last_seen_at'] . ' UTC');
        if ($seen === false) return false;
        return time() <= $seen + self::TTL_SECONDS;
    }

    /**
     * State DTO returned to clients. Includes the viewer list, who holds the
     * scepter, and what the caller's active tab is recorded as (so the client
     * can decide whether it is the active tab or a passive one).
     *
     * @return array{
     *   viewers: list<array<string,mixed>>,
     *   holder_id: int|null,
     *   my_active_tab_id: string|null,
     *   lock: array<string,mixed>
     * }
     */
    public static function stateFor(int $diagramId, int $userId): array
    {
        $diagram = Diagram::byId($diagramId) ?? [];
        $holder = isset($diagram['edit_lock_user']) && $diagram['edit_lock_user'] !== null
            ? (int) $diagram['edit_lock_user'] : null;

        $cutoff = gmdate('Y-m-d H:i:s', time() - self::TTL_SECONDS);
        $stmt = db()->prepare(
            'SELECT v.user_id, v.joined_at, v.last_seen_at, v.active_tab_id,
                    v.selection_json, v.selection_at,
                    v.view_state, v.is_following,
                    u.email, u.display_name
             FROM diagram_viewers v
             LEFT JOIN users u ON u.id = v.user_id
             WHERE v.diagram_id = ? AND v.last_seen_at >= ?
             ORDER BY v.joined_at ASC'
        );
        $stmt->execute([$diagramId, $cutoff]);
        $viewers = [];
        $myActive = null;
        $holderView = null;
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $uid = (int) $row['user_id'];
            $sel = $row['selection_json'] ?? null;
            $decoded = null;
            if ($sel !== null && $sel !== '') {
                $tmp = json_decode((string) $sel, true);
                if (is_array($tmp)) $decoded = $tmp;
            }
            $isFollowing = (int) ($row['is_following'] ?? 0) === 1;
            $viewers[] = [
                'user_id'      => $uid,
                'email'        => $row['email'] ?? null,
                'display_name' => $row['display_name'] ?? null,
                'joined_at'    => $row['joined_at'],
                'last_seen_at' => $row['last_seen_at'],
                'selection'    => $decoded,
                'selection_at' => $row['selection_at'] ?? null,
                'is_following' => $isFollowing,
            ];
            if ($uid === $userId) {
                $myActive = $row['active_tab_id'];
            }
            if ($holder !== null && $uid === $holder) {
                $vs = $row['view_state'] ?? null;
                if ($vs !== null && $vs !== '') {
                    $tmp = json_decode((string) $vs, true);
                    if (is_array($tmp)
                        && isset($tmp['x'], $tmp['y'], $tmp['w'], $tmp['h'])) {
                        $holderView = [
                            'x' => (float) $tmp['x'],
                            'y' => (float) $tmp['y'],
                            'w' => (float) $tmp['w'],
                            'h' => (float) $tmp['h'],
                        ];
                    }
                }
            }
        }

        return [
            'viewers'           => $viewers,
            'holder_id'         => $holder,
            'holder_view'       => $holderView,
            'my_active_tab_id'  => $myActive,
            'lock'              => Lock::state($diagram),
        ];
    }
}
