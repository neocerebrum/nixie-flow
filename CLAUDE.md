# Aquata

## Deploy

Deploy single files via FTP with `./deploy.sh <file1> [file2 ...]`.
Deploy entire project with `./deploy.sh --all`.

When the user says "deploy", run `./deploy.sh` with the modified files — do NOT commit/push unless explicitly requested.

## i18n

The app is fully internationalized. Supported languages: EN (fallback), IT, FR, DE, ES, PT.

- **Translation files**: `lang/{en,it,fr,de,es,pt}.php` — flat associative arrays with dot-notation keys.
- **PHP helper**: `__(string $key, mixed ...$args)` — global function, uses `sprintf` for interpolation. Available in all templates and controllers.
- **JS helper**: `__(key, ...args)` — defined at the top of `editor.js` and `dashboard.js`. Reads from `window.__i18n` (injected in `<head>` by `layout.php` and `editor.php`).
- **I18n class**: `app/I18n.php` — detection chain: cookie `aquata_lang` → `Accept-Language` header → fallback `en`.
- **Language switcher**: `<select>` in nav bar (authenticated pages), footer links on auth pages. Sets cookie + reloads.
- **Adding a language**: create `lang/xx.php` with all keys, add `'xx'` to `I18n::SUPPORTED`.
- **Key convention**: `section.context.name` (e.g. `login.submit`, `editor.modal.rename.title`, `error.email_invalid`). JS keys are prefixed `js.` in PHP files (prefix stripped when injected into frontend).
- **All code, comments, and documentation must be in English.** Only `lang/*.php` files contain non-English text.
