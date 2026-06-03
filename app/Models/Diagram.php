<?php
declare(strict_types=1);

namespace App\Models;

use PDO;
use App\Models\Share;
use App\Models\ProjectShare;

final class Diagram
{
    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM diagrams WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function bySlug(string $slug): ?array
    {
        $stmt = db()->prepare('SELECT * FROM diagrams WHERE slug = ?');
        $stmt->execute([$slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function slugExists(string $slug): bool
    {
        $stmt = db()->prepare('SELECT 1 FROM diagrams WHERE slug = ?');
        $stmt->execute([$slug]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Diagrams owned by the user. Does not include diagrams shared with them.
     * @return array<int, array<string, mixed>>
     */
    public static function listForUser(int $userId, bool $includeDeleted = false): array
    {
        $sql = 'SELECT * FROM diagrams WHERE owner_id = ?';
        if (!$includeDeleted) {
            $sql .= ' AND deleted_at IS NULL';
        }
        $sql .= ' ORDER BY updated_at DESC';
        $stmt = db()->prepare($sql);
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Diagrams visible to the user: owned + shared via diagram_shares.
     * Each row carries `share_permission` (null when owned).
     * @return array<int, array<string, mixed>>
     */
    public static function listAccessibleForUser(int $userId): array
    {
        $stmt = db()->prepare(
            "SELECT d.*, NULL AS share_permission
             FROM diagrams d
             WHERE d.owner_id = ? AND d.deleted_at IS NULL
             UNION ALL
             SELECT d.*, ds.permission AS share_permission
             FROM diagrams d
             INNER JOIN diagram_shares ds ON ds.diagram_id = d.id
             WHERE ds.user_id = ? AND d.owner_id <> ? AND d.deleted_at IS NULL
             ORDER BY updated_at DESC"
        );
        $stmt->execute([$userId, $userId, $userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public static function listAll(bool $includeDeleted = false): array
    {
        $sql = 'SELECT * FROM diagrams';
        if (!$includeDeleted) {
            $sql .= ' WHERE deleted_at IS NULL';
        }
        $sql .= ' ORDER BY updated_at DESC';
        return db()->query($sql)->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Create diagram + #current row atomically. Returns [diagram, current].
     * No snapshot is created — the user creates snapshots explicitly via Save.
     * `head_revision_id` on the diagram is the stable id of the #current row.
     * @return array{0: array<string,mixed>, 1: array<string,mixed>}
     */
    public static function createWithFirstRevision(
        string $slug,
        string $title,
        int $ownerId,
        string $source,
        ?string $layoutJson
    ): array {
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'INSERT INTO diagrams (slug, title, owner_id) VALUES (?, ?, ?)'
            );
            $stmt->execute([$slug, $title, $ownerId]);
            $diagramId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare(
                'INSERT INTO diagram_revisions
                   (diagram_id, parent_id, source, layout, author_id, is_current, source_revision_id)
                 VALUES (?, NULL, ?, ?, ?, 1, NULL)'
            );
            $stmt->execute([$diagramId, $source, $layoutJson, $ownerId]);
            $currentId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare(
                'UPDATE diagrams SET head_revision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            $stmt->execute([$currentId, $diagramId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $diagram = self::byId($diagramId);
        $current = Revision::byId($currentId);
        if ($diagram === null || $current === null) {
            throw new \RuntimeException('Failed to reload created diagram');
        }
        return [$diagram, $current];
    }

    public static function rename(int $diagramId, ?string $title, ?string $slug): void
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
        $params[] = $diagramId;
        $stmt = db()->prepare(
            'UPDATE diagrams SET ' . implode(', ', $sets) . ' WHERE id = ?'
        );
        $stmt->execute($params);
    }

    public static function softDelete(int $diagramId): void
    {
        $stmt = db()->prepare(
            'UPDATE diagrams SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$diagramId]);
    }

    public static function restore(int $diagramId): void
    {
        $stmt = db()->prepare(
            'UPDATE diagrams SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$diagramId]);
    }

    public static function isDeleted(array $diagram): bool
    {
        return !empty($diagram['deleted_at']);
    }

    // ── Projects ─────────────────────────────────────────────────────────────

    /**
     * Live (non-deleted) diagrams filed under a project, newest first.
     * @return array<int, array<string, mixed>>
     */
    public static function listForProject(int $projectId): array
    {
        $stmt = db()->prepare(
            'SELECT * FROM diagrams WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC'
        );
        $stmt->execute([$projectId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Diagrams the user owns that are not filed under any project, newest first.
     * @return array<int, array<string, mixed>>
     */
    public static function listUnfiledForUser(int $userId): array
    {
        $stmt = db()->prepare(
            'SELECT * FROM diagrams
             WHERE owner_id = ? AND project_id IS NULL AND deleted_at IS NULL
             ORDER BY updated_at DESC'
        );
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** File a diagram into a project, or pass null to unfile it. */
    public static function setProject(int $diagramId, ?int $projectId): void
    {
        $stmt = db()->prepare(
            'UPDATE diagrams SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        );
        $stmt->execute([$projectId, $diagramId]);
    }

    /**
     * Duplicate a diagram into a fresh diagram owned by $newOwnerId, copying the
     * #current source + layout. Optionally files it under $projectId.
     * @return array{0: array<string,mixed>, 1: array<string,mixed>}
     */
    public static function duplicate(
        int $sourceDiagramId,
        string $newSlug,
        string $newTitle,
        int $newOwnerId,
        ?int $projectId
    ): array {
        $current = Revision::current($sourceDiagramId);
        $source  = $current !== null ? (string) $current['source'] : "graph TD\n";
        $layout  = $current !== null ? $current['layout'] : null;

        [$diagram, $rev] = self::createWithFirstRevision($newSlug, $newTitle, $newOwnerId, $source, $layout);
        if ($projectId !== null) {
            self::setProject((int) $diagram['id'], $projectId);
            $diagram = self::byId((int) $diagram['id']) ?? $diagram;
        }
        return [$diagram, $rev];
    }

    /** True if user can read the diagram (owner, admin, or shared view/edit). */
    public static function canAccess(array $diagram, array $user): bool
    {
        if (($user['role'] ?? '') === 'admin') {
            return true;
        }
        if ((int) $diagram['owner_id'] === (int) $user['id']) {
            return true;
        }
        return self::sharedPermission($diagram, (int) $user['id']) !== null;
    }

    /** True if user can write to the diagram (owner, admin, or shared with edit). */
    public static function canWrite(array $diagram, array $user): bool
    {
        if (($user['role'] ?? '') === 'admin') {
            return true;
        }
        if ((int) $diagram['owner_id'] === (int) $user['id']) {
            return true;
        }
        return self::sharedPermission($diagram, (int) $user['id']) === Share::PERM_EDIT;
    }

    /** Returns 'owner' | 'edit' | 'view' | null. */
    public static function permissionFor(array $diagram, array $user): ?string
    {
        if ((int) $diagram['owner_id'] === (int) $user['id']) {
            return 'owner';
        }
        if (($user['role'] ?? '') === 'admin') {
            return 'edit';
        }
        return self::sharedPermission($diagram, (int) $user['id']);
    }

    /**
     * Effective shared permission for a non-owner: the strongest of the
     * direct diagram share and the share of the project this diagram is filed
     * under ('edit' beats 'view'). Returns 'edit' | 'view' | null.
     */
    private static function sharedPermission(array $diagram, int $userId): ?string
    {
        $best = null; // 0 none, 1 view, 2 edit
        $rank = static fn (?string $p): int => $p === Share::PERM_EDIT ? 2 : ($p === Share::PERM_VIEW ? 1 : 0);

        $direct = Share::get((int) $diagram['id'], $userId);
        if ($direct !== null) {
            $best = $direct['permission'];
        }

        if (!empty($diagram['project_id'])) {
            $viaProject = ProjectShare::get((int) $diagram['project_id'], $userId);
            if ($viaProject !== null && $rank($viaProject['permission']) > $rank($best)) {
                $best = $viaProject['permission'];
            }
        }

        return $best;
    }
}
