<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

final class Revision
{
    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM diagram_revisions WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public static function listByDiagram(int $diagramId): array
    {
        $stmt = db()->prepare(
            'SELECT id, diagram_id, parent_id, author_id, message, created_at
             FROM diagram_revisions
             WHERE diagram_id = ?
             ORDER BY id ASC'
        );
        $stmt->execute([$diagramId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Create a new revision and atomically update head_revision_id.
     * Uses optimistic locking: aborts with 409-style RuntimeException
     * carrying current head id if expected does not match.
     *
     * @throws \App\Exceptions\RevisionConflict on optimistic lock failure
     */
    public static function createAndAdvanceHead(
        int $diagramId,
        ?int $expectedRevisionId,
        string $source,
        ?string $layoutJson,
        int $authorId,
        ?string $message
    ): array {
        $pdo = db();
        // SQLite needs IMMEDIATE to acquire write lock atomically.
        $isSqlite = (db()->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite');
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
        } else {
            $pdo->beginTransaction();
        }

        try {
            $stmt = $pdo->prepare('SELECT head_revision_id FROM diagrams WHERE id = ?');
            $stmt->execute([$diagramId]);
            $currentHead = $stmt->fetchColumn();
            if ($currentHead === false) {
                throw new \RuntimeException('Diagram not found');
            }
            $currentHead = $currentHead === null ? null : (int) $currentHead;

            if ($currentHead !== $expectedRevisionId) {
                $pdo->rollBack();
                throw new \App\Exceptions\RevisionConflict($currentHead);
            }

            $stmt = $pdo->prepare(
                'INSERT INTO diagram_revisions (diagram_id, parent_id, source, layout, author_id, message)
                 VALUES (?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([$diagramId, $expectedRevisionId, $source, $layoutJson, $authorId, $message]);
            $newId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare(
                'UPDATE diagrams SET head_revision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            $stmt->execute([$newId, $diagramId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $row = self::byId($newId);
        if ($row === null) {
            throw new \RuntimeException('Failed to reload created revision');
        }
        return $row;
    }

    /**
     * In-place autosave on the head revision: mutates source/layout of the row
     * pointed by diagrams.head_revision_id, bumps diagrams.updated_at, but does
     * NOT create a new revision. Used by the live-draft autosave flow — explicit
     * Save still goes through createAndAdvanceHead.
     *
     * @throws \App\Exceptions\RevisionConflict if expected head doesn't match.
     */
    public static function updateDraft(
        int $diagramId,
        int $expectedHeadId,
        ?string $source,
        ?string $layoutJson
    ): array {
        $pdo = db();
        $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
        } else {
            $pdo->beginTransaction();
        }

        try {
            $stmt = $pdo->prepare('SELECT head_revision_id FROM diagrams WHERE id = ?');
            $stmt->execute([$diagramId]);
            $currentHead = $stmt->fetchColumn();
            if ($currentHead === false) {
                throw new \RuntimeException('Diagram not found');
            }
            $currentHead = (int) $currentHead;

            if ($currentHead !== $expectedHeadId) {
                $pdo->rollBack();
                throw new \App\Exceptions\RevisionConflict($currentHead);
            }

            // Build dynamic UPDATE only with provided fields.
            $sets = [];
            $params = [];
            if ($source !== null) {
                $sets[] = 'source = ?';
                $params[] = $source;
            }
            if ($layoutJson !== null) {
                $sets[] = 'layout = ?';
                $params[] = $layoutJson;
            }
            if ($sets === []) {
                $pdo->rollBack();
                throw new \RuntimeException('Nothing to update in draft');
            }
            $params[] = $currentHead;
            $stmt = $pdo->prepare(
                'UPDATE diagram_revisions SET ' . implode(', ', $sets) . ' WHERE id = ?'
            );
            $stmt->execute($params);

            $stmt = $pdo->prepare(
                'UPDATE diagrams SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            $stmt->execute([$diagramId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $row = self::byId($expectedHeadId);
        if ($row === null) {
            throw new \RuntimeException('Failed to reload draft revision');
        }
        return $row;
    }

    public static function mostRecentChild(int $diagramId, int $parentId): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM diagram_revisions
             WHERE diagram_id = ? AND parent_id = ?
             ORDER BY created_at DESC, id DESC LIMIT 1'
        );
        $stmt->execute([$diagramId, $parentId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    public static function hasChildren(int $diagramId, int $parentId): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM diagram_revisions WHERE diagram_id = ? AND parent_id = ? LIMIT 1'
        );
        $stmt->execute([$diagramId, $parentId]);
        return $stmt->fetchColumn() !== false;
    }
}
