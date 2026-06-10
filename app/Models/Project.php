<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * A project is a folder grouping a user's own diagrams. A diagram belongs to at
 * most one project (diagrams.project_id; NULL = unfiled). Projects organize the
 * owner's diagrams only — sharing stays at the diagram level for now.
 */
final class Project
{
    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM projects WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function bySlug(string $slug): ?array
    {
        $stmt = db()->prepare('SELECT * FROM projects WHERE slug = ?');
        $stmt->execute([$slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function slugExists(string $slug): bool
    {
        $stmt = db()->prepare('SELECT 1 FROM projects WHERE slug = ?');
        $stmt->execute([$slug]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Projects owned by the user (not deleted), each carrying `diagram_count`
     * (live, non-deleted diagrams filed under it).
     * @return array<int, array<string, mixed>>
     */
    public static function listForUser(int $userId): array
    {
        $stmt = db()->prepare(
            "SELECT p.*,
                    (SELECT COUNT(*) FROM diagrams d
                     WHERE d.project_id = p.id AND d.deleted_at IS NULL) AS diagram_count
             FROM projects p
             WHERE p.owner_id = ? AND p.deleted_at IS NULL
             ORDER BY p.updated_at DESC"
        );
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public static function create(string $slug, string $title, int $ownerId, ?int $sourceProjectId = null): array
    {
        $stmt = db()->prepare(
            'INSERT INTO projects (slug, title, owner_id, source_project_id) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$slug, $title, $ownerId, $sourceProjectId]);
        $project = self::byId((int) db()->lastInsertId());
        if ($project === null) {
            throw new \RuntimeException('Failed to reload created project');
        }
        return $project;
    }

    /**
     * The user's personal fork of a shared source project, if any (newest first).
     * A fork is a project they own with source_project_id pointing at the original.
     */
    public static function forkFor(int $sourceProjectId, int $ownerId): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM projects
             WHERE owner_id = ? AND source_project_id = ? AND deleted_at IS NULL
             ORDER BY updated_at DESC'
        );
        $stmt->execute([$ownerId, $sourceProjectId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function rename(int $projectId, ?string $title, ?string $slug): void
    {
        $sets = [];
        $params = [];
        if ($title !== null) {
            $sets[] = 'title = ?';
            $params[] = $title;
        }
        if ($slug !== null) {
            $sets[] = 'slug = ?';
            $params[] = $slug;
        }
        if ($sets === []) {
            return;
        }
        $sets[] = 'updated_at = CURRENT_TIMESTAMP';
        $params[] = $projectId;
        $stmt = db()->prepare(
            'UPDATE projects SET ' . implode(', ', $sets) . ' WHERE id = ?'
        );
        $stmt->execute($params);
    }

    /**
     * Soft-delete a project, detach (not delete) its diagrams — every diagram
     * filed under it becomes unfiled (project_id = NULL) — and drop its shares.
     */
    public static function softDelete(int $projectId): void
    {
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'UPDATE diagrams SET project_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?'
            );
            $stmt->execute([$projectId]);

            $stmt = $pdo->prepare('DELETE FROM project_shares WHERE project_id = ?');
            $stmt->execute([$projectId]);

            $stmt = $pdo->prepare(
                'UPDATE projects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            $stmt->execute([$projectId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    public static function touch(int $projectId): void
    {
        $stmt = db()->prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        $stmt->execute([$projectId]);
    }

    /**
     * True if the user may manage (rename/delete/share/file into) this project.
     * Owner only — admins get read oversight via canAccess but no management
     * elevation on projects they don't own.
     */
    public static function canManage(array $project, array $user): bool
    {
        return (int) $project['owner_id'] === (int) $user['id'];
    }

    /** True if the user may open this project (owner, admin, or shared view/edit). */
    public static function canAccess(array $project, array $user): bool
    {
        if (($user['role'] ?? '') === 'admin') {
            return true;
        }
        if ((int) $project['owner_id'] === (int) $user['id']) {
            return true;
        }
        return ProjectShare::get((int) $project['id'], (int) $user['id']) !== null;
    }

    /**
     * Returns the user's permission on the project: 'owner' | 'edit' | 'view' |
     * null. Admins are NOT elevated: on a project they don't own they get their
     * actual share permission (or null), so the project view stays read-only
     * unless they were explicitly granted edit.
     */
    public static function permissionFor(array $project, array $user): ?string
    {
        if ((int) $project['owner_id'] === (int) $user['id']) {
            return 'owner';
        }
        $share = ProjectShare::get((int) $project['id'], (int) $user['id']);
        return $share['permission'] ?? null;
    }
}
