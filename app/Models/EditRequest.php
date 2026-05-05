<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Hand-over request from a spectator to the current scepter holder.
 * status: pending | granted | rejected | cancelled
 *
 * On accept the scepter is transferred atomically to the requester
 * (see EditRequestController::accept), so granted is purely a record of
 * the outcome — there is no acquisition window to race for.
 */
final class EditRequest
{
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
     * Returns the user's active pending request, or null. Granted requests
     * are not returned: the scepter is transferred atomically on accept, so a
     * granted record is purely historical.
     */
    public static function activeForUser(int $diagramId, int $userId): ?array
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
