<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Json;
use App\Models\Diagram;
use App\Models\MergeRequest;
use App\Models\Revision;
use App\Response;

/**
 * Merge requests: a fork owner proposes publishing their variant (source) onto
 * the original it was forked from (target). Accepting writes the variant's
 * current source+layout as a new revision/#current on the original.
 *
 * Endpoints whose {slug} is the SOURCE (variant): create, mine, withdraw.
 * Endpoints whose {slug} is the TARGET (original): list, accept, decline.
 */
final class MergeRequestController
{
    private const NOTE_MAX = 500;

    /** Fork owner proposes a merge onto the original. {slug} = variant. */
    public function create(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $source = $this->loadAccessibleOr404($args['slug'], $user);

        if ((int) $source['owner_id'] !== (int) $user['id']) {
            Response::error('Only the fork owner can request a merge', 403);
        }
        if (empty($source['source_diagram_id'])) {
            Response::error('This diagram is not a fork of another diagram', 400);
        }
        $target = Diagram::byId((int) $source['source_diagram_id']);
        if ($target === null || Diagram::isDeleted($target)) {
            Response::error('The original diagram no longer exists', 409);
        }
        if ((int) $target['owner_id'] === (int) $user['id']) {
            Response::error('You already own the original diagram', 400);
        }

        $body = Json::readBody();
        $note = Json::requireString($body, 'note', self::NOTE_MAX, false);

        $existing = MergeRequest::pendingForPair((int) $source['id'], (int) $target['id']);
        if ($existing !== null) {
            Response::json(['request' => $this->toDto($existing)], 200);
        }

        $id = MergeRequest::create((int) $source['id'], (int) $target['id'], (int) $user['id'], $note);
        Response::json(['request' => $this->toDto(MergeRequest::mineForSource((int) $source['id'], (int) $user['id']))], 201);
    }

    /** Requester polls their pending request on this variant. {slug} = variant. */
    public function mine(array $args): never
    {
        $user = Auth::requireLoginApi();
        $source = $this->loadAccessibleOr404($args['slug'], $user);
        $row = MergeRequest::mineForSource((int) $source['id'], (int) $user['id']);
        Response::json(['request' => $row !== null ? $this->toDto($row) : null]);
    }

    /** Requester withdraws their own pending request. {slug} = variant. */
    public function withdraw(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $source = $this->loadAccessibleOr404($args['slug'], $user);

        $mr = MergeRequest::byId((int) $args['id']);
        if ($mr === null || (int) $mr['source_diagram_id'] !== (int) $source['id']) {
            Response::error('Request not found', 404);
        }
        if ((int) $mr['requester_id'] !== (int) $user['id']) {
            Response::error('Not your request', 403);
        }
        if (($mr['status'] ?? '') !== 'pending') {
            Response::error('Request is not pending', 400);
        }
        MergeRequest::resolve((int) $mr['id'], 'withdrawn');
        http_response_code(204);
        exit;
    }

    /** Original owner lists pending requests targeting this diagram. {slug} = target. */
    public function listForDiagram(array $args): never
    {
        $user = Auth::requireLoginApi();
        $target = $this->loadManageableOr404($args['slug'], $user);
        $rows = MergeRequest::pendingForTarget((int) $target['id']);
        Response::json(['requests' => array_map([$this, 'toDto'], $rows)]);
    }

    /**
     * Original owner accepts → the variant's current content becomes a new
     * revision/#current on the original. {slug} = target.
     */
    public function accept(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $target = $this->loadManageableOr404($args['slug'], $user);

        $mr = MergeRequest::byId((int) $args['id']);
        if ($mr === null || (int) $mr['target_diagram_id'] !== (int) $target['id']) {
            Response::error('Request not found', 404);
        }
        if (($mr['status'] ?? '') !== 'pending') {
            Response::error('Request is not pending', 400);
        }

        $source = Diagram::byId((int) $mr['source_diagram_id']);
        if ($source === null || Diagram::isDeleted($source)) {
            MergeRequest::resolve((int) $mr['id'], 'withdrawn');
            Response::error('The variant no longer exists', 409);
        }
        $current = Revision::current((int) $source['id']);
        if ($current === null) {
            Response::error('The variant has no content to merge', 409);
        }

        $label = trim((string) ($source['title'] ?? '')) !== ''
            ? (string) $source['title'] : (string) $source['slug'];
        $message = sprintf('Merged variant "%s" (merge request #%d)', $label, (int) $mr['id']);

        $snapshot = Revision::commitForeign(
            (int) $target['id'],
            (string) $current['source'],
            $current['layout'] !== null ? (string) $current['layout'] : null,
            (int) $mr['requester_id'],
            $message
        );

        MergeRequest::accept((int) $mr['id'], (int) $user['id'], (int) $snapshot['id']);
        Response::json([
            'request'     => $this->toDto(MergeRequest::byId((int) $mr['id'])),
            'revision_id' => (int) $snapshot['id'],
        ]);
    }

    /** Original owner declines a pending request. {slug} = target. */
    public function decline(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $target = $this->loadManageableOr404($args['slug'], $user);

        $mr = MergeRequest::byId((int) $args['id']);
        if ($mr === null || (int) $mr['target_diagram_id'] !== (int) $target['id']) {
            Response::error('Request not found', 404);
        }
        if (($mr['status'] ?? '') !== 'pending') {
            Response::error('Request is not pending', 400);
        }
        MergeRequest::resolve((int) $mr['id'], 'declined', (int) $user['id']);
        Response::json(['request' => $this->toDto(MergeRequest::byId((int) $mr['id']))]);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private function loadAccessibleOr404(string $slug, array $user): array
    {
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canAccess($diagram, $user)) {
            Response::error('Not found', 404);
        }
        if (Diagram::isDeleted($diagram) && ($user['role'] ?? '') !== 'admin') {
            Response::error('Not found', 404);
        }
        return $diagram;
    }

    /** Owner or admin of the diagram (the merge target). */
    private function loadManageableOr404(string $slug, array $user): array
    {
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null) {
            Response::error('Not found', 404);
        }
        $isAdmin = ($user['role'] ?? '') === 'admin';
        $isOwner = (int) $diagram['owner_id'] === (int) $user['id'];
        if (!$isAdmin && !$isOwner) {
            Response::error('Not found', 404);
        }
        if (Diagram::isDeleted($diagram) && !$isAdmin) {
            Response::error('Not found', 404);
        }
        return $diagram;
    }

    private function toDto(?array $r): ?array
    {
        if ($r === null) {
            return null;
        }
        return [
            'id'                => (int) $r['id'],
            'source_diagram_id' => (int) $r['source_diagram_id'],
            'target_diagram_id' => (int) $r['target_diagram_id'],
            'requester_id'      => (int) $r['requester_id'],
            'requester_name'    => $r['requester_name'] ?? null,
            'requester_email'   => $r['requester_email'] ?? null,
            'source_slug'       => $r['source_slug'] ?? null,
            'source_title'      => $r['source_title'] ?? null,
            'target_slug'       => $r['target_slug'] ?? null,
            'target_title'      => $r['target_title'] ?? null,
            'status'            => $r['status'],
            'note'              => $r['note'] ?? null,
            'created_at'        => $r['created_at'] ?? null,
            'resolved_at'       => $r['resolved_at'] ?? null,
        ];
    }
}
