# Launch plan

Ordered checklist for taking Aquata public. Living document — check items off as they land.

## Phase 0 — Release packaging (done)

- [x] Audit git history for secrets (clean — `.env` / `.deploy-config` never committed)
- [x] AGPL-3.0 `LICENSE`, copyright Lamberto Tedaldi (Neocerebrum.ai)
- [x] Public-facing `README.md` (pitch, features, quick start, MCP setup, license)
- [x] `CONTRIBUTING.md` (English-only, zero-deps constraint, i18n rules, inbound=outbound)
- [x] `SECURITY.md` (GitHub private vulnerability reporting)
- [x] AGPL §13 source link in the app footer (all 9 languages)
- [x] Scrub internal references (Ariel, Plesk-specific framing) from docs, scripts, comments
- [x] Logo: text-to-path, stripped hidden raster (836KB → 13KB), shown in README
- [x] Editor screenshot in README (`docs/assets/editor.png`)

## Phase 1 — Pre-public fixes

- [ ] **Fix the quick start**: `php -S localhost:8080 index.php` does not serve `static/` files.
      Add `scripts/dev_router.php` (serve static files, delegate the rest to `index.php`) and
      update README. Then verify the whole quick start on a clean checkout: clone → `.env` →
      seed admin → login → create diagram → connect MCP token.
- [ ] Translate the pending merge-request i18n keys (currently English-only in some languages — see backlog)
- [ ] Decide initial version (suggest `1.0.0`), add `CHANGELOG.md`, tag the release
- [ ] GitHub repo metadata: description ("Mermaid diagrams as a shared language between humans
      and AI coding agents"), topics (`mermaid`, `mcp`, `diagrams`, `ai-agents`, `php`,
      `self-hosted`, `documentation`), social preview image (logo on dark background)

## Phase 2 — Go public

- [ ] Make the GitHub repo public
- [ ] Enable private vulnerability reporting (Settings → Security) — SECURITY.md points there
- [ ] Enable Discussions (low-friction questions without polluting Issues)
- [ ] Branch protection on `main` (no force-push)
- [ ] Publish the v1.0.0 GitHub Release with readable release notes

## Phase 3 — Documentation (minimum for adoption)

- [ ] `docs/grounding.md` — the grounding protocol spec: per-element notes as contracts,
      receipts `{ref, quote}`, noteHash binding, verdict lifecycle, `prepare_save` →
      `commit_save` / `set_grounding` flow. This is the differentiator; today it lives only
      in the MCP prompt.
- [ ] `docs/getting-started.md` — "your first diagram with Claude Code": create a token,
      register the MCP server, have the agent draw the architecture, ground it, see verdicts
      in the editor.
- [ ] Link both from the README

## Phase 4 — Demo & media (friction killers)

- [ ] 60–90s screen recording (or GIF) for the README: agent edits diagram → appears in
      editor → grounding colors the verdicts. The single most effective asset.
- [ ] Public demo instance: decide policy (open signup on the hosted instance with quotas
      vs. dedicated sandbox). "Try it without installing" multiplies evaluations.

## Phase 5 — Distribution (in firing order)

- [ ] Submit to MCP registries: official MCP registry, mcp.so, Smithery, PulseMCP, Glama
- [ ] PRs to curated lists: awesome-mcp-servers, awesome-claude-code, awesome-selfhosted
      (check each list's acceptance criteria first)
- [ ] Blog article: the real workflow story (reasoning with the agent over a diagram, a
      `contradicted` note catching a regression). Canonical link for everything below.
- [ ] Show HN: "Show HN: Aquata – shared diagrams between you and your coding agent,
      verified against the code". Weekday morning US time; author's first comment tells
      the why. Be present all day to answer.
- [ ] Communities, dosed and honest: r/ClaudeAI, r/selfhosted, Mermaid Discord/discussions
- [ ] X/Twitter thread with the GIF

## Phase 6 — Post-launch

- [ ] Answer issues/questions fast for the first weeks (responsiveness is the best marketing)
- [ ] Collect recurring friction into a public roadmap (GitHub issues + milestones)
- [ ] Re-evaluate SaaS launch (pricing, billing) once there are real users to ask
