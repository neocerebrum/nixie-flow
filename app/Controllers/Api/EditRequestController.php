<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Json;
use App\Models\Diagram;
use App\Models\EditRequest;
use App\Models\Lock;
use App\Response;

final class EditRequestController
{
    private const NOTE_MAX = 500;

    /** Viewer asks the current editor for the turn. */
    public function create(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $body = Json::readBody();
        $note = Json::requireString($body, 'note', self::NOTE_MAX, false);

        EditRequest::expireStale((int) $diagram['id']);

        $lockState = Lock::state($diagram);
        if (!$lockState['is_active'] || $lockState['user_id'] === (int) $user['id']) {
            Response::error('Lock is free or already yours; just acquire it', 400);
        }

        $existing = EditRequest::activeForUser((int) $diagram['id'], (int) $user['id']);
        if ($existing !== null) {
            Response::json([
                'request' => $this->toDto($existing),
                'lock'    => $lockState,
            ], 200);
        }

        $id = EditRequest::create((int) $diagram['id'], (int) $user['id'], $note);
        $row = EditRequest::byId($id);
        Response::json([
            'request' => $this->toDto($row),
            'lock'    => $lockState,
        ], 201);
    }

    /** Editor sees the pending requests on the diagram. */
    public function listForDiagram(array $args): never
    {
        $user = Auth::requireLoginApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        EditRequest::expireStale((int) $diagram['id']);
        $rows = EditRequest::pendingOn((int) $diagram['id']);
        Response::json([
            'requests' => array_map([$this, 'toDto'], $rows),
        ]);
    }

    /** Editor accepts → release lock, mark granted (requester has 30s to take). */
    public function accept(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $req = EditRequest::byId((int) $args['id']);
        if ($req === null || (int) $req['diagram_id'] !== (int) $diagram['id']) {
            Response::error('Request not found', 404);
        }
        if (($req['status'] ?? '') !== 'pending') {
            Response::error('Request is not pending', 400);
        }

        if (!Lock::heldBy($diagram, (int) $user['id'])
            && ($user['role'] ?? '') !== 'admin') {
            Response::error('Only the current editor can accept this request', 403);
        }

        Lock::release((int) $diagram['id'], (int) $user['id'], true);
        EditRequest::setStatus((int) $req['id'], 'granted');

        $fresh = EditRequest::byId((int) $req['id']);
        Response::json(['request' => $this->toDto($fresh)]);
    }

    /** Editor declines → mark rejected. */
    public function decline(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $req = EditRequest::byId((int) $args['id']);
        if ($req === null || (int) $req['diagram_id'] !== (int) $diagram['id']) {
            Response::error('Request not found', 404);
        }
        if (($req['status'] ?? '') !== 'pending') {
            Response::error('Request is not pending', 400);
        }

        if (!Lock::heldBy($diagram, (int) $user['id'])
            && ($user['role'] ?? '') !== 'admin') {
            Response::error('Only the current editor can decline this request', 403);
        }

        EditRequest::setStatus((int) $req['id'], 'rejected');
        $fresh = EditRequest::byId((int) $req['id']);
        Response::json(['request' => $this->toDto($fresh)]);
    }

    /** Requester polls the status of their last request on this diagram. */
    public function mine(array $args): never
    {
        $user = Auth::requireLoginApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $row = EditRequest::activeForUser((int) $diagram['id'], (int) $user['id']);
        Response::json([
            'request' => $row !== null ? $this->toDto($row) : null,
        ]);
    }

    /** Requester withdraws their own pending request. */
    public function cancel(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $req = EditRequest::byId((int) $args['id']);
        if ($req === null || (int) $req['diagram_id'] !== (int) $diagram['id']) {
            Response::error('Request not found', 404);
        }
        if ((int) $req['requester_id'] !== (int) $user['id']) {
            Response::error('Not your request', 403);
        }
        if (($req['status'] ?? '') !== 'pending') {
            Response::error('Request is not pending', 400);
        }
        EditRequest::setStatus((int) $req['id'], 'cancelled');
        http_response_code(204);
        exit;
    }

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

    private function toDto(array $r): array
    {
        return [
            'id'              => (int) $r['id'],
            'diagram_id'      => (int) $r['diagram_id'],
            'requester_id'    => (int) $r['requester_id'],
            'requester_email' => $r['requester_email'] ?? null,
            'requester_name'  => $r['requester_name'] ?? null,
            'status'          => $r['status'],
            'note'            => $r['note'] ?? null,
            'created_at'      => $r['created_at'],
            'resolved_at'     => $r['resolved_at'],
            'grant_open'      => EditRequest::isGrantWindowOpen($r),
        ];
    }
}
