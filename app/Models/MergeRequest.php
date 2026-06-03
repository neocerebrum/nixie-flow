<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * A request to publish a forked diagram (the variant / source) onto the diagram
 * it was forked from (the original / target). Accepting is NOT a diff merge: the
 * variant's current source+layout becomes a new revision/#current on the target.
 * status: pending | accepted | declined | withdrawn
 */
final class MergeRequest
{
    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM merge_requests WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /** A pending request for this exact source→target pair, if any. */
    public static function pendingForPair(int $sourceId, int $targetId): ?array
    {
        $stmt = db()->prepare(
            "SELECT * FROM merge_requests
             WHERE source_diagram_id = ? AND target_diagram_id = ? AND status = 'pending'
             ORDER BY id DESC LIMIT 1"
        );
        $stmt->execute([$sourceId, $targetId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /**
     * The requester's latest request originating from this variant (any status),
     * so the editor can tell pending from accepted/declined. Null if none ever.
     */
    public static function mineForSource(int $sourceId, int $requesterId): ?array
    {
        $stmt = db()->prepare(
            "SELECT mr.*, td.slug AS target_slug, td.title AS target_title
             FROM merge_requests mr
             LEFT JOIN diagrams td ON td.id = mr.target_diagram_id
             WHERE mr.source_diagram_id = ? AND mr.requester_id = ?
             ORDER BY mr.id DESC LIMIT 1"
        );
        $stmt->execute([$sourceId, $requesterId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /**
     * Pending requests targeting a diagram, enriched with the variant's
     * slug/title and the requester's identity (for the owner's review panel).
     * @return array<int, array<string, mixed>>
     */
    public static function pendingForTarget(int $targetId): array
    {
        $stmt = db()->prepare(
            "SELECT mr.*,
                    sd.slug AS source_slug, sd.title AS source_title,
                    u.email AS requester_email, u.display_name AS requester_name
             FROM merge_requests mr
             JOIN diagrams sd ON sd.id = mr.source_diagram_id
             LEFT JOIN users u ON u.id = mr.requester_id
             WHERE mr.target_diagram_id = ? AND mr.status = 'pending'
             ORDER BY mr.id ASC"
        );
        $stmt->execute([$targetId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public static function countPendingForTarget(int $targetId): int
    {
        $stmt = db()->prepare(
            "SELECT COUNT(*) FROM merge_requests WHERE target_diagram_id = ? AND status = 'pending'"
        );
        $stmt->execute([$targetId]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * True if $userId owns a diagram that is the target of a pending request
     * whose source is $sourceId — i.e. they may preview that variant.
     */
    public static function ownerCanPreview(int $sourceId, int $userId): bool
    {
        $stmt = db()->prepare(
            "SELECT 1 FROM merge_requests mr
             JOIN diagrams td ON td.id = mr.target_diagram_id
             WHERE mr.source_diagram_id = ? AND mr.status = 'pending' AND td.owner_id = ?
             LIMIT 1"
        );
        $stmt->execute([$sourceId, $userId]);
        return $stmt->fetchColumn() !== false;
    }

    public static function create(int $sourceId, int $targetId, int $requesterId, ?string $note): int
    {
        $stmt = db()->prepare(
            "INSERT INTO merge_requests (source_diagram_id, target_diagram_id, requester_id, status, note)
             VALUES (?, ?, ?, 'pending', ?)"
        );
        $stmt->execute([$sourceId, $targetId, $requesterId, $note]);
        return (int) db()->lastInsertId();
    }

    /** Resolve as accepted, recording who accepted and the revision created. */
    public static function accept(int $id, int $resolverId, int $revisionId): void
    {
        $stmt = db()->prepare(
            "UPDATE merge_requests
             SET status = 'accepted', resolved_at = CURRENT_TIMESTAMP,
                 resolver_id = ?, accepted_revision_id = ?
             WHERE id = ?"
        );
        $stmt->execute([$resolverId, $revisionId, $id]);
    }

    /** Resolve as declined/withdrawn. */
    public static function resolve(int $id, string $status, ?int $resolverId = null): void
    {
        $stmt = db()->prepare(
            'UPDATE merge_requests
             SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolver_id = ?
             WHERE id = ?'
        );
        $stmt->execute([$status, $resolverId, $id]);
    }
}
