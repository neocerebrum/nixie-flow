<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Hand-over request from a viewer to the current editor.
 * status: pending | granted | rejected | cancelled
 *
 * Once granted, the requester has GRANT_WINDOW_SECONDS to acquire the lock
 * (it has been freed by the editor). After that, anyone may take it.
 */
final class EditRequest
{
    public const GRANT_WINDOW_SECONDS = 30;

    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM edit_requests WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function pendingForUser(int $diagramId, int $userId): ?array
    {
        $stmt = db()->prepare(
            "SELECT * FROM edit_requests
             WHERE diagram_id = ? AND requester_id = ? AND status = 'pending'
             ORDER BY id DESC LIMIT 1"
        );
        $stmt->execute([$diagramId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /**
     * Returns the active request (pending OR granted-with-window-open) for a user.
     * Granted requests whose 30s acquisition window has expired are NOT returned —
     * they're treated as concluded so the user can file a fresh request.
     */
    public static function activeForUser(int $diagramId, int $userId): ?array
    {
        $stmt = db()->prepare(
            "SELECT * FROM edit_requests
             WHERE diagram_id = ? AND requester_id = ?
                   AND status IN ('pending', 'granted')
             ORDER BY id DESC LIMIT 1"
        );
        $stmt->execute([$diagramId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) return null;
        if (($row['status'] ?? '') === 'granted' && !self::isGrantWindowOpen($row)) {
            // Window expired → consume it so the next request creates a fresh row.
            self::setStatus((int) $row['id'], 'cancelled');
            return null;
        }
        return $row;
    }

    /** @return array<int, array<string, mixed>> Pending requests on a diagram. */
    public static function pendingOn(int $diagramId): array
    {
        $stmt = db()->prepare(
            "SELECT er.*, u.email AS requester_email, u.display_name AS requester_name
             FROM edit_requests er
             LEFT JOIN users u ON u.id = er.requester_id
             WHERE er.diagram_id = ? AND er.status = 'pending'
             ORDER BY er.id ASC"
        );
        $stmt->execute([$diagramId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public static function create(int $diagramId, int $requesterId, ?string $note): int
    {
        $stmt = db()->prepare(
            "INSERT INTO edit_requests (diagram_id, requester_id, status, note)
             VALUES (?, ?, 'pending', ?)"
        );
        $stmt->execute([$diagramId, $requesterId, $note]);
        return (int) db()->lastInsertId();
    }

    public static function setStatus(int $id, string $status): void
    {
        $stmt = db()->prepare(
            'UPDATE edit_requests SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$status, $id]);
    }

    /**
     * True if the granted timestamp is still within the acquisition window.
     */
    public static function isGrantWindowOpen(array $request): bool
    {
        if (($request['status'] ?? '') !== 'granted') {
            return false;
        }
        $resolved = $request['resolved_at'] ?? null;
        if ($resolved === null) {
            return false;
        }
        $ts = strtotime((string) $resolved . ' UTC');
        if ($ts === false) {
            return false;
        }
        return time() < $ts + self::GRANT_WINDOW_SECONDS;
    }

    /** Mark stale pending requests on a diagram as rejected (older than 5 minutes). */
    public static function expireStale(int $diagramId, int $maxAgeSeconds = 300): void
    {
        $cutoff = gmdate('Y-m-d H:i:s', time() - $maxAgeSeconds);
        $stmt = db()->prepare(
            "UPDATE edit_requests
             SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP
             WHERE diagram_id = ? AND status = 'pending' AND created_at < ?"
        );
        $stmt->execute([$diagramId, $cutoff]);
    }
}
