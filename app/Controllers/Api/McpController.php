<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Config;
use App\Exceptions\QuotaExceeded;
use App\Exceptions\RevisionConflict;
use App\Models\ApiToken;
use App\Models\Diagram;
use App\Models\EditRequest;
use App\Models\Lock;
use App\Models\Presence;
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
 *   - initialize                  (advertises tools + prompts; returns `instructions`)
 *   - notifications/initialized   (no response — it's a notification)
 *   - ping
 *   - tools/list, tools/call
 *   - prompts/list, prompts/get   → the `ground` prompt (grounding procedure)
 *
 * Tools exposed (mirror the API's verbs but identified by slug instead of internal id):
 *   - list_diagrams                         → owned + shared, excluding deleted
 *   - get_diagram(slug)                     → source + grounding + revision_id (no layout: positions are the editor's concern)
 *   - save_diagram(slug, source, expected_version[, message])  (DEPRECATED → prepare/commit)
 *   - create_diagram(title[, slug, source]) → first revision
 *   - delete_diagram(slug)                  → soft delete (owner only)
 *   - get_layout(slug)                      → just the positions sidecar
 *   - set_layout(slug, layout, expected_version)
 *
 * Grounding gate (notes-as-code-contracts): verdicts live in layout.grounding, bound to
 * the note text by noteHash; a 'verified'/'contradicted' without a matching receipt is rejected.
 *   - prepare_save(slug, source, expected_version) → token + requires_grounding
 *   - commit_save(token, grounding[, message])               → snapshot with grounding
 *   - set_grounding(slug, grounding, expected_version)        → re-verify in-place (no snapshot)
 */
final class McpController
{
    private const PROTOCOL_VERSION = '2024-11-05';
    private const SERVER_NAME      = 'aquata';
    private const SERVER_VERSION   = '0.7.0';

    /**
     * Display label for this request's agent scepter holds — the API-token's
     * human-given name (e.g. "claude", "my-bot"). Set per request in handle().
     */
    private ?string $agentLabel = null;

    /** Sent in the initialize response; primes the client on the grounding contract. */
    private const SERVER_INSTRUCTIONS =
        "Aquata hosts Mermaid diagrams whose per-element notes (`%% [<id>] <text>`) are contracts about code. "
        . "When you change a diagram, preserve and update these notes — they carry authorial intent. "
        . "Before recording a note as 'verified' or 'contradicted', GROUND it against the code: read the code, "
        . "collect {ref, quote} evidence, and check the quote literally. The server never sees your code — it only "
        . "enforces a receipt's form and binds it to the note by noteHash. Use the `ground` prompt for the full "
        . "procedure. To save with verdicts use prepare_save → commit_save; to re-verify an unchanged diagram use "
        . "set_grounding. Plain saves still work via save_diagram. Grey/unverified notes are always free; the gate "
        . "only forbids a 'verified'/'contradicted' without a well-formed, note-bound receipt. "
        . "Editing is turn-based and shared with live human editors: write tools auto-acquire the edit turn (scepter) "
        . "and hold it on a short lease. If someone has the diagram open in the editor, your write registers a polite "
        . "request and returns 'turn held' — the human sees a yield prompt in the editor; retry the same write shortly "
        . "after they yield (or after ~60 s if they step away). When a write result reports \"human_waiting\": true, "
        . "finish up and call release_edit(slug) to yield the turn promptly.";

    /** Body of the `ground` MCP prompt. {{SLUG}} is substituted in prompts/get. */
    private const GROUND_PROMPT = <<<'TXT'
You are grounding the Aquata diagram "{{SLUG}}" against the local code in the CURRENT working directory (cwd = repo root). The diagram's notes (`%% [<id>] <text>`) are contracts about that code; check whether they still tell the truth and record verdicts the server can trust.

Principle: Aquata never sees the code. The server only checks a receipt's FORM and binds it to the note by noteHash. You establish TRUTH here, by a mechanical quote check. A note is not true just because it reads well.

Procedure:
1. Pin the commit: `git -C . rev-parse --short HEAD` → $COMMIT. Sanity-check that cwd is the repo this diagram describes; if it clearly is not, stop and ask the user.
2. Fetch: call get_diagram("{{SLUG}}"). Read EVERY `%% [<id>] <text>` note and any existing `grounding`. Keep the revision_id (it is the expected_version for writes).
3. For each note that makes a claim about code:
   a. Anchor: the files/symbols it names. If the code is unreachable from cwd (a separate repo, an external API), status = "unverified" with an explicit reason — never fake-verify what you cannot see.
   b. Read the anchored code at HEAD.
   c. Verdict: verified | contradicted | unverified | n/a  (n/a = the note makes no verifiable code claim, e.g. a UI preference).
   d. Evidence (required for verified/contradicted): [{ "ref": "path:line[-line]", "quote": "<literal substring of the code>" }]. ref must match ^[A-Za-z0-9._/-]+:[0-9]+(-[0-9]+)?$ .
   e. MECHANICAL CHECK (this is the truth): the quote MUST appear literally at that ref. If it does not, fix the ref/quote or downgrade to "unverified". Never emit a verified that fails this.
   f. noteHash = sha256 of the note text after: decode inline encoding (`\n`→newline, `\\`→backslash), collapse every whitespace run to a single space, then trim. It must equal the server's, or the receipt is rejected.
4. Ghosts (advisory): list repo files/symbols with no node in the diagram. Not a gate — a hint for missing nodes. Distinguish accidental drift from intentional omission (ask if unclear).
5. Writing:
   - Re-verification, source UNCHANGED → set_grounding("{{SLUG}}", expected_version, grounding).
   - You are CHANGING the source → prepare_save("{{SLUG}}", source, expected_version) returns a token + requires_grounding (the new/changed notes); ground those, then commit_save(token, grounding).
   - Report-only (default if the user did not ask to persist): print a table per id (status · ref · one-line reason) plus the ghost list. Do NOT smuggle verdicts into save_diagram.

Grey/unverified is always free. The gate only forbids a "verified"/"contradicted" without a well-formed, note-bound receipt — it never forces you to verify.
TXT;

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
        // The token's label names the agent when it holds the scepter.
        $this->agentLabel = $tokenHash !== null ? ApiToken::labelByHash($tokenHash) : null;

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
                        'capabilities'    => [
                            'tools'   => ['listChanged' => false],
                            'prompts' => ['listChanged' => false],
                        ],
                        'serverInfo'      => [
                            'name'    => self::SERVER_NAME,
                            'version' => self::SERVER_VERSION,
                        ],
                        'instructions'    => self::SERVER_INSTRUCTIONS,
                    ]);
                case 'notifications/initialized':
                case 'notifications/cancelled':
                    return null;
                case 'ping':
                    return $this->ok($id, new \stdClass());
                case 'tools/list':
                    return $this->ok($id, ['tools' => $this->toolDefinitions()]);
                case 'prompts/list':
                    return $this->ok($id, ['prompts' => $this->promptDefinitions()]);
                case 'prompts/get':
                    return $this->ok($id, $this->getPrompt(
                        (string) ($params['name'] ?? ''),
                        is_array($params['arguments'] ?? null) ? $params['arguments'] : []
                    ));
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
        return in_array($name, ['save_diagram', 'create_diagram', 'delete_diagram', 'set_layout', 'prepare_save', 'commit_save', 'set_grounding', 'set_note', 'set_flows'], true);
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
     *     %% [<id>] <free text>
     *
     * where <id> is a node id or subgraph id. The brackets make the note line
     * unambiguous (a `%%` comment whose first token isn't a bracketed id is an
     * ordinary comment, not a note). The legacy bare form `%% <id> <text>` is
     * still recognised for back-compat. The note sits immediately after the
     * element's declaration line. Multi-line notes are encoded inline: literal
     * newline → `\n` (two characters: backslash + n), literal backslash → `\\`.
     * At most one note line per id. Mermaid ignores `%%` lines, so notes do not
     * affect the rendered diagram. Read these comments to recover authorial
     * intent for a node/subgraph; write/update them by adding or rewriting
     * the matching `%% [<id>] ...` line.
     */
    private const NOTES_CONVENTION_DOC =
        "Per-element notes are stored as Mermaid comments using the convention `%% [<id>] <text>` (one line per node/subgraph id, placed right after the element's declaration). "
        . "The legacy bare form `%% <id> <text>` (no brackets) is still recognised for back-compat. "
        . "Multi-line notes are encoded inline: newline → `\\n` (literal backslash + n), backslash → `\\\\`. "
        . "At most one such line per id; absence = no note. These comments are authored via the Aquata editor's notes panel and convey authorial intent — read them, and preserve/update them when rewriting the source (do not strip `%% [<id>] ...` lines unless you want to delete the corresponding note).";

    /** Shape + binding rules for grounding receipts (used by commit_save / set_grounding). */
    private const GROUNDING_DOC =
        "grounding is a map keyed by node/subgraph id; each value is {status: 'verified'|'contradicted'|'unverified'|'n/a', evidence: [{ref, quote}], noteHash, checkedAtCommit, checkedAt, verifier}. "
        . "evidence is required and non-empty for verified/contradicted (each ref must match `^[A-Za-z0-9._/-]+:[0-9]+(-[0-9]+)?$` and quote be a literal code substring); it is ignored/empty for unverified/n/a. "
        . "noteHash = sha256 of the note's text after decoding the inline encoding (\\n→newline, \\\\→backslash), trimming, and collapsing every whitespace run to a single space. "
        . "For verified/contradicted the noteHash MUST equal the hash of that id's note in the source being committed/checked, otherwise the receipt is rejected (a changed note cannot keep a stale 'verified'). unverified/n/a are always accepted. "
        . "The server never sees your code: it only enforces this form and the noteHash binding — the truth of each quote is established client-side.";

    /** prepare_save token lifetime (seconds). */
    private const PREPARE_TTL_SECONDS = 900;

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
                'description' => 'Fetch a diagram by slug. Returns source, revision_id, title, lock state, and the existing grounding verdicts. It deliberately does NOT return the layout sidecar (node positions, styles, palettes): that is the user\'s editor concern, is pure noise for you, and is preserved automatically when you re-save the source — you never read or send it. ' . $notesDoc,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => ['slug' => ['type' => 'string']],
                    'required' => ['slug'],
                ],
            ],
            [
                'name' => 'save_diagram',
                'description' => 'DEPRECATED — prefer prepare_save → commit_save, which records grounding verdicts for the notes you changed (save_diagram writes the source with NO grounding receipts). Still supported for plain saves where grounding is not wanted. Creates a new immutable snapshot from the live working copy. expected_version is the snapshot id the working copy is currently based on (null/0 on a never-saved diagram); mismatch returns a conflict error. Auto-acquires the edit lock. The source MUST be a Mermaid flowchart (flowchart/graph TD|LR|TB|BT|RL); other Mermaid diagram types (sequence, class, ER, state, gantt, etc.) are not supported by the editor. Do NOT include style directives, classDef, or per-node fill/stroke/color: visual styling is managed by the user via the editor palette and stored separately. The layout sidecar (node positions, styles, palettes) is carried over UNCHANGED from the current revision — you do not (and cannot) send it. ' . $notesDoc,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'source'           => ['type' => 'string', 'description' => 'Mermaid flowchart source. Plain nodes/edges/subgraphs only — no style/classDef/colors. ' . $notesDoc],
                        'expected_version' => ['type' => 'integer'],
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
            [
                'name' => 'prepare_save',
                'description' => 'Stage a new source for a GATED save and find out which notes need re-grounding. Returns a short-lived prepare token plus `requires_grounding`: the note ids whose text is new or changed since the current revision — exactly the notes whose truth claims must be re-checked against the code. Ground those notes locally (read the code, collect {ref, quote} evidence at the pinned commit), then call commit_save with the token and the grounding receipts. prepare_save does NOT create a snapshot and changes nothing on the diagram; it only stages the source under a token (TTL ' . self::PREPARE_TTL_SECONDS . 's). The layout sidecar (positions, styles, palettes) is carried over UNCHANGED at commit time — you never send it. Prefer this over save_diagram when you want note verdicts recorded alongside the save. ' . self::NOTES_CONVENTION_DOC,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'source'           => ['type' => 'string', 'description' => 'Mermaid flowchart source. Plain nodes/edges/subgraphs only — no style/classDef/colors. ' . self::NOTES_CONVENTION_DOC],
                        'expected_version' => ['type' => 'integer'],
                    ],
                    'required' => ['slug', 'source', 'expected_version'],
                ],
            ],
            [
                'name' => 'commit_save',
                'description' => 'Finalize a save started with prepare_save. Pass the prepare `token` and a `grounding` map of receipts. The server validates the FORM of each receipt and binds it to the staged source by noteHash, then creates the snapshot (same optimistic-concurrency as save_diagram, re-checked against the staged base) and stores the grounding in the layout. Receipts MERGE onto the existing grounding: notes you omit keep their current verdict, so you only need to send receipts for the notes prepare flagged in `requires_grounding`. The one exception is automatic — a previously verified/contradicted note whose text you changed has its now-stale verdict dropped unless you re-ground it. ' . self::GROUNDING_DOC,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'token'     => ['type' => 'string'],
                        'grounding' => ['type' => 'object'],
                        'message'   => ['type' => 'string'],
                    ],
                    'required' => ['token', 'grounding'],
                ],
            ],
            [
                'name' => 'set_grounding',
                'description' => 'Record or update grounding verdicts for the CURRENT revision WITHOUT changing the source (re-verification against newer code). Pass expected_version and a `grounding` map. Same form + noteHash binding as commit_save, checked against the current source. Updates the layout in-place (no snapshot), like set_layout. Receipts MERGE onto the existing grounding — send only the notes you re-checked; every other note keeps its current verdict (send an explicit `unverified` to clear one). ' . self::GROUNDING_DOC,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'grounding'        => ['type' => 'object'],
                        'expected_version' => ['type' => 'integer'],
                    ],
                    'required' => ['slug', 'grounding', 'expected_version'],
                ],
            ],
            [
                'name' => 'set_note',
                'description' => 'Set (or clear) the note of a SINGLE node/subgraph WITHOUT resending the whole source — the surgical alternative to rewriting the Mermaid just to edit one comment. Pass the element `id` and the new `text` (raw, multi-line allowed: the server applies the inline encoding for you). An empty/omitted `text` removes the note. The id must already be a declared node or subgraph in the diagram. Creates a new snapshot (same optimistic-concurrency as save_diagram; pass expected_version, null/0 if never saved). Because the note IS the code-contract, changing its text invalidates any prior verified/contradicted verdict for that id (its noteHash no longer matches) — the verdict drops to grey/unverified and must be re-grounded via prepare_save → commit_save or set_grounding. This tool can only ever clear a verdict, never set one, so it cannot bypass the grounding gate. ' . self::NOTES_CONVENTION_DOC,
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'id'               => ['type' => 'string', 'description' => 'The node or subgraph id whose note to set.'],
                        'text'             => ['type' => 'string', 'description' => 'New note text (raw, multi-line allowed). Empty or omitted removes the note.'],
                        'expected_version' => ['type' => 'integer'],
                        'message'          => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'id', 'expected_version'],
                ],
            ],
            [
                'name' => 'get_flows',
                'description' => 'Return all named flows defined on a diagram. A flow is an ordered sequence of edges shown to the user as a step-by-step animation. Each edge is represented as "SRC --> TGT" (or "SRC --> TGT (#N)" when N>1 parallel edges exist between the same pair, 1-based). Use this to read human-defined execution paths before generating or updating flows.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => ['slug' => ['type' => 'string']],
                    'required' => ['slug'],
                ],
            ],
            [
                'name' => 'set_flows',
                'description' => 'Create or update named flows on a diagram (upsert by name). A flow is an ordered sequence of edges that the editor animates step-by-step for the user. Each edge is "SRC --> TGT" (or "SRC --> TGT (#N)" for parallel edges, N 1-based). Flows not mentioned in the call are preserved. Pass null as the value to delete a named flow. expected_version is the snapshot id the working copy is currently based on (0 if never saved). Updates the layout in-place; no new snapshot is created.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug'             => ['type' => 'string'],
                        'flows'            => [
                            'type'                 => 'object',
                            'description'          => 'Map of flow name → ordered edge list (or null to delete). E.g. {"happy path": ["A --> B", "B --> C"], "old flow": null}',
                            'additionalProperties' => [
                                'oneOf' => [
                                    ['type' => 'array', 'items' => ['type' => 'string']],
                                    ['type' => 'null'],
                                ],
                            ],
                        ],
                        'expected_version' => ['type' => 'integer'],
                    ],
                    'required' => ['slug', 'flows', 'expected_version'],
                ],
            ],
            [
                'name' => 'release_edit',
                'description' => 'Yield the edit turn (scepter) on a diagram once you are done changing it — the courteous "release" half of the co-editing protocol. The write tools (save_diagram, commit_save, set_note, set_layout, set_grounding) auto-acquire the turn for you and hold it on a short lease; call release_edit when your batch of edits is finished so a human collaborator waiting in the editor gets control immediately instead of waiting for the lease to lapse. Especially do this when a write result reports "human_waiting": true. Idempotent and safe to call even if you do not hold the turn (returns released=false). You do NOT need this for one-off edits on a diagram nobody else is viewing — the lease cleans up on its own — but it is good hygiene whenever you may be co-editing with a person.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => ['slug' => ['type' => 'string']],
                    'required' => ['slug'],
                ],
            ],
        ];
    }

    // ── Prompt definitions (advertised via prompts/list) ────────────────────

    /** @return array<int, array<string, mixed>> */
    private function promptDefinitions(): array
    {
        return [
            [
                'name'        => 'ground',
                'description' => "Verify an Aquata diagram's notes against the local code (run from inside the repo: cwd = repo root) and optionally record the verdicts via set_grounding or prepare_save → commit_save. Notes are contracts about the code; this checks whether they still tell the truth and flags drift, dead code, and missing nodes.",
                'arguments'   => [
                    ['name' => 'slug', 'description' => 'The diagram slug to ground (e.g. bibliomante).', 'required' => true],
                ],
            ],
        ];
    }

    private function getPrompt(string $name, array $arguments): array
    {
        if ($name !== 'ground') {
            throw new McpToolException("Unknown prompt: $name");
        }
        $slug = (isset($arguments['slug']) && is_string($arguments['slug']) && $arguments['slug'] !== '')
            ? $arguments['slug'] : '<slug>';
        $text = str_replace('{{SLUG}}', $slug, self::GROUND_PROMPT);
        return [
            'description' => 'Ground the notes of an Aquata diagram against the local code.',
            'messages'    => [
                ['role' => 'user', 'content' => ['type' => 'text', 'text' => $text]],
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
            case 'prepare_save':   return $this->toolPrepareSave($args, $user);
            case 'commit_save':    return $this->toolCommitSave($args, $user);
            case 'set_grounding':  return $this->toolSetGrounding($args, $user);
            case 'set_note':       return $this->toolSetNote($args, $user);
            case 'get_flows':      return $this->toolGetFlows($args, $user);
            case 'set_flows':      return $this->toolSetFlows($args, $user);
            case 'release_edit':   return $this->toolReleaseEdit($args, $user);
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

    /**
     * Take the edit scepter for this write as a leased, presence-less agent
     * holder — the AI's turn in the co-editing protocol.
     *
     * Protocol:
     *  1. If we already hold the scepter (from a previous write or a yield/transfer
     *     by the human): refresh the lease and proceed immediately.
     *  2. If any human with edit permission currently has the editor open (fresh
     *     presence row), request the turn politely and throw — the caller should
     *     retry shortly, or the human can yield from the editor.
     *  3. If nobody is present: take the scepter freely (prune stale holds first).
     *
     * Rule 2 means the agent always ASKS before editing whenever a human is
     * watching — even when the scepter is nominally free — so no one ends up
     * in read-only without a warning.
     */
    private function acquireTurn(array $diagram, array $user): void
    {
        $did = (int) $diagram['id'];
        $uid = (int) $user['id'];

        // Fast path: we already hold the scepter (our prior agent hold, or one
        // granted via transfer after a human yielded). Just refresh and proceed.
        $current = Diagram::byId($did);
        $currentHolder = isset($current['edit_lock_user']) && $current['edit_lock_user'] !== null
            ? (int) $current['edit_lock_user'] : null;
        if ($currentHolder === $uid) {
            Lock::tryClaimAgent($did, $uid, $this->agentLabel);
            return;
        }

        // If any OTHER human editor (different user_id) currently has the editor
        // open, request the turn politely rather than taking silently. The request
        // surfaces in their editor as the familiar "yield / deny" prompt.
        // The same user's own browser session does NOT block their agent — the
        // agent can take from itself, and the banner informs them.
        if ($this->hasLiveEditViewers($did, $uid)) {
            if (EditRequest::pendingForUser($did, $uid) === null) {
                $note = ($this->agentLabel !== null ? $this->agentLabel . ' (agent)' : 'agent')
                    . ' requests the edit turn';
                EditRequest::create($did, $uid, $note, $this->agentLabel);
            }
            $holderId = $currentHolder;
            $who = 'a collaborator';
            if ($holderId !== null) {
                $h = User::byId($holderId);
                if ($h !== null) {
                    $who = ($h['display_name'] ?? '') !== '' ? $h['display_name']
                         : (($h['email'] ?? '') !== '' ? $h['email'] : 'user ' . $holderId);
                }
            }
            $ctx = $holderId !== null
                ? "$who is currently editing this diagram"
                : "$who has this diagram open";
            throw new McpToolException(
                "turn held: $ctx. Your request for the edit turn has been registered "
                . "— retry shortly, or ask them to yield."
            );
        }

        // No other live human viewers — take the scepter freely (or prune a
        // stale hold first and then take).
        if (Lock::tryClaimAgent($did, $uid, $this->agentLabel)) {
            return;
        }
        Presence::ensureHolder($did);
        if (Lock::tryClaimAgent($did, $uid, $this->agentLabel)) {
            return;
        }

        // Shouldn't normally reach here (another agent in a concurrent race).
        $fresh = Diagram::byId($did);
        $holderId = isset($fresh['edit_lock_user']) && $fresh['edit_lock_user'] !== null
            ? (int) $fresh['edit_lock_user'] : null;
        if ($holderId !== null && $holderId !== $uid && EditRequest::pendingForUser($did, $uid) === null) {
            $note = ($this->agentLabel !== null ? $this->agentLabel . ' (agent)' : 'agent')
                . ' requests the edit turn';
            EditRequest::create($did, $uid, $note);
        }
        $who = 'another agent';
        throw new McpToolException(
            "turn held: $who is currently editing this diagram. Your request has been "
            . "registered — retry shortly."
        );
    }

    /**
     * True if at least one human with edit permission (other than $excludeUserId)
     * currently has the diagram open. View-only viewers are excluded — they can't
     * hold the scepter so the agent taking doesn't affect them.
     * The same user's own browser session ($excludeUserId) is intentionally
     * excluded: a user's agent can take from their own browser session.
     */
    private function hasLiveEditViewers(int $diagramId, int $excludeUserId): bool
    {
        $cutoff = gmdate('Y-m-d H:i:s', time() - Presence::TTL_SECONDS);
        $stmt = db()->prepare(
            "SELECT 1 FROM diagram_viewers v
             INNER JOIN diagrams d ON d.id = v.diagram_id
             WHERE v.diagram_id = ? AND v.last_seen_at >= ? AND v.user_id != ?
               AND (
                 v.user_id = d.owner_id
                 OR EXISTS (
                   SELECT 1 FROM diagram_shares
                   WHERE diagram_id = v.diagram_id AND user_id = v.user_id AND permission = 'edit'
                 )
                 OR EXISTS (
                   SELECT 1 FROM project_shares
                   WHERE project_id = d.project_id AND user_id = v.user_id AND permission = 'edit'
                 )
               )
             LIMIT 1"
        );
        $stmt->execute([$diagramId, $cutoff, $excludeUserId]);
        return $stmt->fetch() !== false;
    }

    /**
     * Hint for the agent after a write: is a human waiting for the turn? If so
     * the agent should finish up and call release_edit so they get it promptly
     * instead of waiting out the hold's lease. Excludes the agent's own user id.
     */
    private function turnHint(int $diagramId, int $userId): array
    {
        $waiting = false;
        foreach (EditRequest::pendingOn($diagramId) as $r) {
            if ((int) ($r['requester_id'] ?? 0) !== $userId) {
                $waiting = true;
                break;
            }
        }
        return ['human_waiting' => $waiting];
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
        // Surface ONLY the grounding verdicts from the layout sidecar; the rest of
        // the layout (positions, styles, palettes) is the editor's concern and noise
        // for an LLM, so we never hand it over. It is preserved untouched on re-save.
        $layout    = $current && $current['layout'] !== null ? json_decode($current['layout'], true) : null;
        $grounding = (is_array($layout) && !empty($layout['grounding']) && is_array($layout['grounding']))
            ? $layout['grounding'] : new \stdClass();
        return $this->structuredResult([
            'slug'        => $diagram['slug'],
            'title'       => $diagram['title'],
            'owner_id'    => (int) $diagram['owner_id'],
            'revision_id' => $sourceRevId,
            'parent_id'   => null,
            'source'      => $current ? $current['source'] : null,
            'grounding'   => $grounding,
            'updated_at'  => $diagram['updated_at'],
            'lock'        => Lock::state($diagram),
        ]);
    }

    private function toolSaveDiagram(array $args, array $user): array
    {
        $slug   = $this->requireString($args, 'slug');
        $source = $this->requireString($args, 'source');
        $expected = $this->requireInt($args, 'expected_version');
        $message = isset($args['message']) ? (string) $args['message'] : null;

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        $this->acquireTurn($diagram, $user);

        // Carry the existing layout (positions/styles/palettes/grounding) over
        // — a source-only save must never wipe the user's arrangement — pruning
        // entries for ids the new source dropped so orphans don't accumulate.
        $layoutJson = $this->carryLayoutJson((int) $diagram['id'], $source);
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
        ] + $this->turnHint((int) $diagram['id'], (int) $user['id']));
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
        // Owner only; admins are not elevated to delete others' diagrams.
        if ((int) $diagram['owner_id'] !== (int) $user['id']) {
            throw new McpToolException('only the owner can delete this diagram');
        }
        Diagram::softDelete((int) $diagram['id']);
        return $this->structuredResult(['ok' => true, 'slug' => $diagram['slug']]);
    }

    /**
     * Yield the edit scepter the agent holds on a diagram — the "release" half
     * of the turn-based protocol. Idempotent: a no-op (released=false) if the
     * agent does not currently hold it. On release, promotes a waiting human (or
     * clears the scepter) immediately rather than waiting for the lease to lapse.
     */
    private function toolReleaseEdit(array $args, array $user): array
    {
        $slug = $this->requireString($args, 'slug');
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found: $slug");
        }
        $released = Lock::releaseIfHeldByAgent((int) $diagram['id'], (int) $user['id']);
        if ($released) {
            Presence::ensureHolder((int) $diagram['id']);
        }
        return $this->structuredResult([
            'slug'     => $diagram['slug'],
            'released' => $released,
        ]);
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

        $this->acquireTurn($diagram, $user);

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

        $base = $expected === 0 ? null : $expected;
        try {
            Revision::updateCurrent((int) $diagram['id'], $base, null, $layoutJson);
        } catch (RevisionConflict $c) {
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, expected $expected");
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'        => $fresh['slug'],
            'revision_id' => $expected,
            'updated_at'  => $fresh['updated_at'],
        ] + $this->turnHint((int) $diagram['id'], (int) $user['id']));
    }

    // ── Grounding gate: prepare_save / commit_save / set_grounding ──────────

    /**
     * Stage a new source under a short-lived token and report which notes are
     * new/changed (and thus need a fresh grounding receipt before they can be
     * marked verified at commit). Creates no snapshot; changes nothing.
     */
    private function toolPrepareSave(array $args, array $user): array
    {
        $slug     = $this->requireString($args, 'slug');
        $source   = $this->requireString($args, 'source');
        $expected = $this->requireInt($args, 'expected_version');
        // 0 means "never saved" (no source_revision_id yet); store as NULL so
        // it matches the nullable optimistic-lock check in snapshotCurrent.
        $base     = $expected === 0 ? null : $expected;

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        // No layout is staged: it is read fresh and preserved at commit time so
        // edits the user makes in the editor between prepare and commit survive.
        $layoutJson = null;

        $current      = Revision::current((int) $diagram['id']);
        $currentNotes = $this->parseNotes($current['source'] ?? '');
        $stagedNotes  = $this->parseNotes($source);
        $requires = [];
        foreach ($stagedNotes as $id => $text) {
            $old = $currentNotes[$id] ?? null;
            if ($old === null || $this->noteHashOf($old) !== $this->noteHashOf($text)) {
                $requires[] = $id;
            }
        }

        $this->purgeExpiredPrepare();
        $token = bin2hex(random_bytes(32));
        $stmt = db()->prepare(
            'INSERT INTO diagram_prepare
               (token, diagram_id, user_id, base_version, staged_source, staged_layout, requires_grounding)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $token,
            (int) $diagram['id'],
            (int) $user['id'],
            $base,
            $source,
            $layoutJson,
            json_encode(array_values($requires), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ]);

        return $this->structuredResult([
            'token'              => $token,
            'slug'               => $diagram['slug'],
            'base_version'       => $base,
            'requires_grounding' => array_values($requires),
            'note_count'         => count($stagedNotes),
            'ttl_seconds'        => self::PREPARE_TTL_SECONDS,
        ]);
    }

    /**
     * Finalize a prepared save: validate the grounding receipts' form, bind
     * verified/contradicted to the staged note text by noteHash, then snapshot.
     */
    private function toolCommitSave(array $args, array $user): array
    {
        $token = $this->requireString($args, 'token');
        if (!array_key_exists('grounding', $args)) {
            throw new McpToolException('missing required arg: grounding');
        }
        $message = isset($args['message']) ? (string) $args['message'] : null;

        $row = $this->loadPrepare($token);
        if ($row === null) {
            throw new McpToolException('invalid prepare token — call prepare_save again');
        }
        if ((int) $row['user_id'] !== (int) $user['id']) {
            throw new McpToolException('prepare token belongs to another user');
        }
        if ($this->prepareIsExpired($row)) {
            $this->deletePrepare($token);
            throw new McpToolException('prepare token expired — call prepare_save again');
        }

        $diagram = Diagram::byId((int) $row['diagram_id']);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            $this->deletePrepare($token);
            throw new McpToolException('diagram no longer writable');
        }

        $source = (string) $row['staged_source'];
        $base   = $row['base_version'] !== null ? (int) $row['base_version'] : null;

        // The gate: form + noteHash binding against the staged source.
        $grounding = $this->validateGrounding($args['grounding'], $source);

        // Carry the user's CURRENT layout (never a stale staged one), prune
        // entries whose ids the staged source dropped, then merge in the fresh
        // grounding — preserves positions/styles, accumulates no orphans.
        $current = Revision::current((int) $diagram['id']);
        $layout  = ($current && $current['layout'] !== null && $current['layout'] !== '')
            ? json_decode((string) $current['layout'], true) : [];
        if (!is_array($layout)) $layout = [];
        $layout = $this->pruneLayout($layout, $source);
        $existing = (isset($layout['grounding']) && is_array($layout['grounding'])) ? $layout['grounding'] : [];
        $merged = $this->mergeGrounding($existing, $grounding, $source);
        $layout['grounding'] = $merged === [] ? new \stdClass() : $merged;
        $layoutJson = $this->encodeLayout($layout);

        $this->acquireTurn($diagram, $user);
        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            $payloadBytes = strlen($source) + strlen($layoutJson ?? '');
            Quota::checkCanAddRevision((int) $diagram['id'], $owner, $user, $payloadBytes);
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        try {
            $rev = Revision::snapshotCurrent(
                (int) $diagram['id'], $base, $source, $layoutJson, (int) $user['id'], $message
            );
        } catch (RevisionConflict $c) {
            // Base moved under us: this staged save is stale. Drop the token.
            $this->deletePrepare($token);
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, staged on $base — re-run prepare_save");
        }

        $this->deletePrepare($token);
        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'        => $fresh['slug'],
            'revision_id' => (int) $rev['id'],
            'parent_id'   => $rev['parent_id'] !== null ? (int) $rev['parent_id'] : null,
            'grounded'    => count($grounding),
            'updated_at'  => $fresh['updated_at'],
        ] + $this->turnHint((int) $diagram['id'], (int) $user['id']));
    }

    /**
     * Record grounding verdicts against the CURRENT source without changing it
     * (re-verification). Updates the layout in-place; no snapshot.
     */
    private function toolSetGrounding(array $args, array $user): array
    {
        $slug     = $this->requireString($args, 'slug');
        $expected = $this->requireInt($args, 'expected_version');
        $base     = $expected === 0 ? null : $expected;
        if (!array_key_exists('grounding', $args)) {
            throw new McpToolException('missing required arg: grounding');
        }

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        $current = Revision::current((int) $diagram['id']);
        if ($current === null) {
            throw new McpToolException('diagram has no current revision');
        }
        $grounding = $this->validateGrounding($args['grounding'], (string) $current['source']);

        $layout = ($current['layout'] !== null && $current['layout'] !== '')
            ? json_decode((string) $current['layout'], true) : [];
        if (!is_array($layout)) $layout = [];
        $existing = (isset($layout['grounding']) && is_array($layout['grounding'])) ? $layout['grounding'] : [];
        $merged = $this->mergeGrounding($existing, $grounding, (string) $current['source']);
        $layout['grounding'] = $merged === [] ? new \stdClass() : $merged;
        $layoutJson = $this->encodeLayout($layout);

        $this->acquireTurn($diagram, $user);
        try {
            $owner    = User::byId((int) $diagram['owner_id']) ?? $user;
            $oldBytes = strlen((string) $current['source']) + strlen((string) ($current['layout'] ?? ''));
            $newBytes = strlen((string) $current['source']) + strlen($layoutJson ?? '');
            Quota::checkCanReplaceDraft($owner, $user, $oldBytes, $newBytes);
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        try {
            Revision::updateCurrent((int) $diagram['id'], $base, null, $layoutJson);
        } catch (RevisionConflict $c) {
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, expected $expected");
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'        => $fresh['slug'],
            'revision_id' => $base,
            'grounded'    => count($grounding),
            'updated_at'  => $fresh['updated_at'],
        ] + $this->turnHint((int) $diagram['id'], (int) $user['id']));
    }

    /**
     * Set or clear the note of one node/subgraph without resending the source.
     * Edits the single `%% [<id>] …` line in the current source and snapshots.
     * A note-text change invalidates that id's verified/contradicted verdict
     * (stale noteHash) → the verdict is dropped to grey; this tool never records
     * a verdict, so it cannot lift a note to green.
     */
    private function toolSetNote(array $args, array $user): array
    {
        $slug     = $this->requireString($args, 'slug');
        $id       = $this->requireString($args, 'id');
        $expected = $this->requireInt($args, 'expected_version');
        // 0 means "never saved": store as NULL to match the nullable lock check.
        $base     = $expected === 0 ? null : $expected;
        $text     = isset($args['text']) ? (string) $args['text'] : '';
        $message  = isset($args['message']) ? (string) $args['message'] : null;

        if (!preg_match('/^[A-Za-z0-9_]+$/', $id)) {
            throw new McpToolException('invalid id: must match [A-Za-z0-9_]+');
        }

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        $current = Revision::current((int) $diagram['id']);
        $source  = (string) ($current['source'] ?? '');
        $lines   = explode("\n", $source);

        // The id must exist in the diagram — either already carrying a note or
        // declared as a node/subgraph. Refuse to attach a note to a phantom id.
        $hasNote = array_key_exists($id, $this->parseNotes($source));
        $hasDecl = $this->findDeclLine($lines, $id) !== null;
        if (!$hasNote && !$hasDecl) {
            throw new McpToolException("no node or subgraph '$id' in this diagram");
        }

        $encoded   = $this->encodeNote($text);   // '' → removes the note
        $newSource = $this->upsertNoteInSource($source, $id, $encoded);

        if ($newSource === $source) {
            // Identical text, or clearing a note that isn't there: nothing to do.
            $sourceRevId = $current && $current['source_revision_id'] !== null
                ? (int) $current['source_revision_id'] : null;
            return $this->structuredResult([
                'slug'                  => $diagram['slug'],
                'revision_id'           => $sourceRevId,
                'changed'               => false,
                'grounding_invalidated' => false,
                'updated_at'            => $diagram['updated_at'],
            ]);
        }

        // Carry the user's layout over the new source, prune orphans, then drop
        // any now-stale verdict (no incoming receipts → mergeGrounding only
        // keeps still-matching verdicts and drops the changed note's verdict).
        $layout = ($current && $current['layout'] !== null && $current['layout'] !== '')
            ? json_decode((string) $current['layout'], true) : [];
        if (!is_array($layout)) $layout = [];
        $layout   = $this->pruneLayout($layout, $newSource);
        $existing = (isset($layout['grounding']) && is_array($layout['grounding'])) ? $layout['grounding'] : [];
        $prevRec  = $existing[$id] ?? null;
        $wasGreen = is_array($prevRec) && in_array($prevRec['status'] ?? '', ['verified', 'contradicted'], true);
        $merged   = $this->mergeGrounding($existing, [], $newSource);
        $invalidated = $wasGreen && !isset($merged[$id]);
        $layout['grounding'] = $merged === [] ? new \stdClass() : $merged;
        $layoutJson = $this->encodeLayout($layout);

        $this->acquireTurn($diagram, $user);
        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            $payloadBytes = strlen($newSource) + strlen($layoutJson ?? '');
            Quota::checkCanAddRevision((int) $diagram['id'], $owner, $user, $payloadBytes);
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        try {
            $rev = Revision::snapshotCurrent(
                (int) $diagram['id'], $base, $newSource, $layoutJson, (int) $user['id'], $message
            );
        } catch (RevisionConflict $c) {
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, expected $expected");
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'                  => $fresh['slug'],
            'revision_id'           => (int) $rev['id'],
            'parent_id'             => $rev['parent_id'] !== null ? (int) $rev['parent_id'] : null,
            'changed'               => true,
            'note_removed'          => $encoded === '',
            'grounding_invalidated' => $invalidated,
            'updated_at'            => $fresh['updated_at'],
        ] + $this->turnHint((int) $diagram['id'], (int) $user['id']));
    }

    // ── Flows ───────────────────────────────────────────────────────────────

    private function toolGetFlows(array $args, array $user): array
    {
        $diagram = $this->loadAccessible($args, $user);
        $current = Revision::current((int) $diagram['id']);
        $layout  = $current && $current['layout'] !== null
            ? json_decode($current['layout'], true) : [];
        $raw = (is_array($layout) && isset($layout['flows']) && is_array($layout['flows']))
            ? $layout['flows'] : [];

        $out = [];
        foreach ($raw as $flow) {
            if (!isset($flow['name']) || !isset($flow['edges']) || !is_array($flow['edges'])) continue;
            $out[$flow['name']] = array_map([$this, 'edgeKeyToString'], $flow['edges']);
        }

        return $this->structuredResult(['slug' => $diagram['slug'], 'flows' => $out]);
    }

    private function toolSetFlows(array $args, array $user): array
    {
        $slug     = $this->requireString($args, 'slug');
        $expected = $this->requireInt($args, 'expected_version');
        if (!array_key_exists('flows', $args) || !is_array($args['flows'])) {
            throw new McpToolException('missing or invalid arg: flows (must be an object)');
        }
        $incoming = $args['flows']; // name → edge-string-list | null

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user) || Diagram::isDeleted($diagram)) {
            throw new McpToolException("Not found or no edit permission: $slug");
        }

        $this->acquireTurn($diagram, $user);

        $current = Revision::current((int) $diagram['id']);
        $layout  = $current && $current['layout'] !== null
            ? json_decode($current['layout'], true) : [];
        if (!is_array($layout)) $layout = [];

        $existing = (isset($layout['flows']) && is_array($layout['flows'])) ? $layout['flows'] : [];

        // Build index by name for easy lookup
        $byName = [];
        foreach ($existing as $f) {
            if (isset($f['name'])) $byName[$f['name']] = $f;
        }

        foreach ($incoming as $name => $edges) {
            if ($edges === null) {
                // Delete
                unset($byName[$name]);
            } else {
                if (!is_array($edges)) {
                    throw new McpToolException("Flow \"$name\": edges must be an array or null");
                }
                $parsed = [];
                foreach ($edges as $i => $str) {
                    if (!is_string($str)) {
                        throw new McpToolException("Flow \"$name\" edge [$i]: must be a string");
                    }
                    $parsed[] = $this->edgeStringToKey($str, $name, $i);
                }
                if (isset($byName[$name])) {
                    $byName[$name]['edges'] = $parsed;
                } else {
                    $id = 'f' . base_convert((string) (time() * 1000 + array_search($name, array_keys($incoming))), 10, 36)
                            . substr(md5($name), 0, 5);
                    $byName[$name] = ['id' => $id, 'name' => $name, 'edges' => $parsed];
                }
            }
        }

        $layout['flows'] = array_values($byName);
        $layoutJson = json_encode($layout, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $oldBytes = $current
            ? strlen((string) $current['source']) + strlen((string) ($current['layout'] ?? ''))
            : 0;
        $newBytes = ($current ? strlen((string) $current['source']) : 0) + strlen($layoutJson);

        try {
            $owner = User::byId((int) $diagram['owner_id']) ?? $user;
            Quota::checkCanReplaceDraft($owner, $user, $oldBytes, $newBytes);
        } catch (QuotaExceeded $q) {
            throw new McpToolException($q->getMessage());
        }

        $base = $expected === 0 ? null : $expected;
        try {
            Revision::updateCurrent((int) $diagram['id'], $base, null, $layoutJson);
        } catch (RevisionConflict $c) {
            throw new McpToolException("conflict: current is now based on revision {$c->currentRevisionId}, expected $expected");
        }

        $fresh = Diagram::byId((int) $diagram['id']);
        return $this->structuredResult([
            'slug'        => $fresh['slug'],
            'revision_id' => $expected,
            'updated_at'  => $fresh['updated_at'],
            'flows_count' => count($layout['flows']),
        ] + $this->turnHint((int) $diagram['id'], (int) $user['id']));
    }

    /** Convert internal edge key "SRC|TGT|ORD" to human string "SRC --> TGT" or "SRC --> TGT (#N)". */
    private function edgeKeyToString(string $key): string
    {
        $parts = explode('|', $key, 3);
        if (count($parts) !== 3) return $key;
        [$src, $tgt, $ord] = $parts;
        $ordinal = (int) $ord;
        return $ordinal === 0
            ? "$src --> $tgt"
            : "$src --> $tgt (#" . ($ordinal + 1) . ")";
    }

    /** Parse "SRC --> TGT" or "SRC --> TGT (#N)" back to internal key "SRC|TGT|ORD". */
    private function edgeStringToKey(string $str, string $flowName, int $idx): string
    {
        // "A --> B (#3)" or "A --> B"
        if (!preg_match('/^(.+?)\s+-->\s+(.+?)(?:\s+\(#(\d+)\))?$/', trim($str), $m)) {
            throw new McpToolException("Flow \"$flowName\" edge [$idx]: cannot parse \"$str\" — expected \"SRC --> TGT\" or \"SRC --> TGT (#N)\"");
        }
        $src = trim($m[1]);
        $tgt = trim($m[2]);
        $ordinal = isset($m[3]) ? (int) $m[3] - 1 : 0;
        if ($ordinal < 0) $ordinal = 0;
        return "$src|$tgt|$ordinal";
    }

    // ── Grounding helpers ───────────────────────────────────────────────────

    /**
     * Extract per-element notes from a Mermaid source. Returns id → raw (still
     * inline-encoded) note text, using the canonical `%% [<id>] <text>` form.
     * @return array<string,string>
     */
    private function parseNotes(string $source): array
    {
        $out = [];
        foreach (preg_split('/\r?\n/', $source) as $line) {
            if (preg_match('/^\s*%%\s*\[([A-Za-z0-9_]+)\]\s*(.*)$/', $line, $m)) {
                $out[$m[1]] = rtrim($m[2]);
            }
        }
        return $out;
    }

    /** Decode inline note encoding: `\n` → newline, `\\` → backslash. */
    private function decodeNote(string $text): string
    {
        return strtr($text, ['\\n' => "\n", '\\\\' => '\\']);
    }

    /** Canonical note text: decode, collapse every whitespace run to one space, trim. */
    private function canonicalizeNote(string $encoded): string
    {
        $decoded = $this->decodeNote($encoded);
        return trim((string) preg_replace('/\s+/u', ' ', $decoded));
    }

    private function noteHashOf(string $encoded): string
    {
        return hash('sha256', $this->canonicalizeNote($encoded));
    }

    // ── Single-note source editing (port of editor.js upsertNoteInSource) ────

    /** Mermaid node-shape bodies, longest-match first. Mirror of editor.js. */
    private const NODE_SHAPE_BODY = <<<'RE'
(?:\[\[[^\]\n]*\]\]|\[\([^)\n]*\)\]|\(\[[^\]\n]*\]\)|\[\/[^\\\n]*\\\]|\[\\[^\/\n]*\/\]|\[\/[^\/\n]*\/\]|\[\\[^\\\n]*\\\]|\[[^\]\n]*\]|\(\(\([^)\n]*\)\)\)|\(\([^)\n]*\)\)|\([^)\n]*\)|\{\{[^}\n]*\}\}|\{[^}\n]*\}|>[^\]\n]*\])
RE;

    /** Encode raw note text for the inline `%% [id] …` form: `\` → `\\`, newline → `\n`. */
    private function encodeNote(string $text): string
    {
        $text = str_replace('\\', '\\\\', $text);
        $text = preg_replace('/\r\n?/', "\n", $text);
        return str_replace("\n", '\\n', $text);
    }

    /**
     * Locate the declaration line of `id` (node decl or subgraph header) so a
     * new note can be placed adjacent to it. Returns ['idx'=>int,'indent'=>str]
     * or null (e.g. an id that only appears on edges).
     * @param array<int,string> $lines
     */
    private function findDeclLine(array $lines, string $id): ?array
    {
        $idEsc      = preg_quote($id, '~');
        $nodeDeclRe = '~^(\s*)' . $idEsc . '\s*' . self::NODE_SHAPE_BODY . '(?:\s*:::\s*\w+)?\s*$~';
        $sgHeaderRe = '~^(\s*)subgraph\s+' . $idEsc . '(?:\s|\[|$)~i';
        foreach ($lines as $i => $line) {
            if (preg_match($nodeDeclRe, $line, $m)) return ['idx' => (int) $i, 'indent' => $m[1]];
            if (preg_match($sgHeaderRe, $line, $m)) return ['idx' => (int) $i, 'indent' => $m[1]];
        }
        // Fallback: id declared only inline on an edge line (e.g. `A[Start] --> B[End]`).
        // Return the first edge line where the id appears as a whole token.
        $edgeRe  = '~(?:-->|---|-.->|==>)~';
        $tokenRe = '~\b' . $idEsc . '\b~';
        foreach ($lines as $i => $line) {
            if (preg_match($edgeRe, $line) && preg_match($tokenRe, $line)) {
                preg_match('~^(\s*)~', $line, $m);
                return ['idx' => (int) $i, 'indent' => $m[1]];
            }
        }
        return null;
    }

    /**
     * Return $source with the note for $id set to $encoded (already inline-
     * encoded), or removed when $encoded is ''. The first canonical `%% [id] …`
     * line is updated in place; a brand-new note is inserted right after the
     * element's declaration (or appended at end for ids with no declaration).
     * Only the bracketed form is matched (the server's notion of a note), so a
     * plain `%% comment` banner is never clobbered.
     */
    private function upsertNoteInSource(string $source, string $id, string $encoded): string
    {
        $lines    = explode("\n", $source);
        $foundIdx = -1;
        $foundIndent = '';
        foreach ($lines as $i => $line) {
            if (preg_match('/^(\s*)%%\s*\[([A-Za-z0-9_]+)\]/', $line, $m) && $m[2] === $id) {
                $foundIdx = (int) $i;
                $foundIndent = $m[1];
                break;
            }
        }
        $isEmpty = ($encoded === '');
        if ($foundIdx !== -1) {
            if ($isEmpty) {
                array_splice($lines, $foundIdx, 1);
                return implode("\n", $lines);
            }
            $lines[$foundIdx] = $foundIndent . '%% [' . $id . '] ' . $encoded;
            return implode("\n", $lines);
        }
        if ($isEmpty) return $source;
        $decl = $this->findDeclLine($lines, $id);
        if ($decl !== null) {
            array_splice($lines, $decl['idx'] + 1, 0, [$decl['indent'] . '%% [' . $id . '] ' . $encoded]);
            return implode("\n", $lines);
        }
        if ($source !== '' && substr($source, -1) !== "\n") $source .= "\n";
        return $source . '%% [' . $id . '] ' . $encoded . "\n";
    }

    /**
     * Validate the FORM of a grounding map and bind verified/contradicted
     * receipts to the note text in $source by noteHash. Returns the normalized
     * grounding (assoc id → record). Throws on the first problem.
     * @return array<string, array<string, mixed>>
     */
    private function validateGrounding(mixed $grounding, string $source): array
    {
        if ($grounding === null) return [];
        if (!is_array($grounding)) {
            throw new McpToolException('grounding must be an object');
        }
        if ($grounding !== [] && array_keys($grounding) === range(0, count($grounding) - 1)) {
            throw new McpToolException('grounding must be an object keyed by node id, not an array');
        }

        $notes   = $this->parseNotes($source);
        $allowed = ['verified', 'contradicted', 'unverified', 'n/a'];
        $refRe   = '/^[A-Za-z0-9._\/-]+:[0-9]+(-[0-9]+)?$/';
        $out = [];

        foreach ($grounding as $id => $rec) {
            if (!is_string($id) || !preg_match('/^[A-Za-z0-9_]+$/', $id)) {
                throw new McpToolException('grounding key is not a valid node id: ' . (is_string($id) ? $id : '(non-string)'));
            }
            if (!is_array($rec)) {
                throw new McpToolException("grounding[$id] must be an object");
            }
            $status = $rec['status'] ?? null;
            $status = is_string($status) ? strtolower($status) : '';
            if ($status === 'na') $status = 'n/a';
            if (!in_array($status, $allowed, true)) {
                throw new McpToolException("grounding[$id].status must be one of verified|contradicted|unverified|n/a");
            }

            $record       = ['status' => $status];
            $needsEvidence = ($status === 'verified' || $status === 'contradicted');

            $evidence = $rec['evidence'] ?? [];
            if (!is_array($evidence)) {
                throw new McpToolException("grounding[$id].evidence must be an array");
            }
            $normEvidence = [];
            foreach ($evidence as $ev) {
                if (!is_array($ev)) {
                    throw new McpToolException("grounding[$id].evidence entries must be objects {ref, quote}");
                }
                $ref   = $ev['ref']   ?? '';
                $quote = $ev['quote'] ?? '';
                if (!is_string($ref) || !preg_match($refRe, $ref)) {
                    throw new McpToolException("grounding[$id].evidence.ref must match <path>:<line[-line]> (got: " . (is_string($ref) ? $ref : '(non-string)') . ')');
                }
                if (!is_string($quote) || $quote === '') {
                    throw new McpToolException("grounding[$id].evidence.quote must be a non-empty string");
                }
                $normEvidence[] = ['ref' => $ref, 'quote' => $quote];
            }
            if ($needsEvidence && $normEvidence === []) {
                throw new McpToolException("grounding[$id]: status '$status' requires at least one {ref, quote} evidence item");
            }
            $record['evidence'] = $normEvidence;

            if ($needsEvidence) {
                $noteHash = $rec['noteHash'] ?? '';
                if (!is_string($noteHash) || !preg_match('/^[a-f0-9]{64}$/', $noteHash)) {
                    throw new McpToolException("grounding[$id].noteHash must be a sha256 hex string for a '$status' verdict");
                }
                if (!isset($notes[$id])) {
                    throw new McpToolException("grounding[$id]: no note found in the source for this id — cannot mark '$status'");
                }
                if (!hash_equals($this->noteHashOf($notes[$id]), $noteHash)) {
                    throw new McpToolException("grounding[$id].noteHash does not match the note being committed (stale verdict? re-ground this note)");
                }
                $record['noteHash'] = $noteHash;
            } elseif (isset($rec['noteHash']) && is_string($rec['noteHash'])) {
                $record['noteHash'] = $rec['noteHash'];
            }

            foreach (['checkedAtCommit', 'checkedAt', 'verifier'] as $k) {
                if (isset($rec[$k]) && is_string($rec[$k]) && $rec[$k] !== '') {
                    $record[$k] = $rec[$k];
                }
            }
            $out[$id] = $record;
        }
        return $out;
    }

    /**
     * Merge freshly-validated receipts onto the existing grounding so a save
     * that only re-grounds the changed notes does NOT wipe the verdicts of the
     * untouched ones. An existing verified/contradicted is carried only while
     * its noteHash still matches the note in $source (a changed note's stale
     * verdict is dropped → grey); unverified/n/a and still-matching verdicts are
     * kept; the incoming receipt wins on conflict.
     *
     * @param array<string,mixed> $existing
     * @param array<string,array<string,mixed>> $incoming  already validated
     * @return array<string,array<string,mixed>>
     */
    private function mergeGrounding(array $existing, array $incoming, string $source): array
    {
        $notes  = $this->parseNotes($source);
        $merged = [];
        foreach ($existing as $id => $rec) {
            if (!is_array($rec) || !isset($notes[(string) $id])) continue;  // note gone — drop
            $status = is_string($rec['status'] ?? null) ? $rec['status'] : '';
            if ($status === 'verified' || $status === 'contradicted') {
                $h = $rec['noteHash'] ?? '';
                if (!is_string($h) || !hash_equals($this->noteHashOf($notes[(string) $id]), $h)) {
                    continue;  // stale: the note text changed since this verdict
                }
            }
            $merged[(string) $id] = $rec;
        }
        foreach ($incoming as $id => $rec) {
            $merged[(string) $id] = $rec;  // fresh verdict wins
        }
        return $merged;
    }

    private function loadPrepare(string $token): ?array
    {
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) return null;
        $stmt = db()->prepare('SELECT * FROM diagram_prepare WHERE token = ?');
        $stmt->execute([$token]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    private function deletePrepare(string $token): void
    {
        $stmt = db()->prepare('DELETE FROM diagram_prepare WHERE token = ?');
        $stmt->execute([$token]);
    }

    private function prepareIsExpired(array $row): bool
    {
        $created = strtotime((string) $row['created_at'] . ' UTC');
        if ($created === false) return false;
        return (time() - $created) > self::PREPARE_TTL_SECONDS;
    }

    private function purgeExpiredPrepare(): void
    {
        $cutoff = gmdate('Y-m-d H:i:s', time() - self::PREPARE_TTL_SECONDS);
        $stmt = db()->prepare('DELETE FROM diagram_prepare WHERE created_at < ?');
        $stmt->execute([$cutoff]);
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

    /**
     * Carry the current working copy's layout onto a new source, used to keep
     * the user's positions/styles/palettes/grounding across a source-only
     * re-save (the LLM surface never sends layout). Entries referencing ids no
     * longer in the source are pruned so orphans don't accumulate; new ids get
     * no entry and fall back to the editor's defaults.
     */
    private function carryLayoutJson(int $diagramId, string $newSource): ?string
    {
        $current = Revision::current($diagramId);
        if (!$current || $current['layout'] === null) return null;
        $layout = json_decode((string) $current['layout'], true);
        if (!is_array($layout)) return (string) $current['layout'];
        return $this->encodeLayout($this->pruneLayout($layout, $newSource));
    }

    /**
     * Drop layout entries whose ids are absent from the source. Conservative by
     * design: an entry is removed only when its id (or, for an edge, one of its
     * endpoints) appears NOWHERE as a token in the source — a live id always
     * appears in its declaration/edge, so this never discards a valid entry.
     */
    private function pruneLayout(array $layout, string $source): array
    {
        preg_match_all('/[A-Za-z0-9_.-]+/', $source, $m);
        $tok = array_fill_keys($m[0], true);
        $idLives   = static fn($id): bool => isset($tok[(string) $id]);
        $edgeLives = static function ($key) use ($tok): bool {
            $p = explode('|', (string) $key);
            if (count($p) < 2) return true;                 // unknown shape — keep
            return isset($tok[$p[0]]) && isset($tok[$p[1]]);
        };

        foreach (['positions', 'nodeStyles', 'subgraphStyles'] as $b) {
            if (isset($layout[$b]) && is_array($layout[$b])) {
                $layout[$b] = array_filter($layout[$b], $idLives, ARRAY_FILTER_USE_KEY);
            }
        }
        foreach (['edgeAnchors', 'edgeBend', 'edgeStyles'] as $b) {
            if (isset($layout[$b]) && is_array($layout[$b])) {
                $layout[$b] = array_filter($layout[$b], $edgeLives, ARRAY_FILTER_USE_KEY);
            }
        }
        foreach (['collapsibleIds', 'collapsedIds', 'lockedIds', 'frameLockedIds'] as $b) {
            if (isset($layout[$b]) && is_array($layout[$b])) {
                $layout[$b] = array_values(array_filter($layout[$b], $idLives));
            }
        }
        if (isset($layout['grounding']) && is_array($layout['grounding'])) {
            $noteIds = $this->parseNotes($source);
            $layout['grounding'] = array_filter(
                $layout['grounding'],
                static fn($id): bool => isset($noteIds[(string) $id]),
                ARRAY_FILTER_USE_KEY
            );
        }
        return $layout;
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
        if (array_key_exists('grounding', $layout)
            && is_array($layout['grounding']) && $layout['grounding'] === []) {
            $layout['grounding'] = new \stdClass();
        }
        $enc = json_encode($layout, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($enc === false || strlen($enc) > 262144) {
            throw new McpToolException('layout is invalid or too large');
        }
        return $enc;
    }
}

final class McpToolException extends \RuntimeException {}
