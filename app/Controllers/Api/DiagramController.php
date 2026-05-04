<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Exceptions\QuotaExceeded;
use App\Exceptions\RevisionConflict;
use App\Json;
use App\Models\Diagram;
use App\Models\Lock;
use App\Models\Revision;
use App\Models\User;
use App\Quota;
use App\RateLimit;
use App\Response;
use App\Slug;

final class DiagramController
{
    private const SOURCE_MAX = 1048576;   // 1 MiB
    private const TITLE_MAX  = 200;
    private const MESSAGE_MAX = 500;

    /** Auth + per-user/per-IP rate-limit. $write=true charges the write counter. */
    private function apiUser(bool $write): array
    {
        $user = Auth::requireLoginApi();
        RateLimit::throttle('api', $user, null, $write);
        return $user;
    }

    public function index(array $args): never
    {
        $user = $this->apiUser(false);
        $all = isset($_GET['all']) && $_GET['all'] === '1';

        if ($all && ($user['role'] ?? '') === 'admin') {
            $rows = Diagram::listAll(false);
        } else {
            $rows = Diagram::listAccessibleForUser((int) $user['id']);
        }

        $userId = (int) $user['id'];
        $out = array_map(
            fn (array $d) => $this->toListItem($d, $userId),
            $rows
        );
        Response::json($out);
    }

    public function show(array $args): never
    {
        $user = $this->apiUser(false);
        $diagram = $this->loadOr404($args['slug'], $user);
        $head = null;
        if ($diagram['head_revision_id'] !== null) {
            $head = Revision::byId((int) $diagram['head_revision_id']);
        }
        Response::json($this->toFullDto($diagram, $head, $user));
    }

    public function history(array $args): never
    {
        $user = $this->apiUser(false);
        $diagram = $this->loadOr404($args['slug'], $user);
        $revs = Revision::listByDiagram((int) $diagram['id']);
        Response::json([
            'head_revision_id' => $diagram['head_revision_id'] !== null ? (int) $diagram['head_revision_id'] : null,
            'revisions' => array_map(static fn($r) => [
                'id'         => (int) $r['id'],
                'parent_id'  => $r['parent_id'] !== null ? (int) $r['parent_id'] : null,
                'author_id'  => (int) $r['author_id'],
                'message'    => $r['message'],
                'created_at' => $r['created_at'],
            ], $revs),
        ]);
    }

    public function create(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $body = Json::readBody();

        $title = Json::requireString($body, 'title', self::TITLE_MAX, true);
        $source = Json::requireString($body, 'source', self::SOURCE_MAX, true);
        $layout = Json::readLayout($body);
        $customSlug = $body['slug'] ?? null;

        try {
            Quota::checkCanCreateDiagram($user);
            $payloadBytes = strlen($source) + strlen($layout ?? '');
            Quota::checkBytesForOwner($user, $user, $payloadBytes);
        } catch (QuotaExceeded $q) {
            $this->respondQuota($q);
        }

        $autoGen = ($customSlug === null || $customSlug === '');
        if ($autoGen) {
            $base = Slug::fromTitle($title);
            $slug = Slug::ensureUnique($base, [Diagram::class, 'slugExists']);
        } else {
            if (!is_string($customSlug) || !Slug::validate($customSlug)) {
                Response::error('Invalid slug format', 400);
            }
            if (Diagram::slugExists($customSlug)) {
                Response::error('Slug already exists', 409);
            }
            $slug = $customSlug;
        }

        [$diagram, $revision] = Diagram::createWithFirstRevision(
            $slug,
            $title,
            (int) $user['id'],
            $source,
            $layout
        );

        Response::json($this->toFullDto($diagram, $revision, $user), 201);
    }

    public function save(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $body = Json::readBody();

        $source = Json::requireString($body, 'source', self::SOURCE_MAX, true);
        $layout = Json::readLayout($body);
        $message = Json::requireString($body, 'message', self::MESSAGE_MAX, false);
        $expected = Json::readInt($body, 'expected_revision_id');

        // expected_revision_id is required when diagram has a head, optional only on
        // freshly-created diagrams with null head — extremely rare since createWithFirstRevision
        // always sets a head. We require it here.
        if (!array_key_exists('expected_revision_id', $body)) {
            Response::error('Missing required field: expected_revision_id', 400);
        }

        $lockState = Lock::tryAcquire((int) $diagram['id'], (int) $user['id']);
        if (!$lockState['is_active'] || $lockState['user_id'] !== (int) $user['id']) {
            Response::json([
                'error' => 'locked',
                'lock'  => $lockState,
            ], 423);
        }

        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            $payloadBytes = strlen($source) + strlen($layout ?? '');
            Quota::checkCanAddRevision((int) $diagram['id'], $owner, $user, $payloadBytes);
        } catch (QuotaExceeded $q) {
            $this->respondQuota($q);
        }

        try {
            $newRev = Revision::createAndAdvanceHead(
                (int) $diagram['id'],
                $expected,
                $source,
                $layout,
                (int) $user['id'],
                $message
            );
        } catch (RevisionConflict $c) {
            Response::json([
                'error' => 'conflict',
                'current_revision_id' => $c->currentRevisionId,
            ], 409);
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $newRev, $user));
    }

    public function saveDraft(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $this->ensureLock($diagram, $user);
        $body = Json::readBody();

        $expected = Json::readInt($body, 'expected_revision_id');
        if (!array_key_exists('expected_revision_id', $body)) {
            Response::error('Missing required field: expected_revision_id', 400);
        }

        $hasSource = array_key_exists('source', $body);
        $hasLayout = array_key_exists('layout', $body);
        if (!$hasSource && !$hasLayout) {
            Response::error('Provide at least one of: source, layout', 400);
        }

        $head = $diagram['head_revision_id'] !== null
            ? Revision::byId((int) $diagram['head_revision_id'])
            : null;
        $oldBytes = ($head ? strlen((string) $head['source']) + strlen((string) ($head['layout'] ?? '')) : 0);

        $source = $hasSource ? Json::requireString($body, 'source', self::SOURCE_MAX, true) : null;
        $layout = $hasLayout ? Json::readLayout($body) : null;

        $newSourceBytes = $hasSource ? strlen((string) $source) : ($head ? strlen((string) $head['source']) : 0);
        $newLayoutBytes = $hasLayout ? strlen((string) ($layout ?? '')) : ($head ? strlen((string) ($head['layout'] ?? '')) : 0);
        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            Quota::checkCanReplaceDraft($owner, $user, $oldBytes, $newSourceBytes + $newLayoutBytes);
        } catch (QuotaExceeded $q) {
            $this->respondQuota($q);
        }

        try {
            $rev = Revision::updateDraft(
                (int) $diagram['id'],
                (int) $expected,
                $source,
                $layout
            );
        } catch (RevisionConflict $c) {
            Response::json([
                'error' => 'conflict',
                'current_revision_id' => $c->currentRevisionId,
            ], 409);
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $rev, $user));
    }

    public function patch(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $body = Json::readBody();

        $newTitle = null;
        $newSlug = null;
        if (array_key_exists('title', $body)) {
            $newTitle = Json::requireString($body, 'title', self::TITLE_MAX, true);
        }
        if (array_key_exists('slug', $body)) {
            $candidate = $body['slug'];
            if (!is_string($candidate) || !Slug::validate($candidate)) {
                Response::error('Invalid slug format', 400);
            }
            if ($candidate !== $diagram['slug'] && Diagram::slugExists($candidate)) {
                Response::error('Slug already exists', 409);
            }
            $newSlug = $candidate;
        }

        if ($newTitle === null && $newSlug === null) {
            Response::error('Nothing to update', 400);
        }

        Diagram::rename((int) $diagram['id'], $newTitle, $newSlug);
        $fresh = Diagram::byId((int) $diagram['id']);
        $head = $fresh['head_revision_id'] ? Revision::byId((int) $fresh['head_revision_id']) : null;
        Response::json($this->toFullDto($fresh, $head, $user));
    }

    public function undo(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $this->ensureLock($diagram, $user);

        if ($diagram['head_revision_id'] === null) {
            Response::error('Diagram has no head', 400);
        }
        $head = Revision::byId((int) $diagram['head_revision_id']);
        if ($head === null) {
            Response::error('Head revision missing', 500);
        }
        if ($head['parent_id'] === null) {
            Response::error('Already at root revision', 400);
        }

        Diagram::setHead((int) $diagram['id'], (int) $head['parent_id']);
        $fresh = Diagram::byId((int) $diagram['id']);
        $newHead = Revision::byId((int) $head['parent_id']);
        Response::json($this->toFullDto($fresh, $newHead, $user));
    }

    public function redo(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $this->ensureLock($diagram, $user);

        if ($diagram['head_revision_id'] === null) {
            Response::error('Diagram has no head', 400);
        }
        $child = Revision::mostRecentChild((int) $diagram['id'], (int) $diagram['head_revision_id']);
        if ($child === null) {
            Response::error('Nothing to redo', 400);
        }

        Diagram::setHead((int) $diagram['id'], (int) $child['id']);
        $fresh = Diagram::byId((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $child, $user));
    }

    public function checkout(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $this->ensureLock($diagram, $user);
        $body = Json::readBody();
        $revisionId = Json::readInt($body, 'revision_id');
        if ($revisionId === null) {
            Response::error('Missing required field: revision_id', 400);
        }

        $rev = Revision::byId($revisionId);
        if ($rev === null || (int) $rev['diagram_id'] !== (int) $diagram['id']) {
            Response::error('Revision does not belong to this diagram', 400);
        }

        Diagram::setHead((int) $diagram['id'], $revisionId);
        $fresh = Diagram::byId((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $rev, $user));
    }

    public function delete(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        // Only owner or admin can delete; shared-edit users cannot.
        $isAdmin = ($user['role'] ?? '') === 'admin';
        if (!$isAdmin && (int) $diagram['owner_id'] !== (int) $user['id']) {
            Response::error('Only the owner can delete this diagram', 403);
        }
        Diagram::softDelete((int) $diagram['id']);
        http_response_code(204);
        exit;
    }

    public function restore(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();

        // Restoring a soft-deleted diagram requires bypassing the deleted check;
        // resolve directly. Only owner or admin can restore.
        $diagram = Diagram::bySlug($args['slug']);
        $isAdmin = ($user['role'] ?? '') === 'admin';
        $isOwner = $diagram !== null && (int) $diagram['owner_id'] === (int) $user['id'];
        if ($diagram === null || (!$isAdmin && !$isOwner)) {
            Response::error('Not found', 404);
        }
        if (!Diagram::isDeleted($diagram)) {
            Response::error('Diagram is not deleted', 400);
        }
        Diagram::restore((int) $diagram['id']);
        $fresh = Diagram::byId((int) $diagram['id']);
        $head = $fresh['head_revision_id'] ? Revision::byId((int) $fresh['head_revision_id']) : null;
        Response::json($this->toFullDto($fresh, $head, $user));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private function loadOr404(string $slug, array $user): array
    {
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canAccess($diagram, $user)) {
            Response::error('Not found', 404);
        }
        $isAdmin = ($user['role'] ?? '') === 'admin';
        if (Diagram::isDeleted($diagram) && !$isAdmin) {
            Response::error('Not found', 404);
        }
        return $diagram;
    }

    private function loadWritableOr404(string $slug, array $user): array
    {
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canAccess($diagram, $user)) {
            Response::error('Not found', 404);
        }
        $isAdmin = ($user['role'] ?? '') === 'admin';
        if (Diagram::isDeleted($diagram) && !$isAdmin) {
            Response::error('Not found', 404);
        }
        if (!Diagram::canWrite($diagram, $user)) {
            Response::error('You do not have edit permission on this diagram', 403);
        }
        return $diagram;
    }

    private function respondQuota(QuotaExceeded $q): never
    {
        Response::json([
            'error'   => 'quota_exceeded',
            'kind'    => $q->kind,
            'limit'   => $q->limit,
            'current' => $q->current,
            'message' => $q->getMessage(),
        ], 413);
    }

    /** Atomically claim or refresh the lock for $user. 423 if held by someone else. */
    private function ensureLock(array $diagram, array $user): void
    {
        $state = Lock::tryAcquire((int) $diagram['id'], (int) $user['id']);
        if (!$state['is_active'] || $state['user_id'] !== (int) $user['id']) {
            Response::json([
                'error' => 'locked',
                'lock'  => $state,
            ], 423);
        }
    }

    private function toListItem(array $d, int $userId): array
    {
        $isOwner = (int) $d['owner_id'] === $userId;
        $sharePerm = $d['share_permission'] ?? null;
        $perm = $isOwner ? 'owner' : ($sharePerm ?? null);

        return [
            'slug'             => $d['slug'],
            'title'            => $d['title'],
            'owner_id'         => (int) $d['owner_id'],
            'head_revision_id' => $d['head_revision_id'] !== null ? (int) $d['head_revision_id'] : null,
            'created_at'       => $d['created_at'],
            'updated_at'       => $d['updated_at'],
            'deleted_at'       => $d['deleted_at'] ?? null,
            'permission'       => $perm,
            'lock'             => Lock::state($d),
        ];
    }

    private function toFullDto(?array $d, ?array $head, ?array $user = null): array
    {
        if ($d === null) {
            Response::error('Diagram missing', 500);
        }
        $hasChildren = $head !== null
            && Revision::hasChildren((int) $d['id'], (int) $head['id']);

        $perm = null;
        if ($user !== null) {
            $perm = Diagram::permissionFor($d, $user);
        }

        return [
            'slug'        => $d['slug'],
            'title'       => $d['title'],
            'owner_id'    => (int) $d['owner_id'],
            'revision_id' => $head !== null ? (int) $head['id'] : null,
            'parent_id'   => $head !== null && $head['parent_id'] !== null ? (int) $head['parent_id'] : null,
            'source'      => $head !== null ? $head['source'] : null,
            'layout'      => $head !== null && $head['layout'] !== null ? json_decode($head['layout'], true) : null,
            'author_id'   => $head !== null ? (int) $head['author_id'] : null,
            'message'     => $head !== null ? $head['message'] : null,
            'created_at'  => $d['created_at'],
            'updated_at'  => $d['updated_at'],
            'deleted_at'  => $d['deleted_at'] ?? null,
            'can_undo'    => $head !== null && $head['parent_id'] !== null,
            'can_redo'    => $hasChildren,
            'permission'  => $perm,
            'lock'        => Lock::state($d),
        ];
    }
}
