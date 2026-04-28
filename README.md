# Aquata

Mermaid editor + MCP server: essential syntax for LLMs, rich visual layout for humans. Sister project of [Ariel](../Ariel/) (the original single-user local editor).

## Architecture

- **Web editor** (PHP 8.3+): browser UI for human editing, served by Apache + PHP-FPM (Plesk-friendly)
- **MCP HTTP endpoint** (`/mcp`): Streamable HTTP transport, Bearer-token auth, exposes diagrams to Claude Desktop/Code
- **Storage**: SQLite (default) or MySQL/MariaDB, single source of truth
- **Collaboration**: turn-based locking with viewer polling and edit-handover requests
- **History**: immutable revision DAG with branching (no destructive undo)

No Composer, no build step. Everything runs on plain LAMP.

## Workflow

Local machine is for **editing + syntax check only**. The application runs on the remote Plesk server. Deploy is via FTP using `deploy.sh`.

```
local edits → ./lint.sh → ./deploy.sh --all → live on aquata.neoverebrum.work
```

Local SQLite + dev server are not used for normal work; the canonical state lives on the server.

## Requirements

**Local machine** (for syntax check only):
- PHP **8.3+** (`php -l` is enough — no extensions required for linting)

**Remote server** (Plesk on AlmaLinux):
- PHP 8.3+ selected for the (sub)domain in Plesk PHP Settings
- Extensions: `pdo`, `pdo_sqlite` (or `pdo_mysql`), `json`, `mbstring`, `openssl`
- Apache with `mod_rewrite` (Plesk default)
- `data/` directory writable by the PHP-FPM user

## Setup

### Local

```bash
cp .env.example .env                # adjust if needed (defaults are fine)
cp .deploy-config.example .deploy-config   # set FTP_HOST, FTP_USER, FTP_PASS, FTP_REMOTE_DIR
chmod +x deploy.sh lint.sh
./lint.sh                            # validate PHP syntax
```

### First deploy

```bash
./lint.sh && ./deploy.sh --all
```

The DB schema is created automatically on the first request (see `app/Schema.php`).
After deploy, seed the admin user — on the server via SSH, **always use the Plesk per-version PHP binary** (the system `php` on AlmaLinux is too old):

```bash
/opt/plesk/php/8.4/bin/php scripts/seed_admin.php
```

(adjust `8.4` to whatever Plesk has at `/opt/plesk/php/`)

Then open `https://aquata.neocerebrum.work/` — should redirect to `/login`.

### Lockout fallback

If you ever lose the admin password and no other admin can log in, use the CLI escape hatch:

```bash
/opt/plesk/php/8.4/bin/php scripts/reset_password.php admin@example.com
```

### Subsequent deploys

```bash
./lint.sh && ./deploy.sh app/Controllers/UserController.php static/app.js
# or
./lint.sh && ./deploy.sh --all
```

## Project layout

Layout is **flat** because Plesk's FTP user is jailed inside `httpdocs/` (or the subdomain root). Internal directories are protected via `.htaccess`.

```
Aquata/                ← project root (on local; mirrored to httpdocs/ on remote)
├── index.php          ← front controller
├── .htaccess          ← rewrite + deny app/, scripts/, data/, docs/, dotfiles
├── static/            ← CSS, JS, images (publicly served)
├── app/               ← PHP source (denied via .htaccess); app/Schema.php auto-creates the DB
├── scripts/           ← CLI utilities, seed_admin etc. (denied via .htaccess)
├── data/              ← SQLite file (denied via .htaccess; never deployed — server-only)
├── docs/              ← design notes (not deployed)
├── .env               ← config secrets (denied via .htaccess; never deployed — server-managed)
├── .env.example       ← template (not deployed)
├── deploy.sh          ← FTP upload (not deployed)
├── lint.sh            ← syntax check (not deployed)
└── .deploy-config     ← FTP credentials (not deployed; gitignored)
```

Files **never** deployed (excluded by `deploy.sh`): `.env`, `.env.example`, `.deploy-config*`, `deploy.sh`, `lint.sh`, `data/**`, `docs/**`, `*.sqlite*`, `*.log`, `.git/**`, `.gitignore`.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Scaffold — structure, DB schema, bootstrap, health check, deploy pipeline | done |
| 1 | Auth: login/logout/sessions + admin user CRUD + soft-disable | done |
| 2 | Diagram + Revision models, REST API, undo/redo via DAG, soft-delete | done |
| 4 | Editor frontend (port from Ariel `mermaid_editor.{js,html}`) | done |
| 3 | Turn-based locking, edit requests, sharing | pending |
| 5 | MCP HTTP endpoint with Bearer-token auth | pending |
| 6 | One-shot import script from Ariel filesystem `.mmd` files | pending |

See `docs/DESIGN.md` for architectural decisions.
