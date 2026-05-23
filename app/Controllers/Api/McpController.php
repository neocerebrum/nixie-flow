<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Config;
use App\Exceptions\QuotaExceeded;
use App\Exceptions\RevisionConflict;
use App\Models\ApiToken;
use App\Models\Diagram;
use App\Models\Lock;
use App\Models\Revision;
use App\Models\User;
use App\Quota;
use App\RateLimit;
use App\Slug;

/**
 * MCP HTTP endpoint — Streamable HTTP transport per the MCP spec.
 * Single endpoint POST /mcp accepting JSON-RPC 2.0 envelopes.
 *
 * Auth: `Authorization: Bearer aqt_...` resolved via App\Models\ApiToken.
 *
 * Implemented JSON-RPC methods:
 *   - initialize
 *   - notifications/initialized   (no response — it's a notification)
 *   - ping
 *   - tools/list
 *   - tools/call  → dispatches to one of the 7 Aquata tools below.
 *
 * Tools exposed (mirror the API's verbs but identified by slug instead of internal id):
 *   - list_diagrams                         → owned + shared, excluding deleted
 *   - get_diagram(slug)                     → source + layout + revision_id
 *   - save_diagram(slug, source, expected_version[, layout, message])
 *   - create_diagram(title[, slug, source]) → first revision
 *   - delete_diagram(slug)                  → soft delete (owner only)
 *   - get_layout(slug)                      → just the positions sidecar
 *   - set_layout(slug, layout, expected_version)
 */
final class McpController
{
    private const PROTOCOL_VERSION = '2024-11-05';
    private const SERVER_NAME      = 'aquata';
    private const SERVER_VERSION   = '0.1.0';

    public function handle(array $args): never
    {
        header('Content-Type: application/json; charset=utf-8');
        $this->applyCors();
        if (($_SERVER['REQUEST_METHOD'] ?? 'POST') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }

        $user = Auth::bearerUser();
        if ($user === null) {
            http_response_code(401);
            echo $this->errorEnvelope(null, -32001, 'Unauthorized: missing or invalid Bearer token');
            exit;
        }

        $tokenHash = $this->bearerTokenHash();

        $raw = file_get_contents('php://input') ?: '';
        $msg = json_decode($raw, true);
        if (!is_array($msg)) {
            http_response_code(400);
            echo $this->errorEnvelope(null, -32700, 'Parse error: invalid JSON');
            exit;
        }

        // Batch support per JSON-RPC 2.0.
        if ($this->isBatch($msg)) {
            $isWrite = false;
            foreach ($msg as $req) {
                if ($this->isWriteCall((array) $req)) { $isWrite = true; break; }
            }
            RateLimit::throttle('mcp', $user, $tokenHash, $isWrite);

            $out = [];
            foreach ($msg as $req) {
                $resp = $this->dispatchSingle($req, $user);
                if ($resp !== null) $out[] = $resp;
            }
            echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            exit;
        }

        RateLimit::throttle('mcp', $user, $tokenHash, $this->isWriteCall($msg));
        $resp = $this->dispatchSingle($msg, $user);
        if ($resp === null) {
            // Notification: no body.
            http_response_code(204);
            exit;
        }
        echo json_encode($resp, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    // ── JSON-RPC dispatch ───────────────────────────────────────────────────

    /** Returns null on notifications (no response). */
    private function dispatchSingle(array $req, array $user): ?array
    {
        $id = $req['id'] ?? null;
        $method = (string) ($req['method'] ?? '');
        $params = $req['params'] ?? [];
        $isNotification = !array_key_exists('id', $req);

        try {
            switch ($method) {
                case 'initialize':
                    return $this->ok($id, [
                        'protocolVersion' => self::PROTOCOL_VERSION,
                        'capabilities'    => ['tools' => ['listChanged' => false]],
                        'serverInfo'      => [
                            'name'    => self::SERVER_NAME,
                            'version' => self::SERVER_VERSION,
                        ],
                    ]);
                case 'notifications/initialized':
                case 'notifications/cancelled':
                    return null;
                case 'ping':
                    return $this->ok($id, new \stdClass());
                case 'tools/list':
                    return $this->ok($id, ['tools' => $this->toolDefinitions()]);
                case 'tools/call':
                    $name = (string) ($params['name'] ?? '');
                    $argsT = $params['arguments'] ?? [];
                    $result = $this->callTool($name, is_array($argsT) ? $argsT : [], $user);
                    return $this->ok($id, $result);
                default:
                    if ($isNotification) return null;
                    return $this->err($id, -32601, "Method not found: $method");
            }
        } catch (McpToolException $e) {
            return $this->ok($id, [
                'content' => [['type' => 'text', 'text' => $e->getMessage()]],
                'isError' => true,
            ]);
        } catch (\Throwable $e) {
            error_log('[Aquata MCP] ' . $e::class . ': ' . $e->getMessage()
                . ' @ ' . $e->getFile() . ':' . $e->getLine());
            if ($isNotification) return null;
            return $this->err($id, -32603, 'Internal error');
        }
    }

    private function ok($id, mixed $result): array
    {
        return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }

    private function err($id, int $code, string $message): array
    {
        return [
            'jsonrpc' => '2.0',
            'id' => $id,
            'error' => ['code' => $code, 'message' => $message],
        ];
    }

    private function errorEnvelope($id, int $code, string $message): string
    {
        return json_encode($this->err($id, $code, $message), JSON_UNESCAPED_SLASHES);
    }

    private function isBatch(array $m): bool
    {
        return $m !== [] && array_keys($m) === range(0, count($m) - 1);
    }

    private function bearerTokenHash(): ?string
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
        if (!is_string($h) || stripos($h, 'Bearer ') !== 0) return null;
        $token = trim(substr($h, 7));
        return $token === '' ? null : hash('sha256', $token);
    }

    private function isWriteCall(array $req): bool
    {
        if (($req['method'] ?? '') !== 'tools/call') return false;
        $name = $req['params']['name'] ?? '';
        return in_array($name, ['save_diagram', 'create_diagram', 'delete_diagram', 'set_layout'], true);
    }

    /**
     * MCP uses Bearer auth (no cookies), so wildcard CORS is acceptable.
     * Allowlist via MCP_ALLOWED_ORIGINS=* | comma-separated. Default: *.
     */
    private function applyCors(): void
    {
        $allowed = Config::get('MCP_ALLOWED_ORIGINS', '*') ?? '*';
        $origin  = $_SERVER['HTTP_ORIGIN'] ?? '';

        if ($allowed === '*') {
            header('Access-Control-Allow-Origin: *');
            header('Vary: Origin');
        } else {
            $list = array_filter(array_map('trim', explode(',', $allowed)));
            if ($origin !== '' && in_array($origin, $list, true)) {
                header('Access-Control-Allow-Origin: ' . $origin);
                header('Vary: Origin');
            }
        }
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
        header('Access-Control-Max-Age: 600');
    }

    // ── Tool definitions (advertised via tools/list) ────────────────────────

    /**
     * Per-element notes are stored as Mermaid comments, one line per element:
     *
     *     %% <id> <free text>
     *
     * where <id> is a node id or subgraph id. Multi-line notes are encoded
     * inline: literal newline → `\n` (two characters: backslash + n), literal
     * backslash → `\\`. At most one note line per id; the line may appear
     * anywhere in the source. Mermaid ignores `%%` lines, so notes do not
     * affect the rendered diagram. Read these comments to recover authorial
     * intent for a node/subgraph; write/update them by adding or rewriting
     * the matching `%% <id> ...` line.
     */
    private const NOTES_CONVENTION_DOC =
        "Per-element notes are stored as Mermaid comments using the convention `%% <id> <text>` (one line per node/subgraph id). "
        . "Multi-line notes are encoded inline: newline → `\\n` (literal backslash + n), backslash → `\\\\`. "
        . "At most one such line per id; absence = no note. These comments are authored via the Aquata editor's notes panel and convey authorial intent — read them, and preserve/update them when rewriting the source (do not strip `%% <id> ...` lines unless you want to delete the corresponding note).";

    /** @return array<int, array<string, mixed>> */
    private function toolDefinitions(): array
    {
        $notesDoc = self::NOTES_CONVENTION_DOC;
        return [
            [
                'name' => 'list_diagrams',
                'description' => 'List all diagrams visible to the authenticated user (owned + shared). Returns slug, title, owner_id, head_revision_id (the snapshot id the live working copy is based on, null if never saved), updated_at, permission.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => new \stdClass(),
                ],
            ],
            [
                'name' => 'get_diagram',
                'description' => 'Fetch a diagram by slug. Returns source, layout, revision_id, title, lock state. ' . $notesDoc,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => ['slug' => ['type' => 'string']],
                    'required' => ['slug'],
                ],
            ],
            [
                'name' => 'save_diagram',
                'description' => 'Create a new immutable snapshot from the live working copy. expected_version is the snapshot id the working copy is currently based on (null/0 on a never-saved diagram); mismatch returns a conflict error. Auto-acquires the edit lock. The source MUST be a Mermaid flowchart (flowchart/graph TD|LR|TB|BT|RL); other Mermaid diagram types (sequence, class, ER, state, gantt, etc.) are not supported by the editor. Do NOT include style directives, classDef, or per-node fill/stroke/color: visual styling is managed by the user via the editor palette and stored separately. ' . $notesDoc,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'source'           => ['type' => 'string', 'description' => 'Mermaid flowchart source. Plain nodes/edges/subgraphs only — no style/classDef/colors. ' . $notesDoc],
                        'expected_version' => ['type' => 'integer'],
                        'layout'           => ['type' => 'object'],
                        'message'          => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'source', 'expected_version'],
                ],
            ],
            [
                'name' => 'create_diagram',
                'description' => 'Create a new diagram with an initial revision. If slug is omitted it is generated from title. The source MUST be a Mermaid flowchart (flowchart/graph TD|LR|TB|BT|RL); other Mermaid diagram types (sequence, class, ER, state, gantt, etc.) are not supported by the editor. Do NOT include style directives, classDef, or per-node fill/stroke/color: visual styling is managed by the user via the editor palette and stored separately. ' . $notesDoc,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'title'  => ['type' => 'string'],
                        'slug'   => ['type' => 'string'],
                        'source' => ['type' => 'string', 'description' => 'Mermaid flowchart source. Plain nodes/edges/subgraphs only — no style/classDef/colors. ' . $notesDoc],
                        'layout' => ['type' => 'object'],
                    ],
                    'required' => ['title', 'source'],
                ],
            ],
            [
                'name' => 'delete_diagram',
                'description' => 'Soft-delete a diagram (owner only). Restorable via the web admin UI.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => ['slug' => ['type' => 'string']],
                    'required' => ['slug'],
                ],
            ],
            [
                'name' => 'get_layout',
                'description' => 'Return the layout sidecar (positions per node) for a diagram.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => ['slug' => ['type' => 'string']],
                    'required' => ['slug'],
                ],
            ],
            [
                'name' => 'set_layout',
                'description' => 'Update the layout sidecar in-place on the live working copy (no snapshot created). Useful for incremental drag-style updates. expected_version is the snapshot id the working copy is currently based on.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'layout'           => ['type' => 'object'],
                        'expected_version' => ['type' => 'integer'],
                    ],
                    'required' => ['slug', 'layout', 'expected_version'],
                ],
            ],
        ];
    }

    // ── Tool dispatch ───────────────────────────────────────────────────────

    /** Returns the MCP tools/call result envelope: {content: [...], isError?: bool}. */
    private function callTool(string $name, array $args, array $user): array
    {
        switch ($name) {
            case 'list_diagrams':  return $this->toolListDiagrams($user);
            case 'get_diagram':    return $this->toolGetDiagram($args, $user);
            case 'save_diagram':   return $this->toolSaveDiagram($args, $user);
            case 'create_diagram': return $this->toolCreateDiagram($args, $user);
            case 'delete_diagram': return $this->toolDeleteDiagram($args, $user);
            case 'get_layout':     return $this->toolGetLayout($args, $user);
            case 'set_layout':     return $this->toolSetLayout($args, $user);
            default:
                throw new McpToolException("Unknown tool: $name");
        }
    }

    private function structuredResult(array $payload): array
    {
        return [
            'content' => [['type' => 'text', 'text' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)]],
        ];
    }

    private function toolListDiagrams(array $user): array
    {
        $rows = Diagram::listAccessibleForUser((int) $user['id']);
        if ($rows === []) {
            return $this->structuredResult(['diagrams' => []]);
        }
        // Fetch each diagram's #current source_revision_id (the snapshot
        // identifier callers should pass as expected_version on save).
        $ids = array_map(static fn ($r) => (int) $r['id'], $rows);
        $place = implode(',', array_fill(0, count($ids), '?'));
        $stmt = db()->prepare(
            "SELECT diagram_id, source_revision_id FROM diagram_revisions
             WHERE is_current = 1 AND diagram_id IN ($place)"
        );
        $stmt->execute($ids);
        $srcMap = [];
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $r) {
            $srcMap[(int) $r['diagram_id']] = $r['source_revision_id'] !== null
                ? (int) $r['source_revision_id'] : null;
        }
        $out = [];
        foreach ($rows as $d) {
            $out[] = [
                'slug'             => $d['slug'],
                'title'            => $d['title'],
                'owner_id'         => (int) $d['owner_id'],
                'head_revision_id' => $srcMap[(int) $d['id']] ?? null,
                'updated_at'       => $d['updated_at'],
                'permission'       => (int) $d['owner_id'] === (int) $user['id']
                                        ? 'owner'
                                        : ($d['share_permission'] ?? null),
            ];
        }
        return $this->structuredResult(['diagrams' => $out]);
    }

    private function toolGetDiagram(array $args, array $user): array
    {
        $diagram = $this->loadAccessible($args, $user);
        $current = Revision::current((int) $diagram['id']);
        $sourceRevId = $current && $current['source_revision_id'] !== null
            ? (int) $current['source_revision_id'] : null;
        return $this->structuredResult([
            'slug'        => $diagram['slug'],
            'title'       => $diagram['title'],
            'owner_id'    => (int) $diagram['owner_id'],
            'revision_id' => $sourceRevId,
            'parent_id'   => null,
            'source'      => $current ? $current['source'] : null,
            'layout'      => $current && $current['layout'] !== null ? json_decode($current['layout'], true) : null,
            'updated_at'  => $diagram['updated_at'],
            'lock'        => Lock::state($diagram),
        ]);
    }

    private function toolSaveDiagram(array $args, array $user): array
    {
        $slug   = $this->requireString($args, 'slug');
        $source = $this->requireString($args, 'source');
        $expected = $this->requireInt($args, 'expected_version');
        $layout = isset($args['layout']) ? $args['layout'] : null;
        $message = isset($args['message']) ? (string) $args['message'] : null;

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        if (!Lock::tryClaimIfFree((int) $diagram['id'], (int) $user['id'])) {
            throw new McpToolException('locked: another user is currently editing this diagram');
        }

        $layoutJson = $this->encodeLayout($layout);
        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            $payloadBytes = strlen($source) + strlen($layoutJson ?? '');
            Quota::checkCanAddRevision((int) $diagram['id'], $owner, $user, $payloadBytes);
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        try {
            $rev = Revision::snapshotCurrent(
                (int) $diagram['id'],
                $expected,
                $source,
                $layoutJson,
                (int) $user['id'],
                $message
            );
        } catch (RevisionConflict $c) {
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, expected $expected");
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'        => $fresh['slug'],
            'revision_id' => (int) $rev['id'],
            'parent_id'   => $rev['parent_id'] !== null ? (int) $rev['parent_id'] : null,
            'updated_at'  => $fresh['updated_at'],
        ]);
    }

    private function toolCreateDiagram(array $args, array $user): array
    {
        $title  = $this->requireString($args, 'title');
        $source = $this->requireString($args, 'source');
        $layout = isset($args['layout']) ? $args['layout'] : null;

        $layoutJson = $this->encodeLayout($layout);
        try {
            Quota::checkCanCreateDiagram($user);
            Quota::checkBytesForOwner($user, $user, strlen($source) + strlen($layoutJson ?? ''));
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        $custom = $args['slug'] ?? null;
        if (is_string($custom) && $custom !== '') {
            if (!Slug::validate($custom)) {
                throw new McpToolException('invalid slug format');
            }
            if (Diagram::slugExists($custom)) {
                throw new McpToolException("slug already exists: $custom");
            }
            $slug = $custom;
        } else {
            $base = Slug::fromTitle($title);
            $slug = Slug::ensureUnique($base, [Diagram::class, 'slugExists']);
        }

        [$diagram, $rev] = Diagram::createWithFirstRevision(
            $slug, $title, (int) $user['id'], $source, $layoutJson
        );

        return $this->structuredResult([
            'slug'        => $diagram['slug'],
            'title'       => $diagram['title'],
            'revision_id' => (int) $rev['id'],
            'updated_at'  => $diagram['updated_at'],
        ]);
    }

    private function toolDeleteDiagram(array $args, array $user): array
    {
        $diagram = $this->loadAccessible($args, $user);
        $isAdmin = ($user['role'] ?? '') === 'admin';
        if (!$isAdmin && (int) $diagram['owner_id'] !== (int) $user['id']) {
            throw new McpToolException('only the owner can delete this diagram');
        }
        Diagram::softDelete((int) $diagram['id']);
        return $this->structuredResult(['ok' => true, 'slug' => $diagram['slug']]);
    }

    private function toolGetLayout(array $args, array $user): array
    {
        $diagram = $this->loadAccessible($args, $user);
        $current = Revision::current((int) $diagram['id']);
        $layout = $current && $current['layout'] !== null
            ? json_decode($current['layout'], true) : null;
        $sourceRevId = $current && $current['source_revision_id'] !== null
            ? (int) $current['source_revision_id'] : null;
        return $this->structuredResult([
            'slug'        => $diagram['slug'],
            'revision_id' => $sourceRevId,
            'layout'      => $layout,
        ]);
    }

    private function toolSetLayout(array $args, array $user): array
    {
        $slug = $this->requireString($args, 'slug');
        $expected = $this->requireInt($args, 'expected_version');
        if (!array_key_exists('layout', $args)) {
            throw new McpToolException('missing required arg: layout');
        }

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        if (!Lock::tryClaimIfFree((int) $diagram['id'], (int) $user['id'])) {
            throw new McpToolException('locked: another user is currently editing this diagram');
        }

        $layoutJson = $this->encodeLayout($args['layout']);

        $current = Revision::current((int) $diagram['id']);
        $oldBytes = $current
            ? strlen((string) $current['source']) + strlen((string) ($current['layout'] ?? ''))
            : 0;
        $newBytes = ($current ? strlen((string) $current['source']) : 0) + strlen($layoutJson ?? '');

        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            Quota::checkCanReplaceDraft($owner, $user, $oldBytes, $newBytes);
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        try {
            Revision::updateCurrent((int) $diagram['id'], $expected, null, $layoutJson);
        } catch (RevisionConflict $c) {
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, expected $expected");
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'        => $fresh['slug'],
            'revision_id' => $expected,
            'updated_at'  => $fresh['updated_at'],
        ]);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private function loadAccessible(array $args, array $user): array
    {
        $slug = $this->requireString($args, 'slug');
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canAccess($diagram, $user)) {
            throw new McpToolException("Not found: $slug");
        }
        $isAdmin = ($user['role'] ?? '') === 'admin';
        if (Diagram::isDeleted($diagram) && !$isAdmin) {
            throw new McpToolException("Not found: $slug");
        }
        return $diagram;
    }

    private function requireString(array $args, string $key): string
    {
        $v = $args[$key] ?? null;
        if (!is_string($v) || $v === '') {
            throw new McpToolException("missing required arg: $key");
        }
        return $v;
    }

    private function requireInt(array $args, string $key): int
    {
        $v = $args[$key] ?? null;
        if (is_int($v)) return $v;
        if (is_string($v) && ctype_digit($v)) return (int) $v;
        throw new McpToolException("missing or non-integer arg: $key");
    }

    private function encodeLayout(mixed $layout): ?string
    {
        if ($layout === null) return null;
        if (!is_array($layout)) {
            throw new McpToolException('layout must be an object');
        }
        if (array_key_exists('positions', $layout)
            && is_array($layout['positions']) && $layout['positions'] === []) {
            $layout['positions'] = new \stdClass();
        }
        if (array_key_exists('edgeAnchors', $layout)
            && is_array($layout['edgeAnchors']) && $layout['edgeAnchors'] === []) {
            $layout['edgeAnchors'] = new \stdClass();
        }
        if (array_key_exists('edgeBend', $layout)
            && is_array($layout['edgeBend']) && $layout['edgeBend'] === []) {
            $layout['edgeBend'] = new \stdClass();
        }
        $enc = json_encode($layout, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($enc === false || strlen($enc) > 262144) {
            throw new McpToolException('layout is invalid or too large');
        }
        return $enc;
    }
}

final class McpToolException extends \RuntimeException {}
