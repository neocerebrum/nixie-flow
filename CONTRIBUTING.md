# Contributing to Aquata

Thanks for your interest in contributing!

## Ground rules

- **All code, comments, commit messages and documentation are in English.** Only `lang/*.php` files contain non-English text.
- **No dependencies.** Plain PHP 8.3+, no Composer, no framework, no build step, vanilla JS on the frontend. This is a deliberate constraint — it keeps the app deployable on any LAMP host. PRs introducing package managers or build tooling will not be merged.
- **i18n is mandatory.** Every user-facing string goes through `__()` with a `section.context.name` key, added to **all** files in `lang/` (machine translation is fine for the non-English ones; native review happens later). JS-facing keys are prefixed `js.`.
- **Schema changes** go through `app/Schema.php` (baseline + optional one-shot bridge for existing installations) — never hand-written migration files.

## Workflow

1. Fork, branch from `main`.
2. Make your change. Run `./lint.sh` (PHP syntax check across the tree).
3. For UI changes, include a screenshot in the PR.
4. Keep PRs focused — one concern per PR.

## Code style

Match the surrounding code. Notable conventions:

- PHP: `declare(strict_types=1)`, `final` classes, static helpers over DI containers.
- Templates escape output with `htmlspecialchars` helpers; never echo raw user input.
- Frontend strings come from `window.__i18n` via the `__()` JS helper.
- Icons are inline SVG sprites in `templates/partials/icons.php`, used via `<svg class="icon"><use href="#icon-..."/></svg>`.

## Licensing of contributions

Aquata is licensed under the [GNU AGPL-3.0](LICENSE). By submitting a contribution you agree that it is licensed under the same terms ("inbound = outbound").
