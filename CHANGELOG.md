# Changelog

All notable changes to Nixie Flow are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-06-11

First public release. Nixie Flow is feature-complete for day-to-day use; the `0.x`
line reserves `1.0.0` for once the remaining roadmap items and in-flight
experiments have settled.

### Added

- **Visual editor** — selection-driven, Figma-style toolbar; drag positioning;
  per-type custom palettes (nodes/subgraphs/edges) with a contextual swatch row,
  RGB preset editor and eyedropper; collapsible subgraph "capsules"; multi-select;
  zoom-aware selection halo. Vanilla JS, CodeMirror + Mermaid from CDN.
- **MCP server** — Streamable HTTP endpoint (`/mcp`) with Bearer-token auth and
  JSON-RPC 2.0. Tools: `list_diagrams`, `get_diagram`, `create_diagram`,
  `save_diagram`, `delete_diagram`, `get_layout`, `set_layout`, `set_note`, plus
  the grounding flow (`prepare_save`, `commit_save`, `set_grounding`) and the
  canonical `ground` prompt.
- **Grounding protocol** — per-element notes (`%% [id] text`) as verifiable
  contracts about the code: verdicts (`verified`/`contradicted`/`unverified`/`n/a`)
  backed by `{ref, quote}` evidence and bound to the note text by `noteHash`, so a
  changed note voids a stale verdict. The server enforces a receipt's form and
  binding; truth is established client-side. See [`docs/grounding.md`](docs/grounding.md).
- **Two-layer model** — the Mermaid source is the semantic layer (clean for an
  LLM); positions, colours, palettes and capsule state live in a separate layout
  sidecar (readable for humans). Agents never receive or pollute the layout.
- **Revision history** — immutable revision DAG: undo/redo across sessions and
  devices, branching, no destructive operations.
- **Collaboration** — turn-based edit locking with live viewers and presence,
  edit-handover requests, per-diagram and per-project sharing (view/edit), merge
  requests, and projects (folders).
- **Multi-user / SaaS-ready** — self-service signup with email verification,
  per-user quotas, rate limiting, login lockout, and security headers (CSP, HSTS).
- **Internationalization** — 9 languages: English, Italian, French, German,
  Spanish, Portuguese, Chinese, Japanese, Korean.
- **Deployment** — plain PHP 8.3+, no Composer, no build step. SQLite by default,
  MySQL/MariaDB supported. Self-bootstrapping schema; FTP deploy helper for jailed
  shared hosting.
- **Documentation** — README, getting-started guide (covering both the
  document-existing-code and design-first workflows), grounding spec, design notes,
  CONTRIBUTING and SECURITY.

### Security

- Pre-public security pass: parameterized queries throughout, CSRF on all
  state-changing routes, centralized owner/share authorization (admin = read
  oversight only), systematic output escaping, bearer tokens stored as sha256.
- `.htaccess` denies `lang/` and `tmp/` over HTTP; the mailer rejects CR/LF in
  recipient/subject (header-injection guard).

[Unreleased]: https://github.com/neocerebrum/Nixie Flow/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/neocerebrum/Nixie Flow/releases/tag/v0.7.0
