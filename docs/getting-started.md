# Getting started: your first diagram with an AI agent

This walks you from a fresh Aquata account to a diagram your coding agent draws, you arrange, and the agent grounds against your code. It assumes you have an Aquata instance running (see the [README](../README.md) for setup) and uses [Claude Code](https://claude.com/claude-code) as the agent — any MCP-capable client works the same way.

## 1. Create an account

Open your instance and sign up (or log in). Self-service signup may require email verification depending on the instance config.

## 2. Create an API token

The agent authenticates to Aquata with a bearer token, separate from your browser session.

1. Go to **Profile → API tokens** (`/profile/tokens`).
2. Create a token with a label (e.g. *"claude-code laptop"*).
3. Copy the token shown — it starts with `aqt_` and is displayed **once**. Store it like a password; you can't retrieve it later, only revoke and re-issue.

## 3. Register the MCP server

Point your agent at the Aquata MCP endpoint (`/mcp`), passing the token as a bearer header. For Claude Code:

```bash
claude mcp add --transport http aquata https://your-host/mcp \
  --header "Authorization: Bearer aqt_your_token_here"
```

The token-creation page also shows a ready-to-paste config snippet for clients that take JSON. Verify the connection — the agent should now list Aquata's tools (`list_diagrams`, `get_diagram`, `create_diagram`, `prepare_save`, `commit_save`, `set_grounding`, `set_note`, …) and the `ground` prompt.

## 4. Have the agent draw a diagram

Ask the agent, in plain language, to map something. For example:

> Map the request flow of this service as an Aquata diagram. Use a Mermaid flowchart, give every node a stable id, and add a `%% [id]` note to each one describing what it's responsible for.

The agent calls `create_diagram` with a Mermaid flowchart. A few conventions Aquata expects (the tool descriptions remind the agent of these):

- **Flowcharts only** (`flowchart`/`graph TD|LR|…`). Sequence/class/ER diagrams aren't supported by the editor.
- **No styling in the source** — no `style`, `classDef`, or per-node colours. Visual styling lives in the layout layer, which you control in the editor.
- **Notes carry intent** — `%% [<id>] <text>`, one per node/subgraph. These are the contracts grounding will later verify.

## 5. Open it in the editor

Open the diagram in the browser. This is *your* side of the bridge:

- **Drag** nodes to lay the graph out the way it reads best.
- **Colour** nodes/subgraphs/edges from the contextual palette (double-click a swatch to edit presets, or use the eyedropper).
- **Collapse** a subgraph into a compact capsule to tame a busy area.
- Edit notes in the **notes panel** when you want to refine intent yourself.

None of this touches the Mermaid source the agent sees. Positions, colours and capsule state are stored in the layout sidecar — when the agent re-saves the source, your arrangement is preserved automatically.

## 6. Ground it against the code

This is where the diagram becomes a maintained source of truth. From inside the repo the diagram describes (so the code is reachable), invoke the `ground` prompt:

```
/ground your-diagram-slug
```

The agent will pin the current commit, read each `%% [id]` note, find the code it refers to, and record a verdict — `verified`, `contradicted`, `unverified`, or `n/a` — backed by literal `{ref, quote}` evidence. The verdicts appear in the editor's notes panel, colour-coded, so you can see at a glance which contracts still hold.

See [grounding.md](grounding.md) for the full protocol.

## 7. The loop

From here it's a cycle:

1. You and the agent reason over the diagram instead of only over text.
2. The agent edits the source (`prepare_save` → `commit_save`), preserving and updating notes.
3. You re-arrange and colour for readability in the editor.
4. Re-grounding flags any note the code has drifted away from.

The diagram stays readable for you and clean for the agent, and grounding keeps it honest about the code. That's the whole point of Aquata.

## Troubleshooting

- **Agent can't see the tools** — check the token is valid (not revoked) and the URL ends in `/mcp`. The MCP endpoint speaks JSON-RPC over HTTP with bearer auth; a 401 means the token header is missing or wrong.
- **"locked: another user is editing"** — Aquata uses turn-based locking. The agent auto-acquires the lock on save if it's free; if a human holds it, wait or take the turn in the editor.
- **A save returns a conflict** — the diagram moved since the agent last read it. Re-fetch with `get_diagram` (or re-run `prepare_save`) to get the current `revision_id` and retry.
