# Nixie Flow — Design Decisions

Historical snapshot of architectural decisions agreed before implementation. A few details were superseded during implementation (noted inline where relevant) — the code is the source of truth.

## Goals

Turn the original prototype (single-user, local, filesystem `.mmd` files) into a multi-user remote service, accessible by both human editors (browser) and AI agents (MCP HTTP) from any location, all writing to a single source of truth.

## Stack

- **PHP 8.3+**, no Composer, no framework, no build step
- **SQLite** initial; PDO-based driver-agnostic code → switch to MySQL/MariaDB in a few hours
- **Apache + mod_rewrite** → all requests rewritten to `index.php`
- **Frontend**: vanilla JS (ported from the prototype), CodeMirror + mermaid.js loaded from CDN
- **No server-side rendering**: client-only via mermaid.js. Drops the prototype's Playwright dependency entirely.

## Persistence model: revision DAG

Diagrams are not files. Each diagram has a chain of immutable `diagram_revisions`, linked by `parent_id`. The diagram row holds a pointer `head_revision_id` to the current tip.

- **Save** = INSERT new revision with `parent_id = current_head`, then UPDATE `head_revision_id`.
- **Undo** = move `head_revision_id` to `head.parent_id`. Old revision still exists.
- **Redo** = greedy: jump to most recent child of current head. Browser keeps a hint stack for unambiguous redo.
- **Branching** = if user undoes 3 steps then edits, the new revision branches off. The abandoned tip is still reachable; user can name it via `branches` table to preserve it explicitly.
- **No GC initially**. Cheap to keep all revisions; revisit if storage becomes an issue.

Rationale: avoids destructive undo (the prototype kept undo only in browser RAM — lost on reload). Persists across sessions, devices, and users. Enables "blame" and time-travel for free.

## Concurrency model: turn-based lock

At most one editor at a time per diagram. Others poll and view live.

- `diagrams.edit_lock_user` + `edit_lock_at` (heartbeat). Server TTL 90s; client heartbeats every 30s while it holds the lock.
- Viewer polls `GET /api/diagrams/{slug}` every 5s; the response carries `revision_id` and `lock` state, so a single fetch covers both content sync and lock awareness.
- Viewer can request edit handover via `POST /api/diagrams/{slug}/edit-requests` (with optional note). Editor sees an incoming banner with Cedi/Rifiuta. On Cedi: lock releases, request marked `granted`; the requester has a 30s grant window to acquire (banner shows "Prendi il turno").
- Save (`POST /api/diagrams/{slug}`) atomically tries to acquire the lock first; if held by another active user it returns 423 with the lock state. Same applies to undo/redo/checkout. Patch (rename) and delete don't need the lock.
- No real-time collaborative editing (CRDT/OT). If users need that, Nixie Flow is the wrong tool.

Rationale: covers 95% of real workflows (sequential collaboration). Implementable in PHP + polling, no WebSockets needed.

## Sharing

- `diagram_shares (diagram_id, user_id, permission)` where permission is `view` or `edit`.
- Only the owner (or admin) can manage shares: list/add/remove via `/api/diagrams/{slug}/shares`.
- Editor's "Condividi" button + dashboard's per-card "Condividi" both use the same modal (`templates/dashboard.php` for the dashboard variant; `templates/editor.php` for the editor variant). Both call the same backend.
- `Diagram::canAccess` returns true for owner, admin, or any share row; `Diagram::canWrite` requires owner, admin, or share with `permission='edit'`. View-only shared users see the editor in read-only mode (`body.readonly` CSS class disables edit toolbar buttons and source CodeMirror).

## Sharing & access control

- Each diagram has an `owner_id`.
- Sharing via `diagram_shares (diagram_id, user_id, permission)` where permission is `view` or `edit`.
- Owner has all permissions implicitly. `admin` users can see/edit everything.
- MCP requests authenticate with a Bearer token mapped to a `user_id`; the same ACL applies to API calls.

## MCP integration

- **Transport**: HTTP (Streamable, MCP spec). Endpoint: `POST /mcp`. Single PHP handler implementing JSON-RPC 2.0.
- **Auth**: `Authorization: Bearer <token>`. Token plaintext is shown only at creation time; DB stores `sha256(token)` in `api_tokens`.
- **Tools exposed** (initial set):
  - `list_diagrams` — only those visible to the authenticated user
  - `get_diagram(slug)` — returns source + version
  - `save_diagram(slug, source, expected_version)` — optimistic lock; conflict if version mismatch
  - `create_diagram(slug, source)`, `delete_diagram(slug)`
  - `get_layout`, `set_layout` — sidecar JSON for node positions
- **Per-user token UI**: in the webapp, each user can manage tokens (create with label, revoke). On creation, the page shows the plaintext once plus a ready-to-paste Claude config snippet:
  ```json
  { "mcpServers": { "aquata": { "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer aqt_..." } } } }
  ```

## Authentication

- **Sessions** (PHP native, cookie `aquata_sid`) for browser users.
- **Bearer tokens** (`api_tokens` table) for MCP and API integrations.
- **Registration is closed**: only admins create users (admin CRUD UI in Phase 1).
- Passwords stored as `password_hash(PASSWORD_BCRYPT)`. Verification via `password_verify`.

## Web root layout

As designed: expose only `public/`; everything else (`app/`, `data/`, `.env`) lives above docroot and is unreachable via HTTP.

```
public/         ← docroot, contains only index.php + .htaccess + static/
app/            ← code (not web-served)
data/           ← SQLite + uploads (not web-served; writable by PHP-FPM user)
.env            ← secrets (not web-served, even if accidentally moved into public/ the .htaccess denies dotfiles)
```

**Superseded:** the shipped layout is flat (everything in the web root) because jailed FTP hosting cannot place files above the docroot. Internal directories and dotfiles are denied via `.htaccess` instead.

## Decisions explicitly out of scope (for now)

- Real-time CRDT collaborative editing — would require persistent WebSocket process, incompatible with shared PHP-FPM.
- Server-side PNG/SVG rendering — replaced by client-side export (mermaid SVG → canvas → blob).
- Server-side push for live sync — replaced by 2s polling. Acceptable for single-leader edits.
- LDAP/SSO — local password auth only initially.
- File uploads (images, attachments) — diagrams are pure text.

## SQL portability rules

To keep the same schema running on SQLite and MySQL with minimal adaptation:

- Use `INTEGER PRIMARY KEY` (SQLite auto-increments; MySQL needs `INT AUTO_INCREMENT PRIMARY KEY`, adapted at migration time)
- Use `TEXT` for strings (MySQL: `VARCHAR(N)` or `TEXT` — choose at adapt time based on indexed length)
- Use `TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- Avoid SQLite-only: `AUTOINCREMENT` keyword, `||` string concat, `WITHOUT ROWID`
- Avoid MySQL-only: `ENGINE=`, `CHARSET=` clauses (handled at connection time via `charset=utf8mb4`), `ON UPDATE CURRENT_TIMESTAMP` (handled in app code)
- Foreign keys: enabled per-connection (`PRAGMA foreign_keys = ON` for SQLite; default in InnoDB)
- Booleans: store as INTEGER 0/1 (SQLite has no native BOOL; MySQL accepts both)

## Shared hosting quirks

Some shared hosting stacks (observed on a Plesk plan) strip custom HTTP headers (notably `X-CSRF-Token`) from POST requests that have **no body and no Content-Type**. Confirmed during Phase 2 verification: bodyless POSTs to `/api/diagrams/{slug}/undo|redo|restore` failed CSRF, while identical tokens worked when the same request included `Content-Type: application/json` and at minimum `{}` as body.

**Implication for all API clients:**

```js
// always include Content-Type and a body, even if empty
fetch('/api/diagrams/foo/undo', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': token,
  },
  body: JSON.stringify({}),   // never omit
});
```

This applies to the Phase 4 editor JS, the Phase 5 MCP HTTP server, and any future API client. Server-side endpoints already accept (and ignore) extra body fields, so this is purely a client convention.

## Known issues / pending fixes

- **Edge clipping on non-rectangular node shapes** (Phase 4 leftover, deferred): in `static/editor.js`, edges connecting to diamond/hexagon/circle nodes don't terminate cleanly on the actual outline. Current implementation in `findShapeBoundary` + `rayPolygonHit` doesn't visually match the rendered shape. To investigate next: log actual polygon `points` values vs node `transform`, confirm coordinate space assumptions before re-attempting.

## Phase boundaries

Each phase ends with a runnable, testable system. No phase is partial.

- **Phase 0** (done): scaffold + schema + health check
- **Phase 1** (done): login + admin can CRUD users; one admin seeded; logout works
- **Phase 2** (done): diagram CRUD via API; revisions stored; undo/redo endpoints; no editor UI yet (test via curl)
- **Phase 4** (done — done before Phase 3 by user request): full editor UI ported from the prototype, wired to Phase 2 endpoints. Single-user safe; multi-user has 5s polling + conflict modal but no real lock yet.
- **Phase 3** (done): turn-based lock (90s TTL, 30s heartbeat) with acquire/heartbeat/release endpoints; edit-request handover with 30s grant window; per-diagram sharing (view/edit) with owner-managed CRUD; dashboard surfaces both owned and shared diagrams; editor shows lock banner with role-aware actions and incoming-request banner for the editor.
- **Phase 5** (done): `POST /mcp` endpoint (JSON-RPC 2.0, Streamable HTTP transport) with `initialize`, `ping`, `tools/list`, `tools/call`. Bearer-token auth via `Authorization: Bearer aqt_...`; tokens managed under `/profile/tokens` (one-shot plaintext display + ready-to-paste Claude config snippet). Tools: `list_diagrams`, `get_diagram`, `save_diagram`, `create_diagram`, `delete_diagram`, `get_layout`, `set_layout`. All tools share the same ACL as the web (Diagram::canAccess/canWrite) and the same lock model (auto-acquire on save/set_layout, error if held by other user).
- **Phase 6** (done): `scripts/import_mmd.php --source=<dir> --owner=<email>` reads `*.mmd` + `*.mmd.layout.json` and creates Nixie Flow diagrams owned by the given user. Supports `--dry-run`, `--prefix=`, `--overwrite` (append a new revision instead of skipping).
