# Launch plan

Ordered checklist for taking Nixie Flow public. Living document — check items off as they land.

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

- [x] **Fix the quick start**: added `scripts/dev_router.php` (serves `/static/` directly,
      delegates the rest to `index.php`; excluded from deploy), README updated. Verified:
      static 200, `.env` 404, app routes OK.
- [x] Verify the whole quick start on a clean checkout — done on a pristine clone: clone →
      `cp .env.example .env` → seed admin → dev server (static served) → real login (302 →
      dashboard) → create diagram via API (201) → mint token in UI → MCP initialize/tools/list/
      get_diagram round-trips the web-created diagram. One UX wart found & fixed: when the PDO
      driver isn't loaded (e.g. pdo_sqlite on minimal PHP), `Db::connect` now throws an
      actionable message instead of PDO's cryptic "could not find driver".
- [x] Translate the pending merge-request i18n keys — verified: all 9 languages carry the
      full 519-key set (0 missing, 0 extra) and the merge keys are genuinely localized.
- [x] Decide initial version, add `CHANGELOG.md`, tag the release — chose `0.7.0` (mature
      beta; 1.0 reserved until the roadmap + experiments settle). `CHANGELOG.md` added,
      MCP `SERVER_VERSION` aligned to 0.7.0, tagged `v0.7.0`.
- [x] GitHub repo "About" (doable now, while private — the **About** box on the repo home,
      gear icon — NOT Settings). Ready-to-paste:
      - **Description:** `Mermaid diagrams as a shared language between humans and AI coding agents — a self-hostable editor + MCP server with code-grounded, verifiable notes.`
      - **Website:** `https://nixie.neocerebrum.work`
      - **Topics:** `mermaid mcp model-context-protocol ai-agents claude claude-code llm diagrams diagram-editor living-documentation documentation-as-code architecture-diagrams self-hosted php sqlite agpl`
      - (Social preview image moved to Phase 2 — GitHub hides that section on private repos.)

### Security pass (2026-06-11)

Full read-through audit before exposing a public demo. No critical/high code
vulnerabilities found; authz, CSRF, token auth, injection, XSS handling, rate
limiting, lockout and the password-reset/signup flows are all sound. Production
`.env` verified hardened (debug off, `.env` not HTTP-reachable, Secure cookie +
HSTS + CSP live, SMTP working, quotas/limits on); `TRUSTED_PROXIES` empty is
correct here (PHP sees real client IPs). Done:

- [x] `.htaccess`: deny `lang/` and `tmp/` over HTTP (defense in depth)
- [x] Mailer: reject CR/LF in recipient/subject (header-injection guard)

Deferred hardening (none blocking the demo):

- [ ] **Tighten CSP — remove `script-src 'unsafe-inline'`.** Defense-in-depth
      only (no XSS sink exists: Mermaid `htmlLabels:false` + strict, systematic
      `escapeHtml`/`textContent`). Not a quick edit: needs a per-request nonce
      threaded into the 5 inline `<script>` JSON blocks (layout/editor/project)
      AND refactoring 7 inline event handlers (`onclick`/`onsubmit`/`onchange`
      in profile_tokens, nav, admin/users_list, layout) to `addEventListener`.
      Do it on its own branch with UI testing.
- [ ] `APP_FORCE_HTTPS=true` in the production `.env` — optional belt-and-braces
      (HTTPS is already detected, so Secure/HSTS work today).
- [ ] Global account cap / periodic wipe for the public demo — abuse control
      against many self-signups (each up to the 50MB quota). Operational + code.

## Phase 2 — Go public

- [ ] Make the GitHub repo public
- [ ] Set the **social preview** image (Settings → General → Social preview) — this section
      only appears once the repo is public. 1280×640 PNG: logo on a dark background, ideally
      with the editor screenshot faint behind it for scroll-stopping unfurls on X/Slack.
- [ ] Enable private vulnerability reporting (Settings → Security) — SECURITY.md points there
- [ ] Enable Discussions (low-friction questions without polluting Issues)
- [ ] Branch protection on `main` (no force-push)
- [ ] Publish the `v0.7.0` GitHub Release from the existing tag, using the CHANGELOG 0.7.0 entry as the notes

## Phase 3 — Documentation (minimum for adoption)

- [x] `docs/grounding.md` — the grounding protocol spec: per-element notes as contracts,
      receipts `{ref, quote}`, noteHash binding, the verification gate, verdict lifecycle,
      `prepare_save` → `commit_save` / `set_grounding` / `set_note` flows. Written against the
      actual McpController implementation.
- [x] `docs/getting-started.md` — "your first diagram with an AI agent": account → token →
      MCP registration → agent draws → arrange in editor → ground → the loop, plus troubleshooting.
- [x] Link both from the README

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
- [ ] Show HN: "Show HN: Nixie Flow – shared diagrams between you and your coding agent,
      verified against the code". Weekday morning US time; author's first comment tells
      the why. Be present all day to answer.
- [ ] Communities, dosed and honest: r/ClaudeAI, r/selfhosted, Mermaid Discord/discussions
- [ ] X/Twitter thread with the GIF

## Phase 6 — Post-launch

- [ ] Answer issues/questions fast for the first weeks (responsiveness is the best marketing)
- [ ] Collect recurring friction into a public roadmap (GitHub issues + milestones)
- [ ] Re-evaluate SaaS launch (pricing, billing) once there are real users to ask
