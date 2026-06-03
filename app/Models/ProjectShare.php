<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Sharing of a project with another user. Access cascades to every diagram
 * filed under the project (resolved in Diagram::permissionFor).
 * permission: 'view' | 'edit'
 */
final class ProjectShare
{
    public const PERM_VIEW = 'view';
    public const PERM_EDIT = 'edit';

    public static function isValidPermission(string $p): bool
    {
        return $p === self::PERM_VIEW || $p === self::PERM_EDIT;
    }

    public static function get(int $projectId, int $userId): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM project_shares WHERE project_id = ? AND user_id = ?'
        );
        $stmt->execute([$projectId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /** @return array<int, array<string, mixed>> Shares on a project, with user info. */
    public static function listForProject(int $projectId): array
    {
        $stmt = db()->prepare(
            'SELECT ps.*, u.email AS user_email, u.display_name AS user_name, u.disabled_at AS user_disabled_at
             FROM project_shares ps
             LEFT JOIN users u ON u.id = ps.user_id
             WHERE ps.project_id = ?
             ORDER BY ps.shared_at ASC'
        );
        $stmt->execute([$projectId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Projects shared with a given user (excluding deleted, excluding owned),
     * each carrying `diagram_count` (live diagrams filed under it) and
     * `share_permission`.
     * @return array<int, array<string, mixed>>
     */
    public static function projectsForUser(int $userId): array
    {
        $stmt = db()->prepare(
            "SELECT p.*, ps.permission AS share_permission,
                    (SELECT COUNT(*) FROM diagrams d
                     WHERE d.project_id = p.id AND d.deleted_at IS NULL) AS diagram_count
             FROM projects p
             INNER JOIN project_shares ps ON ps.project_id = p.id
             WHERE ps.user_id = ? AND p.deleted_at IS NULL AND p.owner_id <> ?
             ORDER BY p.updated_at DESC"
        );
        $stmt->execute([$userId, $userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** Insert or update a share row. */
    public static function upsert(int $projectId, int $userId, string $permission): void
    {
        $existing = self::get($projectId, $userId);
        if ($existing === null) {
            $stmt = db()->prepare(
                'INSERT INTO project_shares (project_id, user_id, permission) VALUES (?, ?, ?)'
            );
            $stmt->execute([$projectId, $userId, $permission]);
        } else {
            $stmt = db()->prepare(
                'UPDATE project_shares SET permission = ? WHERE project_id = ? AND user_id = ?'
            );
            $stmt->execute([$permission, $projectId, $userId]);
        }
    }

    public static function remove(int $projectId, int $userId): void
    {
        $stmt = db()->prepare(
            'DELETE FROM project_shares WHERE project_id = ? AND user_id = ?'
        );
        $stmt->execute([$projectId, $userId]);
    }
}
