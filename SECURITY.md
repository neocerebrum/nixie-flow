# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately via [GitHub private vulnerability reporting](https://github.com/neocerebrum/Nixie Flow/security/advisories/new) (Security tab → "Report a vulnerability").

You should receive a response within a few days. Please include reproduction steps and the affected version/commit.

## Scope

Nixie Flow is designed to be exposed on the public internet as a multi-user service. In-scope examples:

- Authentication/session flaws, CSRF, privilege escalation (including the admin read-only oversight model)
- Cross-tenant data access (diagrams, projects, shares)
- MCP endpoint auth bypass or token-scope violations
- Injection of any kind (SQL, XSS via diagram content/notes, header injection in the mailer)
- Rate-limit or quota bypasses with practical impact

Out of scope: vulnerabilities requiring a malicious server administrator, and issues in third-party CDN assets (CodeMirror, Mermaid) without an Nixie Flow-specific exploitation path.

## Supported versions

The latest release / `main` branch.
