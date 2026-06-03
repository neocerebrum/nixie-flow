<?php
declare(strict_types=1);

namespace App\Models;

use PDO;

/**
 * Revisions storage model.
 *
 * Each diagram has exactly one row with `is_current = 1` — the live working
 * copy that the editor mutates continuously via autosave. All other rows
 * (`is_current = 0`) are immutable user-created snapshots.
 *
 * `source_revision_id` on the #current row identifies which snapshot the
 * working copy was forked from (null when never saved). On a snapshot row
 * it is unused. Snapshots are chained through `parent_id`, which points at
 * the previous snapshot in the same branch.
 */
final class Revision
{
    public static function byId(int $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM diagram_revisions WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /** Fetch the #current row for this diagram (mutable working copy). */
    public static function current(int $diagramId): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM diagram_revisions
             WHERE diagram_id = ? AND is_current = 1
             LIMIT 1'
        );
        $stmt->execute([$diagramId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row !== false ? $row : null;
    }

    /**
     * List immutable snapshots (excludes #current) ordered by id ASC.
     * @return array<int, array<string, mixed>>
     */
    public static function listSnapshots(int $diagramId): array
    {
        $stmt = db()->prepare(
            'SELECT id, diagram_id, parent_id, author_id, message, created_at
             FROM diagram_revisions
             WHERE diagram_id = ? AND is_current = 0
             ORDER BY id ASC'
        );
        $stmt->execute([$diagramId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Save: take #current and create a new immutable snapshot from it.
     * Optimistic lock: aborts if #current's source_revision_id no longer
     * matches `$expectedSourceRevisionId`. The snapshot's parent_id is set to
     * that same id, so the snapshot tree mirrors the user's branch decisions.
     * #current's source/layout are also updated to the supplied values
     * (matching what autosave would have flushed) and its source_revision_id
     * advances to the new snapshot id.
     *
     * @throws \App\Exceptions\RevisionConflict
     */
    public static function snapshotCurrent(
        int $diagramId,
        ?int $expectedSourceRevisionId,
        string $source,
        ?string $layoutJson,
        int $authorId,
        ?string $message
    ): array {
        $pdo = db();
        $isSqlite = ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite');
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
            $forUpdate = '';
        } else {
            $pdo->beginTransaction();
            $forUpdate = ' FOR UPDATE';
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT id, source_revision_id FROM diagram_revisions
                 WHERE diagram_id = ? AND is_current = 1' . $forUpdate
            );
            $stmt->execute([$diagramId]);
            $current = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($current === false) {
                throw new \RuntimeException('Diagram has no #current row');
            }
            $currentId = (int) $current['id'];
            $actualSrc = $current['source_revision_id'] === null
                ? null : (int) $current['source_revision_id'];

            if ($actualSrc !== $expectedSourceRevisionId) {
                $pdo->rollBack();
                throw new \App\Exceptions\RevisionConflict($actualSrc);
            }

            $stmt = $pdo->prepare(
                'INSERT INTO diagram_revisions
                   (diagram_id, parent_id, source, layout, author_id, message, is_current, source_revision_id)
                 VALUES (?, ?, ?, ?, ?, ?, 0, NULL)'
            );
            $stmt->execute([
                $diagramId,
                $expectedSourceRevisionId,
                $source,
                $layoutJson,
                $authorId,
                $message,
            ]);
            $newSnapshotId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare(
                'UPDATE diagram_revisions
                 SET source = ?, layout = ?, source_revision_id = ?
                 WHERE id = ?'
            );
            $stmt->execute([$source, $layoutJson, $newSnapshotId, $currentId]);

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

        $row = self::byId($newSnapshotId);
        if ($row === null) {
            throw new \RuntimeException('Failed to reload created snapshot');
        }
        return $row;
    }

    /**
     * Autosave: in-place update of source/layout on the #current row.
     * Optimistic lock checks #current's source_revision_id against the
     * client's expected value (i.e., the snapshot the client believes
     * #current is forked from).
     *
     * @throws \App\Exceptions\RevisionConflict
     */
    public static function updateCurrent(
        int $diagramId,
        ?int $expectedSourceRevisionId,
        ?string $source,
        ?string $layoutJson
    ): array {
        $pdo = db();
        $isSqlite = ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite');
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
            $forUpdate = '';
        } else {
            $pdo->beginTransaction();
            $forUpdate = ' FOR UPDATE';
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT id, source_revision_id FROM diagram_revisions
                 WHERE diagram_id = ? AND is_current = 1' . $forUpdate
            );
            $stmt->execute([$diagramId]);
            $current = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($current === false) {
                throw new \RuntimeException('Diagram has no #current row');
            }
            $currentId = (int) $current['id'];
            $actualSrc = $current['source_revision_id'] === null
                ? null : (int) $current['source_revision_id'];

            if ($actualSrc !== $expectedSourceRevisionId) {
                $pdo->rollBack();
                throw new \App\Exceptions\RevisionConflict($actualSrc);
            }

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
                throw new \RuntimeException('Nothing to update on #current');
            }
            $params[] = $currentId;
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

        $row = self::byId($currentId);
        if ($row === null) {
            throw new \RuntimeException('Failed to reload #current row');
        }
        return $row;
    }

    /**
     * Checkout: copy a snapshot's content into #current and stamp the
     * snapshot's id as the new source_revision_id (so further saves chain
     * from this branch point).
     */
    public static function checkoutSnapshot(int $diagramId, int $snapshotId): array
    {
        $pdo = db();
        $isSqlite = ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite');
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
            $forUpdate = '';
        } else {
            $pdo->beginTransaction();
            $forUpdate = ' FOR UPDATE';
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT * FROM diagram_revisions
                 WHERE id = ? AND diagram_id = ? AND is_current = 0'
            );
            $stmt->execute([$snapshotId, $diagramId]);
            $snap = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($snap === false) {
                $pdo->rollBack();
                throw new \RuntimeException('Snapshot does not belong to this diagram');
            }

            $stmt = $pdo->prepare(
                'SELECT id FROM diagram_revisions
                 WHERE diagram_id = ? AND is_current = 1' . $forUpdate
            );
            $stmt->execute([$diagramId]);
            $currentId = $stmt->fetchColumn();
            if ($currentId === false) {
                throw new \RuntimeException('Diagram has no #current row');
            }
            $currentId = (int) $currentId;

            $stmt = $pdo->prepare(
                'UPDATE diagram_revisions
                 SET source = ?, layout = ?, source_revision_id = ?
                 WHERE id = ?'
            );
            $stmt->execute([$snap['source'], $snap['layout'], $snapshotId, $currentId]);

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

        $row = self::byId($currentId);
        if ($row === null) {
            throw new \RuntimeException('Failed to reload #current after checkout');
        }
        return $row;
    }

    /**
     * Publish foreign content (e.g. an accepted merge request's variant) onto a
     * diagram: create an immutable snapshot from the given source+layout and
     * advance #current to it. Unlike snapshotCurrent there is no optimistic-lock
     * check — the content is replaced wholesale (a "jump"). Any editor currently
     * open on this diagram detects the new source_revision_id on its next save
     * and is offered a reload through the usual conflict path. Returns the
     * created snapshot.
     */
    public static function commitForeign(
        int $diagramId,
        string $source,
        ?string $layoutJson,
        int $authorId,
        ?string $message
    ): array {
        $pdo = db();
        $isSqlite = ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite');
        if ($isSqlite) {
            $pdo->exec('BEGIN IMMEDIATE');
            $forUpdate = '';
        } else {
            $pdo->beginTransaction();
            $forUpdate = ' FOR UPDATE';
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT id, source_revision_id FROM diagram_revisions
                 WHERE diagram_id = ? AND is_current = 1' . $forUpdate
            );
            $stmt->execute([$diagramId]);
            $current = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($current === false) {
                throw new \RuntimeException('Diagram has no #current row');
            }
            $currentId = (int) $current['id'];
            $parentId = $current['source_revision_id'] === null
                ? null : (int) $current['source_revision_id'];

            $stmt = $pdo->prepare(
                'INSERT INTO diagram_revisions
                   (diagram_id, parent_id, source, layout, author_id, message, is_current, source_revision_id)
                 VALUES (?, ?, ?, ?, ?, ?, 0, NULL)'
            );
            $stmt->execute([$diagramId, $parentId, $source, $layoutJson, $authorId, $message]);
            $newSnapshotId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare(
                'UPDATE diagram_revisions
                 SET source = ?, layout = ?, source_revision_id = ?
                 WHERE id = ?'
            );
            $stmt->execute([$source, $layoutJson, $newSnapshotId, $currentId]);

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

        $row = self::byId($newSnapshotId);
        if ($row === null) {
            throw new \RuntimeException('Failed to reload merge snapshot');
        }
        return $row;
    }
}
