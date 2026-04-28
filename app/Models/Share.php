<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Sharing of a diagram with another user.
 * permission: 'view' | 'edit'
 */
final class Share
{
    public const PERM_VIEW = 'view';
    public const PERM_EDIT = 'edit';

    public static function isValidPermission(string $p): bool
    {
        return $p === self::PERM_VIEW || $p === self::PERM_EDIT;
    }

    public static function get(int $diagramId, int $userId): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM diagram_shares WHERE diagram_id = ? AND user_id = ?'
        );
        $stmt->execute([$diagramId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /** @return array<int, array<string, mixed>> Shares on a diagram, with user info. */
    public static function listForDiagram(int $diagramId): array
    {
        $stmt = db()->prepare(
            'SELECT ds.*, u.email AS user_email, u.display_name AS user_name, u.disabled_at AS user_disabled_at
             FROM diagram_shares ds
             LEFT JOIN users u ON u.id = ds.user_id
             WHERE ds.diagram_id = ?
             ORDER BY ds.shared_at ASC'
        );
        $stmt->execute([$diagramId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Diagrams shared with a given user (excluding deleted, excluding owner_id == userId).
     * @return array<int, array<string, mixed>>
     */
    public static function diagramsForUser(int $userId): array
    {
        $stmt = db()->prepare(
            'SELECT d.*, ds.permission AS share_permission
             FROM diagrams d
             INNER JOIN diagram_shares ds ON ds.diagram_id = d.id
             WHERE ds.user_id = ? AND d.deleted_at IS NULL AND d.owner_id <> ?
             ORDER BY d.updated_at DESC'
        );
        $stmt->execute([$userId, $userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** Insert or update a share row. */
    public static function upsert(int $diagramId, int $userId, string $permission): void
    {
        $existing = self::get($diagramId, $userId);
        if ($existing === null) {
            $stmt = db()->prepare(
                'INSERT INTO diagram_shares (diagram_id, user_id, permission) VALUES (?, ?, ?)'
            );
            $stmt->execute([$diagramId, $userId, $permission]);
        } else {
            $stmt = db()->prepare(
                'UPDATE diagram_shares SET permission = ? WHERE diagram_id = ? AND user_id = ?'
            );
            $stmt->execute([$permission, $diagramId, $userId]);
        }
    }

    public static function remove(int $diagramId, int $userId): void
    {
        $stmt = db()->prepare(
            'DELETE FROM diagram_shares WHERE diagram_id = ? AND user_id = ?'
        );
        $stmt->execute([$diagramId, $userId]);
    }
}
