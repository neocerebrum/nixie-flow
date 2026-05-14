<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Json;
use App\Models\Diagram;
use App\Models\Presence;
use App\Response;

/**
 * Presence + scepter endpoints. The client calls join on entry, heartbeat
 * every {@see Presence::HEARTBEAT_SECONDS}s while open, and leave on close
 * (via navigator.sendBeacon). Each call may run scepter promotion as a
 * side effect — that's how the "scepter never stays vacant" invariant is
 * maintained without a background job.
 */
final class PresenceController
{
    private const TAB_ID_MAX = 64;

    public function join(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $body = Json::readBody();
        $tabId = $this->requireTabId($body);

        $state = Presence::join((int) $diagram['id'], (int) $user['id'], $tabId, true);
        Response::json($state);
    }

    public function heartbeat(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $body = Json::readBody();
        $tabId = $this->requireTabId($body);
        $claim = !empty($body['claim_active']);

        $state = Presence::heartbeat((int) $diagram['id'], (int) $user['id'], $tabId, $claim);
        Response::json($state);
    }

    /**
     * Update the caller's current selection. Lightweight, high-frequency
     * endpoint: a single UPDATE on diagram_viewers, no scepter logic. The
     * `selection` body field is an opaque object — server just JSON-encodes
     * and persists it after a size check. Returns the full presence state
     * so the client can render peers' selections in the same round-trip.
     */
    public function selection(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $body = Json::readBody();
        $tabId = $this->requireTabId($body);

        $sel = $body['selection'] ?? null;
        $encoded = null;
        if ($sel !== null) {
            if (!is_array($sel)) {
                Response::error('Field selection must be an object or null', 400);
            }
            $encoded = json_encode($sel, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false || strlen($encoded) > \App\Models\Presence::SELECTION_MAX) {
                $encoded = null; // too large or unencodable → treat as cleared
            }
        }

        $state = Presence::setSelection((int) $diagram['id'], (int) $user['id'], $tabId, $encoded);
        Response::json($state);
    }

    /**
     * Leave: tolerant to missing CSRF token, since this is normally called
     * via navigator.sendBeacon during page unload (where some browsers do
     * not surface custom headers). Idempotent and safe — only marks the
     * caller's row as stale.
     */
    public function leave(array $args): never
    {
        $user = Auth::requireLoginApi();
        $diagram = $this->loadAccessibleOr404($args['slug'], $user);

        $body = Json::readBody();
        $tabId = $this->requireTabId($body);

        Presence::leave((int) $diagram['id'], (int) $user['id'], $tabId);
        http_response_code(204);
        exit;
    }

    private function requireTabId(array $body): string
    {
        $tabId = Json::requireString($body, 'tab_id', self::TAB_ID_MAX, true);
        if (!preg_match('/^[A-Za-z0-9_-]+$/', (string) $tabId)) {
            Response::error('Invalid tab_id', 400);
        }
        return (string) $tabId;
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
}
