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
use App\Models\Presence;
use App\Models\Project;
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
        $current = Revision::current((int) $diagram['id']);
        Response::json($this->toFullDto($diagram, $current, $user));
    }

    public function history(array $args): never
    {
        $user = $this->apiUser(false);
        $diagram = $this->loadOr404($args['slug'], $user);
        $current = Revision::current((int) $diagram['id']);
        $snaps = Revision::listSnapshots((int) $diagram['id']);
        Response::json([
            'head_revision_id' => $current && $current['source_revision_id'] !== null
                ? (int) $current['source_revision_id'] : null,
            // Live working copy — surfaced explicitly so the editor UI can
            // render it as a distinct top entry in the history list.
            'current' => $current === null ? null : [
                'source_revision_id' => $current['source_revision_id'] !== null
                    ? (int) $current['source_revision_id'] : null,
                'author_id'  => (int) $current['author_id'],
                'updated_at' => $diagram['updated_at'],
            ],
            'revisions' => array_map(static fn($r) => [
                'id'         => (int) $r['id'],
                'parent_id'  => $r['parent_id'] !== null ? (int) $r['parent_id'] : null,
                'author_id'  => (int) $r['author_id'],
                'message'    => $r['message'],
                'created_at' => $r['created_at'],
            ], $snaps),
        ]);
    }

    // Diagrams filed under the same project as {slug}, for the editor's node
    // "link to another diagram" picker. Excludes the diagram itself and any the
    // caller can't read. Empty list when the diagram isn't filed in a project.
    public function siblings(array $args): never
    {
        $user = $this->apiUser(false);
        $diagram = $this->loadOr404($args['slug'], $user);
        $out = [];
        if ($diagram['project_id'] !== null) {
            foreach (Diagram::listForProject((int) $diagram['project_id']) as $d) {
                if ((int) $d['id'] === (int) $diagram['id']) {
                    continue;
                }
                if (!Diagram::canAccess($d, $user)) {
                    continue;
                }
                $out[] = [
                    'slug'  => $d['slug'],
                    'title' => $d['title'],
                ];
            }
        }
        Response::json($out);
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

        // Optional: create the diagram directly inside a project (used by the
        // "New diagram" button on a project page).
        $projectId = array_key_exists('project', $body)
            ? $this->resolveTargetProject($body['project'], $user)
            : null;

        $expiresAt = User::isDemo($user)
            ? gmdate('Y-m-d H:i:s', time() + 86400)
            : null;

        [$diagram, $current] = Diagram::createWithFirstRevision(
            $slug,
            $title,
            (int) $user['id'],
            $source,
            $layout,
            $expiresAt
        );
        if ($projectId !== null) {
            Diagram::setProject((int) $diagram['id'], $projectId);
            $diagram = Diagram::byId((int) $diagram['id']) ?? $diagram;
        }

        Response::json($this->toFullDto($diagram, $current, $user), 201);
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

        // expected_revision_id is the snapshot id #current is forked from
        // (or null on a never-saved diagram). Required field.
        if (!array_key_exists('expected_revision_id', $body)) {
            Response::error('Missing required field: expected_revision_id', 400);
        }

        $this->requireScepter($diagram, $user);

        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            $payloadBytes = strlen($source) + strlen($layout ?? '');
            Quota::checkCanAddRevision((int) $diagram['id'], $owner, $user, $payloadBytes);
        } catch (QuotaExceeded $q) {
            $this->respondQuota($q);
        }

        try {
            Revision::snapshotCurrent(
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
        $current = Revision::current((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $current, $user));
    }

    public function saveDraft(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $this->requireScepter($diagram, $user);
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

        $current = Revision::current((int) $diagram['id']);
        $oldBytes = $current
            ? strlen((string) $current['source']) + strlen((string) ($current['layout'] ?? ''))
            : 0;

        $source = $hasSource ? Json::requireString($body, 'source', self::SOURCE_MAX, true) : null;
        $layout = $hasLayout ? Json::readLayout($body) : null;

        $newSourceBytes = $hasSource ? strlen((string) $source) : ($current ? strlen((string) $current['source']) : 0);
        $newLayoutBytes = $hasLayout ? strlen((string) ($layout ?? '')) : ($current ? strlen((string) ($current['layout'] ?? '')) : 0);
        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            Quota::checkCanReplaceDraft($owner, $user, $oldBytes, $newSourceBytes + $newLayoutBytes);
        } catch (QuotaExceeded $q) {
            $this->respondQuota($q);
        }

        try {
            Revision::updateCurrent(
                (int) $diagram['id'],
                $expected,
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
        $freshCurrent = Revision::current((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $freshCurrent, $user));
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

    public function checkout(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        $this->requireScepter($diagram, $user);
        $body = Json::readBody();
        $revisionId = Json::readInt($body, 'revision_id');
        if ($revisionId === null) {
            Response::error('Missing required field: revision_id', 400);
        }

        $rev = Revision::byId($revisionId);
        if ($rev === null
            || (int) $rev['diagram_id'] !== (int) $diagram['id']
            || (int) ($rev['is_current'] ?? 0) === 1
        ) {
            Response::error('Snapshot does not belong to this diagram', 400);
        }

        try {
            Revision::checkoutSnapshot((int) $diagram['id'], $revisionId);
        } catch (\RuntimeException $e) {
            Response::error($e->getMessage(), 400);
        }
        $fresh = Diagram::byId((int) $diagram['id']);
        $current = Revision::current((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $current, $user));
    }

    public function delete(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);
        // Owner only; shared-edit users and admins cannot delete others' work.
        if ((int) $diagram['owner_id'] !== (int) $user['id']) {
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

    /**
     * File a diagram into a project (or unfile it). Body: { project: slug|null }.
     * Only the diagram owner (or admin) may move it, and the target project must
     * be one they manage.
     */
    public function move(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadOr404($args['slug'], $user);

        // Owner only; admins are not elevated for filing others' diagrams.
        if ((int) $diagram['owner_id'] !== (int) $user['id']) {
            Response::error('Only the owner can move this diagram', 403);
        }

        $body = Json::readBody();
        if (!array_key_exists('project', $body)) {
            Response::error('Missing required field: project', 400);
        }

        $projectId = $this->resolveTargetProject($body['project'], $user);
        Diagram::setProject((int) $diagram['id'], $projectId);

        $fresh = Diagram::byId((int) $diagram['id']);
        $current = Revision::current((int) $diagram['id']);
        Response::json($this->toFullDto($fresh, $current, $user));
    }

    /**
     * Duplicate a diagram the user can read into a fresh diagram they own,
     * copying the live source + layout. Body: { title?, project? }.
     */
    public function duplicate(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $diagram = $this->loadOr404($args['slug'], $user);
        $body = Json::readBody();

        $title = null;
        if (array_key_exists('title', $body)) {
            $title = Json::requireString($body, 'title', self::TITLE_MAX, true);
        }
        if ($title === null || $title === '') {
            $base = trim((string) ($diagram['title'] ?? '')) !== ''
                ? (string) $diagram['title']
                : (string) $diagram['slug'];
            $title = mb_substr($base . ' (copy)', 0, self::TITLE_MAX);
        }

        // `fork_project` (a shared project's slug) takes precedence: the copy is
        // filed into the user's personal fork of that project (created on demand).
        // Otherwise `project` files it into a project the user manages.
        $forkProjectSlug = null;
        if (array_key_exists('fork_project', $body) && $body['fork_project'] !== null && $body['fork_project'] !== '') {
            $fork = $this->resolveForkProject($body['fork_project'], $user);
            $projectId = (int) $fork['id'];
            $forkProjectSlug = $fork['slug'];
        } else {
            $projectId = array_key_exists('project', $body)
                ? $this->resolveTargetProject($body['project'], $user)
                : null;
        }

        // Copy is owned by the current user; quota counts against them.
        $current = Revision::current((int) $diagram['id']);
        $bytes = $current
            ? strlen((string) $current['source']) + strlen((string) ($current['layout'] ?? ''))
            : 0;
        try {
            Quota::checkCanCreateDiagram($user);
            Quota::checkBytesForOwner($user, $user, $bytes);
        } catch (QuotaExceeded $q) {
            $this->respondQuota($q);
        }

        $slug = Slug::ensureUnique(Slug::fromTitle($title), [Diagram::class, 'slugExists']);
        [$newDiagram, $newCurrent] = Diagram::duplicate(
            (int) $diagram['id'],
            $slug,
            $title,
            (int) $user['id'],
            $projectId
        );
        $dto = $this->toFullDto($newDiagram, $newCurrent, $user);
        if ($forkProjectSlug !== null) {
            // Tell the client where the copy landed so it can navigate there.
            $dto['project'] = $forkProjectSlug;
        }
        Response::json($dto, 201);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Resolve a shared project's slug into the id of the user's personal fork of
     * it, creating the fork on first use. The source must be a project the user
     * can access; if they actually manage it, no fork is made (returns it as-is).
     */
    private function resolveForkProject(mixed $sourceSlug, array $user): array
    {
        if (!is_string($sourceSlug)) {
            Response::error('Invalid project', 400);
        }
        $source = Project::bySlug($sourceSlug);
        if ($source === null || !empty($source['deleted_at']) || !Project::canAccess($source, $user)) {
            Response::error('Project not found', 404);
        }
        if (Project::canManage($source, $user)) {
            return $source; // owner/admin: file straight into it, no fork
        }
        $existing = Project::forkFor((int) $source['id'], (int) $user['id']);
        if ($existing !== null) {
            return $existing;
        }
        $title = trim((string) ($source['title'] ?? '')) !== ''
            ? (string) $source['title']
            : (string) $source['slug'];
        $slug = Slug::ensureUnique(Slug::fromTitle($title), [Project::class, 'slugExists']);
        return Project::create($slug, $title, (int) $user['id'], (int) $source['id']);
    }

    /**
     * Resolve a `project` request value (slug, or null/'' for unfiled) into a
     * project id the user manages. 404s if a non-empty slug doesn't resolve.
     */
    private function resolveTargetProject(mixed $projectSlug, array $user): ?int
    {
        if ($projectSlug === null || $projectSlug === '') {
            return null;
        }
        if (!is_string($projectSlug)) {
            Response::error('Invalid project', 400);
        }
        $project = Project::bySlug($projectSlug);
        if ($project === null || !empty($project['deleted_at']) || !Project::canManage($project, $user)) {
            Response::error('Project not found', 404);
        }
        return (int) $project['id'];
    }

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
        if (Diagram::isExpired($diagram) && !$isAdmin) {
            Response::error('diagram_expired', 410);
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
        if (Diagram::isExpired($diagram) && !$isAdmin) {
            Response::error('diagram_expired', 410);
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

    /**
     * Require that this caller currently holds the scepter and is calling
     * from the active tab they last claimed. Replies 423 if someone else
     * holds the scepter, or 409 inactive_tab if they hold it but a different
     * tab is the active one. Reads the tab id from the X-Tab-Id header.
     */
    private function requireScepter(array $diagram, array $user): void
    {
        $tabId = $_SERVER['HTTP_X_TAB_ID'] ?? '';
        if (!is_string($tabId) || $tabId === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $tabId)) {
            Response::error('Missing or invalid X-Tab-Id header', 400);
        }
        if (!Presence::heldByActiveTab((int) $diagram['id'], (int) $user['id'], $tabId)) {
            $fresh = Diagram::byId((int) $diagram['id']) ?? [];
            if (Lock::heldBy($fresh, (int) $user['id'])) {
                Response::json([
                    'error' => 'inactive_tab',
                    'lock'  => Lock::state($fresh),
                ], 409);
            }
            Response::json([
                'error' => 'locked',
                'lock'  => Lock::state($fresh),
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

    /**
     * Build the full editor DTO from a diagram + its #current row.
     * `revision_id` exposes the snapshot id #current is forked from (or null
     * if the diagram has never been Saved). The client uses that as
     * `expected_revision_id` for autosave + Save optimistic locking.
     */
    private function toFullDto(?array $d, ?array $current, ?array $user = null): array
    {
        if ($d === null) {
            Response::error('Diagram missing', 500);
        }

        $perm = null;
        if ($user !== null) {
            $perm = Diagram::permissionFor($d, $user);
        }

        $sourceRevId = $current !== null && $current['source_revision_id'] !== null
            ? (int) $current['source_revision_id']
            : null;

        return [
            'slug'        => $d['slug'],
            'title'       => $d['title'],
            'owner_id'    => (int) $d['owner_id'],
            'revision_id' => $sourceRevId,
            'parent_id'   => null,
            'source'      => $current !== null ? $current['source'] : null,
            'layout'      => $current !== null && $current['layout'] !== null
                                ? json_decode($current['layout'], true) : null,
            'author_id'   => $current !== null ? (int) $current['author_id'] : null,
            'message'     => null,
            'created_at'  => $d['created_at'],
            'updated_at'  => $d['updated_at'],
            'deleted_at'  => $d['deleted_at'] ?? null,
            'can_undo'    => false,
            'can_redo'    => false,
            'permission'  => $perm,
            'lock'        => Lock::state($d),
        ];
    }
}
