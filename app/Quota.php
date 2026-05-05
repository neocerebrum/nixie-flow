<?php
declare(strict_types=1);

namespace App;

use App\Exceptions\QuotaExceeded;
use PDO;

/**
 * Per-user resource quotas. All limits are config-driven via .env:
 *   QUOTA_DIAGRAMS_PER_USER     (default 100, 0 = unlimited)
 *   QUOTA_REVISIONS_PER_DIAGRAM (default 500, 0 = unlimited)
 *   QUOTA_BYTES_PER_USER        (default 50 MiB, 0 = unlimited)
 *
 * Admins bypass all quotas. Bytes are counted as
 * LENGTH(source) + LENGTH(COALESCE(layout, '')) across all revisions of
 * non-deleted diagrams owned by the user.
 */
final class Quota
{
    private const DEFAULT_DIAGRAMS  = 100;
    private const DEFAULT_REVISIONS = 500;
    private const DEFAULT_BYTES     = 52428800; // 50 MiB

    public static function isAdmin(array $user): bool
    {
        return ($user['role'] ?? '') === 'admin';
    }

    public static function maxDiagrams(): int
    {
        return Config::int('QUOTA_DIAGRAMS_PER_USER', self::DEFAULT_DIAGRAMS);
    }

    public static function maxRevisionsPerDiagram(): int
    {
        return Config::int('QUOTA_REVISIONS_PER_DIAGRAM', self::DEFAULT_REVISIONS);
    }

    public static function maxBytesPerUser(): int
    {
        return Config::int('QUOTA_BYTES_PER_USER', self::DEFAULT_BYTES);
    }

    public static function checkCanCreateDiagram(array $user): void
    {
        if (self::isAdmin($user)) {
            return;
        }
        $limit = self::maxDiagrams();
        if ($limit <= 0) {
            return;
        }
        $current = self::countDiagrams((int) $user['id']);
        if ($current >= $limit) {
            throw new QuotaExceeded(
                QuotaExceeded::KIND_DIAGRAMS,
                $limit,
                $current,
                "Diagram quota exceeded ($current/$limit)"
            );
        }
    }

    public static function checkCanAddRevision(int $diagramId, array $owner, array $actor, int $payloadBytes): void
    {
        if (self::isAdmin($actor)) {
            return;
        }
        $revLimit = self::maxRevisionsPerDiagram();
        if ($revLimit > 0) {
            $current = self::countRevisions($diagramId);
            if ($current >= $revLimit) {
                throw new QuotaExceeded(
                    QuotaExceeded::KIND_REVISIONS,
                    $revLimit,
                    $current,
                    "Revision history full ($current/$revLimit). Delete this diagram or contact admin."
                );
            }
        }
        self::checkBytesForOwner($owner, $actor, $payloadBytes);
    }

    /**
     * Byte quota is charged to the diagram OWNER, not the actor (a shared
     * editor saving on someone else's diagram fills the owner's quota).
     */
    public static function checkBytesForOwner(array $owner, array $actor, int $additionalBytes): void
    {
        if (self::isAdmin($actor) || self::isAdmin($owner)) {
            return;
        }
        $byteLimit = self::maxBytesPerUser();
        if ($byteLimit <= 0 || $additionalBytes <= 0) {
            return;
        }
        $current = self::usedBytes((int) $owner['id']);
        if ($current + $additionalBytes > $byteLimit) {
            throw new QuotaExceeded(
                QuotaExceeded::KIND_BYTES,
                $byteLimit,
                $current,
                'Storage quota exceeded for diagram owner'
            );
        }
    }

    /**
     * In-place replacement of source/layout on the head revision (saveDraft, set_layout).
     * Charges only the positive byte delta to the diagram owner.
     */
    public static function checkCanReplaceDraft(array $owner, array $actor, int $oldBytes, int $newBytes): void
    {
        if (self::isAdmin($actor) || self::isAdmin($owner)) {
            return;
        }
        $byteLimit = self::maxBytesPerUser();
        if ($byteLimit <= 0) {
            return;
        }
        $delta = $newBytes - $oldBytes;
        if ($delta <= 0) {
            return;
        }
        $current = self::usedBytes((int) $owner['id']);
        if ($current + $delta > $byteLimit) {
            throw new QuotaExceeded(
                QuotaExceeded::KIND_BYTES,
                $byteLimit,
                $current,
                'Storage quota exceeded for diagram owner'
            );
        }
    }

    public static function countDiagrams(int $userId): int
    {
        $stmt = db()->prepare(
            'SELECT COUNT(*) FROM diagrams WHERE owner_id = ? AND deleted_at IS NULL'
        );
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    public static function countRevisions(int $diagramId): int
    {
        // Counts user-created snapshots only; the mutable #current row is not
        // a checkpoint and shouldn't count toward the per-diagram revision cap.
        $stmt = db()->prepare(
            'SELECT COUNT(*) FROM diagram_revisions WHERE diagram_id = ? AND is_current = 0'
        );
        $stmt->execute([$diagramId]);
        return (int) $stmt->fetchColumn();
    }

    public static function usedBytes(int $userId): int
    {
        $sql = 'SELECT COALESCE(SUM(LENGTH(r.source) + LENGTH(COALESCE(r.layout, ""))), 0)
                FROM diagram_revisions r
                INNER JOIN diagrams d ON d.id = r.diagram_id
                WHERE d.owner_id = ? AND d.deleted_at IS NULL';
        $stmt = db()->prepare($sql);
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    /** Snapshot for UI / debugging. */
    public static function usageFor(array $user): array
    {
        $userId = (int) $user['id'];
        return [
            'admin'                => self::isAdmin($user),
            'diagrams'             => self::countDiagrams($userId),
            'diagrams_limit'       => self::maxDiagrams(),
            'bytes_used'           => self::usedBytes($userId),
            'bytes_limit'          => self::maxBytesPerUser(),
            'revisions_per_diagram_limit' => self::maxRevisionsPerDiagram(),
        ];
    }
}
