/* Aquata editor — ported from Ariel mermaid_editor with adaptations.
 *
 * Differences from Ariel:
 *  - No filesystem paths: a single diagram identified by `state.slug`
 *  - Source + layout saved atomically via POST /api/diagrams/{slug}
 *  - Optimistic locking via expected_revision_id; 409 → conflict modal
 *  - In-RAM undo/redo (per-action, ported from Ariel) — DB revision created only on Save
 *  - SSE replaced by 5s polling (visibility-aware)
 *  - All POST/PATCH/DELETE always send Content-Type + body (Plesk header-stripping quirk)
 *  - History modal + checkout endpoint
 */

(function () {
  "use strict";

  /* ─────────────────────────────────────────────────────────────────────
   * SECTION MAP  (line numbers approximate — search the `// ── <name>` banner)
   *
   *     85  Constants
   *    127  Color math (hex ↔ rgb ↔ hsl, luminance)
   *    270  DOM refs
   *    313  State
   *    439  Phase 3: collaboration state
   *    457  API helper (Plesk quirk: always send body + CT)
   *    487  Validity / parse status
   *    595  CodeMirror wrapper
   *    653  Undo / Redo
   *    719  Export
   *    777  Render
   *    873  Index / SVG helpers
   *    971  Visual styles & painting
   *   1111  Translate helpers & saved positions
   *   1277  Shape geometry & anchors
   *   1574  Arrow markers, bends & edge routing
   *   1840  Collapse/expand buttons
   *   2124  Collapsed-state rendering
   *   2499  Edge hotspots & bend handles
   *   2874  Cluster bounds & viewbox
   *   3053  Drag handlers
   *   3456  Label editing
   *   3954  Align / Distribute selected nodes
   *   4113  Notes (per-element comments)
   *   4277  Add/delete node/edge
   *   5021  Edge/node delete actions
   *   5161  Connect mode (ghost edge)
   *   5262  Move-to-subgraph: pick a target subgraph (or root) for the current
   *   5356  Pan / zoom
   *   5822  Selection / palette
   *   6123  Contextual palette row
   *   6201  Preset editor modal
   *   6340  Eyedropper
   *   6471  Shape change
   *   6521  Add Node modal
   *   6697  Save (atomic POST + optimistic locking)
   *   6699  Autosave (PATCH /draft)
   *   6832  Reload (discard local)
   *   6878  Polling for remote changes
   *   6917  UI: history modal
   *   7009  UI: rename modal
   *   7045  UI: conflict modal
   *   7075  UI: remote update banner
   *   7102  UI: toast
   *   7118  Phase 3: presence + scepter + edit-request + share
   *   7317  Selection broadcast (presence side-channel)
   *   7770  Share modal
   *   7842  Wiring
   *   7932  Side-panel prefs (localStorage)
   *   8147  Init
   * ───────────────────────────────────────────────────────────────────── */

  const _t = window.__i18n || {};
  function __(key, ...args) {
    let s = _t[key] !== undefined ? _t[key] : key;
    if (args.length) { let i = 0; s = s.replace(/%[sd]/g, () => args[i++] ?? ""); }
    return s;
  }

  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });

  // ── Constants ───────────────────────────────────────────────────────────

  const SHAPES = [
    { key: "rect",       name: __("editor.shape.rect"),      open: "[",   close: "]"   },
    { key: "rounded",    name: __("editor.shape.rounded"),   open: "(",   close: ")"   },
    { key: "stadium",    name: __("editor.shape.stadium"),   open: "([",  close: "])"  },
    { key: "subroutine", name: "Subroutine",                 open: "[[",  close: "]]"  },
    { key: "cylinder",   name: __("editor.shape.cylinder"),  open: "[(",  close: ")]"  },
    { key: "circle",     name: __("editor.shape.circle"),    open: "((",  close: "))"  },
    { key: "diamond",    name: __("editor.shape.diamond"),   open: "{",   close: "}"   },
    { key: "hexagon",    name: __("editor.shape.hexagon"),   open: "{{",  close: "}}"  },
  ];

  const SHAPE_PREVIEWS = {
    rect:       `<rect x="2" y="6" width="36" height="16" rx="0" fill="currentColor"/>`,
    rounded:    `<rect x="2" y="6" width="36" height="16" rx="5" fill="currentColor"/>`,
    stadium:    `<rect x="2" y="6" width="36" height="16" rx="8" fill="currentColor"/>`,
    subroutine: `<rect x="2" y="6" width="36" height="16" fill="currentColor"/>
                 <line x1="5" y1="6" x2="5" y2="22" stroke="#0f1419" stroke-width="1.5"/>
                 <line x1="35" y1="6" x2="35" y2="22" stroke="#0f1419" stroke-width="1.5"/>`,
    cylinder:   `<ellipse cx="20" cy="8" rx="14" ry="2.5" fill="currentColor"/>
                 <rect x="6" y="8" width="28" height="12" fill="currentColor"/>
                 <ellipse cx="20" cy="20" rx="14" ry="2.5" fill="currentColor"/>`,
    circle:     `<circle cx="20" cy="14" r="10" fill="currentColor"/>`,
    diamond:    `<polygon points="20,4 34,14 20,24 6,14" fill="currentColor"/>`,
    hexagon:    `<polygon points="10,6 30,6 36,14 30,22 10,22 4,14" fill="currentColor"/>`,
  };

  // Pastel base palette (the node defaults). The subgraph and edge default
  // palettes are derived from this one slot-by-slot via HSL transforms so the
  // three palettes stay aligned by slot/name (see DEFAULT_PALETTES below).
  const PALETTE_BASE = [
    { name: "blue",   fill: "#5e81ac", stroke: "#3b5371", color: "#eceff4" },
    { name: "cyan",   fill: "#88c0d0", stroke: "#5b8898", color: "#2e3440" },
    { name: "green",  fill: "#a3be8c", stroke: "#738a5f", color: "#2e3440" },
    { name: "yellow", fill: "#ebcb8b", stroke: "#b79855", color: "#2e3440" },
    { name: "orange", fill: "#d08770", stroke: "#9a5540", color: "#2e3440" },
    { name: "red",    fill: "#bf616a", stroke: "#8e3b44", color: "#eceff4" },
    { name: "purple", fill: "#b48ead", stroke: "#815b7e", color: "#eceff4" },
  ];
  const PALETTE_NAMES = PALETTE_BASE.map((p) => p.name);

  // ── Color math (hex ↔ rgb ↔ hsl, luminance) ───────────────────────────────
  function hexToRgb(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    if (!Number.isFinite(n) || h.length !== 6) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function rgbToHex({ r, g, b }) {
    const h = (v) => clamp255(v).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }
  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h, s, l };
  }
  function hslToRgb({ h, s, l }) {
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
  }
  function rgbToHsv({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: (max === 0 ? 0 : d / max) * 100, v: max * 100 };
  }
  function hsvToRgb({ h, s, v }) {
    h = ((h % 360) + 360) % 360; s /= 100; v /= 100;
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }
  function relLuminance({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  // Pick a legible label color (dark Nord vs light Nord) for a given fill.
  function textOn(fillHex) {
    return relLuminance(hexToRgb(fillHex)) > 0.45 ? "#2e3440" : "#eceff4";
  }
  // Shift saturation/lightness of a hex color in HSL space (deltas, clamped).
  function shiftHsl(hex, dS, dL) {
    const hsl = rgbToHsl(hexToRgb(hex));
    hsl.s = Math.max(0, Math.min(1, hsl.s + dS));
    hsl.l = Math.max(0, Math.min(1, hsl.l + dL));
    return rgbToHex(hslToRgb(hsl));
  }
  // Parse a CSS color (hex or rgb()/rgba()) to a hex string; null if unknown.
  function cssColorToHex(css) {
    if (!css) return null;
    const s = String(css).trim();
    if (s === "none" || s === "transparent") return null;
    if (s[0] === "#") return rgbToHex(hexToRgb(s));
    const m = s.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
    if (m) return rgbToHex({ r: +m[1], g: +m[2], b: +m[3] });
    return null;
  }

  // Default palettes, one per object group. Nodes = pastel base; subgraphs =
  // same hues but darker; edges = same hues but more saturated/brilliant
  // (edges have no fill — only the line stroke + label color matter).
  const DEFAULT_PALETTES = {
    nodes: PALETTE_BASE.map((p) => ({ fill: p.fill, stroke: p.stroke, color: p.color })),
    subgraphs: PALETTE_BASE.map((p) => {
      const fill = shiftHsl(p.fill, 0.02, -0.28);
      return { fill, stroke: shiftHsl(p.stroke, 0.02, -0.20), color: textOn(fill) };
    }),
    edges: PALETTE_BASE.map((p) => {
      const vivid = shiftHsl(p.fill, 0.30, 0.04);
      return { stroke: vivid, color: vivid };
    }),
  };
  const PALETTE_GROUPS = ["nodes", "subgraphs", "edges"];
  // Channel layout per group, for the preset editor modal (property → i18n key).
  const PALETTE_CHANNELS = {
    nodes:     [["fill", "background"], ["stroke", "border"], ["color", "text"]],
    subgraphs: [["fill", "background"], ["stroke", "border"], ["color", "text"]],
    edges:     [["stroke", "line"], ["color", "label"]],
  };

  // Normalize a stored palettes object: must have all three groups as arrays of
  // the right length; otherwise fall back to the defaults for that group.
  function normalizePalettes(raw) {
    const out = {};
    for (const g of PALETTE_GROUPS) {
      const arr = raw && Array.isArray(raw[g]) ? raw[g] : null;
      if (arr && arr.length === PALETTE_BASE.length
          && arr.every((p) => p && typeof p === "object")) {
        out[g] = arr.map((p, i) => {
          const def = DEFAULT_PALETTES[g][i];
          const merged = {};
          for (const [prop] of PALETTE_CHANNELS[g]) {
            merged[prop] = cssColorToHex(p[prop]) || def[prop];
          }
          return merged;
        });
      } else {
        out[g] = DEFAULT_PALETTES[g].map((p) => Object.assign({}, p));
      }
    }
    return out;
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const reloadBtn = document.getElementById("reloadBtn");
  const resetBtn = document.getElementById("resetBtn");
  const addNodeBtn = document.getElementById("addNodeBtn");
  const addEdgeBtn = document.getElementById("addEdgeBtn");
  const addSubgraphBtn = document.getElementById("addSubgraphBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const toggleEdgeStyleBtn = document.getElementById("toggleEdgeStyleBtn");
  const cycleEdgeArrowBtn = document.getElementById("cycleEdgeArrowBtn");
  const reverseEdgeBtn = document.getElementById("reverseEdgeBtn");
  const alignVBtn = document.getElementById("alignVBtn");
  const alignHBtn = document.getElementById("alignHBtn");
  const distributeHBtn = document.getElementById("distributeHBtn");
  const distributeVBtn = document.getElementById("distributeVBtn");
  const moveToSubgraphBtn = document.getElementById("moveToSubgraphBtn");
  const exportBtn = document.getElementById("exportBtn");
  const saveBtn = document.getElementById("saveBtn");
  const fitBtn = document.getElementById("fitBtn");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const historyBtn = document.getElementById("historyBtn");
  const renameBtn = document.getElementById("renameBtn");
  const exportSvgBtn = document.getElementById("exportSvgBtn");
  const exportPngBtn = document.getElementById("exportPngBtn");
  const statusEl = document.getElementById("status");
  const dirtyBadge = document.getElementById("dirtyBadge");
  const titleEl = document.getElementById("diagramTitle");
  const diagramEl = document.getElementById("diagram");
  const colorPaletteEl = document.getElementById("colorPalette");
  const shapePaletteEl = document.getElementById("shapePalette");
  const sourceEditor = document.getElementById("sourceEditor");
  const parseStatusEl = document.getElementById("parseStatus");
  const sourcePanel = document.getElementById("sourcePanel");
  const togglePanelBtn = document.getElementById("togglePanelBtn");
  const resizer = document.getElementById("resizer");
  const resizerRight = document.getElementById("resizerRight");
  const notesPanel = document.getElementById("notesPanel");
  const notesTextarea = document.getElementById("notesTextarea");
  const notesEmpty = document.getElementById("notesEmpty");
  const notesTargetLabel = document.getElementById("notesTargetLabel");
  const toggleNotesPanelBtn = document.getElementById("toggleNotesPanelBtn");

  // ── State ────────────────────────────────────────────────────────────────

  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

  // Per-tab id, persisted in sessionStorage so the same tab keeps its id across
  // soft reloads (Cmd+R) but each new tab gets a fresh one. Used by the server
  // to track which of the user's tabs is currently the "active" one — only
  // that tab is allowed to issue writes.
  const TAB_ID = (() => {
    const KEY = "aquata_tab_id";
    let v = null;
    try { v = sessionStorage.getItem(KEY); } catch (_) {}
    if (!v) {
      v = (crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "")
                                        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { sessionStorage.setItem(KEY, v); } catch (_) {}
    }
    return v;
  })();

  // bootstrap data injected by EditorController
  const bootstrap = JSON.parse(document.getElementById("bootstrap-data").textContent);

  let currentSource = bootstrap.source || "";
  // Normalize to plain object: PHP json_decode($x, true) of "{}" gives [] which
  // JSON.stringify silently strips when we add custom keys to it.
  let positions = (bootstrap.layout && bootstrap.layout.positions) || {};
  if (Array.isArray(positions)) positions = {};
  // edgeAnchors: { "src|tgt|ord": { source?: "n"|"ne"|..., target?: ... } }
  // Purely cosmetic — pins which compass hotspot an edge endpoint uses
  // instead of the auto ray-intersection. Lives only in the layout layer.
  let edgeAnchors = (bootstrap.layout && bootstrap.layout.edgeAnchors) || {};
  if (Array.isArray(edgeAnchors)) edgeAnchors = {};
  // edgeBend: { "src|tgt|ord": { t, n } } — single user-defined control point.
  // Stored in chord-relative coords so the curve "follows" the endpoints when
  // nodes move: t∈[0,1] is the parameter along the src→tgt chord, n is the
  // signed perpendicular offset in SVG world units. n=0 ⇒ straight line.
  let edgeBend = (bootstrap.layout && bootstrap.layout.edgeBend) || {};
  if (Array.isArray(edgeBend)) edgeBend = {};
  // Per-element visual styles stored outside the Mermaid source.
  //   nodeStyles[id]      = { fill, stroke, color }   — node fill/border/label
  //   subgraphStyles[id]  = { fill, stroke, color }   — cluster fill/border/label
  //   edgeStyles["s|t|o"] = { stroke, color }         — edge line/label color
  // Keys are extracted from any `style …` directives on load (see
  // extractInlineStylesFromSource) and applied to the SVG post-render.
  let nodeStyles     = (bootstrap.layout && bootstrap.layout.nodeStyles)     || {};
  if (Array.isArray(nodeStyles)) nodeStyles = {};
  let subgraphStyles = (bootstrap.layout && bootstrap.layout.subgraphStyles) || {};
  if (Array.isArray(subgraphStyles)) subgraphStyles = {};
  let edgeStyles     = (bootstrap.layout && bootstrap.layout.edgeStyles)     || {};
  if (Array.isArray(edgeStyles)) edgeStyles = {};
  // Custom color palettes (one per object group), diagram-wide. Stored in the
  // layout JSON so they travel with the diagram to shared collaborators.
  // Editing a preset never recolors existing elements (their concrete colors
  // live in nodeStyles/subgraphStyles/edgeStyles) — it only changes future
  // clicks. See normalizePalettes / DEFAULT_PALETTES.
  let palettes = normalizePalettes(bootstrap.layout && bootstrap.layout.palettes);
  // Collapsible subgraphs (human-side only — never encoded in the Mermaid
  // source). `collapsibleIds` = subgraphs the user marked as collapsible;
  // `collapsedIds` ⊆ collapsibleIds = those currently shown collapsed. Both are
  // persisted in the layout JSON as arrays (Sets don't JSON-serialize) so the
  // collapse state is remembered across reloads and travels to collaborators.
  // `collapseDisplace` is transient (never persisted): per just-expanded id it
  // records how far each surrounding node was pushed to "make space", so a
  // later collapse can reverse it exactly. The saved `positions` always hold
  // the collapsed-baseline layout — expansion displacement is recomputed.
  let collapsibleIds = new Set((bootstrap.layout && bootstrap.layout.collapsibleIds) || []);
  let collapsedIds   = new Set((bootstrap.layout && bootstrap.layout.collapsedIds) || []);
  let collapseDisplace = {};
  // Promote legacy quadratic bends to cubic on initial load (idempotent).
  // `migrateAllBends` is a function declaration so it's hoisted within this IIFE.
  migrateAllBends();
  // Migrate inline `style …` directives out of the Mermaid source into the
  // layout layer. Idempotent — diagrams already clean are unaffected.
  // Persistence happens on the next save/autosave; we don't mark dirty here
  // because that would surface "unsaved changes" the instant a diagram opens.
  extractInlineStylesFromSource();

  // Single shape for everything sent to the save / draft / beacon endpoints.
  function buildLayoutPayload() {
    return {
      version: 1,
      positions, edgeAnchors, edgeBend,
      nodeStyles, subgraphStyles, edgeStyles,
      palettes,
      collapsibleIds: [...collapsibleIds],
      collapsedIds: [...collapsedIds],
    };
  }
  let currentRevisionId = bootstrap.revision_id;
  let currentTitle = bootstrap.title;
  const slug = bootstrap.slug;

  let nodeMap = {};
  let clusterMap = {};
  let edges = [];
  let dirtySource = false;
  let dirtyLayout = false;
  let connectingState = null;
  let _skipNextDiagramClick = false;
  let connectSource = null;
  let selectedNodeIds = new Set(); // multi-select via Shift/Ctrl/Cmd+click
  let selectedClusterIds = new Set(); // multi-select via Shift/Ctrl/Cmd+click; can coexist with selectedNodeIds (mixed selection)
  let selectedEdgeKeys = new Set(); // multi-select via Shift/Ctrl/Cmd+click; entries: "<src>|<tgt>|<ordinal>"
  let initialViewBox = null;
  let viewState = null;
  let skipSourceSync = false;
  let textareaRenderTimer = null;
  let sourceCM = null;
  let suppressChange = false;
  const HISTORY_CAP = 80;
  let history = [];
  let historyPtr = -1;
  let lastParseValid = true;
  let saveInProgress = false;
  let _ghostCleanup = null;
  let pendingRemoteRevisionId = null; // set by polling when remote diverged & we're dirty

  // Autosave (PATCH /draft) — coalesces rapid changes and updates head row in-place.
  let typingTimer = null;
  let draftFlushInFlight = false;
  let draftFlushPending = false;
  let lastDraftFlushAt = null;       // timestamp ms of last successful autosave
  let lastUpdatedAt = bootstrap.updated_at || null; // server-side diagrams.updated_at
  const autosaveBadgeEl = document.getElementById("autosaveBadge");

  // ── Phase 3: collaboration state ─────────────────────────────────────────
  const me = bootstrap.me || { id: null, email: null, display_name: null };
  const permission = bootstrap.permission; // 'owner' | 'edit' | 'view' | null
  const canWrite   = (permission === "owner" || permission === "edit");
  let lockState = bootstrap.lock || { user_id: null, since: null, is_active: false, expires_at: null };
  let myEditRequest = null;       // {id, status, ...} when I have one pending
  let pendingIncomingReqs = [];   // requests waiting for me to accept/decline
  let heartbeatTimer = null;
  let requestPollTimer = null;
  let isReadOnly = false;         // becomes true when lock is held by another user (or perm===view)

  const lockBannerEl   = document.getElementById("lockBanner");
  const lockMessageEl  = document.getElementById("lockMessage");
  const lockActionsEl  = document.getElementById("lockActions");
  const lockViewersEl  = document.getElementById("lockViewers");
  const incomingReqEl  = document.getElementById("incomingRequestBanner");
  const shareBtn       = document.getElementById("shareBtn");

  // ── API helper (Plesk quirk: always send body + CT) ──────────────────────

  async function api(method, path, body) {
    const isReadOnly = method === "GET" || method === "HEAD";
    const init = {
      method,
      headers: {
        "X-CSRF-Token": csrfToken,
        "X-Tab-Id": TAB_ID,
      },
    };
    if (!isReadOnly) {
      // POST/PATCH/DELETE: always send Content-Type + body (even {})
      // — Plesk strips custom headers when both are absent.
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body || {});
    }
    // Spec forbids body on GET/HEAD; some browsers (Firefox) reject the call.
    const r = await fetch(path, init);
    if (r.status === 401) {
      location.href = "/login";
      throw new Error("auth");
    }
    let json = null;
    if (r.status !== 204) {
      try { json = await r.json(); } catch (_) { json = null; }
    }
    return { status: r.status, json };
  }

  // ── Validity / parse status ──────────────────────────────────────────────

  function setSourceValidity(valid, errorMsg) {
    const wasInvalid = !lastParseValid;
    lastParseValid = valid;
    document.body.classList.toggle("source-invalid", !valid);
    if (valid) {
      setParseStatus("ok", null);
      if (wasInvalid && statusEl.className === "error") setStatus("");
    } else {
      setParseStatus("error", errorMsg || __("editor.err.source_invalid"));
    }
  }

  function requireValidSource(actionName) {
    if (!lastParseValid) {
      setStatus(__("editor.status.invalid_source", actionName), true);
      return false;
    }
    return true;
  }

  function setParseStatus(kind, message) {
    if (kind === "ok") {
      parseStatusEl.className = "ok";
      parseStatusEl.textContent = __("editor.valid");
      parseStatusEl.title = "";
    } else if (kind === "error") {
      parseStatusEl.className = "error";
      const short = (message || "").split("\n")[0].slice(0, 80);
      parseStatusEl.textContent = "✗ " + short;
      parseStatusEl.title = message || "";
    } else {
      parseStatusEl.className = "";
      parseStatusEl.textContent = "";
      parseStatusEl.title = "";
    }
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "error" : "";
  }

  // Promise-based replacement for window.confirm: in-app modal so the browser
  // can't silently block repeated dialogs. Resolves to true (OK) or false
  // (Cancel / Escape / backdrop click).
  let _confirmDialogResolve = null;
  function confirmDialog(message, opts) {
    opts = opts || {};
    const titleEl   = document.getElementById("confirmDialogTitle");
    const messageEl = document.getElementById("confirmDialogMessage");
    const okBtn     = document.getElementById("confirmDialogOkBtn");
    const cancelBtn = document.getElementById("confirmDialogCancelBtn");
    const modal     = document.getElementById("confirmDialogModal");
    titleEl.textContent   = opts.title || __("common.confirm");
    messageEl.textContent = message;
    okBtn.textContent     = opts.confirmLabel || __("common.confirm");
    cancelBtn.textContent = opts.cancelLabel || __("common.cancel");
    okBtn.classList.toggle("danger", !!opts.danger);
    okBtn.classList.toggle("primary", !opts.danger);
    modal.classList.remove("hidden");
    setTimeout(() => okBtn.focus(), 0);
    return new Promise(resolve => { _confirmDialogResolve = resolve; });
  }
  function _confirmDialogClose(result) {
    document.getElementById("confirmDialogModal").classList.add("hidden");
    const r = _confirmDialogResolve;
    _confirmDialogResolve = null;
    if (r) r(result);
  }

  function updateDirtyBadge() {
    dirtyBadge.classList.toggle("hidden", !(dirtySource || dirtyLayout));
  }

  let _typingFromCM = false;

  function markDirtySource() {
    dirtySource = true; updateDirtyBadge();
    if (_typingFromCM) autosaveAfterTyping();
    else autosaveAfterAction();
  }
  function markDirtyLayout() {
    dirtyLayout = true; updateDirtyBadge();
    autosaveAfterAction();
  }
  function clearDirty() {
    dirtySource = false; dirtyLayout = false;
    updateDirtyBadge();
    if (typeof updateAutosaveBadge === "function") updateAutosaveBadge();
  }
  function autosaveAfterAction() {
    // Discrete macro-action just finished — flush ASAP if there's anything to save.
    // (typeof guard so this can be called before flushDraft is parsed.)
    if (typeof flushDraft === "function" && (dirtySource || dirtyLayout)) {
      flushDraft({ immediate: true });
    }
  }
  function autosaveAfterTyping() {
    // CodeMirror change → debounce 2.5s.
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingTimer = null;
      if (dirtySource || dirtyLayout) flushDraft({ immediate: true });
    }, 2500);
  }

  // ── CodeMirror wrapper ───────────────────────────────────────────────────

  function getSourceValue() { return sourceCM ? sourceCM.getValue() : sourceEditor.value; }
  function setSourceValue(v) {
    if (sourceCM) {
      suppressChange = true;
      const cursor = sourceCM.getCursor();
      sourceCM.setValue(v);
      try { sourceCM.setCursor(cursor); } catch (_) {}
      suppressChange = false;
    } else {
      sourceEditor.value = v;
    }
  }

  function initSourceEditor() {
    if (typeof CodeMirror === "undefined") return;
    if (CodeMirror.defineSimpleMode) {
      CodeMirror.defineSimpleMode("mermaid", {
        start: [
          { regex: /%%.*/, token: "comment" },
          { regex: /^(\s*)(flowchart|graph|subgraph|end|style|linkStyle|classDef|click|direction)\b/i,
            token: [null, "keyword"] },
          { regex: /(-->|-\.-|-\.->|==>|--x|--o|---)/, token: "operator" },
          { regex: /\|[^|\n]*\|/, token: "string" },
          { regex: /\[\[[^\]\n]*\]\]|\{\{[^\}\n]*\}\}|\(\([^\)\n]*\)\)|\[\([^\)\n]*\)\]|\(\[[^\]\n]*\]\)/, token: "atom" },
          { regex: /\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}/, token: "atom" },
          { regex: /#[0-9a-fA-F]{3,8}\b/, token: "number" },
        ],
      });
    }
    sourceCM = CodeMirror.fromTextArea(sourceEditor, {
      lineNumbers: true,
      mode: "mermaid",
      matchBrackets: true,
      tabSize: 4,
      indentWithTabs: false,
      extraKeys: {
        "Ctrl-S": () => { save(); return false; },
        "Cmd-S":  () => { save(); return false; },
        "Ctrl-Z": () => { undo(); return false; },
        "Cmd-Z":  () => { undo(); return false; },
        "Ctrl-Shift-Z": () => { redo(); return false; },
        "Cmd-Shift-Z":  () => { redo(); return false; },
        "Ctrl-Y": () => { redo(); return false; },
      },
    });
    sourceCM.on("change", () => {
      if (suppressChange) return;
      currentSource = sourceCM.getValue();
      _typingFromCM = true;
      try { markDirtySource(); } finally { _typingFromCM = false; }
      scheduleTextareaRender();
    });
    sourceCM.setSize("100%", "100%");
    setTimeout(() => sourceCM && sourceCM.refresh(), 0);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────

  function pushHistory() {
    history = history.slice(0, historyPtr + 1);
    history.push({
      source: currentSource,
      positions: JSON.parse(JSON.stringify(positions)),
      edgeAnchors: JSON.parse(JSON.stringify(edgeAnchors)),
      edgeBend: JSON.parse(JSON.stringify(edgeBend)),
      nodeStyles: JSON.parse(JSON.stringify(nodeStyles)),
      subgraphStyles: JSON.parse(JSON.stringify(subgraphStyles)),
      edgeStyles: JSON.parse(JSON.stringify(edgeStyles)),
      palettes: JSON.parse(JSON.stringify(palettes)),
      collapsibleIds: [...collapsibleIds],
      collapsedIds: [...collapsedIds],
    });
    if (history.length > HISTORY_CAP) {
      history = history.slice(history.length - HISTORY_CAP);
    }
    historyPtr = history.length - 1;
    updateUndoRedoBtns();
  }

  function updateUndoRedoBtns() {
    undoBtn.disabled = historyPtr <= 0;
    redoBtn.disabled = historyPtr >= history.length - 1;
  }

  async function applyHistorySnapshot() {
    const snap = history[historyPtr];
    if (!snap) return;
    currentSource = snap.source;
    positions = JSON.parse(JSON.stringify(snap.positions));
    edgeAnchors = JSON.parse(JSON.stringify(snap.edgeAnchors || {}));
    edgeBend = JSON.parse(JSON.stringify(snap.edgeBend || {}));
    nodeStyles = JSON.parse(JSON.stringify(snap.nodeStyles || {}));
    subgraphStyles = JSON.parse(JSON.stringify(snap.subgraphStyles || {}));
    edgeStyles = JSON.parse(JSON.stringify(snap.edgeStyles || {}));
    collapsibleIds = new Set(snap.collapsibleIds || []);
    collapsedIds = new Set(snap.collapsedIds || []);
    palettes = normalizePalettes(snap.palettes);
    currentPaletteGroup = null; // force swatch rebuild — colors may have changed
    renderActivePalette();
    migrateAllBends();
    markDirtySource(); markDirtyLayout();
    try {
      await renderDiagram();
    } catch (e) {
      setSourceValidity(false, e.message || String(e));
      setSourceValue(currentSource);
    }
  }

  async function undo() {
    if (historyPtr <= 0) return;
    historyPtr--;
    updateUndoRedoBtns();
    await applyHistorySnapshot();
  }
  async function redo() {
    if (historyPtr >= history.length - 1) return;
    historyPtr++;
    updateUndoRedoBtns();
    await applyHistorySnapshot();
  }

  // ── Export ──────────────────────────────────────────────────────────────

  function serializeSvg() {
    const svgEl = diagramEl.querySelector("svg");
    if (!svgEl) return null;
    const clone = svgEl.cloneNode(true);
    clone.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportSvg() {
    const str = serializeSvg();
    if (!str) { setStatus(__("editor.status.no_diagram"), true); return; }
    downloadBlob(new Blob([str], { type: "image/svg+xml;charset=utf-8" }), `${slug}.svg`);
    setStatus(__("editor.status.exported", `${slug}.svg`));
  }

  async function exportPng() {
    const str = serializeSvg();
    if (!str) { setStatus(__("editor.status.no_diagram"), true); return; }
    const svgEl = diagramEl.querySelector("svg");
    const vb = svgEl.viewBox.baseVal;
    const w = Math.max(1, Math.round(vb.width));
    const h = Math.max(1, Math.round(vb.height));
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1e2530";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.decoding = "sync";
    const blob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally { URL.revokeObjectURL(url); }
    canvas.toBlob(b => { downloadBlob(b, `${slug}.png`); setStatus(__("editor.status.exported", `${slug}.png`)); }, "image/png");
  }

  function exportSource() {
    if (!currentSource) return;
    const blob = new Blob([currentSource], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${slug}.mmd`);
    setStatus(__("editor.status.exported", `${slug}.mmd`));
  }

  // ── Render ──────────────────────────────────────────────────────────────

  async function renderDiagram() {
    const parsed = await mermaid.parse(currentSource);
    if (parsed === false) throw new Error(__("editor.err.source_invalid"));
    const { svg } = await mermaid.render("mmd-out", currentSource);
    diagramEl.innerHTML = svg;
    const svgEl = diagramEl.querySelector("svg");
    svgEl.removeAttribute("style");
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

    indexNodesAndEdges(svgEl);
    reorderClustersByContainment(svgEl);
    offsetArrowMarkers(svgEl);
    applyVisualStyles(svgEl);
    applyCollapsibleClasses(svgEl);
    applySavedPositions();
    applyExpansionSpacing();
    updateAllClusterBounds();
    applyCollapsedState(svgEl);
    // Second pass: expanded ancestors re-fit around any now-shrunk nested boxes
    // (the guard in updateClusterBounds leaves collapsed boxes at their fixed
    // size). Harmless single no-op cost when nothing is collapsed.
    if (collapsedIds.size > 0) updateAllClusterBounds();
    rerouteAllEdges();
    raiseExpandedEntities(svgEl);
    recomputeViewBoxFromNodes(svgEl);
    attachDragHandlers(svgEl);
    attachClusterHandlers(svgEl);
    attachLabelEditors();
    attachEdgeClickHandlers();
    setupPanZoom(svgEl);
    // Re-apply selection visuals after re-render (DOM was rebuilt).
    for (const id of [...selectedNodeIds]) {
      if (nodeMap[id]) nodeMap[id].g.classList.add("selected");
      else selectedNodeIds.delete(id);
    }
    for (const cid of [...selectedClusterIds]) {
      if (clusterMap[cid]) clusterMap[cid].g.classList.add("selected");
      else selectedClusterIds.delete(cid);
    }
    for (const key of [...selectedEdgeKeys]) {
      const e = findEdgeByKey(key);
      if (e) e.path.classList.add("selected");
      else selectedEdgeKeys.delete(key);
    }
    updateToolbarState();
    applyNoteTooltips();
    renderCollapseButtons();
    // SVG was rebuilt — repaint peer-selection overlay so external selections
    // stay visible across remote-poll reloads.
    if (typeof renderPeerSelections === "function") renderPeerSelections();
    if (!skipSourceSync) setSourceValue(currentSource);
    setSourceValidity(true);
  }

  // Set/replace/remove a native SVG <title> child on an element so hovering
  // shows the text as a browser-native tooltip after the usual hover delay.
  function setNoteTitle(g, text) {
    if (!g) return;
    let existing = g.querySelector(":scope > title");
    if (!text) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElementNS("http://www.w3.org/2000/svg", "title");
      g.insertBefore(existing, g.firstChild);
    }
    existing.textContent = text;
  }

  // Set a native SVG <title> child on each node/cluster that has a note.
  function applyNoteTooltips() {
    for (const id of Object.keys(nodeMap)) {
      const enc = findNoteForId(currentSource, id);
      setNoteTitle(nodeMap[id].g, enc ? decodeNote(enc) : null);
    }
    for (const id of Object.keys(clusterMap)) {
      const enc = findNoteForId(currentSource, id);
      setNoteTitle(clusterMap[id].g, enc ? decodeNote(enc) : null);
    }
  }

  // Refresh just one element's tooltip live (no diagram re-render) — used after
  // a note edit, which deliberately skips re-rendering. For a collapsed capsule
  // the hover is owned by the collapse-hit rect on the overlay, so rebuild the
  // overlay too (renderCollapseButtons re-reads the note onto the hit rect).
  function refreshNoteTooltip(id) {
    const enc = findNoteForId(currentSource, id);
    const text = enc ? decodeNote(enc) : null;
    const ref = (nodeMap[id] && nodeMap[id].g) || (clusterMap[id] && clusterMap[id].g);
    setNoteTitle(ref, text);
    if (clusterMap[id] && collapsedIds.has(id)) renderCollapseButtons();
  }

  async function safeRenderFromTextarea() {
    skipSourceSync = true;
    try { await renderDiagram(); }
    catch (e) { setSourceValidity(false, e.message || String(e)); }
    finally { skipSourceSync = false; }
  }

  function scheduleTextareaRender() {
    if (textareaRenderTimer) clearTimeout(textareaRenderTimer);
    textareaRenderTimer = setTimeout(safeRenderFromTextarea, 300);
  }

  // ── Index / SVG helpers ──────────────────────────────────────────────────

  function indexNodesAndEdges(svgEl) {
    nodeMap = {}; edges = []; clusterMap = {};
    const nodes = svgEl.querySelectorAll("g.node");
    for (const g of nodes) {
      const id = extractNodeId(g);
      if (!id) continue;
      const bbox = g.getBBox();
      // centerLocal = visual center of the shape in g-local coords. For Mermaid
      // rect shapes this is (0,0); for polygons (diamond, hexagon) the bbox can
      // be offset and we need the true centroid for correct edge clipping.
      const centerLocal = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
      nodeMap[id] = {
        g,
        centerLocal,
        halfW: bbox.width / 2,
        halfH: bbox.height / 2,
        shape: detectSvgShape(g),
        incomingEdges: [],
        outgoingEdges: [],
      };
    }
    // Clusters indexed AFTER nodes so findSubgraphMembers can resolve IDs.
    // Pass 1: collect g/bg/label/members/directChildren for every cluster.
    const clusters = svgEl.querySelectorAll("g.cluster");
    for (const g of clusters) {
      const id = extractNodeId(g);
      if (!id) continue;
      let bg = null;
      for (const child of g.children) {
        const tag = child.tagName.toLowerCase();
        if (tag === "rect" || tag === "polygon" || tag === "path") { bg = child; break; }
      }
      const label = g.querySelector(":scope > g.cluster-label, :scope > g.label");
      const members = findSubgraphMembers(currentSource, id);
      const direct = findSubgraphDirectChildren(currentSource, id);
      clusterMap[id] = {
        g, bg, label, members,
        directNodes: direct.nodes,
        directSubgraphs: direct.subgraphs,
        padding: null,
        incomingEdges: [], outgoingEdges: [],
      };
    }
    // Pass 2: compute padding using direct-children bbox (nodes ∪ inner
    // cluster rects). Sub-cluster bgs are now visible in the SVG so their
    // world bboxes resolve correctly via clusterMap.
    for (const id of Object.keys(clusterMap)) {
      const c = clusterMap[id];
      if (!c.bg || c.bg.tagName.toLowerCase() !== "rect") continue;
      const ct = getNodeTranslate(c.g);
      const rx = parseFloat(c.bg.getAttribute("x")) || 0;
      const ry = parseFloat(c.bg.getAttribute("y")) || 0;
      const rw = parseFloat(c.bg.getAttribute("width")) || 0;
      const rh = parseFloat(c.bg.getAttribute("height")) || 0;
      const wx1 = ct.x + rx, wy1 = ct.y + ry;
      const wx2 = wx1 + rw, wy2 = wy1 + rh;
      const mb = computeClusterDirectChildrenBbox(id);
      if (mb) {
        // Normalize padding instead of inheriting Mermaid's auto-layout values
        // — those vary with title length and content layout, producing
        // asymmetric and unpredictable margins that shift around when nodes
        // are added/removed. Fixed values give the cluster a stable look.
        // The top band is widened to make room for the subgraph title.
        let labelH = 0;
        if (c.label) {
          try { labelH = c.label.getBBox().height || 0; } catch (_) { labelH = 0; }
        }
        const SIDE = 16;
        const TOP = labelH > 0 ? Math.round(labelH + 14) : SIDE;
        c.padding = { left: SIDE, top: TOP, right: SIDE, bottom: SIDE, rx, ry };
      }
    }
    const paths = svgEl.querySelectorAll("g.edgePaths path, g.edges path");
    const labelGroups = Array.from(svgEl.querySelectorAll("g.edgeLabels > g"));
    let edgeIdx = 0;
    const ordinalCounter = {};
    for (const p of paths) {
      const cls = p.getAttribute("class") || "";
      const ls = cls.match(/LS-(\S+)/);
      const le = cls.match(/LE-(\S+)/);
      if (!ls || !le) { edgeIdx++; continue; }
      const source = ls[1], target = le[1];
      const label = labelGroups[edgeIdx] || null;
      const key = `${source}${target}`;
      const ordinal = ordinalCounter[key] || 0;
      ordinalCounter[key] = ordinal + 1;
      const edge = { path: p, source, target, label, ordinal };
      edges.push(edge);
      if (nodeMap[source]) nodeMap[source].outgoingEdges.push(edge);
      if (nodeMap[target]) nodeMap[target].incomingEdges.push(edge);
      if (clusterMap[source]) clusterMap[source].outgoingEdges.push(edge);
      if (clusterMap[target]) clusterMap[target].incomingEdges.push(edge);
      edgeIdx++;
    }
  }

  // ── Visual styles & painting ────────────────────────────────────────────

  // Apply user-defined fills/strokes/text colors stored in the layout layer
  // (nodeStyles / subgraphStyles / edgeStyles). These directives used to live
  // inline as `style …` / `linkStyle …` lines inside the Mermaid source; we
  // now keep them out of the source so it stays clean for LLM consumers and
  // re-apply them post-render here. CSS `!important` selection styles in
  // editor.css still win over the inline styles set below.
  function applyVisualStyles(svgEl) {
    for (const id of Object.keys(nodeStyles)) {
      const n = nodeMap[id];
      if (!n) continue;
      paintShape(n.g, nodeStyles[id]);
    }
    for (const id of Object.keys(subgraphStyles)) {
      const c = clusterMap[id];
      if (!c) continue;
      if (c.bg) paintEl(c.bg, subgraphStyles[id]);
      if (c.label) paintLabelText(c.label, subgraphStyles[id]);
    }
    for (const e of edges) {
      const props = edgeStyles[edgeKey(e)];
      if (!props) continue;
      if (props.stroke) e.path.style.stroke = props.stroke;
      if (props.color && e.label) paintLabelText(e.label, props);
    }
  }

  // Tag collapsible/collapsed clusters with CSS classes so they read as a
  // distinct object class (a dashed accent outline while expanded, a node-like
  // box once collapsed). Pure marking — hiding members / shrinking the box is
  // done later in applyCollapsedState. Stale ids (subgraph removed via source
  // edits) are pruned so the buckets don't accumulate orphans.
  function applyCollapsibleClasses(svgEl) {
    let pruned = false;
    for (const id of [...collapsibleIds]) {
      if (!clusterMap[id]) { collapsibleIds.delete(id); collapsedIds.delete(id); pruned = true; }
    }
    for (const id of [...collapsedIds]) {
      if (!collapsibleIds.has(id)) { collapsedIds.delete(id); pruned = true; }
    }
    if (pruned) markDirtyLayout();
    for (const id of Object.keys(clusterMap)) {
      const c = clusterMap[id];
      if (!c || !c.g) continue;
      c.g.classList.toggle("collapsible", collapsibleIds.has(id));
      c.g.classList.toggle("collapsed", collapsedIds.has(id));
    }
  }

  // Set / clear the "collapsible" flag on a subgraph id. Unmarking a currently-
  // collapsed subgraph also expands it so we never leave a hidden-but-unmarkable
  // box behind. Returns true if the flag changed. Persistence / re-render is the
  // caller's responsibility (the edit-subgraph modal batches it with the rest).
  function setSubgraphCollapsible(id, on) {
    const was = collapsibleIds.has(id);
    if (on === was) return false;
    if (on) {
      collapsibleIds.add(id);
    } else {
      collapsibleIds.delete(id);
      collapsedIds.delete(id);
    }
    return true;
  }

  // Paint the primitive shape children of a node group (rect, polygon, circle,
  // ellipse, path) plus its label text.
  function paintShape(g, props) {
    for (const child of g.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "rect" || tag === "polygon" || tag === "circle"
          || tag === "ellipse" || tag === "path") {
        paintEl(child, props);
      }
    }
    const label = g.querySelector(":scope > g.label");
    if (label) paintLabelText(label, props);
  }

  function paintEl(el, props) {
    if (props.fill)   el.style.fill   = props.fill;
    if (props.stroke) el.style.stroke = props.stroke;
  }

  function shallowEq(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
  }

  // SVG `<text>` colors via `fill`, not `color`. Mermaid is configured with
  // htmlLabels:false so all labels are plain `<text>` — set fill on every
  // descendant text element.
  function paintLabelText(labelG, props) {
    if (!props.color) return;
    for (const t of labelG.querySelectorAll("text, tspan")) {
      t.style.fill = props.color;
    }
  }

  // Reorder sibling `g.cluster` elements so outer subgraphs paint first and
  // inner ones paint on top. Mermaid sometimes emits nested clusters in the
  // wrong source-derived order — when a child appears earlier than its parent
  // among shared siblings, the parent's bg ends up covering the child.
  //
  // "Outer" = bigger transitive `members` set (findSubgraphMembers walks the
  // body and collects nodeMap-known ids regardless of nesting). Siblings
  // sharing a parent get sorted in place; if clusters live under different
  // parents (e.g. a child cluster physically nested inside its parent's `g`),
  // their DOM containment already handles z-order so we don't touch them.
  function reorderClustersByContainment(svgEl) {
    const clusterGs = [...svgEl.querySelectorAll("g.cluster")];
    if (clusterGs.length < 2) return;
    const byParent = new Map();
    for (const g of clusterGs) {
      if (!byParent.has(g.parentNode)) byParent.set(g.parentNode, []);
      byParent.get(g.parentNode).push(g);
    }
    for (const [parent, gs] of byParent) {
      if (gs.length < 2) continue;
      const setGs = new Set(gs);
      // Anchor: first child after the contiguous run of our clusters, so we
      // reinsert in-place rather than push to the very end of the parent.
      const children = [...parent.childNodes];
      const firstIdx = children.findIndex(c => setGs.has(c));
      let i = firstIdx;
      while (i < children.length && setGs.has(children[i])) i++;
      const anchor = children[i] || null;
      gs.sort((a, b) => {
        const ida = extractNodeId(a), idb = extractNodeId(b);
        const ma = clusterMap[ida] ? clusterMap[ida].members.size : 0;
        const mb = clusterMap[idb] ? clusterMap[idb].members.size : 0;
        return mb - ma; // descending: larger (outer) first
      });
      for (const g of gs) parent.insertBefore(g, anchor);
    }
  }

  // ── Translate helpers & saved positions ─────────────────────────────────

  function extractNodeId(g) {
    const dataId = g.getAttribute("data-id");
    if (dataId) return dataId;
    const id = g.getAttribute("id") || "";
    const m = id.match(/^flowchart-(.+?)-\d+$/);
    if (m) return m[1];
    if (id && !id.includes("-")) return id;
    return null;
  }

  function getNodeTranslate(g) {
    // Firefox fix (Ariel commit ccbfbf4): consolidate() may return null
    const t = g.transform.baseVal.consolidate();
    if (t) return { x: t.matrix.e, y: t.matrix.f };
    return { x: 0, y: 0 };
  }

  // Cumulative translate from <svg> root down to `g`. Mermaid wraps subgraph
  // contents in nested <g class="root" transform="translate(...)"> groups, so
  // a node/cluster's `transform` only encodes its position WITHIN its
  // subgraph. Edge paths live at the outer-root level, so their geometry must
  // be expressed in world coords.
  function getWorldTranslate(g) {
    let x = 0, y = 0;
    let el = g;
    while (el && el.tagName && el.tagName.toLowerCase() !== "svg") {
      if (el.transform && el.transform.baseVal) {
        const t = el.transform.baseVal.consolidate();
        if (t) { x += t.matrix.e; y += t.matrix.f; }
      }
      el = el.parentNode;
    }
    return { x, y };
  }

  // Cumulative translate from <svg> down to el's PARENT (excluding el itself).
  // Mermaid nests subgraph-internal edges inside an inner `<g class="root">`
  // with its own transform (e.g. translate(-7.5, 636)) — when we write a path's
  // `d` in world coords without subtracting this, the path renders offset by
  // that translate. Use this to convert world coords into the element's own
  // parent frame before writing geometry.
  function getElementParentTranslate(el) {
    let x = 0, y = 0;
    let p = el ? el.parentNode : null;
    while (p && p.tagName && p.tagName.toLowerCase() !== "svg") {
      if (p.transform && p.transform.baseVal) {
        const t = p.transform.baseVal.consolidate();
        if (t) { x += t.matrix.e; y += t.matrix.f; }
      }
      p = p.parentNode;
    }
    return { x, y };
  }

  function setNodeTranslate(g, x, y) {
    g.setAttribute("transform", `translate(${x}, ${y})`);
  }

  function applySavedPositions() {
    // Prune positions for ids that no longer exist in the rendered graph
    // (typically because the user renamed/removed a node via direct source
    // edits). Mark layout dirty so the cleanup gets autosaved instead of
    // hanging around as orphan entries forever.
    const orphans = [];
    for (const [id, pos] of Object.entries(positions)) {
      const n = nodeMap[id];
      if (!n) { orphans.push(id); continue; }
      setNodeTranslate(n.g, pos.x, pos.y);
    }
    if (orphans.length > 0) {
      for (const id of orphans) delete positions[id];
      markDirtyLayout();
    }
    pruneOrphanEdgeAnchors();
    pruneOrphanNodeStyles();
  }

  // Drop edgeAnchors / edgeBend / edgeStyles entries that no longer correspond
  // to any current edge. Edges are keyed by `src|tgt|ord`; the triple changes
  // when ids are renamed outside the editor's rename flow or when edges are
  // reordered/deleted.
  function pruneOrphanEdgeAnchors() {
    const live = new Set();
    for (const e of edges) live.add(edgeKey(e));
    let changed = false;
    for (const bucket of [edgeAnchors, edgeBend, edgeStyles]) {
      for (const k of Object.keys(bucket)) {
        if (!live.has(k)) { delete bucket[k]; changed = true; }
      }
    }
    if (changed) markDirtyLayout();
  }

  // Drop nodeStyles / subgraphStyles entries whose id no longer exists in the
  // current graph. Triggered after each render so deletes / source edits clean
  // up. Keeps the layout JSON tidy without changing observable behavior.
  function pruneOrphanNodeStyles() {
    let changed = false;
    for (const id of Object.keys(nodeStyles)) {
      if (!nodeMap[id]) { delete nodeStyles[id]; changed = true; }
    }
    for (const id of Object.keys(subgraphStyles)) {
      if (!clusterMap[id]) { delete subgraphStyles[id]; changed = true; }
    }
    if (changed) markDirtyLayout();
  }

  // Re-key edgeAnchors/edgeBend entries whose source or target matched oldId.
  // Called from the rename flows that already migrate positions[oldId].
  function renameIdInEdgeAnchors(oldId, newId) {
    if (oldId === newId) return;
    let changed = false;
    const rekey = (obj) => {
      const updated = {};
      let touchedAny = false;
      for (const [k, v] of Object.entries(obj)) {
        const parts = k.split("|");
        if (parts.length !== 3) { updated[k] = v; continue; }
        let [s, t, o] = parts;
        let touched = false;
        if (s === oldId) { s = newId; touched = true; }
        if (t === oldId) { t = newId; touched = true; }
        const nk = touched ? `${s}|${t}|${o}` : k;
        updated[nk] = v;
        if (touched) touchedAny = true;
      }
      return { updated, touchedAny };
    };
    const a = rekey(edgeAnchors);
    if (a.touchedAny) { edgeAnchors = a.updated; changed = true; }
    const b = rekey(edgeBend);
    if (b.touchedAny) { edgeBend = b.updated; changed = true; }
    const c = rekey(edgeStyles);
    if (c.touchedAny) { edgeStyles = c.updated; changed = true; }
    for (const bucket of [nodeStyles, subgraphStyles]) {
      if (Object.prototype.hasOwnProperty.call(bucket, oldId)) {
        bucket[newId] = bucket[oldId];
        delete bucket[oldId];
        changed = true;
      }
    }
    if (changed) markDirtyLayout();
  }

  function nodeCenter(id) {
    const info = endpointInfo(id);
    if (!info) return null;
    const t = getWorldTranslate(info.g);
    return { x: t.x + info.centerLocal.x, y: t.y + info.centerLocal.y };
  }

  // Detect the primitive shape used by Mermaid for this node, so edges can clip
  // to the actual outline (diamond, circle, hexagon...) instead of the bbox.
  // Mermaid sometimes places its own translate() on the shape element itself
  // (e.g. diamond polygons get transform="translate(-w/2, w/2)" so the raw
  // points sit in their own local frame). We need to lift the shape into
  // g-local coords for ray clipping math.
  function getElementLocalTranslate(el) {
    if (!el || !el.transform || !el.transform.baseVal) return { x: 0, y: 0 };
    const t = el.transform.baseVal.consolidate();
    if (!t) return { x: 0, y: 0 };
    return { x: t.matrix.e, y: t.matrix.f };
  }

  // ── Shape geometry & anchors ────────────────────────────────────────────

  function detectSvgShape(g) {
    // Mermaid can emit multiple polygons inside a single node. Composite shapes
    // like subroutine [[...]] are drawn as a main inner rectangle plus two side
    // bars (each a separate polygon/rect): the largest polygon by area is the
    // main rect, but it sits INSIDE the full node bbox — so its outline isn't
    // where edges should clip and isn't where hotspots should sit. Below we
    // pick the largest polygon, then verify its bbox matches g.getBBox(); if
    // not, the polygon is a sub-piece of a composite, and we fall back to rect
    // (which uses g.getBBox() union as the outer extent).
    let bestPoly = null;
    let bestArea = -Infinity;
    let bestBbox = null;
    for (const child of g.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "polygon") {
        const tr = getElementLocalTranslate(child);
        const raw = parsePolygonPoints(child.getAttribute("points") || "");
        const points = raw.map(p => ({ x: p.x + tr.x, y: p.y + tr.y }));
        if (points.length === 0) continue;
        let minX =  Infinity, minY =  Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        const area = (maxX - minX) * (maxY - minY);
        if (area > bestArea) {
          bestArea = area;
          bestPoly = { type: "polygon", points };
          bestBbox = { width: maxX - minX, height: maxY - minY };
        }
        continue;
      }
      if (tag === "circle") {
        const tr = getElementLocalTranslate(child);
        return {
          type: "circle",
          cx: (parseFloat(child.getAttribute("cx")) || 0) + tr.x,
          cy: (parseFloat(child.getAttribute("cy")) || 0) + tr.y,
          r: parseFloat(child.getAttribute("r")) || 0,
        };
      }
      if (tag === "ellipse") {
        const tr = getElementLocalTranslate(child);
        return {
          type: "ellipse",
          cx: (parseFloat(child.getAttribute("cx")) || 0) + tr.x,
          cy: (parseFloat(child.getAttribute("cy")) || 0) + tr.y,
          rx: parseFloat(child.getAttribute("rx")) || 0,
          ry: parseFloat(child.getAttribute("ry")) || 0,
        };
      }
    }
    if (bestPoly) {
      // Composite shapes like subroutine [[...]] are sometimes a SINGLE polygon
      // whose outline traces both the outer rect AND the two inner side bars
      // (10+ vertices). Its bbox matches g.getBBox(), but a ray-cast from the
      // center hits the inner bar before the outer edge — wrong for both edge
      // clipping and hotspots. Heuristic: only trust polygons with ≤6 vertices
      // (diamond=4, hexagon=6, trapezoid/parallelogram=4). Anything more
      // complex → treat as rect using g.getBBox() as the outer extent.
      if (bestPoly.points.length > 6) return { type: "rect" };
      try {
        const gb = g.getBBox();
        if (Math.abs(bestBbox.width - gb.width) <= 2 && Math.abs(bestBbox.height - gb.height) <= 2) {
          return bestPoly;
        }
      } catch (_) { return bestPoly; }
      // Composite shape — outer extent ≠ best polygon.
    }
    return { type: "rect" };
  }

  function parsePolygonPoints(str) {
    const nums = str.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    return pts;
  }

  // Ray from C in direction D = (dx, dy). Find first intersection with the
  // closed polygon (ordered vertices `pts`). Returns the hit point in same
  // coords, or null if none.
  function rayPolygonHit(C, D, pts) {
    let bestT = Infinity, bestPt = null;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const A = pts[i], B = pts[(i + 1) % n];
      const ex = B.x - A.x, ey = B.y - A.y;
      const det = -D.x * ey + D.y * ex;
      if (Math.abs(det) < 1e-9) continue;
      const rx = A.x - C.x, ry = A.y - C.y;
      const t = (ry * ex - rx * ey) / det;
      const s = (D.x * ry - D.y * rx) / det;
      if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6 && t < bestT) {
        bestT = t;
        bestPt = { x: C.x + t * D.x, y: C.y + t * D.y };
      }
    }
    return bestPt;
  }

  // Find boundary point on node's actual outline along a ray from its center
  // in direction (dx, dy). Returns the offset relative to the node's translate
  // origin (so caller adds the translate to get svg coords).
  function findShapeBoundary(n, dx, dy) {
    if (dx === 0 && dy === 0) return { x: n.centerLocal.x, y: n.centerLocal.y };
    const c = n.centerLocal;
    const sh = n.shape;

    if (sh.type === "polygon" && sh.points.length >= 3) {
      const hit = rayPolygonHit(c, { x: dx, y: dy }, sh.points);
      if (hit) return hit;
    }
    if (sh.type === "circle" && sh.r > 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      return { x: sh.cx + sh.r * dx / len, y: sh.cy + sh.r * dy / len };
    }
    if (sh.type === "ellipse" && sh.rx > 0 && sh.ry > 0) {
      const u = dx / sh.rx, v = dy / sh.ry;
      const t = 1 / Math.sqrt(u * u + v * v);
      return { x: sh.cx + t * dx, y: sh.cy + t * dy };
    }
    // Rect / fallback: clip to bbox edge
    const scale = Math.min(
      Math.abs(dx) > 0.001 ? n.halfW / Math.abs(dx) : Infinity,
      Math.abs(dy) > 0.001 ? n.halfH / Math.abs(dy) : Infinity
    );
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }

  // Hotspot anchors: pin an edge endpoint to a fixed point on the shape outline.
  // Compass naming: cardinals (n,e,s,w) at side midpoints, corners (ne,se,sw,nw),
  // and side intermediates (nnw,nne,ene,ese,sse,ssw,wsw,wnw) at quarter-points.
  // Rect/cluster expose all 16; circle/ellipse expose 8 cardinals only.
  const SQRT2_2 = Math.SQRT1_2;
  // dx/dy: radial direction from center (SVG y-down). nx/ny: outward unit normal
  // used as bezier control direction for cluster-incident edges.
  const ANCHOR_DIRS = {
    n:   { dx:  0,        dy: -1,        nx:  0,        ny: -1 },
    nne: { dx:  0.5,      dy: -1,        nx:  0,        ny: -1 },
    ne:  { dx:  1,        dy: -1,        nx:  SQRT2_2,  ny: -SQRT2_2 },
    ene: { dx:  1,        dy: -0.5,      nx:  1,        ny:  0 },
    e:   { dx:  1,        dy:  0,        nx:  1,        ny:  0 },
    ese: { dx:  1,        dy:  0.5,      nx:  1,        ny:  0 },
    se:  { dx:  1,        dy:  1,        nx:  SQRT2_2,  ny:  SQRT2_2 },
    sse: { dx:  0.5,      dy:  1,        nx:  0,        ny:  1 },
    s:   { dx:  0,        dy:  1,        nx:  0,        ny:  1 },
    ssw: { dx: -0.5,      dy:  1,        nx:  0,        ny:  1 },
    sw:  { dx: -1,        dy:  1,        nx: -SQRT2_2,  ny:  SQRT2_2 },
    wsw: { dx: -1,        dy:  0.5,      nx: -1,        ny:  0 },
    w:   { dx: -1,        dy:  0,        nx: -1,        ny:  0 },
    wnw: { dx: -1,        dy: -0.5,      nx: -1,        ny:  0 },
    nw:  { dx: -1,        dy: -1,        nx: -SQRT2_2,  ny: -SQRT2_2 },
    nnw: { dx: -0.5,      dy: -1,        nx:  0,        ny: -1 },
  };
  // Rect anchors (nodes): 4 corners + 3 along top/bottom + 1 (the cardinal) on
  // each vertical side. Vertical sides are typically short relative to labels,
  // so 3-per-side felt cluttered for nodes.
  const RECT_ANCHORS = ["n","nne","ne","e","se","sse","s","ssw","sw","w","nw","nnw"];
  // Cluster anchors: subgraphs are usually large enough on both axes that 3
  // anchors per side stay comfortably spaced — full 16-point grid.
  const CLUSTER_ANCHORS = ["n","nne","ne","ene","e","ese","se","sse","s","ssw","sw","wsw","w","wnw","nw","nnw"];
  const CARDINAL_ANCHORS = ["n","ne","e","se","s","sw","w","nw"];

  // Flat-top hexagon (Mermaid's `{{...}}`): 6 vertices forming a <=> outline.
  // Returns the local-frame point for a compass anchor:
  //   nw/ne = top edge corners, n = top edge midpoint
  //   sw/se = bottom edge corners, s = bottom edge midpoint
  //   e     = right point vertex, w = left point vertex
  // Returns null if `points` doesn't look like a flat-top hexagon.
  function hexagonAnchorPoint(points, name) {
    const EPS = 0.5;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const topPts   = points.filter(p => Math.abs(p.y - minY) < EPS).sort((a, b) => a.x - b.x);
    const botPts   = points.filter(p => Math.abs(p.y - maxY) < EPS).sort((a, b) => a.x - b.x);
    const leftPt   = points.find(p => Math.abs(p.x - minX) < EPS);
    const rightPt  = points.find(p => Math.abs(p.x - maxX) < EPS);
    if (topPts.length !== 2 || botPts.length !== 2 || !leftPt || !rightPt) return null;
    switch (name) {
      case "nw": return topPts[0];
      case "n":  return { x: (topPts[0].x + topPts[1].x) / 2, y: minY };
      case "ne": return topPts[1];
      case "e":  return rightPt;
      case "se": return botPts[1];
      case "s":  return { x: (botPts[0].x + botPts[1].x) / 2, y: maxY };
      case "sw": return botPts[0];
      case "w":  return leftPt;
      default:   return null;
    }
  }

  // List of anchors valid for this shape (in render order).
  // Polygons (diamond, hexagon, subroutine in Mermaid v10) expose 8 cardinals
  // computed via ray-cast on the actual outline — the rect 16-anchor scheme
  // would place corner anchors outside non-rectangular shapes.
  function anchorsForShape(n) {
    const sh = n && n.shape;
    if (!sh) return [];
    if (sh.type === "circle" || sh.type === "ellipse") return CARDINAL_ANCHORS;
    if (sh.type === "polygon" && sh.points && sh.points.length >= 3) return CARDINAL_ANCHORS;
    // rect: clusters get the denser 16-point grid; plain nodes get the 12-point one.
    if (n.isCluster) return CLUSTER_ANCHORS;
    return RECT_ANCHORS;
  }

  // Local-frame point and outward unit normal for a given anchor on a shape.
  // Returns null if the name isn't valid for this shape.
  function anchorPoint(n, name) {
    if (!name) return null;
    const dir = ANCHOR_DIRS[name];
    if (!dir) return null;
    const sh = n.shape;
    const list = anchorsForShape(n);
    if (list.indexOf(name) === -1) return null;
    if (sh.type === "circle" && sh.r > 0) {
      // Use the unit normal (nx, ny) so diagonals land on the circumference,
      // not on the bbox corner (dir.dx/dy for diagonals are ±1, ±1 — length √2).
      return { x: sh.cx + sh.r * dir.nx, y: sh.cy + sh.r * dir.ny, nx: dir.nx, ny: dir.ny };
    }
    if (sh.type === "ellipse" && sh.rx > 0 && sh.ry > 0) {
      return { x: sh.cx + sh.rx * dir.nx, y: sh.cy + sh.ry * dir.ny, nx: dir.nx, ny: dir.ny };
    }
    if (sh.type === "polygon" && sh.points.length >= 3) {
      // Hexagon (flat-top, 6 vertices): map compass to actual vertices instead
      // of ray-casting at 45° (which would land on the slanted edges, between
      // a corner and the side midpoint). The visual <=> shape has 4 "corner"
      // vertices on the top/bottom edges plus 2 "point" vertices on the sides.
      if (sh.points.length === 6) {
        const hp = hexagonAnchorPoint(sh.points, name);
        if (hp) return { x: hp.x, y: hp.y, nx: dir.nx, ny: dir.ny };
      }
      // Ray from polygon centroid (approx via bbox center) hits the outline
      // exactly; corner cardinals land on edge midpoints or vertices depending
      // on the polygon's geometry, which is what we want visually.
      const hit = rayPolygonHit(n.centerLocal, { x: dir.dx, y: dir.dy }, sh.points);
      if (hit) return { x: hit.x, y: hit.y, nx: dir.nx, ny: dir.ny };
      return null;
    }
    // rect (and cluster bg rect): dir.dx/dy already use ±1 / ±0.5 along bbox.
    return {
      x: n.centerLocal.x + n.halfW * dir.dx,
      y: n.centerLocal.y + n.halfH * dir.dy,
      nx: dir.nx, ny: dir.ny,
    };
  }

  function endpointInfo(id) {
    if (nodeMap[id]) return nodeMap[id];
    const c = clusterMap[id];
    if (!c || !c.bg) return null;
    // Clusters use their bg rect as the clipping shape. Recompute live so we
    // pick up size/position changes from updateClusterBounds.
    if (c.bg.tagName.toLowerCase() === "rect") {
      const rx = parseFloat(c.bg.getAttribute("x")) || 0;
      const ry = parseFloat(c.bg.getAttribute("y")) || 0;
      const rw = parseFloat(c.bg.getAttribute("width")) || 0;
      const rh = parseFloat(c.bg.getAttribute("height")) || 0;
      return {
        g: c.g,
        centerLocal: { x: rx + rw / 2, y: ry + rh / 2 },
        halfW: rw / 2,
        halfH: rh / 2,
        shape: { type: "rect" },
        isCluster: true,
      };
    }
    // Polygon/path bg fallback — getBBox is in g-local coords.
    let bb;
    try { bb = c.bg.getBBox(); } catch (_) { return null; }
    return {
      g: c.g,
      centerLocal: { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 },
      halfW: bb.width / 2,
      halfH: bb.height / 2,
      shape: { type: "rect" },
      isCluster: true,
    };
  }

  // Outward unit normal of a cluster's rect bg at the given local boundary
  // point. Used to make cluster-incident edges leave perpendicular to the
  // subgraph border, distinguishing them visually from node↔node lines.
  function clusterOutwardNormal(n, boundaryLocal) {
    const lx = boundaryLocal.x - n.centerLocal.x;
    const ly = boundaryLocal.y - n.centerLocal.y;
    const rx = n.halfW > 0 ? Math.abs(lx) / n.halfW : 0;
    const ry = n.halfH > 0 ? Math.abs(ly) / n.halfH : 0;
    if (rx >= ry) return { x: Math.sign(lx) || 1, y: 0 };
    return { x: 0, y: Math.sign(ly) || 1 };
  }

  // ── Arrow markers, bends & edge routing ─────────────────────────────────

  // Pull Mermaid's arrowhead markers backward along the line direction so the
  // arrow visibly sits past the node fill instead of being half-covered by it.
  // We bump `refX` of every end-marker (`*-pointEnd`, `*-circleEnd`, …): the
  // marker is anchored at the line endpoint, so a larger refX shifts the whole
  // marker drawing in the −X direction = backward along the line at the target,
  // i.e. toward the source. The line itself still terminates at the boundary,
  // producing a tiny segment between the arrow tip and the boundary that reads
  // visually as the arrow's stem. Start-markers (back-arrow on `<-->` edges)
  // need the opposite sign AND a slightly larger magnitude: Mermaid v10.9.1
  // defines pointEnd with refX=6 (tip at marker-x=10 → bump +4 lands the tip
  // on the endpoint) and pointStart with refX=4.5 (mirrored shape, tip at
  // marker-x=0 → bump -4.5 lands the tip on the line start). The 0.5-unit
  // asymmetry comes from Mermaid's own defaults, not from us.
  // FUTURE: hard-coded to Mermaid 10.9.1's refX defaults — if the Mermaid
  // version bumps and the defaults shift, this calibration drifts. A more
  // robust fix would read each marker's path tip extent and compute the
  // delta dynamically; sufficient for now since the version is pinned.
  const ARROW_MARKER_REFX_BUMP_END = 4;
  const ARROW_MARKER_REFX_BUMP_START = -4.5;
  function offsetArrowMarkers(svgEl) {
    // Mermaid v10 IDs vary across releases (e.g. `flowchart-pointEnd`,
    // `flowchart-pointEnd_1`, `…-End-XYZ`). Match any marker whose id contains
    // "start" or "end" (case-insensitive) for the refX offset, and the same
    // set for the colour-inheritance pass — otherwise the start-side arrowhead
    // on bidirectional edges stays in its default (white) colour while the
    // edge body gets recoloured.
    for (const m of svgEl.querySelectorAll('marker')) {
      const id = m.getAttribute('id') || '';
      const isEnd = /end/i.test(id);
      const isStart = !isEnd && /start/i.test(id);
      if (isEnd || isStart) {
        const cur = parseFloat(m.getAttribute('refX') || '0');
        if (!Number.isNaN(cur)) {
          const delta = isEnd ? ARROW_MARKER_REFX_BUMP_END : ARROW_MARKER_REFX_BUMP_START;
          m.setAttribute('refX', String(cur + delta));
        }
      }
      if (!/(start|end)/i.test(id)) continue;
      // SVG2 `context-stroke`: makes the arrowhead inherit the stroke colour
      // of the referencing edge path. Set on BOTH fill (arrow body) and stroke
      // (arrow outline) — otherwise the outline stays at the marker's hard-
      // coded default. Default (uncoloured) edges already share the marker's
      // default stroke, so visible output is unchanged for them.
      for (const p of m.querySelectorAll('path, polygon')) {
        p.style.fill   = 'context-stroke';
        p.style.stroke = 'context-stroke';
      }
    }
  }

  // Chord-relative bend storage helpers.
  //
  // Schema: cubic Bezier with TWO control points per edge, stored as
  // `{t1, n1, t2, n2}` — each (t,n) is a chord-relative position (t along
  // src→tgt, n perpendicular signed offset in SVG world units). The two
  // handles ARE the cubic's cp1/cp2 (Illustrator-style "magnet" model).
  //
  // Default neutral shape (straight line) = {t1: 1/3, n1: 0, t2: 2/3, n2: 0}.
  const BEND_DEFAULT = Object.freeze({ t1: 1/3, n1: 0, t2: 2/3, n2: 0 });

  // Legacy quadratic bends `{t, n}` (from the single-cp prototype) are
  // promoted on read to mathematically equivalent cubics via degree elevation:
  //   cp1 = P0 + 2/3·(cp − P0)  ⇒  chord-relative (2t/3, 2n/3)
  //   cp2 = P2 + 2/3·(cp − P2)  ⇒  chord-relative ((1+2t)/3, 2n/3)
  function migrateBend(b) {
    if (!b || typeof b !== 'object') return null;
    if (typeof b.t1 === 'number' && typeof b.t2 === 'number') return b;
    if (typeof b.t === 'number' && typeof b.n === 'number') {
      const t = b.t, n = b.n;
      return { t1: 2*t/3, n1: 2*n/3, t2: (1+2*t)/3, n2: 2*n/3 };
    }
    return null;
  }
  // Move legacy `style <id> fill:…,stroke:…,color:…` directives out of the
  // Mermaid source and into nodeStyles/subgraphStyles (in the layout layer).
  // Visual styles are pure presentation — keeping them in the source pollutes
  // it for LLM consumers without adding semantic value. Idempotent: a source
  // with no `style` lines is a no-op. Subgraph vs node is disambiguated by
  // scanning for `subgraph <id>` declarations in the same source.
  function extractInlineStylesFromSource() {
    if (!currentSource) return false;
    const subgraphIds = new Set();
    const sgRe = /^\s*subgraph\s+([A-Za-z_][\w-]*)\b/;
    for (const line of currentSource.split("\n")) {
      const m = line.match(sgRe);
      if (m) subgraphIds.add(m[1]);
    }
    const styleRe = /^\s*style\s+([A-Za-z_][\w-]*)\s+(.+?)\s*$/;
    const out = [];
    let changed = false;
    for (const line of currentSource.split("\n")) {
      const m = line.match(styleRe);
      if (!m) { out.push(line); continue; }
      const id = m[1];
      const props = parseStyleProps(m[2]);
      if (!props) { out.push(line); continue; } // unparseable: leave in source
      const bucket = subgraphIds.has(id) ? subgraphStyles : nodeStyles;
      bucket[id] = Object.assign({}, bucket[id] || {}, props);
      changed = true;
      // skip line → drop from source
    }
    if (changed) currentSource = out.join("\n");
    return changed;
  }

  // Parse a Mermaid `style` value list ("fill:#5e81ac,stroke:#3b5371,…") into
  // a plain object. Returns null if the string is not a comma-separated list
  // of `key:value` pairs (e.g. user wrote something exotic — leave it alone).
  // Color-typed props with garbage values (corruption from accidental pastes
  // into the source) are silently dropped so the rotten value doesn't carry
  // over into the layout layer.
  function parseStyleProps(str) {
    const out = {};
    for (const part of str.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const i = p.indexOf(":");
      if (i < 1) return null;
      const k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (!k || !v) return null;
      if (isColorProp(k) && !isValidCssColor(v)) continue;
      out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  function isColorProp(k) {
    return k === "fill" || k === "stroke" || k === "color";
  }
  // Accept hex (#rgb/#rgba/#rrggbb/#rrggbbaa), functional notations
  // (rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color), and bare keywords for
  // named colors / `none` / `transparent` / `currentColor`. Anything else is
  // treated as garbage — corrupted source values would otherwise survive the
  // migration and silently break rendering once moved into the layout layer.
  function isValidCssColor(v) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
    if (/^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\([^()]*\)$/i.test(v)) return true;
    if (/^[a-zA-Z]+$/.test(v)) return true;
    return false;
  }

  function migrateAllBends() {
    for (const k of Object.keys(edgeBend)) {
      const m = migrateBend(edgeBend[k]);
      if (m) edgeBend[k] = m;
      else delete edgeBend[k];
    }
  }

  // World coords of one of the two cubic control points (which = 1 | 2).
  function bendCpWorld(sxW, syW, txW, tyW, bend, which) {
    const dx = txW - sxW, dy = tyW - syW;
    const L = Math.hypot(dx, dy) || 1;
    const t = which === 1 ? bend.t1 : bend.t2;
    const n = which === 1 ? bend.n1 : bend.n2;
    const ax = sxW + dx * t, ay = syW + dy * t;
    const px = -dy / L, py = dx / L;
    return { x: ax + px * n, y: ay + py * n };
  }
  // Inverse: given a world point, return its chord-relative {t, n}.
  function worldToBend(sxW, syW, txW, tyW, hx, hy) {
    const dx = txW - sxW, dy = tyW - syW;
    const L2 = dx * dx + dy * dy || 1;
    const L = Math.sqrt(L2);
    const vx = hx - sxW, vy = hy - syW;
    const t = (vx * dx + vy * dy) / L2;
    const n = (-dy * vx + dx * vy) / L;
    return { t, n };
  }

  function rerouteEdge(edge) {
    // If an endpoint is inside a collapsed subgraph, attach to that box instead
    // of the (hidden) node. effectiveEndpoint is identity when nothing relevant
    // is collapsed, so normal routing is unaffected.
    const srcId = effectiveEndpoint(edge.source);
    const tgtId = effectiveEndpoint(edge.target);
    const sn = endpointInfo(srcId);
    const tn = endpointInfo(tgtId);
    if (!sn || !tn) return;
    const sT = getWorldTranslate(sn.g);
    const tT = getWorldTranslate(tn.g);
    const scx = sT.x + sn.centerLocal.x, scy = sT.y + sn.centerLocal.y;
    const tcx = tT.x + tn.centerLocal.x, tcy = tT.y + tn.centerLocal.y;
    const dx = tcx - scx, dy = tcy - scy;
    // Explicit hotspot anchors (cosmetic layout layer) take precedence over
    // the auto center-to-center ray intersection. Each endpoint is independent.
    const anchors = edgeAnchors[edgeKey(edge)] || {};
    const sAnchor = anchors.source ? anchorPoint(sn, anchors.source) : null;
    const tAnchor = anchors.target ? anchorPoint(tn, anchors.target) : null;
    const sBoundary = sAnchor || findShapeBoundary(sn, dx, dy);
    const tBoundary = tAnchor || findShapeBoundary(tn, -dx, -dy);
    // Endpoints in WORLD coords first…
    const sxW = sT.x + sBoundary.x, syW = sT.y + sBoundary.y;
    const txW = tT.x + tBoundary.x, tyW = tT.y + tBoundary.y;
    // …then convert to the path element's own parent frame. Subgraph-internal
    // edges live inside a nested <g class="root"> with its own transform.
    const eFrame = getElementParentTranslate(edge.path);
    const sx = sxW - eFrame.x, sy = syW - eFrame.y;
    const tx = txW - eFrame.x, ty = tyW - eFrame.y;
    const sIsCluster = !!clusterMap[srcId];
    const tIsCluster = !!clusterMap[tgtId];
    const bend = edgeBend[edgeKey(edge)] || null;
    let labelX, labelY;
    if (bend) {
      // User-defined cubic bend overrides auto routing. The two handles ARE
      // cp1/cp2 (Illustrator-style "magnet" model): drag each independently
      // for tangent control at each endpoint, S-curves, etc.
      const c1 = bendCpWorld(sxW, syW, txW, tyW, bend, 1);
      const c2 = bendCpWorld(sxW, syW, txW, tyW, bend, 2);
      const c1x = c1.x - eFrame.x, c1y = c1.y - eFrame.y;
      const c2x = c2.x - eFrame.x, c2y = c2.y - eFrame.y;
      edge.path.setAttribute("d", `M ${sx},${sy} C ${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`);
      labelX = (sx + 3 * c1x + 3 * c2x + tx) / 8;
      labelY = (sy + 3 * c1y + 3 * c2y + ty) / 8;
    } else if (sIsCluster || tIsCluster || sAnchor || tAnchor) {
      const dist = Math.hypot(tx - sx, ty - sy) || 1;
      const cl = Math.max(40, Math.min(200, dist * 0.3));
      let snx, sny;
      if (sAnchor) {
        snx = sAnchor.nx; sny = sAnchor.ny;
      } else if (sIsCluster) {
        const nrm = clusterOutwardNormal(sn, sBoundary);
        snx = nrm.x; sny = nrm.y;
      } else {
        snx = (tx - sx) / dist; sny = (ty - sy) / dist;
      }
      let tnx, tny;
      if (tAnchor) {
        tnx = tAnchor.nx; tny = tAnchor.ny;
      } else if (tIsCluster) {
        const nrm = clusterOutwardNormal(tn, tBoundary);
        tnx = nrm.x; tny = nrm.y;
      } else {
        tnx = (sx - tx) / dist; tny = (sy - ty) / dist;
      }
      const c1x = sx + snx * cl, c1y = sy + sny * cl;
      const c2x = tx + tnx * cl, c2y = ty + tny * cl;
      edge.path.setAttribute("d", `M ${sx},${sy} C ${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`);
      labelX = (sx + 3 * c1x + 3 * c2x + tx) / 8;
      labelY = (sy + 3 * c1y + 3 * c2y + ty) / 8;
    } else {
      edge.path.setAttribute("d", `M ${sx},${sy} L ${tx},${ty}`);
      labelX = (sx + tx) / 2;
      labelY = (sy + ty) / 2;
    }
    if (edge.hitPath) edge.hitPath.setAttribute("d", edge.path.getAttribute("d"));
    if (edge.label) {
      // labelX/labelY are in the path's parent frame; the label has its own
      // parent (g.edgeLabels), possibly under a different nested root.
      const labelXW = labelX + eFrame.x;
      const labelYW = labelY + eFrame.y;
      const lFrame = getElementParentTranslate(edge.label);
      edge.label.setAttribute("transform", `translate(${labelXW - lFrame.x}, ${labelYW - lFrame.y})`);
    }
    // Keep hotspot dots glued to the source/target shapes during drag.
    if (selectedEdgeKeys.has(edgeKey(edge))) renderEdgeHotspots();
  }

  function rerouteAllEdges() {
    for (const e of edges) rerouteEdge(e);
    renderEdgeHotspots();
  }

  // ── Collapse/expand buttons ───────────────────────────────────────────────
  // One SVG overlay group at the <svg> root holding a small button per visible
  // collapsible subgraph, glued to the box's top-right corner. World coords are
  // used so the overlay tracks pan/zoom automatically (same trick as
  // g.edge-hotspots / g.edge-bend); the button is counter-scaled by the current
  // screen CTM so it keeps a constant on-screen size at any zoom level. Rebuilt
  // on every render and after any in-place box geometry change (drag).
  const COLLAPSE_BTN_SIZE = 22; // on-screen px (square)
  const COLLAPSE_BTN_INSET = 0; // on-screen px from the box's top-right corner (0 = flush to border)

  function renderCollapseButtons() {
    const svgEl = diagramEl && diagramEl.querySelector("svg");
    if (!svgEl) return;
    const old = svgEl.querySelector(":scope > g.collapse-buttons");
    if (old) old.remove();
    if (!canWrite) return;
    if (collapsibleIds.size === 0) return;
    const ctm = svgEl.getScreenCTM();
    const scale = ctm ? ctm.a : 1;          // world→screen factor (uniform)
    const sizeW = COLLAPSE_BTN_SIZE / scale; // button side in world units
    const insetW = COLLAPSE_BTN_INSET / scale;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const overlay = document.createElementNS(SVG_NS, "g");
    overlay.setAttribute("class", "collapse-buttons");
    svgEl.appendChild(overlay);
    for (const id of collapsibleIds) {
      const c = clusterMap[id];
      if (!c) continue;
      // Skip boxes hidden inside an outer collapsed ancestor (Phase 5). For now
      // the hidden check is cheap: an offsetParent-less / display:none g.
      if (isHiddenByCollapsedAncestor(id)) continue;
      const box = getClusterRectWorldBbox(c);
      if (!box) continue;
      const collapsed = collapsedIds.has(id);
      // A collapsed capsule lives in the cluster layer, BELOW the edges, so an
      // edge routed over it wins clicks (especially in the title's glyph gaps),
      // selecting a hidden/irrelevant edge instead of the box. Lay a transparent
      // hit rect over the whole box on this overlay (the last svg child, so it's
      // on top): clicks anywhere on a collapsed capsule select/drag it and the
      // edges behind are shielded. The button is appended AFTER, staying on top.
      if (collapsed) {
        const hit = document.createElementNS(SVG_NS, "rect");
        hit.setAttribute("class", "collapse-hit");
        hit.setAttribute("x", box.minX);
        hit.setAttribute("y", box.minY);
        hit.setAttribute("width", Math.max(0, box.maxX - box.minX));
        hit.setAttribute("height", Math.max(0, box.maxY - box.minY));
        hit.setAttribute("fill", "transparent");
        hit.style.pointerEvents = "all";
        hit.style.cursor = "pointer";
        // The hit rect sits on top of the capsule, so it — not the cluster <g>
        // below — is what the pointer hovers. Carry the note tooltip here too, or
        // a collapsed capsule (especially a nested one, raised above its peers)
        // shows no <title> on hover.
        const noteEnc = findNoteForId(currentSource, id);
        if (noteEnc) {
          const t = document.createElementNS(SVG_NS, "title");
          t.textContent = decodeNote(noteEnc);
          hit.appendChild(t);
        }
        hit.addEventListener("pointerdown", (ev) => {
          if (ev.pointerType === "mouse" && ev.button !== 0) return;
          if (!ev.isPrimary) return;
          if (connectingState === "edge-target") { ev.stopPropagation(); ev.preventDefault(); handleConnectClick(id); return; }
          if (connectingState === "move-target") { ev.stopPropagation(); ev.preventDefault(); handleMoveTargetClick(id); return; }
          if (connectingState) return;
          ev.stopPropagation();
          ev.preventDefault();
          // Modifier held: add this capsule to the selection on pointerup.
          if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
            const pointerId = ev.pointerId;
            const onUp = (e) => {
              if (e && e.pointerId !== pointerId) return;
              document.removeEventListener("pointerup", onUp);
              document.removeEventListener("pointercancel", onUp);
              toggleClusterSelection(id, true);
            };
            document.addEventListener("pointerup", onUp);
            document.addEventListener("pointercancel", onUp);
            return;
          }
          startClusterDrag(ev, svgEl, id);
        });
        hit.addEventListener("dblclick", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openEditSubgraphModal(id);
        });
        overlay.appendChild(hit);
      }
      const x = box.maxX - sizeW - insetW;
      const y = box.minY + insetW;
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "collapse-btn");
      g.setAttribute("data-sg-id", id);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("class", "collapse-btn-bg");
      rect.setAttribute("x", x); rect.setAttribute("y", y);
      rect.setAttribute("width", sizeW); rect.setAttribute("height", sizeW);
      rect.setAttribute("rx", 3 / scale);
      const use = document.createElementNS(SVG_NS, "use");
      use.setAttribute("href", collapsed ? "#icon-maximize" : "#icon-minimize");
      const pad = sizeW * 0.22;
      use.setAttribute("x", x + pad); use.setAttribute("y", y + pad);
      use.setAttribute("width", sizeW - 2 * pad); use.setAttribute("height", sizeW - 2 * pad);
      use.setAttribute("class", "collapse-btn-icon");
      g.appendChild(rect);
      g.appendChild(use);
      overlay.appendChild(g);
      const onDown = (ev) => {
        if (connectingState) return;
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        // Beat the cluster-drag handler (which only bails on g.node).
        ev.stopPropagation();
        ev.preventDefault();
        toggleCollapse(id);
      };
      g.addEventListener("pointerdown", onDown);
    }
  }

  // True when `id` (cluster) lives inside another subgraph that is currently
  // collapsed, so its own button/box is not visible. Builds the owner chain for
  // both nodes and nested subgraphs.
  function isHiddenByCollapsedAncestor(id) {
    if (collapsedIds.size === 0) return false;
    const owners = computeNodeSubgraphOwners(currentSource);
    for (const cid of Object.keys(clusterMap)) {
      for (const sgId of (clusterMap[cid].directSubgraphs || [])) {
        if (owners[sgId] === undefined) owners[sgId] = cid;
      }
    }
    let cur = owners[id];
    while (cur) {
      if (collapsedIds.has(cur)) return true;
      cur = owners[cur];
    }
    return false;
  }

  // Toggle the collapsed state of a collapsible subgraph, then re-render: the
  // render pipeline (applyCollapsedState) does the actual hide/shrink/reattach.
  // The COLLAPSED layout is canonical (what positions{} stores / saves); EXPAND
  // is a transient "make space" view. So expanding computes how far to push the
  // surrounding nodes outward and records it in collapseDisplace[id]; collapsing
  // discards that record. The push itself is reapplied to live translates every
  // render by applyExpansionSpacing and is NEVER written to positions{}.
  function toggleCollapse(id) {
    if (!collapsibleIds.has(id) || !clusterMap[id]) return;
    if (collapsedIds.has(id)) {
      // → expand: snapshot how far to push surrounding nodes (measured now,
      // while members are still at their collapsed-baseline positions).
      collapsedIds.delete(id);
      collapseDisplace[id] = computeExpansionDisplacement(id);
    } else {
      // → collapse: surrounding nodes return to baseline; drop the snapshot.
      collapsedIds.add(id);
      delete collapseDisplace[id];
    }
    markDirtyLayout();
    pushHistory();
    renderDiagram();
  }

  // World bbox of a subgraph's member nodes computed from cached half-extents
  // (nodeMap centerLocal/halfW/halfH) rather than getBBox — so it works even
  // while the members are display:none (collapsed). Returns null if empty.
  function membersWorldBbox(members) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const mid of members) {
      const n = nodeMap[mid];
      if (!n) continue;
      const t = getWorldTranslate(n.g);
      const cx = t.x + n.centerLocal.x, cy = t.y + n.centerLocal.y;
      if (cx - n.halfW < minX) minX = cx - n.halfW;
      if (cy - n.halfH < minY) minY = cy - n.halfH;
      if (cx + n.halfW > maxX) maxX = cx + n.halfW;
      if (cy + n.halfH > maxY) maxY = cy + n.halfH;
      any = true;
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  // Compute how far each surrounding node should move to "make space" when the
  // subgraph `id` expands from its collapsed box to its full size. Nodes above
  // the box center move up by (expandedH−collapsedH)/2, below move down, left
  // move left, right move right (the user's spec). Members of `id` stay put.
  // Returns { nodeId: {dx, dy} } in world units (translation deltas, so they're
  // frame-invariant and can be added directly to any node's transform).
  function computeExpansionDisplacement(id) {
    const c = clusterMap[id];
    if (!c) return {};
    const bb = membersWorldBbox(c.members);
    if (!bb) return {};
    const pd = c.padding || { left: 16, top: 16, right: 16, bottom: 16 };
    // Expanded box extents; top padding is larger (title room) so the box —
    // collapsed and expanded alike — is centered at cxW/cyW, matching
    // applyCollapsedState (NOT the raw members-bbox center).
    const expW = (bb.maxX - bb.minX) + pd.left + pd.right;
    const expH = (bb.maxY - bb.minY) + pd.top + pd.bottom;
    const cx = (bb.minX + bb.maxX) / 2 + (pd.right - pd.left) / 2;
    const cy = (bb.minY + bb.maxY) / 2 + (pd.bottom - pd.top) / 2;
    const cw = collapsedBoxWidth(c);
    const dX = Math.max(0, expW / 2 - cw / 2);
    const dY = Math.max(0, expH / 2 - COLLAPSED_BOX_H / 2);
    // Zones use the COLLAPSED box edges (what the user sees and positions nodes
    // around), so a node just outside the small box gets the full push and lands
    // just outside the expanded box — symmetric on both sides, no overlaps.
    const left = cx - cw / 2, right = cx + cw / 2;
    const top = cy - COLLAPSED_BOX_H / 2, bottom = cy + COLLAPSED_BOX_H / 2;
    // Push zones, decided by where a node sits relative to the expanded box:
    //   • beyond right edge (any Y)  → push right  (horizontal only)
    //   • beyond left edge  (any Y)  → push left   (horizontal only)
    //   • above top / below bottom, but within [left,right] → push vertically
    //   • INSIDE the footprint (within [left,right] AND [top,bottom]) → push
    //     along the dominant axis (single-axis, no diagonals). These are the
    //     nearby nodes that would otherwise be overlapped by the growing box:
    //     because collapsed members keep their full internal layout, the
    //     expanded footprint is already large and centered on the box, so a
    //     visually-close node can fall inside it and must still make room.
    // Corners (beyond a side edge AND above/below) fall into the horizontal
    // zones, so they move only horizontally — no diagonal pushes.
    const out = {};
    for (const nid of Object.keys(nodeMap)) {
      if (c.members.has(nid)) continue;
      const n = nodeMap[nid];
      const t = getWorldTranslate(n.g);
      const ncx = t.x + n.centerLocal.x, ncy = t.y + n.centerLocal.y;
      let ddx = 0, ddy = 0;
      if (ncx > right) ddx = dX;
      else if (ncx < left) ddx = -dX;
      else if (ncy < top) ddy = -dY;       // within horizontal range, above
      else if (ncy > bottom) ddy = dY;     // within horizontal range, below
      else {
        // Inside the collapsed box (rare): push out along the axis on which the
        // node is proportionally farther from the box center.
        const nx = (ncx - cx) / (cw / 2 || 1);
        const ny = (ncy - cy) / (COLLAPSED_BOX_H / 2 || 1);
        if (Math.abs(nx) >= Math.abs(ny)) ddx = (nx >= 0 ? dX : -dX);
        else ddy = (ny >= 0 ? dY : -dY);
      }
      if (ddx || ddy) out[nid] = { dx: ddx, dy: ddy };
    }
    return out;
  }

  // Reapply the transient expansion displacement (recorded per expanded
  // subgraph) on top of the baseline positions set by applySavedPositions.
  // Runs every render; never touches positions{}. Stale entries for a
  // now-collapsed subgraph are dropped.
  function applyExpansionSpacing() {
    // Reconstruct the push for any expanded collapsible that has no record yet.
    // collapseDisplace isn't persisted, so after a (re)load every expanded box
    // is missing it — without this, the box overlaps its neighbours, which were
    // saved at the collapsed baseline and never get pushed out. Measure now,
    // before applying anything below: nodes are still at the saved baseline
    // (applySavedPositions just ran), so each box is computed from baseline —
    // exactly as if the user had loaded it collapsed and expanded it by hand.
    for (const id of collapsibleIds) {
      if (collapsedIds.has(id) || !clusterMap[id]) continue;
      if (!collapseDisplace[id]) collapseDisplace[id] = computeExpansionDisplacement(id);
    }
    for (const sgId of Object.keys(collapseDisplace)) {
      if (collapsedIds.has(sgId) || !clusterMap[sgId]) {
        delete collapseDisplace[sgId];
        continue;
      }
      const d = collapseDisplace[sgId];
      for (const nid of Object.keys(d)) {
        const n = nodeMap[nid];
        if (!n) continue;
        const t = getNodeTranslate(n.g);
        setNodeTranslate(n.g, t.x + d[nid].dx, t.y + d[nid].dy);
      }
    }
  }

  // Sum of every active (non-collapsed) subgraph's displacement for one node.
  // Subtracted on drag-commit so the saved baseline excludes the transient push.
  function totalExpansionDelta(nodeId) {
    let dx = 0, dy = 0;
    for (const sgId of Object.keys(collapseDisplace)) {
      if (collapsedIds.has(sgId)) continue;
      const e = collapseDisplace[sgId][nodeId];
      if (e) { dx += e.dx; dy += e.dy; }
    }
    return { dx, dy };
  }

  // Frame offset (world − local) for each node currently moved into the z-raise
  // layer; rebuilt by raiseExpandedEntities each render. Empty when nothing is
  // raised. See computeBaselinePosition.
  let _raiseFrameOffset = {};

  // The value to store in positions{} for a node after a drag: convert its live
  // translate back to the collapsed-baseline LOCAL frame by removing (a) the
  // z-raise frame offset (if the node is in the identity raise layer) and (b) the
  // transient expansion displacement. Identity when nothing is raised/expanded.
  function computeBaselinePosition(id, liveTranslate) {
    const off = _raiseFrameOffset[id] || { x: 0, y: 0 };
    const d = totalExpansionDelta(id);
    return { x: liveTranslate.x - off.x - d.dx, y: liveTranslate.y - off.y - d.dy };
  }

  // ── Collapsed-state rendering ─────────────────────────────────────────────
  // Collapsed capsule box (world units; the diagram isn't zoomed at layout time
  // so 1 world unit ≈ 1 px at fit). Width ADAPTS to the title like a normal node
  // (see collapsedBoxWidth); COLLAPSED_BOX_W is only the fallback seed. Height is
  // fixed — titles are single-line.
  const COLLAPSED_BOX_W = 150;
  const COLLAPSED_BOX_H = 54;
  const COLLAPSED_MIN_W = 80;        // smallest box (very short titles)
  const COLLAPSED_PAD_X = 14;        // breathing room each side of the title
  const COLLAPSED_BTN_RESERVE = 26;  // right strip kept clear for the button
  // Width that fits the title + side padding + the expand-button strip, floored
  // at COLLAPSED_MIN_W. Cached on the cluster (_collapsedW) so it survives a
  // moment when the label can't be measured (e.g. at expand time).
  function collapsedBoxWidth(c) {
    let textW = 0;
    if (c && c.label) {
      let lbb; try { lbb = c.label.getBBox(); } catch (_) { lbb = null; }
      if (lbb && lbb.width > 0) textW = lbb.width;
    }
    if (textW <= 0) return (c && c._collapsedW) || COLLAPSED_BOX_W;
    const w = Math.max(COLLAPSED_MIN_W,
      Math.round(textW + COLLAPSED_PAD_X * 2 + COLLAPSED_BTN_RESERVE));
    if (c) c._collapsedW = w;
    return w;
  }

  // True if `id` (a cluster id) sits inside another subgraph that is currently
  // collapsed — walk the source-derived owner chain. Used to skip inner boxes
  // whose ancestor already hides them.
  function hasCollapsedAncestor(id, owners) {
    let cur = owners[id];
    while (cur) {
      if (collapsedIds.has(cur)) return true;
      cur = owners[cur];
    }
    return false;
  }

  // For a node/subgraph id, return the OUTERMOST collapsed ancestor subgraph id
  // (the box an external edge should reattach to), or null if none of its
  // ancestors are collapsed. Walks the full owner chain and keeps the last hit.
  function outermostCollapsedAncestor(id, owners) {
    let cur = owners[id], outer = null;
    while (cur) {
      if (collapsedIds.has(cur)) outer = cur;
      cur = owners[cur];
    }
    return outer;
  }

  // Apply collapsed visuals after layout: hide member nodes + intra-box edges,
  // shrink each collapsed cluster's bg to a fixed node-sized rect centered on
  // its current box center, and recenter the title. Reattachment of crossing
  // edges to the box is handled in rerouteEdge via effectiveEndpoint(); this
  // function only deals with visibility + box geometry. Idempotent: it first
  // clears any hidden flags from a previous pass.
  function applyCollapsedState(svgEl) {
    // 1) Reset visibility from any previous render pass.
    for (const id of Object.keys(nodeMap)) nodeMap[id].g.style.display = "";
    for (const e of edges) {
      if (e.path) e.path.style.display = "";
      if (e.hitPath) e.hitPath.style.display = "";
      if (e.label) e.label.style.display = "";
    }
    for (const id of Object.keys(clusterMap)) {
      const c = clusterMap[id];
      if (c && c.g) c.g.style.display = "";
    }
    if (collapsedIds.size === 0) return;

    const owners = computeNodeSubgraphOwners(currentSource);
    // Subgraph→parent owner chain (computeNodeSubgraphOwners only covers nodes).
    // Build it from each cluster's direct subgraph children.
    for (const cid of Object.keys(clusterMap)) {
      for (const sgId of (clusterMap[cid].directSubgraphs || [])) {
        if (owners[sgId] === undefined) owners[sgId] = cid;
      }
    }
    window.__collapseOwners = owners; // shared with effectiveEndpoint this render

    // 2) Process collapsed boxes outermost-first so an inner collapsed box that
    //    lives under an outer collapsed box is simply hidden with the rest.
    const collapsed = [...collapsedIds].filter(id => clusterMap[id]);
    collapsed.sort((a, b) =>
      (clusterMap[b].members.size || 0) - (clusterMap[a].members.size || 0));

    for (const id of collapsed) {
      const c = clusterMap[id];
      // Skip if an outer collapsed ancestor already hides this whole subtree.
      if (hasCollapsedAncestor(id, owners)) { c.g.style.display = "none"; continue; }
      // Box center = center of the EXPANDED box this subgraph would have, so
      // collapse and expand are concentric (expand grows from / collapse shrinks
      // to the same point). The expanded box = members bbox + padding, exactly
      // as updateClusterBounds computes it; the top padding is larger (room for
      // the title), so centering on the raw members bbox instead would make the
      // box expand off-center toward a corner. Derived from the members' (saved)
      // positions via cached extents, so it works while members are hidden.
      const mb = membersWorldBbox(c.members);
      const box = mb || getClusterRectWorldBbox(c);
      if (!box) continue;
      const pd = c.padding || { left: 0, top: 0, right: 0, bottom: 0 };
      const exLeft = box.minX - pd.left, exRight = box.maxX + pd.right;
      const exTop = box.minY - pd.top, exBottom = box.maxY + pd.bottom;
      const cxW = (exLeft + exRight) / 2;
      const cyW = (exTop + exBottom) / 2;
      // Hide every member node + any nested cluster <g>.
      for (const mid of c.members) {
        if (nodeMap[mid]) nodeMap[mid].g.style.display = "none";
      }
      for (const cid of Object.keys(clusterMap)) {
        if (cid === id) continue;
        if (c.members.has(cid) || isDescendantSubgraph(cid, id, owners)) {
          clusterMap[cid].g.style.display = "none";
        }
      }
      // Shrink the bg to the fixed box, centered on cxW/cyW. Keep the SAME bg
      // origin convention as updateClusterBounds (bg.x = pad.rx, bg.y = pad.ry):
      // that function positions the g assuming bg.x/y equal rx/ry and never
      // rewrites them, so zeroing them here would make a later expand land off by
      // (rx,ry) — the "shifts right/down on expand" bug. With a consistent origin
      // the box is concentric across collapse/expand cycles.
      const rx = pd.rx || 0, ry = pd.ry || 0;
      const boxW = collapsedBoxWidth(c);
      const halfW = boxW / 2, halfH = COLLAPSED_BOX_H / 2;
      const parentW = getWorldTranslate(c.g.parentNode);
      const gx = cxW - halfW - rx - parentW.x;
      const gy = cyW - halfH - ry - parentW.y;
      setNodeTranslate(c.g, gx, gy);
      c.bg.setAttribute("x", rx);
      c.bg.setAttribute("y", ry);
      c.bg.setAttribute("width", boxW);
      c.bg.setAttribute("height", COLLAPSED_BOX_H);
      // Center the title in the area left of the button strip.
      if (c.label) {
        let lbb; try { lbb = c.label.getBBox(); } catch (_) { lbb = null; }
        if (lbb) {
          setNodeTranslate(c.label,
            rx + (boxW - COLLAPSED_BTN_RESERVE) / 2 - (lbb.x + lbb.width / 2),
            ry + halfH - (lbb.y + lbb.height / 2));
        }
      }
    }

    // 3) Hide edges that are fully internal to a collapsed box (both endpoints
    //    resolve to the SAME collapsed ancestor). Crossing edges stay visible
    //    and get reattached by rerouteEdge.
    for (const e of edges) {
      const sEff = outermostCollapsedAncestor(e.source, owners) || e.source;
      const tEff = outermostCollapsedAncestor(e.target, owners) || e.target;
      if (sEff === tEff && collapsedIds.has(sEff)) {
        if (e.path) e.path.style.display = "none";
        if (e.hitPath) e.hitPath.style.display = "none";
        if (e.label) e.label.style.display = "none";
      }
    }
  }

  // Build a complete owner chain (node→parent subgraph AND subgraph→parent
  // subgraph) from the current source + clusterMap. computeNodeSubgraphOwners
  // only covers nodes, so we add the subgraph→parent links.
  function buildOwnerChain() {
    const owners = computeNodeSubgraphOwners(currentSource);
    for (const cid of Object.keys(clusterMap)) {
      for (const sgId of (clusterMap[cid].directSubgraphs || [])) {
        if (owners[sgId] === undefined) owners[sgId] = cid;
      }
    }
    return owners;
  }
  function hasAncestorIn(id, owners, set) {
    let cur = owners[id];
    while (cur) { if (set.has(cur)) return true; cur = owners[cur]; }
    return false;
  }

  // Raise EXPANDED collapsible subgraphs — with everything they contain — above
  // the rest of the diagram (the user's model: the expanded entity becomes the
  // focus, on top of all; everything else is left untouched).
  //
  // Mermaid scatters a subgraph's pieces across DOM layers (bg in g.clusters,
  // members in g.nodes, internal edges in g.edgePaths) and across nested roots,
  // so there's no single subtree node to bump. Instead we move every piece into
  // one identity-transform <g class="expanded-raise"> appended last under the
  // <svg> (top of paint order). Each cluster bg / member node keeps its place by
  // having its transform rewritten to its full world translate (the raise layer
  // has no transform, so a child's own transform IS its world position). Edges
  // are moved then re-routed: rerouteEdge derives geometry from the live
  // endpoints + the path's parent frame, so once the path sits in the (identity)
  // raise layer it recomputes correctly. The whole SVG is rebuilt each render,
  // so nothing needs un-raising.
  //
  // Paint order inside the raise layer follows natural nesting (see below): each
  // cluster's bg then the edges it owns, outermost-first, with all member nodes
  // last — so an inner expanded capsule paints above the OUTER capsule's edges
  // that merely cross it, while edges connecting INTO a box still sit above it.
  function raiseExpandedEntities(svgEl) {
    if (collapsibleIds.size === 0) return;
    const expandedSet = new Set([...collapsibleIds].filter(id =>
      clusterMap[id] && !collapsedIds.has(id)));
    if (expandedSet.size === 0) return;
    const owners = buildOwnerChain();
    // Drop expanded boxes that are themselves hidden inside a collapsed ancestor.
    for (const id of [...expandedSet]) {
      let cur = owners[id], hidden = false;
      while (cur) { if (collapsedIds.has(cur)) { hidden = true; break; } cur = owners[cur]; }
      if (hidden) expandedSet.delete(id);
    }
    if (expandedSet.size === 0) return;

    // Clusters to raise: any expanded box + any cluster nested inside one.
    const raiseClusterIds = Object.keys(clusterMap).filter(cid =>
      expandedSet.has(cid) || hasAncestorIn(cid, owners, expandedSet));
    const raiseClusterIdSet = new Set(raiseClusterIds);
    // Nodes to raise: any node whose owner chain enters an expanded box.
    const raiseNodeIds = Object.keys(nodeMap).filter(nid =>
      hasAncestorIn(nid, owners, expandedSet));
    const raiseNodeSet = new Set(raiseNodeIds);
    // Edges to raise: at least one endpoint inside the expanded entity — both
    // fully-internal edges AND edges coming from outside INTO an internal
    // node/subgraph, so the latter aren't hidden behind the raised box. An
    // endpoint can be a node (in raiseNodeSet) or a subgraph id that is itself
    // raised (e.g. an edge that targets a nested subgraph directly).
    const isRaisedEndpoint = (eid) =>
      raiseNodeSet.has(eid) || raiseClusterIdSet.has(eid);
    const raiseEdges = edges.filter(e =>
      isRaisedEndpoint(e.source) || isRaisedEndpoint(e.target));

    // Capture world translates BEFORE moving anything (a move only affects
    // descendants, and none of these elements contains another in this list).
    // Also record each node's FRAME OFFSET = world − local = the world translate
    // of its original parent. Moving a node into the identity raise layer makes
    // its getNodeTranslate read world coords; a later drag-commit subtracts this
    // offset to convert back to the original (nested) local frame that
    // positions{}/applySavedPositions use — otherwise a nested raised node would
    // be saved in world coords and reappear shifted by the wrapper offset.
    _raiseFrameOffset = {};
    const clusterWorld = {};
    for (const cid of raiseClusterIds) clusterWorld[cid] = getWorldTranslate(clusterMap[cid].g);
    const nodeWorld = {};
    for (const nid of raiseNodeIds) {
      const w = getWorldTranslate(nodeMap[nid].g);
      const l = getNodeTranslate(nodeMap[nid].g);
      nodeWorld[nid] = w;
      _raiseFrameOffset[nid] = { x: w.x - l.x, y: w.y - l.y };
    }

    const SVG_NS = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(SVG_NS, "g");
    layer.setAttribute("class", "expanded-raise");
    svgEl.appendChild(layer);

    // Paint order inside the raise layer must mimic natural nesting z-order, or
    // an OUTER capsule's edges paint above an INNER expanded capsule (edges
    // "passing over" a nested box). Compute each raised cluster's nesting depth,
    // then assign every raised edge to its OWNER = the deepest raised cluster
    // reached by either endpoint. Emitting, outermost-first, each cluster's bg
    // followed by the edges it owns means: an edge merely CROSSING a deeper box
    // (no endpoint inside it) stays owned by the shallower box and paints UNDER
    // the deeper one, while an edge connecting INTO a box paints above it.
    const clusterDepth = {};
    for (const cid of raiseClusterIds) {
      let d = 0, cur = owners[cid];
      while (cur) { if (raiseClusterIdSet.has(cur)) d++; cur = owners[cur]; }
      clusterDepth[cid] = d;
    }
    const deepestRaisedCluster = (eid) => {
      if (raiseClusterIdSet.has(eid)) return eid;
      let cur = owners[eid];
      while (cur) { if (raiseClusterIdSet.has(cur)) return cur; cur = owners[cur]; }
      return null;
    };
    const edgesByOwner = {};
    for (const e of raiseEdges) {
      const cs = deepestRaisedCluster(e.source), ct = deepestRaisedCluster(e.target);
      const ds = cs ? clusterDepth[cs] : -1;
      const dt = ct ? clusterDepth[ct] : -1;
      const owner = (ds >= dt ? cs : ct) || cs || ct;
      (edgesByOwner[owner] = edgesByOwner[owner] || []).push(e);
    }
    // 1) per cluster, outermost-first: bg then the edges it owns.
    raiseClusterIds.sort((a, b) => clusterDepth[a] - clusterDepth[b]);
    for (const cid of raiseClusterIds) {
      const g = clusterMap[cid].g;
      layer.appendChild(g);
      setNodeTranslate(g, clusterWorld[cid].x, clusterWorld[cid].y);
      for (const e of (edgesByOwner[cid] || [])) {
        if (e.path) layer.appendChild(e.path);
        if (e.hitPath) layer.appendChild(e.hitPath);
        if (e.label) layer.appendChild(e.label);
      }
    }
    // 2) member nodes on top of all bgs/edges.
    for (const nid of raiseNodeIds) {
      const g = nodeMap[nid].g;
      layer.appendChild(g);
      setNodeTranslate(g, nodeWorld[nid].x, nodeWorld[nid].y);
    }
    // Re-route raised edges now that endpoints + paths share the identity frame.
    for (const e of raiseEdges) rerouteEdge(e);
  }

  // Position a collapsed cluster's box: shrink the bg to the fixed collapsed
  // size, centered on the center of the EXPANDED box this subgraph would have so
  // collapse/expand are concentric. Derived from the members' live world
  // positions (works while they're display:none), so it stays correct whenever
  // the members move — including mid-drag, where it's called directly (the full
  // applyCollapsedState pass doesn't run during a drag).
  function placeCollapsedBox(c) {
    if (!c || !c.bg) return;
    const mb = membersWorldBbox(c.members);
    const box = mb || getClusterRectWorldBbox(c);
    if (!box) return;
    const pd = c.padding || { left: 0, top: 0, right: 0, bottom: 0 };
    // Expanded box = members bbox + padding (top padding larger for the title),
    // so center on that — not the raw members bbox — to stay concentric.
    const cxW = (box.minX - pd.left + box.maxX + pd.right) / 2;
    const cyW = (box.minY - pd.top + box.maxY + pd.bottom) / 2;
    // Keep updateClusterBounds' bg-origin convention (bg.x=rx, bg.y=ry); zeroing
    // them would offset a later expand by (rx,ry).
    const rx = pd.rx || 0, ry = pd.ry || 0;
    const boxW = collapsedBoxWidth(c);
    const halfW = boxW / 2, halfH = COLLAPSED_BOX_H / 2;
    const parentW = getWorldTranslate(c.g.parentNode);
    setNodeTranslate(c.g, cxW - halfW - rx - parentW.x, cyW - halfH - ry - parentW.y);
    c.bg.setAttribute("x", rx);
    c.bg.setAttribute("y", ry);
    c.bg.setAttribute("width", boxW);
    c.bg.setAttribute("height", COLLAPSED_BOX_H);
    if (c.label) {
      let lbb; try { lbb = c.label.getBBox(); } catch (_) { lbb = null; }
      if (lbb) {
        setNodeTranslate(c.label,
          rx + (boxW - COLLAPSED_BTN_RESERVE) / 2 - (lbb.x + lbb.width / 2),
          ry + halfH - (lbb.y + lbb.height / 2));
      }
    }
  }

  // Re-place every currently-visible collapsed box from its members' live
  // positions, and reroute their incident edges. Called during drags so a
  // collapsed child box follows when its (expanded) parent — or any ancestor —
  // is moved; the full render pass that normally repositions it doesn't run
  // mid-drag.
  function repositionVisibleCollapsedBoxes() {
    if (collapsedIds.size === 0) return;
    for (const id of collapsedIds) {
      const c = clusterMap[id];
      if (!c || !c.g || c.g.style.display === "none") continue;
      placeCollapsedBox(c);
      if (c.incomingEdges) for (const e of c.incomingEdges) rerouteEdge(e);
      if (c.outgoingEdges) for (const e of c.outgoingEdges) rerouteEdge(e);
    }
  }

  // True if subgraph `cid` is nested (at any depth) inside subgraph `ancestorId`.
  function isDescendantSubgraph(cid, ancestorId, owners) {
    let cur = owners[cid];
    while (cur) {
      if (cur === ancestorId) return true;
      cur = owners[cur];
    }
    return false;
  }

  // Resolve an edge endpoint id to the box it should actually attach to: if the
  // endpoint is inside a collapsed subgraph, that's the outermost collapsed
  // ancestor; otherwise the endpoint itself. Used by rerouteEdge so crossing
  // edges terminate on the collapsed box instead of a hidden node.
  function effectiveEndpoint(id) {
    if (collapsedIds.size === 0) return id;
    const owners = window.__collapseOwners;
    if (!owners) return id;
    return outermostCollapsedAncestor(id, owners) || id;
  }

  // True when an edge endpoint is a node/subgraph hidden inside a collapsed
  // capsule — i.e. it resolves to a different (ancestor) box. The edge attaches
  // to that box, so the hidden endpoint must show no anchor hotspots / bend
  // handle (there's no visible shape there to anchor to).
  function isEndpointHidden(id) {
    return effectiveEndpoint(id) !== id;
  }

  // ── Edge hotspots & bend handles ────────────────────────────────────────

  // Render the hotspot overlay for the currently selected edge. No-op when
  // nothing is selected or the source/target shapes don't support anchors.
  // World coords live in the svg's top-level user space, so we append at the
  // <svg> root (same trick as g.peer-selections).
  function renderEdgeHotspots() {
    const svgEl = diagramEl && diagramEl.querySelector("svg");
    if (!svgEl) return;
    const old = svgEl.querySelector(":scope > g.edge-hotspots");
    if (old) old.remove();
    renderEdgeBendHandle();
    // Anchor hotspots / bend handles only make sense on a single edge — on
    // multi-select they'd be ambiguous and crowd the canvas.
    const soleKey = singleEdgeKey();
    if (!soleKey) return;
    // Spectator mode: no writes possible, so hide the affordance.
    if (!canWrite) return;
    const edge = findEdgeByKey(soleKey);
    if (!edge) return;
    const sn = endpointInfo(edge.source);
    const tn = endpointInfo(edge.target);
    if (!sn || !tn) return;
    // An endpoint hidden inside a collapsed capsule has no visible shape — the
    // edge attaches to the box instead — so it gets no anchor hotspots. Handles
    // each side independently (one, both, or neither may be hidden).
    const sAnchors = isEndpointHidden(edge.source) ? [] : anchorsForShape(sn);
    const tAnchors = isEndpointHidden(edge.target) ? [] : anchorsForShape(tn);
    if (sAnchors.length === 0 && tAnchors.length === 0) return;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const overlay = document.createElementNS(SVG_NS, "g");
    overlay.setAttribute("class", "edge-hotspots");
    svgEl.appendChild(overlay);
    const anchors = edgeAnchors[soleKey] || {};
    const sT = getWorldTranslate(sn.g);
    const tT = getWorldTranslate(tn.g);
    drawHotspotSet(overlay, sn, sT, sAnchors, "source", anchors.source);
    drawHotspotSet(overlay, tn, tT, tAnchors, "target", anchors.target);
  }

  // Compute the world endpoints used by rerouteEdge — shared by the bend
  // handle render + drag init so the handles sit exactly where the path does.
  function edgeWorldEndpoints(edge) {
    // Mirror rerouteEdge: route to the collapsed box, not the hidden node, so
    // the handles sit on the actual drawn curve.
    const sn = endpointInfo(effectiveEndpoint(edge.source));
    const tn = endpointInfo(effectiveEndpoint(edge.target));
    if (!sn || !tn) return null;
    const sT = getWorldTranslate(sn.g);
    const tT = getWorldTranslate(tn.g);
    const scx = sT.x + sn.centerLocal.x, scy = sT.y + sn.centerLocal.y;
    const tcx = tT.x + tn.centerLocal.x, tcy = tT.y + tn.centerLocal.y;
    const dx = tcx - scx, dy = tcy - scy;
    const anchors = edgeAnchors[edgeKey(edge)] || {};
    const sAnchor = anchors.source ? anchorPoint(sn, anchors.source) : null;
    const tAnchor = anchors.target ? anchorPoint(tn, anchors.target) : null;
    const sBoundary = sAnchor || findShapeBoundary(sn, dx, dy);
    const tBoundary = tAnchor || findShapeBoundary(tn, -dx, -dy);
    return {
      sxW: sT.x + sBoundary.x, syW: sT.y + sBoundary.y,
      txW: tT.x + tBoundary.x, tyW: tT.y + tBoundary.y,
    };
  }

  // Auto-curve control points in world coords for an edge that has anchor or
  // cluster normals but no explicit bend entry. Returns null when the edge
  // would be a straight line (no anchors, no clusters).
  function autoCurveCps(edge) {
    // Mirror rerouteEdge: resolve to the collapsed box when an endpoint is
    // hidden, so the displayed curve handles match the actual path.
    const srcId = effectiveEndpoint(edge.source);
    const tgtId = effectiveEndpoint(edge.target);
    const sn = endpointInfo(srcId);
    const tn = endpointInfo(tgtId);
    if (!sn || !tn) return null;
    const sT = getWorldTranslate(sn.g);
    const tT = getWorldTranslate(tn.g);
    const scx = sT.x + sn.centerLocal.x, scy = sT.y + sn.centerLocal.y;
    const tcx = tT.x + tn.centerLocal.x, tcy = tT.y + tn.centerLocal.y;
    const dx = tcx - scx, dy = tcy - scy;
    const anchors = edgeAnchors[edgeKey(edge)] || {};
    const sAnchor = anchors.source ? anchorPoint(sn, anchors.source) : null;
    const tAnchor = anchors.target ? anchorPoint(tn, anchors.target) : null;
    const sIsCluster = !!clusterMap[srcId];
    const tIsCluster = !!clusterMap[tgtId];
    if (!sIsCluster && !tIsCluster && !sAnchor && !tAnchor) return null;
    const sBoundary = sAnchor || findShapeBoundary(sn, dx, dy);
    const tBoundary = tAnchor || findShapeBoundary(tn, -dx, -dy);
    const sxW = sT.x + sBoundary.x, syW = sT.y + sBoundary.y;
    const txW = tT.x + tBoundary.x, tyW = tT.y + tBoundary.y;
    const dist = Math.hypot(txW - sxW, tyW - syW) || 1;
    const cl = Math.max(40, Math.min(200, dist * 0.3));
    let snx, sny;
    if (sAnchor) { snx = sAnchor.nx; sny = sAnchor.ny; }
    else if (sIsCluster) {
      const nrm = clusterOutwardNormal(sn, sBoundary);
      snx = nrm.x; sny = nrm.y;
    } else {
      snx = (txW - sxW) / dist; sny = (tyW - syW) / dist;
    }
    let tnx, tny;
    if (tAnchor) { tnx = tAnchor.nx; tny = tAnchor.ny; }
    else if (tIsCluster) {
      const nrm = clusterOutwardNormal(tn, tBoundary);
      tnx = nrm.x; tny = nrm.y;
    } else {
      tnx = (sxW - txW) / dist; tny = (syW - tyW) / dist;
    }
    return {
      c1: { x: sxW + snx * cl, y: syW + sny * cl },
      c2: { x: txW + tnx * cl, y: tyW + tny * cl },
    };
  }

  // Render the two cubic-bend handles + their tangent guide lines for the
  // selected edge. When no edgeBend entry exists and the edge is a straight
  // line, handles sit at the neutral defaults (t1=1/3, n1=0, t2=2/3, n2=0).
  // When no edgeBend entry exists but the edge has auto-curvature (anchors or
  // clusters), handles sit at the actual auto-curve control points so their
  // position matches the visible curve. Grabbing one promotes it into a real
  // entry. Ctrl/Cmd while dragging snaps the dragged handle's perpendicular
  // offset to 0 (8px-screen threshold) ⇒ that endpoint's tangent goes flat.
  function renderEdgeBendHandle() {
    const svgEl = diagramEl && diagramEl.querySelector("svg");
    if (!svgEl) return;
    const old = svgEl.querySelector(":scope > g.edge-bend");
    if (old) old.remove();
    // Bend handles only render on a single-edge selection; on multi-select
    // they'd be ambiguous (one bend per edge) and visually noisy.
    const soleKey = singleEdgeKey();
    if (!soleKey) return;
    if (!canWrite) return;
    const edge = findEdgeByKey(soleKey);
    if (!edge) return;
    // A handle whose endpoint node is hidden inside a collapsed capsule has no
    // visible shape to sit on, so suppress it. If both ends are hidden there's
    // nothing to show at all.
    const sHidden = isEndpointHidden(edge.source);
    const tHidden = isEndpointHidden(edge.target);
    if (sHidden && tHidden) return;
    const ep = edgeWorldEndpoints(edge);
    if (!ep) return;
    const { sxW, syW, txW, tyW } = ep;
    const hasEntry = !!edgeBend[soleKey];
    let c1, c2, isStraight1, isStraight2;
    if (hasEntry) {
      const bend = edgeBend[soleKey];
      c1 = bendCpWorld(sxW, syW, txW, tyW, bend, 1);
      c2 = bendCpWorld(sxW, syW, txW, tyW, bend, 2);
      isStraight1 = Math.abs(bend.n1) < 0.01;
      isStraight2 = Math.abs(bend.n2) < 0.01;
    } else {
      const auto = autoCurveCps(edge);
      if (auto) {
        c1 = auto.c1;
        c2 = auto.c2;
        isStraight1 = false;
        isStraight2 = false;
      } else {
        c1 = bendCpWorld(sxW, syW, txW, tyW, BEND_DEFAULT, 1);
        c2 = bendCpWorld(sxW, syW, txW, tyW, BEND_DEFAULT, 2);
        isStraight1 = true;
        isStraight2 = true;
      }
    }

    const SVG_NS = "http://www.w3.org/2000/svg";
    const overlay = document.createElementNS(SVG_NS, "g");
    overlay.setAttribute("class", "edge-bend");
    svgEl.appendChild(overlay);

    // Tangent guide lines: source→cp1 and target→cp2. Pointer-inert so they
    // don't intercept clicks on the dots or the edge path beneath them.
    const mkTangent = (x1, y1, x2, y2) => {
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("class", "edge-bend-tangent");
      ln.setAttribute("x1", x1); ln.setAttribute("y1", y1);
      ln.setAttribute("x2", x2); ln.setAttribute("y2", y2);
      return ln;
    };
    if (!sHidden) overlay.appendChild(mkTangent(sxW, syW, c1.x, c1.y));
    if (!tHidden) overlay.appendChild(mkTangent(txW, tyW, c2.x, c2.y));

    const mkHandle = (which, cp, isStraight) => {
      const hit = document.createElementNS(SVG_NS, "circle");
      hit.setAttribute("class", "edge-bend-hit");
      hit.setAttribute("data-cp", String(which));
      hit.setAttribute("cx", cp.x); hit.setAttribute("cy", cp.y);
      hit.setAttribute("r", 10);
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "edge-bend-dot" + (isStraight ? " straight" : ""));
      dot.setAttribute("data-cp", String(which));
      dot.setAttribute("cx", cp.x); dot.setAttribute("cy", cp.y);
      dot.setAttribute("r", 5);
      overlay.appendChild(hit);
      overlay.appendChild(dot);
      const start = (ev) => {
        if (connectingState) return;
        if (!lockHeldByMe()) return;
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        beginBendDrag(ev, soleKey, which);
      };
      hit.addEventListener("pointerdown", start);
      dot.addEventListener("pointerdown", start);
      const resetBend = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (!canWrite || !lockHeldByMe()) return;
        if (!edgeBend[soleKey]) return;
        delete edgeBend[soleKey];
        const e = findEdgeByKey(soleKey);
        if (e) rerouteEdge(e);
        markDirtyLayout();
        renderEdgeBendHandle();
        pushHistory();
      };
      hit.addEventListener("dblclick", resetBend);
      dot.addEventListener("dblclick", resetBend);
    };
    if (!sHidden) mkHandle(1, c1, isStraight1);
    if (!tHidden) mkHandle(2, c2, isStraight2);
  }

  // Screen-space snap threshold (px) for n→0 when Ctrl/Cmd is held — mirrors
  // the modifier convention used by node-drag snap (editor.js:1715).
  const BEND_SNAP_SCREEN_PX = 8;

  function beginBendDrag(downEv, key, which) {
    const svgEl = diagramEl && diagramEl.querySelector("svg");
    if (!svgEl) return;
    const edge = findEdgeByKey(key);
    if (!edge) return;
    const ep = edgeWorldEndpoints(edge);
    if (!ep) return;
    // World endpoints captured up-front; we hold them constant during the
    // drag (nodes can't move while we're dragging a bend handle).
    const { sxW, syW, txW, tyW } = ep;
    let touched = false;

    const onMove = (ev) => {
      ev.preventDefault();
      const p = screenToSvg(svgEl, ev.clientX, ev.clientY);
      const { t, n } = worldToBend(sxW, syW, txW, tyW, p.x, p.y);
      let finalN = n;
      let snapping = false;
      if (ev.ctrlKey || ev.metaKey) {
        const ctm = svgEl.getScreenCTM();
        const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
        if (Math.abs(n) * scale < BEND_SNAP_SCREEN_PX) {
          finalN = 0;
          snapping = true;
        }
      }
      // Start from current bend, or from auto-curve equivalents if the edge
      // has anchor/cluster curvature, otherwise from straight-line defaults.
      let cur = edgeBend[key];
      if (!cur) {
        const auto = autoCurveCps(edge);
        if (auto) {
          const b1 = worldToBend(sxW, syW, txW, tyW, auto.c1.x, auto.c1.y);
          const b2 = worldToBend(sxW, syW, txW, tyW, auto.c2.x, auto.c2.y);
          cur = { t1: b1.t, n1: b1.n, t2: b2.t, n2: b2.n };
        } else {
          cur = { ...BEND_DEFAULT };
        }
      }
      const next = { ...cur };
      if (which === 1) { next.t1 = t; next.n1 = finalN; }
      else { next.t2 = t; next.n2 = finalN; }
      edgeBend[key] = next;
      touched = true;
      rerouteEdge(edge);
      // Live-update overlay positions/classes without rebuilding it.
      const overlay = svgEl.querySelector(":scope > g.edge-bend");
      if (overlay) {
        const c1 = bendCpWorld(sxW, syW, txW, tyW, next, 1);
        const c2 = bendCpWorld(sxW, syW, txW, tyW, next, 2);
        const tans = overlay.querySelectorAll(".edge-bend-tangent");
        if (tans[0]) { tans[0].setAttribute("x2", c1.x); tans[0].setAttribute("y2", c1.y); }
        if (tans[1]) { tans[1].setAttribute("x2", c2.x); tans[1].setAttribute("y2", c2.y); }
        for (const el of overlay.querySelectorAll(`[data-cp="1"]`)) {
          el.setAttribute("cx", c1.x); el.setAttribute("cy", c1.y);
        }
        for (const el of overlay.querySelectorAll(`[data-cp="2"]`)) {
          el.setAttribute("cx", c2.x); el.setAttribute("cy", c2.y);
        }
        const dot1 = overlay.querySelector(`.edge-bend-dot[data-cp="1"]`);
        const dot2 = overlay.querySelector(`.edge-bend-dot[data-cp="2"]`);
        if (dot1) {
          dot1.classList.toggle("straight", Math.abs(next.n1) < 0.01);
          dot1.classList.toggle("snapping", snapping && which === 1);
        }
        if (dot2) {
          dot2.classList.toggle("straight", Math.abs(next.n2) < 0.01);
          dot2.classList.toggle("snapping", snapping && which === 2);
        }
      }
      setStatus(snapping
        ? `bend snap: tangent ${which === 1 ? "source" : "destination"} flat (Ctrl)`
        : `bend cp${which}: t=${t.toFixed(2)} n=${finalN.toFixed(1)}`, false);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (touched) {
        // Collapse to "no entry" when both handles are back at their neutral
        // defaults — keeps storage clean and lets the edge fall through to
        // auto-routing on next load.
        const cur = edgeBend[key];
        if (cur
          && Math.abs(cur.n1) < 0.01 && Math.abs(cur.n2) < 0.01
          && Math.abs(cur.t1 - BEND_DEFAULT.t1) < 0.01
          && Math.abs(cur.t2 - BEND_DEFAULT.t2) < 0.01) {
          delete edgeBend[key];
          rerouteEdge(edge);
        }
        markDirtyLayout();
        pushHistory();
        renderEdgeBendHandle();
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function drawHotspotSet(overlay, n, T, list, endpoint, activeName) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    for (const name of list) {
      const pt = anchorPoint(n, name);
      if (!pt) continue;
      const cx = T.x + pt.x, cy = T.y + pt.y;
      // Transparent larger hit target for easier clicking.
      const hit = document.createElementNS(SVG_NS, "circle");
      hit.setAttribute("class", "hotspot-hit");
      hit.setAttribute("cx", cx);
      hit.setAttribute("cy", cy);
      hit.setAttribute("r", 9);
      // Visible dot.
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "hotspot" + (name === activeName ? " active" : ""));
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("r", name === activeName ? 5.5 : 4);
      const onClick = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        toggleEdgeAnchor(endpoint, name);
      };
      hit.addEventListener("click", onClick);
      dot.addEventListener("click", onClick);
      overlay.appendChild(hit);
      overlay.appendChild(dot);
    }
  }

  // Click handler for a hotspot dot: pin/unpin the edge endpoint to the named
  // anchor. Clicking the currently active anchor returns to auto routing.
  function toggleEdgeAnchor(endpoint, name) {
    if (connectingState) return;
    // Anchors are an affordance of the single-edge bend overlay — the function
    // is only reachable while exactly one edge is selected.
    const key = singleEdgeKey();
    if (!key) return;
    if (!canWrite || !lockHeldByMe()) return;
    const edge = findEdgeByKey(key);
    if (!edge) return;
    const cur = edgeAnchors[key] || {};
    const next = { source: cur.source, target: cur.target };
    if (next[endpoint] === name) {
      delete next[endpoint];
    } else {
      next[endpoint] = name;
    }
    if (!next.source && !next.target) {
      delete edgeAnchors[key];
    } else {
      if (!next.source) delete next.source;
      if (!next.target) delete next.target;
      edgeAnchors[key] = next;
    }
    markDirtyLayout();
    rerouteEdge(edge);
    renderEdgeHotspots();
    pushHistory();
  }

  // ── Cluster bounds & viewbox ────────────────────────────────────────────

  function recomputeViewBoxFromNodes(svgEl) {
    const ids = Object.keys(nodeMap);
    if (ids.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const g = nodeMap[id].g;
      // Hidden inside a collapsed subgraph — excluded so collapsing shrinks the
      // fit instead of reserving empty space for the members.
      if (g.style.display === "none") continue;
      let bb;
      try { bb = g.getBBox(); } catch (_) { continue; }
      const t = g.transform.baseVal.consolidate();
      const tx = t ? t.matrix.e : 0;
      const ty = t ? t.matrix.f : 0;
      const x1 = bb.x + tx, y1 = bb.y + ty;
      const x2 = x1 + bb.width, y2 = y1 + bb.height;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    // Collapsed subgraph boxes aren't in nodeMap; include their visible bg rects
    // so a fully-collapsed region still contributes to the fit.
    for (const cid of collapsedIds) {
      const c = clusterMap[cid];
      if (!c || !c.g || c.g.style.display === "none") continue;
      const b = getClusterRectWorldBbox(c);
      if (!b) continue;
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    if (minX === Infinity) return;
    const pad = 30;
    const x = minX - pad, y = minY - pad;
    const w = (maxX - minX) + 2 * pad;
    const h = (maxY - minY) + 2 * pad;
    initialViewBox = { x, y, width: w, height: h };
    // Preserve the user's current pan/zoom across re-renders (color toggle,
    // edge style, drag commit, etc.). Only fall back to the freshly computed
    // fit bbox on the very first render when no view state exists yet.
    if (!viewState) viewState = { ...initialViewBox };
    svgEl.setAttribute("viewBox",
      `${viewState.x} ${viewState.y} ${viewState.width} ${viewState.height}`);
  }

  function computeMemberWorldBboxFromIds(idsIterable) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const mid of idsIterable) {
      const n = nodeMap[mid];
      if (!n) continue;
      let bb;
      try { bb = n.g.getBBox(); } catch (_) { continue; }
      const t = getNodeTranslate(n.g);
      const x1 = bb.x + t.x, y1 = bb.y + t.y;
      const x2 = x1 + bb.width, y2 = y1 + bb.height;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
      any = true;
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  // World bbox of a cluster's bg rect, in current SVG state. The bg's x/y is
  // g-local; we lift it into TRUE world coords via getWorldTranslate, which
  // walks the full ancestor chain. Critical for NESTED subgraphs: Mermaid wraps
  // a nested cluster in an extra <g class="root" transform="…"> that
  // getNodeTranslate (own transform only) would miss, anchoring the box at the
  // wrong origin (phantom margin) and breaking tracking when it moves.
  function getClusterRectWorldBbox(c) {
    if (!c || !c.bg || c.bg.tagName.toLowerCase() !== "rect") return null;
    const t = getWorldTranslate(c.g);
    const rx = parseFloat(c.bg.getAttribute("x")) || 0;
    const ry = parseFloat(c.bg.getAttribute("y")) || 0;
    const rw = parseFloat(c.bg.getAttribute("width")) || 0;
    const rh = parseFloat(c.bg.getAttribute("height")) || 0;
    return { minX: t.x + rx, minY: t.y + ry, maxX: t.x + rx + rw, maxY: t.y + ry + rh };
  }

  // Bbox a cluster should *enclose with padding*, in TRUE world coords: union
  // of direct child node bboxes plus nested cluster rects. Everything is lifted
  // via getWorldTranslate so direct nodes and nested sub-clusters (which sit
  // under an extra wrapper <g>) are measured in the SAME frame — the old code
  // mixed getNodeTranslate for nodes with a shallow translate for sub-clusters,
  // so a nested subgraph was placed at the wrong offset. updateClusterBounds
  // converts this back into the cluster's parent frame before writing.
  function computeClusterDirectChildrenBbox(clusterId) {
    const c = clusterMap[clusterId];
    if (!c) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    function include(b) {
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
      any = true;
    }
    for (const nid of (c.directNodes || [])) {
      const n = nodeMap[nid];
      if (!n) continue;
      let bb;
      try { bb = n.g.getBBox(); } catch (_) { continue; }
      const t = getWorldTranslate(n.g);
      include({ minX: bb.x + t.x, minY: bb.y + t.y, maxX: bb.x + t.x + bb.width, maxY: bb.y + t.y + bb.height });
    }
    for (const sgId of (c.directSubgraphs || [])) {
      const sb = getClusterRectWorldBbox(clusterMap[sgId]);
      if (sb) include(sb);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  function updateClusterBounds(clusterId) {
    const c = clusterMap[clusterId];
    if (!c || !c.bg || !c.padding) return;
    if (c.bg.tagName.toLowerCase() !== "rect") return;
    // A collapsed cluster has its members hidden; its box is a fixed node-sized
    // rect placed by applyCollapsedState, so don't re-grow it from (empty)
    // children here.
    if (collapsedIds.has(clusterId)) return;
    const mb = computeClusterDirectChildrenBbox(clusterId);
    if (!mb) return;
    const pad = c.padding;
    // mb is in world coords; the cluster's transform is interpreted in its
    // PARENT's frame, so subtract the parent's world offset. Top-level clusters
    // have their direct nodes in the same frame as the parent, so this cancels
    // out (identical to the old behaviour); nested clusters get the wrapper <g>
    // offset correctly accounted for.
    const parentW = getWorldTranslate(c.g.parentNode);
    const newCx = mb.minX - pad.left - pad.rx - parentW.x;
    const newCy = mb.minY - pad.top - pad.ry - parentW.y;
    const newW = (mb.maxX - mb.minX) + pad.left + pad.right;
    const newH = (mb.maxY - mb.minY) + pad.top + pad.bottom;
    setNodeTranslate(c.g, newCx, newCy);
    c.bg.setAttribute("width", newW);
    c.bg.setAttribute("height", newH);
    // Center the title horizontally in the bg, vertically in the top band.
    // Using the live label bbox rather than a captured offset means the title
    // always sits at the visual center of our (normalized) top margin, even
    // when the bg width/height change as nodes are added or moved.
    if (c.label) {
      let lbb;
      try { lbb = c.label.getBBox(); } catch (_) { lbb = null; }
      if (lbb) {
        setNodeTranslate(c.label,
          pad.rx + newW / 2 - (lbb.x + lbb.width / 2),
          pad.ry + pad.top / 2 - (lbb.y + lbb.height / 2)
        );
      }
    }
    // Cluster geometry changed → edges connecting to/from this cluster need reroute.
    if (c.incomingEdges) for (const e of c.incomingEdges) rerouteEdge(e);
    if (c.outgoingEdges) for (const e of c.outgoingEdges) rerouteEdge(e);
  }

  function updateAllClusterBounds() {
    // Innermost first: a cluster whose member set is a subset of another's is inner.
    // Approximate by sorting ascending by member-set size — innermost (smaller
    // member sets) get updated first so outer clusters see fresh inner positions.
    const ids = Object.keys(clusterMap).sort(
      (a, b) => (clusterMap[a].members.size || 0) - (clusterMap[b].members.size || 0)
    );
    for (const id of ids) updateClusterBounds(id);
  }

  function rerouteNodeEdges(id) {
    const n = nodeMap[id];
    if (!n) return;
    for (const e of n.incomingEdges) rerouteEdge(e);
    for (const e of n.outgoingEdges) rerouteEdge(e);
  }

  // ── Drag handlers ───────────────────────────────────────────────────────

  function attachDragHandlers(svgEl) {
    for (const [id, n] of Object.entries(nodeMap)) {
      n.g.addEventListener("pointerdown", (ev) => startDrag(ev, svgEl, id));
    }
  }

  function attachClusterHandlers(svgEl) {
    for (const [id, c] of Object.entries(clusterMap)) {
      const target = c.bg || c.g;
      target.style.cursor = "pointer";
      target.style.pointerEvents = "auto";
      const onClusterPointerDown = (ev) => {
        if (ev.target.closest("g.node")) return;
        // Mouse: ignore non-primary buttons. Touch/pen: button is 0 only on
        // the primary contact, which is what we want.
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        if (!ev.isPrimary) return;
        // Modifier held (shift/ctrl/cmd): no drag, toggle additive on
        // pointerup. Lets the user add this subgraph to an existing
        // node-or-cluster multi-selection (mixed group).
        const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (additive) {
          ev.preventDefault(); ev.stopPropagation();
          const pointerId = ev.pointerId;
          function onUpAdditive(e) {
            if (e && e.pointerId !== pointerId) return;
            document.removeEventListener("pointerup", onUpAdditive);
            document.removeEventListener("pointercancel", onUpAdditive);
            toggleClusterSelection(id, true);
          }
          document.addEventListener("pointerup", onUpAdditive);
          document.addEventListener("pointercancel", onUpAdditive);
          return;
        }
        if (isReadOnly) {
          // Spectator: select-only, no drag.
          ev.preventDefault(); ev.stopPropagation();
          const pointerId = ev.pointerId;
          function onUpRO(e) {
            if (e && e.pointerId !== pointerId) return;
            document.removeEventListener("pointerup", onUpRO);
            document.removeEventListener("pointercancel", onUpRO);
            toggleClusterSelection(id);
          }
          document.addEventListener("pointerup", onUpRO);
          document.addEventListener("pointercancel", onUpRO);
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        if (connectingState === "edge-target") { handleConnectClick(id); return; }
        if (connectingState === "move-target") { handleMoveTargetClick(id); return; }
        if (connectingState) return;
        startClusterDrag(ev, svgEl, id);
      };
      target.addEventListener("pointerdown", onClusterPointerDown);
      // The title sits on top of the bg and would otherwise swallow the press,
      // leaving only a thin grabbable border (worst on a fixed-size collapsed
      // capsule). Let a press on the title drag the box too; dblclick-to-rename
      // is wired separately on the label text and still fires.
      if (c.label) {
        c.label.style.pointerEvents = "auto";
        c.label.style.cursor = "pointer";
        c.label.addEventListener("pointerdown", onClusterPointerDown);
      }
    }
  }

  function startClusterDrag(ev, svgEl, id) {
    const c = clusterMap[id];
    if (!c) return;
    const pointerId = ev.pointerId;
    // Eager select-on-press: if this cluster isn't already part of the
    // current selection, replace selection with just [id] (Figma-style plain
    // click). If it is already selected (possibly in a mixed group with
    // nodes/other clusters), preserve the selection and drag the whole set.
    let selectedOnDown = false;
    if (!selectedClusterIds.has(id)) {
      toggleClusterSelection(id, false);
      selectedOnDown = true;
    }
    // Build the group: every selected cluster's bg follows the drag (for
    // non-rect bgs), plus the UNION of all members across selected clusters
    // and all individually selected nodes. Dedup by node id.
    const groupClusters = [];
    for (const cid of selectedClusterIds) {
      const cc = clusterMap[cid];
      if (!cc) continue;
      groupClusters.push({ id: cid, c: cc, origin: getNodeTranslate(cc.g) });
    }
    const memberSet = new Set();
    for (const cid of selectedClusterIds) {
      for (const mid of findSubgraphMembers(currentSource, cid)) memberSet.add(mid);
    }
    for (const nid of selectedNodeIds) memberSet.add(nid);
    const memberStates = [];
    for (const mid of memberSet) {
      const n = nodeMap[mid];
      if (!n) continue;
      const t = getNodeTranslate(n.g);
      memberStates.push({ id: mid, n, originX: t.x, originY: t.y });
    }
    const start = screenToSvg(svgEl, ev.clientX, ev.clientY);
    let moved = false;

    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      const cur = screenToSvg(svgEl, e.clientX, e.clientY);
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      if (!moved && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) moved = true;
      // Move members manually; the dragged clusters (and any nested/outer
      // clusters that share members with them) will be repositioned by
      // updateAllClusterBounds below, which derives each cluster's box
      // from its current members. The fallback setNodeTranslate keeps
      // non-rect cluster bgs (polygon/path) following the drag.
      for (const gc of groupClusters) {
        setNodeTranslate(gc.c.g, gc.origin.x + dx, gc.origin.y + dy);
      }
      for (const m of memberStates) {
        setNodeTranslate(m.n.g, m.originX + dx, m.originY + dy);
        rerouteNodeEdges(m.id);
      }
      // Recompute every cluster's bounds: the dragged cluster's outer
      // ancestors need to grow/shrink, and its inner descendants need
      // their own bg rect to follow the moved members.
      updateAllClusterBounds();
      // Edges incident to any selected cluster itself (cluster↔cluster or
      // cluster↔node) aren't on any member's edge list — reroute explicitly.
      for (const gc of groupClusters) {
        if (gc.c.incomingEdges) for (const e of gc.c.incomingEdges) rerouteEdge(e);
        if (gc.c.outgoingEdges) for (const e of gc.c.outgoingEdges) rerouteEdge(e);
      }
      // Collapsed child boxes follow their moved members during the drag.
      repositionVisibleCollapsedBoxes();
      renderCollapseButtons();
    }
    function onUp(e) {
      if (e && e.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (!moved) {
        // Click without drag: if we already selected on pointerdown, leave
        // the cluster selected; otherwise toggle (re-click to deselect).
        if (!selectedOnDown) toggleClusterSelection(id, false);
        return;
      }
      let changed = 0;
      for (const m of memberStates) {
        const t = getNodeTranslate(m.n.g);
        if (t.x !== m.originX || t.y !== m.originY) {
          // Save the collapsed-baseline LOCAL position: strip the z-raise frame
          // offset (for nested raised nodes) and any transient expansion push so
          // positions{} stays the canonical (collapsed) layout.
          positions[m.id] = computeBaselinePosition(m.id, t);
          changed++;
        }
      }
      if (changed > 0) {
        markDirtyLayout();
        pushHistory();
        setStatus(`subgraph ${id}: moved ${changed} nodes`, false);
      }
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function screenToSvg(svgEl, clientX, clientY) {
    const pt = svgEl.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  // Threshold (in SVG world coords) for axis-aligned snap to a connected
  // node's center while dragging with Ctrl/Cmd held.
  const SNAP_THRESHOLD = 20;

  function startDrag(ev, svgEl, id) {
    if (connectingState) {
      ev.preventDefault();
      handleConnectClick(id);
      return;
    }
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (!ev.isPrimary) return;
    if (isReadOnly) {
      // Spectator: select-only on click, no drag.
      ev.preventDefault();
      const pointerId = ev.pointerId;
      function onUpRO(e) {
        if (e && e.pointerId !== pointerId) return;
        document.removeEventListener("pointerup", onUpRO);
        document.removeEventListener("pointercancel", onUpRO);
        toggleNodeSelection(id, e.ctrlKey || e.metaKey || e.shiftKey);
      }
      document.addEventListener("pointerup", onUpRO);
      document.addEventListener("pointercancel", onUpRO);
      return;
    }
    ev.preventDefault();
    const pointerId = ev.pointerId;

    // Shift-only+down (no Ctrl/Cmd): "no-drag, just toggle multi-select".
    // Ctrl+Shift falls through to the drag path so it can be used for the
    // wide-snap mode (snap to every node/cluster, not just connected peers).
    if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      function onUpAdditive(e) {
        if (e && e.pointerId !== pointerId) return;
        document.removeEventListener("pointerup", onUpAdditive);
        document.removeEventListener("pointercancel", onUpAdditive);
        toggleNodeSelection(id, true);
      }
      document.addEventListener("pointerup", onUpAdditive);
      document.addEventListener("pointercancel", onUpAdditive);
      return;
    }

    const n = nodeMap[id];
    // Eager select-on-press: if no modifier is held and the node isn't
    // already part of the current selection, select it right now so the
    // user has visual feedback during the drag and the node stays selected
    // after the drag completes. With a modifier (Ctrl/Cmd → additive
    // toggle on click) we defer to the mouseup path so the existing
    // multi-select semantics are preserved. The shift-only branch above
    // returns earlier and never reaches this point.
    const noModifier = !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
    let selectedOnDown = false;
    if (noModifier && !selectedNodeIds.has(id)) {
      toggleNodeSelection(id, false);
      selectedOnDown = true;
    }
    // Group drag: pointerdown on a node that's part of an existing
    // multi-selection drags every selected node by the same delta — same
    // ergonomics as if they were inside a virtual subgraph. If the current
    // selection is mixed (nodes + subgraphs), the cluster members are pulled
    // in too so the whole block moves rigidly. Pointerdown on a non-selected
    // node falls back to single-node drag.
    const nodeIsInSelection = selectedNodeIds.has(id);
    const hasMixedClusters = nodeIsInSelection && selectedClusterIds.size > 0;
    const draggingGroup = (nodeIsInSelection && selectedNodeIds.size > 1) || hasMixedClusters;
    const groupNodeSet = new Set();
    if (draggingGroup) {
      for (const nid of selectedNodeIds) groupNodeSet.add(nid);
      for (const cid of selectedClusterIds) {
        for (const mid of findSubgraphMembers(currentSource, cid)) groupNodeSet.add(mid);
      }
    } else {
      groupNodeSet.add(id);
    }
    const groupStates = [];
    for (const gid of groupNodeSet) {
      const ng = nodeMap[gid];
      if (!ng) continue;
      groupStates.push({ id: gid, n: ng, origin: getNodeTranslate(ng.g) });
    }
    // Non-rect cluster bgs (polygon/path) need their own translate too — for
    // rect bgs updateAllClusterBounds repaints them from member positions.
    const groupClusters = [];
    if (draggingGroup) {
      for (const cid of selectedClusterIds) {
        const cc = clusterMap[cid];
        if (!cc) continue;
        groupClusters.push({ id: cid, c: cc, origin: getNodeTranslate(cc.g) });
      }
    }
    const groupIds = new Set(groupStates.map(gs => gs.id));

    // Connected peers (nodes AND clusters) reachable via incoming/outgoing
    // edges of the *primary* node — narrow snap targets for Ctrl/Cmd alone.
    // We exclude any peer that's also being dragged, since the group moves
    // as a rigid unit and snapping to a moving member is meaningless.
    const connectedIds = new Set();
    for (const e of n.incomingEdges) connectedIds.add(e.source === id ? e.target : e.source);
    for (const e of n.outgoingEdges) connectedIds.add(e.source === id ? e.target : e.source);
    for (const gid of groupIds) connectedIds.delete(gid);
    const parentT = getElementParentTranslate(n.g);

    n.g.classList.add("dragging");
    const start = screenToSvg(svgEl, ev.clientX, ev.clientY);
    const origin = getNodeTranslate(n.g);

    // Snap target center for any peer id — node center (uses local bbox)
    // or cluster bg-rect center.
    function peerCenter(pid) {
      if (nodeMap[pid]) return nodeCenter(pid);
      const c = clusterMap[pid];
      if (c) {
        const bb = getClusterRectWorldBbox(c);
        if (!bb) return null;
        return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
      }
      return null;
    }

    // Snap modes:
    //   Ctrl/Cmd        → connected peers only (focused)
    //   Ctrl/Cmd+Shift  → every node + every cluster (broad)
    function applySnap(nx, ny, e) {
      if (!(e.ctrlKey || e.metaKey)) {
        return { nx, ny, snapX: null, snapY: null };
      }
      const wide = e.shiftKey;
      let candidates;
      if (wide) {
        candidates = new Set([
          ...Object.keys(nodeMap),
          ...Object.keys(clusterMap),
        ]);
        for (const gid of groupIds) candidates.delete(gid);
      } else {
        candidates = connectedIds;
      }
      if (candidates.size === 0) return { nx, ny, snapX: null, snapY: null };
      const cx = parentT.x + nx + n.centerLocal.x;
      const cy = parentT.y + ny + n.centerLocal.y;
      let bestDx = 0, bestDxAbs = Infinity, snapX = null;
      let bestDy = 0, bestDyAbs = Infinity, snapY = null;
      for (const pid of candidates) {
        const cc = peerCenter(pid);
        if (!cc) continue;
        const dx = cc.x - cx, dy = cc.y - cy;
        const adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx <= SNAP_THRESHOLD && adx < bestDxAbs) { bestDxAbs = adx; bestDx = dx; snapX = pid; }
        if (ady <= SNAP_THRESHOLD && ady < bestDyAbs) { bestDyAbs = ady; bestDy = dy; snapY = pid; }
      }
      return { nx: nx + bestDx, ny: ny + bestDy, snapX, snapY };
    }

    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      const cur = screenToSvg(svgEl, e.clientX, e.clientY);
      let nx = origin.x + (cur.x - start.x);
      let ny = origin.y + (cur.y - start.y);
      const snap = applySnap(nx, ny, e);
      nx = snap.nx; ny = snap.ny;
      // Apply the same world-space delta to every group member so they
      // move as a rigid unit. Each member's parent translate doesn't
      // change during a drag, so adding world delta to local origin is OK.
      const dx = nx - origin.x, dy = ny - origin.y;
      for (const gs of groupStates) {
        setNodeTranslate(gs.n.g, gs.origin.x + dx, gs.origin.y + dy);
        rerouteNodeEdges(gs.id);
      }
      for (const gc of groupClusters) {
        setNodeTranslate(gc.c.g, gc.origin.x + dx, gc.origin.y + dy);
      }
      updateAllClusterBounds();
      for (const gc of groupClusters) {
        if (gc.c.incomingEdges) for (const e of gc.c.incomingEdges) rerouteEdge(e);
        if (gc.c.outgoingEdges) for (const e of gc.c.outgoingEdges) rerouteEdge(e);
      }
      repositionVisibleCollapsedBoxes();
      renderCollapseButtons();
      n.g.classList.toggle("snapping", !!(snap.snapX || snap.snapY));
      if (snap.snapX || snap.snapY) {
        const parts = [];
        if (snap.snapX) parts.push(`x=${snap.snapX}`);
        if (snap.snapY) parts.push(`y=${snap.snapY}`);
        setStatus(`${id} snap → ${parts.join(", ")}`, false);
      }
    }
    function onUp(e) {
      if (e && e.pointerId !== pointerId) return;
      n.g.classList.remove("dragging");
      n.g.classList.remove("snapping");
      const t = getNodeTranslate(n.g);
      const moved = t.x !== origin.x || t.y !== origin.y;
      if (moved) {
        for (const gs of groupStates) {
          const gt = getNodeTranslate(gs.n.g);
          // Strip z-raise frame offset + transient expansion → collapsed baseline.
          positions[gs.id] = computeBaselinePosition(gs.id, gt);
        }
        markDirtyLayout();
        pushHistory();
        if (draggingGroup) {
          setStatus(`${groupStates.length} nodes moved`, false);
        } else {
          setStatus(`${id} → (${t.x.toFixed(0)}, ${t.y.toFixed(0)})`, false);
        }
      } else if (!selectedOnDown) {
        // No movement and we didn't already select on pointerdown: treat as
        // a click. Modifier-click toggles multi-selection; plain click on
        // the already-only-selected node deselects it.
        toggleNodeSelection(id, e.ctrlKey || e.metaKey || e.shiftKey);
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  // ── Label editing ────────────────────────────────────────────────────────

  function findLabelTextElement(container) {
    return (
      container.querySelector("foreignObject span.nodeLabel, foreignObject span.edgeLabel") ||
      container.querySelector("foreignObject span, foreignObject p, foreignObject div") ||
      container.querySelector("text")
    );
  }
  function getLabelText(el) { return (el.textContent || "").replace(/\s+/g, " ").trim(); }
  function regexEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function validateLabelForShape(label, shape) {
    if (/[|\n]/.test(label)) return "label cannot contain | or newline";
    for (const ch of shape.close) {
      if (label.includes(ch)) {
        return `label cannot contain '${ch}' (closer for shape ${shape.name})`;
      }
    }
    return null;
  }

  // Detect the SHAPES entry actually used in `nodeId`'s declaration. Tries
  // shapes longest-open-first so `((` wins over `(` etc. Returns null if the
  // node has no declaration in source (shouldn't happen for known nodes).
  function detectNodeShapeInSource(source, nodeId) {
    const idEsc = regexEscape(nodeId);
    const shapesByLen = [...SHAPES].sort((a, b) => b.open.length - a.open.length);
    for (const shape of shapesByLen) {
      const openEsc = regexEscape(shape.open);
      const closeEsc = regexEscape(shape.close);
      const re = new RegExp(`\\b${idEsc}\\s*${openEsc}([^]*?)${closeEsc}`);
      if (re.test(source)) return shape;
    }
    return null;
  }

  // Extract the current label of `nodeId` from its declaration. Returns the
  // raw label text (empty string if none) or null if the node isn't declared.
  function getNodeLabelInSource(source, nodeId) {
    const shape = detectNodeShapeInSource(source, nodeId);
    if (!shape) return null;
    const idEsc = regexEscape(nodeId);
    const openEsc = regexEscape(shape.open);
    const closeEsc = regexEscape(shape.close);
    const re = new RegExp(`\\b${idEsc}\\s*${openEsc}([^]*?)${closeEsc}`);
    const m = source.match(re);
    return m ? m[1] : null;
  }

  // Extract the current bracketed title of `subgraphId`. Returns "" if the
  // header has no `[title]`, or null if the subgraph isn't declared.
  function getSubgraphTitleInSource(source, subgraphId) {
    const idEsc = regexEscape(subgraphId);
    const re = new RegExp(`^\\s*subgraph\\s+${idEsc}(?:\\s*\\[([^\\]\\n]*)\\])?\\s*$`, "im");
    const m = source.match(re);
    if (!m) return null;
    return m[1] || "";
  }

  // Rewrite a node declaration's label *and* shape in one shot. Same single-
  // match guarantee as rewriteNodeLabelInSource: refuses if the id has zero
  // or multiple declarations.
  function rewriteNodeDeclInSource(source, nodeId, newLabel, newShape) {
    const idEsc = regexEscape(nodeId);
    const shapesByLen = [...SHAPES].sort((a, b) => b.open.length - a.open.length);
    let winnerMatch = null, winnerCount = 0;
    for (const shape of shapesByLen) {
      const openEsc = regexEscape(shape.open);
      const closeEsc = regexEscape(shape.close);
      const re = new RegExp(`\\b${idEsc}(\\s*)${openEsc}([^]*?)${closeEsc}`, "g");
      const matches = [...source.matchAll(re)];
      if (matches.length === 0) continue;
      if (!winnerMatch) { winnerMatch = matches[0]; winnerCount = matches.length; }
    }
    if (!winnerMatch) return { ok: false, error: `node ${nodeId}: declaration not found` };
    if (winnerCount > 1) return { ok: false, error: `node ${nodeId}: ambiguous (${winnerCount} match)` };
    const err = validateLabelForShape(newLabel, newShape);
    if (err) return { ok: false, error: err };
    const m = winnerMatch;
    const before = source.slice(0, m.index);
    const after = source.slice(m.index + m[0].length);
    const newDecl = `${nodeId}${m[1]}${newShape.open}${newLabel}${newShape.close}`;
    return { ok: true, source: before + newDecl + after };
  }

  // Whole-word replace of `oldId` with `newId` in a single source line,
  // skipping anything that lives inside a label container (`[...]`, `(...)`,
  // `{...}`, `|...|`). Brackets nest naturally for `(([...]))` etc. — depth
  // counts every opener regardless of kind. Used by renameIdInSource to swap
  // ids in edge operands and bare subgraph-member lines without touching
  // label text that happens to contain the same word.
  function replaceIdOutsideLabels(line, oldId, newId) {
    let out = "";
    let depth = 0;
    let inPipe = false;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (inPipe) {
        if (ch === "|") inPipe = false;
        out += ch; i++; continue;
      }
      if (ch === "|") { inPipe = true; out += ch; i++; continue; }
      if (ch === "[" || ch === "(" || ch === "{") { depth++; out += ch; i++; continue; }
      if (ch === "]" || ch === ")" || ch === "}") { if (depth > 0) depth--; out += ch; i++; continue; }
      if (depth === 0 && /[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < line.length && /\w/.test(line[j])) j++;
        const word = line.slice(i, j);
        out += (word === oldId) ? newId : word;
        i = j; continue;
      }
      out += ch; i++;
    }
    return out;
  }

  // Rename `oldId` → `newId` everywhere it can appear in the Mermaid source:
  //   - node declaration line (`oldId[label]`, `oldId((label))`, …)
  //   - subgraph header (`subgraph oldId [title]`)
  //   - subgraph member line (bare `oldId` on its own line)
  //   - edge operands (both sides, including chains like `A --> oldId --> B`)
  //   - per-element style line (`style oldId fill:…`)
  //   - note line (`%% oldId free text`)
  //
  // Lines that start with reserved tokens (`flowchart`/`graph`/`direction`)
  // are passed through untouched, so a `flowchart TD` header isn't smashed
  // if a node happens to be called `TD`.
  function renameIdInSource(source, oldId, newId) {
    if (oldId === newId) return { ok: true, source };
    if (!/^[A-Za-z_][\w]*$/.test(newId)) return { ok: false, error: __("editor.err.id_invalid", newId) };
    if (nodeMap[newId] || clusterMap[newId]) return { ok: false, error: __("editor.err.id_exists", newId) };

    const oldEsc = regexEscape(oldId);
    const noteRe = new RegExp(`^(\\s*%%\\s+)${oldEsc}(\\s.*|\\s*)$`);
    const styleRe = new RegExp(`^(\\s*style\\s+)${oldEsc}(\\b.*)$`);
    const headerKeywordRe = /^\s*(flowchart|graph|direction)\b/i;

    const lines = source.split("\n").map(line => {
      if (headerKeywordRe.test(line)) return line;
      let m = line.match(noteRe);
      if (m) return `${m[1]}${newId}${m[2]}`;
      m = line.match(styleRe);
      if (m) return `${m[1]}${newId}${m[2]}`;
      return replaceIdOutsideLabels(line, oldId, newId);
    });
    return { ok: true, source: lines.join("\n") };
  }

  function rewriteSubgraphLabelInSource(source, id, newLabel) {
    if (/[\]\n]/.test(newLabel)) return { ok: false, error: "label subgraph: niente ] o newline" };
    const idEsc = regexEscape(id);
    // Match a subgraph header line for this id, with optional bracketed title.
    // Handles: `subgraph ID`, `subgraph ID [Old]`, with leading whitespace.
    const re = new RegExp(`^(\\s*subgraph\\s+${idEsc})(\\s*\\[[^\\]\\n]*\\])?(\\s*)$`, "im");
    const lines = source.split("\n");
    let matchIdx = -1, matchCount = 0, leading = "", trailing = "";
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      matchCount++;
      if (matchIdx === -1) { matchIdx = i; leading = m[1]; trailing = m[3] || ""; }
    }
    if (matchCount === 0) {
      return { ok: false, error: `subgraph ${id}: header not found ('subgraph "Title"' form not supported)` };
    }
    if (matchCount > 1) return { ok: false, error: `subgraph ${id}: ambiguous header (${matchCount} match)` };
    const newLine = newLabel === ""
      ? `${leading}${trailing}`
      : `${leading} [${newLabel}]${trailing}`;
    lines[matchIdx] = newLine;
    return { ok: true, source: lines.join("\n") };
  }

  // Connector body pattern for Mermaid edges. Covers forward (-->), no-arrow
  // (---), bidirectional (<-->), dashed/solid/thick variants, and the {x,o}
  // arrowhead glyphs. Used in line-based source edits.
  const EDGE_CONN = "<?[-=.~][-=.~<>xo]*";

  // Line-based edge label rewrite. Handles:
  //   - existing label  → replace
  //   - missing label   → insert |newLabel|
  //   - newLabel === '' → remove existing label (leaving plain edge)
  // Disambiguates multiple <src>→<tgt> via ordinal (matches the same scan as
  // deleteEdgeFromSource). Refuses chain lines (A --> B --> C).
  function rewriteEdgeLabelInSource(source, src, tgt, ordinal, newLabel) {
    if (/[|\n]/.test(newLabel)) return { ok: false, error: "edge label: niente | o newline" };
    const sEsc = regexEscape(src), tEsc = regexEscape(tgt);
    const edgeRe = new RegExp(`\\b${sEsc}\\b\\s*${EDGE_CONN}\\s*\\b${tEsc}\\b`);
    const lines = source.split("\n");
    let matched = 0;
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripEdgeLabels(lines[i])
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
      if (!edgeRe.test(stripped)) continue;
      if (matched !== ordinal) { matched++; continue; }
      const arrowSegs = (stripped.match(new RegExp(`${EDGE_CONN}\\s*\\w+`, "g")) || []).length;
      if (arrowSegs > 1) {
        return { ok: false, error: "edge in chain: split the line to modify its label" };
      }
      const re = new RegExp(`(\\b${sEsc})(\\s+)(${EDGE_CONN})(\\s*)(?:\\|([^|\\n]*)\\|(\\s*))?(${tEsc}\\b)`);
      const m = lines[i].match(re);
      if (!m) return { ok: false, error: `edge ${src}→${tgt}: internal pattern not found` };
      const arrow = m[3];
      const rebuilt = newLabel === ""
        ? `${m[1]} ${arrow} ${m[7]}`
        : `${m[1]} ${arrow}|${newLabel}| ${m[7]}`;
      lines[i] = lines[i].replace(re, rebuilt);
      return { ok: true, source: lines.join("\n") };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} not found` };
  }

  // Toggle edge style between solid and dashed for a specific (src,tgt,ordinal)
  // edge, line-based. Supports common connector forms only; thick (==>) and
  // less common variants are refused with an explanatory error.
  function toggleEdgeStyleInSource(source, src, tgt, ordinal) {
    const STYLE_TOGGLE = {
      "-->": "-.->",
      "-.->": "-->",
      "---": "-.-",
      "-.-": "---",
      "<-->": "<-.->",
      "<-.->": "<-->",
    };
    return mutateEdgeConnector(source, src, tgt, ordinal, STYLE_TOGGLE,
      "style", "only --> ↔ -.->, --- ↔ -.-, <--> ↔ <-.->");
  }

  // Cycle the arrowhead through forward → none → both, preserving solid/dashed.
  function cycleEdgeArrowInSource(source, src, tgt, ordinal) {
    const ARROW_CYCLE = {
      "-->": "---",
      "---": "<-->",
      "<-->": "-->",
      "-.->": "-.-",
      "-.-": "<-.->",
      "<-.->": "-.->",
    };
    return mutateEdgeConnector(source, src, tgt, ordinal, ARROW_CYCLE,
      "arrow", "only solid/dashed connectors");
  }

  // Shared scaffolding for connector mutations: locate the (src,tgt,ordinal)
  // edge line, refuse chains, look up new connector in `cycleMap`.
  function mutateEdgeConnector(source, src, tgt, ordinal, cycleMap, opName, supportedHint) {
    const sEsc = regexEscape(src), tEsc = regexEscape(tgt);
    const edgeRe = new RegExp(`\\b${sEsc}\\b\\s*${EDGE_CONN}\\s*\\b${tEsc}\\b`);
    const lines = source.split("\n");
    let matched = 0;
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripEdgeLabels(lines[i])
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
      if (!edgeRe.test(stripped)) continue;
      if (matched !== ordinal) { matched++; continue; }
      const arrowSegs = (stripped.match(new RegExp(`${EDGE_CONN}\\s*\\w+`, "g")) || []).length;
      if (arrowSegs > 1) {
        return { ok: false, error: `edge in chain: split the line to change ${opName}` };
      }
      const re = new RegExp(`(\\b${sEsc}\\s+)(${EDGE_CONN})(\\s*(?:\\|[^|\\n]*\\|\\s*)?${tEsc}\\b)`);
      const m = lines[i].match(re);
      if (!m) return { ok: false, error: `edge ${src}→${tgt}: internal pattern not found` };
      const newConn = cycleMap[m[2]];
      if (!newConn) return { ok: false, error: `connector '${m[2]}': ${opName} not supported (${supportedHint})` };
      lines[i] = lines[i].replace(re, `${m[1]}${newConn}${m[3]}`);
      return { ok: true, source: lines.join("\n"), from: m[2], to: newConn };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} not found` };
  }

  // Reverse an edge by swapping src and tgt operands in the source line.
  // The connector form is preserved, so `<-->` stays bidirectional; for
  // forward arrows the visual flips because the endpoints are swapped.
  // Also returns `newOrdinal`: the index of the rewritten edge among other
  // (tgt,src) edges in source order, so the caller can keep selection.
  function reverseEdgeInSource(source, src, tgt, ordinal) {
    const sEsc = regexEscape(src), tEsc = regexEscape(tgt);
    const edgeRe = new RegExp(`\\b${sEsc}\\b\\s*${EDGE_CONN}\\s*\\b${tEsc}\\b`);
    // Pattern for the swapped direction (tgt → src), used to count the new
    // edge's ordinal after the rewrite.
    const swapRe = new RegExp(`\\b${tEsc}\\b\\s*${EDGE_CONN}\\s*\\b${sEsc}\\b`);
    const lines = source.split("\n");
    let matched = 0;
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripEdgeLabels(lines[i])
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
      if (!edgeRe.test(stripped)) continue;
      if (matched !== ordinal) { matched++; continue; }
      const arrowSegs = (stripped.match(new RegExp(`${EDGE_CONN}\\s*\\w+`, "g")) || []).length;
      if (arrowSegs > 1) {
        return { ok: false, error: "edge in chain: split the line to reverse" };
      }
      const re = new RegExp(`(\\b)(${sEsc})(\\s+${EDGE_CONN}\\s*(?:\\|[^|\\n]*\\|\\s*)?)(${tEsc})(\\b)`);
      const m = lines[i].match(re);
      if (!m) return { ok: false, error: `edge ${src}→${tgt}: internal pattern not found` };
      lines[i] = lines[i].replace(re, `${m[1]}${m[4]}${m[3]}${m[2]}${m[5]}`);
      // Count pre-existing (tgt,src) edges in source lines before i — that's
      // the new edge's ordinal after the rewrite. Mermaid render order tracks
      // source line order, so this matches the ordinal in the rebuilt SVG.
      let newOrdinal = 0;
      for (let j = 0; j < i; j++) {
        const sj = stripEdgeLabels(lines[j])
          .replace(/\[[^\]\n]*\]/g, " ")
          .replace(/\([^)\n]*\)/g, " ")
          .replace(/\{[^}\n]*\}/g, " ");
        if (swapRe.test(sj)) newOrdinal++;
      }
      return { ok: true, source: lines.join("\n"), newOrdinal };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} not found` };
  }

  // Open inline editor at the curve midpoint to add/edit/remove an edge label.
  // Works for edges with or without an existing label.
  async function startEdgeLabelEdit(edge) {
    if (!requireValidSource("edit edge label")) return;
    const path = edge.path;
    let screenX, screenY;
    try {
      const len = path.getTotalLength();
      const pt = path.getPointAtLength(len / 2);
      const ctm = path.getScreenCTM();
      if (!ctm) return;
      screenX = pt.x * ctm.a + pt.y * ctm.c + ctm.e;
      screenY = pt.x * ctm.b + pt.y * ctm.d + ctm.f;
    } catch (_) {
      return;
    }
    const initialText = edge.label
      ? getLabelText(findLabelTextElement(edge.label) || edge.label)
      : "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = initialText;
    input.placeholder = __("editor.edge_label_placeholder");
    Object.assign(input.style, {
      position: "fixed",
      left: `${screenX - 80}px`,
      top: `${screenY - 14}px`,
      minWidth: "160px",
      height: "28px",
      fontSize: "14px", padding: "2px 6px",
      border: "2px solid #5e81ac", background: "#1c242e",
      color: "#eceff4", zIndex: "1000", borderRadius: "3px", fontFamily: "inherit",
    });
    document.body.appendChild(input);
    input.focus(); input.select();
    let done = false;
    function cleanup() {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      if (input.parentNode) input.parentNode.removeChild(input);
    }
    function cancel() { if (done) return; done = true; cleanup(); }
    async function commit() {
      if (done) return;
      done = true;
      const newText = input.value;
      cleanup();
      if (newText === initialText) return;
      const result = rewriteEdgeLabelInSource(currentSource, edge.source, edge.target, edge.ordinal, newText);
      if (!result.ok) { setStatus(__("editor.err.edit_rejected", result.error), true); return; }
      currentSource = result.source;
      markDirtySource();
      await renderDiagram();
      pushHistory();
      const lbl = `${edge.source}→${edge.target}`;
      if (newText === "") setStatus(`${lbl}: label removed`);
      else if (initialText === "") setStatus(`${lbl}: + "${newText}"`);
      else setStatus(`${lbl}: "${initialText}" → "${newText}"`);
    }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    function onBlur() { commit(); }
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }

  async function applyToggleEdgeStyle() {
    const key = singleEdgeKey();
    if (!key) { setStatus(__("editor.err.select_edge"), true); return; }
    if (!requireValidSource("toggle edge style")) return;
    const edge = findEdgeByKey(key);
    if (!edge) return;
    const result = toggleEdgeStyleInSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`toggle style: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(`${edge.source}→${edge.target}: ${result.from} → ${result.to}`);
  }

  async function applyCycleEdgeArrow() {
    const key = singleEdgeKey();
    if (!key) { setStatus(__("editor.err.select_edge"), true); return; }
    if (!requireValidSource("cycle edge arrow")) return;
    const edge = findEdgeByKey(key);
    if (!edge) return;
    const result = cycleEdgeArrowInSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`arrow: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(`${edge.source}→${edge.target}: ${result.from} → ${result.to}`);
  }

  // Reverse swaps src↔tgt in the source line. The edge identity changes, so
  // we re-key the selection to (tgt, src, newOrdinal) before re-rendering;
  // renderDiagram will re-apply selection visuals from selectedEdgeKeys.
  // Layout entries (anchors/bend/styles) keyed by `src|tgt|ord` would
  // otherwise be pruned as orphans after the rewrite — migrate them onto the
  // new key with the appropriate geometric transform, and shift the ordinals
  // of the other (s,t) / (t,s) edges that get renumbered by the swap.
  async function applyReverseEdge() {
    const key = singleEdgeKey();
    if (!key) { setStatus(__("editor.err.select_edge"), true); return; }
    if (!requireValidSource("reverse edge")) return;
    const edge = findEdgeByKey(key);
    if (!edge) return;
    const result = reverseEdgeInSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`inverti: ${result.error}`, true); return; }
    const s = edge.source, t = edge.target, oOld = edge.ordinal, oNew = result.newOrdinal;
    migrateLayoutOnReverse(s, t, oOld, oNew);
    currentSource = result.source;
    markDirtySource();
    markDirtyLayout();
    selectedEdgeKeys.clear();
    selectedEdgeKeys.add(`${t}|${s}|${oNew}`);
    await renderDiagram();
    pushHistory();
    setStatus(__("editor.op.edge_inverted", s, t));
  }

  // Transform a cubic bend on edge reversal. The chord direction flips, so
  // each control point's chord parameter becomes 1−t and the perpendicular
  // offset flips sign; cp1 and cp2 swap roles (cp1 sits near the new source,
  // which is the old target). Same world geometry, mirrored description.
  function reverseBend(b) {
    if (!b) return b;
    return { t1: 1 - b.t2, n1: -b.n2, t2: 1 - b.t1, n2: -b.n1 };
  }

  // Anchors store a compass direction per endpoint role. The physical nodes
  // don't move, but their roles swap: the source-side anchor becomes the
  // target-side anchor and vice versa.
  function reverseAnchors(a) {
    if (!a) return a;
    const out = {};
    if (a.target !== undefined) out.source = a.target;
    if (a.source !== undefined) out.target = a.source;
    return out;
  }

  // Re-key edgeAnchors / edgeBend / edgeStyles so they survive a reverse on
  // edge (s,t) at ordinal oOld → (t,s) at ordinal oNew. Three groups need
  // updates: the edge itself (transformed), the other (s,t) edges after oOld
  // (ordinal shifts down by 1), and the other (t,s) edges at oNew or later
  // (ordinal shifts up by 1). Done per bucket via a single rebuild so the
  // intermediate state can't collide with itself.
  function migrateLayoutOnReverse(s, t, oOld, oNew) {
    const oldKey = `${s}|${t}|${oOld}`;
    const newKey = `${t}|${s}|${oNew}`;
    const remap = (k) => {
      const parts = k.split("|");
      if (parts.length !== 3) return k;
      const [a, b, oStr] = parts;
      const o = parseInt(oStr, 10);
      if (!Number.isFinite(o)) return k;
      if (k === oldKey) return newKey;
      if (a === s && b === t && o > oOld) return `${a}|${b}|${o - 1}`;
      if (a === t && b === s && o >= oNew) return `${a}|${b}|${o + 1}`;
      return k;
    };
    const rebuild = (bucket, transformSelf) => {
      const next = {};
      for (const [k, v] of Object.entries(bucket)) {
        const nk = remap(k);
        next[nk] = (k === oldKey && transformSelf) ? transformSelf(v) : v;
      }
      for (const k of Object.keys(bucket)) delete bucket[k];
      Object.assign(bucket, next);
    };
    rebuild(edgeAnchors, reverseAnchors);
    rebuild(edgeBend, reverseBend);
    rebuild(edgeStyles, null);
  }

  // ── Align / Distribute selected nodes ────────────────────────────────────

  // Cycling state for the two align toggle buttons. Button text reflects
  // the *current* mode that will be applied on click.
  const ALIGN_V_MODES = ["middle", "top", "bottom"]; // Y-axis cycle
  const ALIGN_H_MODES = ["center", "left", "right"]; // X-axis cycle
  const ALIGN_V_LABELS = { middle: __("editor.align.y_center"), top: __("editor.align.y_top"), bottom: __("editor.align.y_bottom") };
  const ALIGN_H_LABELS = { center: __("editor.align.x_center"), left: __("editor.align.x_left"), right: __("editor.align.x_right") };
  let alignVMode = ALIGN_V_MODES[0];
  let alignHMode = ALIGN_H_MODES[0];

  // Snapshot of each selected node's geometry in world coords. Used both
  // for align (target = aggregate) and distribute (sort by axis).
  function snapshotSelectedNodes() {
    const items = [];
    for (const id of selectedNodeIds) {
      const n = nodeMap[id];
      if (!n) continue;
      const t = getNodeTranslate(n.g);
      const parentT = getElementParentTranslate(n.g);
      const cx = parentT.x + t.x + n.centerLocal.x;
      const cy = parentT.y + t.y + n.centerLocal.y;
      items.push({
        id, n, t, parentT, cx, cy,
        halfW: n.halfW, halfH: n.halfH,
      });
    }
    return items;
  }

  function commitNewWorldCenter(it, newCx, newCy) {
    const newTx = newCx - it.parentT.x - it.n.centerLocal.x;
    const newTy = newCy - it.parentT.y - it.n.centerLocal.y;
    setNodeTranslate(it.n.g, newTx, newTy);
    positions[it.id] = { x: newTx, y: newTy };
  }

  function applyAlignV() {
    if (selectedNodeIds.size < 2) { setStatus(__("editor.err.select_2_nodes"), true); return; }
    const items = snapshotSelectedNodes();
    if (items.length < 2) return;
    let targetCy;
    if (alignVMode === "top")    targetCy = Math.min(...items.map(it => it.cy - it.halfH));
    else if (alignVMode === "bottom") targetCy = Math.max(...items.map(it => it.cy + it.halfH));
    else /* middle */          targetCy = items.reduce((s, it) => s + it.cy, 0) / items.length;
    for (const it of items) {
      let newCy;
      if (alignVMode === "top")    newCy = targetCy + it.halfH;
      else if (alignVMode === "bottom") newCy = targetCy - it.halfH;
      else                       newCy = targetCy;
      commitNewWorldCenter(it, it.cx, newCy);
      rerouteNodeEdges(it.id);
    }
    updateAllClusterBounds();
    markDirtyLayout();
    pushHistory();
    setStatus(__("editor.op.aligned_y", items.length, alignVMode));
    // Cycle to next mode for next click.
    alignVMode = ALIGN_V_MODES[(ALIGN_V_MODES.indexOf(alignVMode) + 1) % ALIGN_V_MODES.length];
    if (alignVBtn) alignVBtn.textContent = ALIGN_V_LABELS[alignVMode];
  }

  function applyAlignH() {
    if (selectedNodeIds.size < 2) { setStatus(__("editor.err.select_2_nodes"), true); return; }
    const items = snapshotSelectedNodes();
    if (items.length < 2) return;
    let targetCx;
    if (alignHMode === "left")   targetCx = Math.min(...items.map(it => it.cx - it.halfW));
    else if (alignHMode === "right")  targetCx = Math.max(...items.map(it => it.cx + it.halfW));
    else /* center */          targetCx = items.reduce((s, it) => s + it.cx, 0) / items.length;
    for (const it of items) {
      let newCx;
      if (alignHMode === "left")   newCx = targetCx + it.halfW;
      else if (alignHMode === "right")  newCx = targetCx - it.halfW;
      else                       newCx = targetCx;
      commitNewWorldCenter(it, newCx, it.cy);
      rerouteNodeEdges(it.id);
    }
    updateAllClusterBounds();
    markDirtyLayout();
    pushHistory();
    setStatus(__("editor.op.aligned_x", items.length, alignHMode));
    alignHMode = ALIGN_H_MODES[(ALIGN_H_MODES.indexOf(alignHMode) + 1) % ALIGN_H_MODES.length];
    if (alignHBtn) alignHBtn.textContent = ALIGN_H_LABELS[alignHMode];
  }

  // Distribute: keep the bounding extremes of the selection, redistribute
  // intermediate nodes so the *gap* between consecutive nodes is uniform.
  // Gap-based (not center-based) so nodes with different sizes still look
  // evenly spaced visually.
  function applyDistribute(axis) {
    if (selectedNodeIds.size < 3) { setStatus(__("editor.err.select_3_nodes"), true); return; }
    const items = snapshotSelectedNodes();
    if (items.length < 3) return;
    if (axis === "h") {
      items.sort((a, b) => a.cx - b.cx);
      const totalSpan = (items[items.length - 1].cx + items[items.length - 1].halfW) -
                        (items[0].cx - items[0].halfW);
      let sumW = 0;
      for (const it of items) sumW += 2 * it.halfW;
      const gap = (totalSpan - sumW) / (items.length - 1);
      let leftEdge = items[0].cx - items[0].halfW;
      for (const it of items) {
        const newCx = leftEdge + it.halfW;
        commitNewWorldCenter(it, newCx, it.cy);
        rerouteNodeEdges(it.id);
        leftEdge += 2 * it.halfW + gap;
      }
    } else {
      items.sort((a, b) => a.cy - b.cy);
      const totalSpan = (items[items.length - 1].cy + items[items.length - 1].halfH) -
                        (items[0].cy - items[0].halfH);
      let sumH = 0;
      for (const it of items) sumH += 2 * it.halfH;
      const gap = (totalSpan - sumH) / (items.length - 1);
      let topEdge = items[0].cy - items[0].halfH;
      for (const it of items) {
        const newCy = topEdge + it.halfH;
        commitNewWorldCenter(it, it.cx, newCy);
        rerouteNodeEdges(it.id);
        topEdge += 2 * it.halfH + gap;
      }
    }
    updateAllClusterBounds();
    markDirtyLayout();
    pushHistory();
    setStatus(__("editor.op.distributed", items.length, axis === "h" ? "X" : "Y"));
  }

  function attachLabelEditors() {
    // Double-click on a node/subgraph label opens the same modal used for
    // creation, pre-filled with the current id/label/shape. This lets the
    // user rename the id (with propagation across edges/notes/style/positions)
    // and change shape/title — capabilities the in-place inline editor lacked.
    for (const [id, n] of Object.entries(nodeMap)) {
      const labelEl = findLabelTextElement(n.g);
      if (!labelEl) continue;
      labelEl.style.cursor = "pointer";
      labelEl.addEventListener("dblclick", (ev) => {
        if (isReadOnly) return; // spectator: no edit
        ev.stopPropagation(); ev.preventDefault();
        openEditNodeModal(id);
      });
    }
    for (const [id, c] of Object.entries(clusterMap)) {
      const labelEl = findLabelTextElement(c.g);
      if (!labelEl) continue;
      labelEl.style.cursor = "pointer";
      labelEl.addEventListener("dblclick", (ev) => {
        if (isReadOnly) return; // spectator: no edit
        ev.stopPropagation(); ev.preventDefault();
        openEditSubgraphModal(id);
      });
    }
    // Edge labels are handled by startEdgeLabelEdit (wired through
    // attachEdgeClickHandlers) — that path also supports labelling edges that
    // currently have no label, so we don't dual-attach here.
  }

  // ── Notes (per-element comments) ─────────────────────────────────────────
  //
  // Convention (also documented for Claude / human readers):
  //   %% <id> <free text>
  // where <id> is a node or subgraph id. Multi-line notes are encoded inline:
  //   - newline → \n  (literal backslash + 'n')
  //   - literal \  → \\
  // One %%-line per id; an empty/whitespace-only note removes the line.

  const NOTE_RE = /^(\s*)%%\s+([A-Za-z_][\w]*)\s+(.*)$/;
  let _notesAutosaveTimer = null;
  let _notesCurrentId = null;     // id of the element currently bound to the panel
  let _notesCurrentKind = null;   // 'node' | 'subgraph'
  let _notesSuppressInput = false;

  function encodeNote(text) {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/\r\n?/g, "\n")
      .replace(/\n/g, "\\n");
  }
  function decodeNote(text) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        const nx = text[i + 1];
        if (nx === "n") { out += "\n"; i++; continue; }
        if (nx === "\\") { out += "\\"; i++; continue; }
      }
      out += ch;
    }
    return out;
  }

  function findNoteForId(source, id) {
    const lines = source.split("\n");
    for (const line of lines) {
      const m = line.match(NOTE_RE);
      if (m && m[2] === id) return m[3];
    }
    return null;
  }

  // Returns the source with the note for `id` set to `encoded` (a single-line
  // already-encoded payload), or removed if `encoded` is empty/null. Updates
  // the first matching line; appends at the end if none exists.
  function upsertNoteInSource(source, id, encoded) {
    const lines = source.split("\n");
    let foundIdx = -1;
    let foundIndent = "";
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(NOTE_RE);
      if (m && m[2] === id) { foundIdx = i; foundIndent = m[1]; break; }
    }
    const isEmpty = !encoded || encoded.length === 0;
    if (foundIdx === -1) {
      if (isEmpty) return source;
      const newLine = `%% ${id} ${encoded}`;
      if (!source.endsWith("\n")) source += "\n";
      return source + newLine + "\n";
    }
    if (isEmpty) {
      lines.splice(foundIdx, 1);
      return lines.join("\n");
    }
    lines[foundIdx] = `${foundIndent}%% ${id} ${encoded}`;
    return lines.join("\n");
  }

  // Read the visible caption (rendered label) of a node or subgraph from the
  // current SVG — falls back to the id when the label is missing or blank.
  function noteCaptionFor(kind, id) {
    let g = null;
    if (kind === "node" && nodeMap[id]) g = nodeMap[id].g;
    else if (kind === "subgraph" && clusterMap[id]) {
      g = clusterMap[id].label || clusterMap[id].g;
    }
    if (!g) return id;
    const labelEl = findLabelTextElement(g);
    const txt = labelEl ? getLabelText(labelEl) : "";
    return txt || id;
  }

  // Decide what (if anything) the panel binds to right now, and refresh it.
  function updateNotesPanel() {
    let kind = null, id = null;
    if (selectedNodeIds.size === 1 && selectedClusterIds.size === 0 && selectedEdgeKeys.size === 0) {
      kind = "node"; id = [...selectedNodeIds][0];
    } else if (selectedClusterIds.size === 1 && selectedNodeIds.size === 0 && selectedEdgeKeys.size === 0) {
      kind = "subgraph"; id = [...selectedClusterIds][0];
    }
    // Was the panel already bound to this same element? (Compare against the
    // PREVIOUS binding, before we overwrite it below.) Used to decide whether
    // a refresh should preserve the user's mid-typing textarea content.
    const sameBinding = (id !== null && _notesCurrentId === id && _notesCurrentKind === kind);

    // If the bound element changed, flush any pending note edit for the
    // previous one so we don't lose it on rapid selection switches.
    if (_notesCurrentId && !sameBinding) {
      flushPendingNoteEdit();
    }
    _notesCurrentId = id;
    _notesCurrentKind = kind;

    // Only protect mid-typing content when the binding hasn't changed —
    // otherwise the new element would inherit the previous one's textarea.
    const isTyping = sameBinding && document.activeElement === notesTextarea;

    if (!id) {
      notesEmpty.classList.remove("hidden");
      notesTextarea.classList.add("hidden");
      notesTargetLabel.textContent = "";
      _notesSuppressInput = true;
      try { notesTextarea.value = ""; } finally { _notesSuppressInput = false; }
      return;
    }

    const caption = noteCaptionFor(kind, id);
    notesTargetLabel.innerHTML =
      `<span class="notes-target-id"></span><span class="notes-target-sep">·</span><span class="notes-target-caption"></span>`;
    notesTargetLabel.querySelector(".notes-target-id").textContent = id;
    notesTargetLabel.querySelector(".notes-target-caption").textContent = caption;

    if (!isTyping) {
      const encoded = findNoteForId(currentSource, id) || "";
      _notesSuppressInput = true;
      try {
        notesTextarea.value = decodeNote(encoded);
      } finally { _notesSuppressInput = false; }
    }

    notesEmpty.classList.add("hidden");
    notesTextarea.classList.remove("hidden");
    notesTextarea.disabled = isReadOnly || !canWrite;
  }

  // Apply the textarea content to currentSource for the bound element.
  // Returns true if the source actually changed.
  function applyNoteEdit() {
    if (!_notesCurrentId) return false;
    const id = _notesCurrentId;
    const text = notesTextarea.value || "";
    const encoded = encodeNote(text).trim();
    const next = upsertNoteInSource(currentSource, id, encoded);
    if (next === currentSource) return false;
    currentSource = next;
    // Sync CodeMirror, but suppress its change handler — comments are pure
    // metadata so we skip the diagram re-render entirely.
    setSourceValue(currentSource);
    // The re-render is skipped, so update this element's live tooltip directly,
    // otherwise the new/edited note only appears after the next full render.
    refreshNoteTooltip(id);
    // Use the typing-debounce autosave path so rapid edits coalesce.
    _typingFromCM = true;
    try { markDirtySource(); } finally { _typingFromCM = false; }
    return true;
  }

  function flushPendingNoteEdit() {
    if (_notesAutosaveTimer) {
      clearTimeout(_notesAutosaveTimer);
      _notesAutosaveTimer = null;
    }
    if (applyNoteEdit()) pushHistory();
  }

  // ── Add/delete node/edge ─────────────────────────────────────────────────

  function appendLineToSource(source, line) {
    if (!source.endsWith("\n")) source += "\n";
    return source + line + "\n";
  }
  function insertAfterLastMatch(source, regex, line) {
    const lines = source.split("\n");
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) lastIdx = i;
    if (lastIdx === -1) return appendLineToSource(source, line);
    lines.splice(lastIdx + 1, 0, line);
    return lines.join("\n");
  }

  function addNodeToSource(source, id, label, shape, subgraphId) {
    if (!/^[A-Za-z_][\w]*$/.test(id)) {
      return { ok: false, error: __("editor.err.id_invalid", id) };
    }
    if (nodeMap[id]) return { ok: false, error: __("editor.err.id_exists", id) };
    const shp = shape || SHAPES[0];
    const lbl = label || id;
    const err = validateLabelForShape(lbl, shp);
    if (err) return { ok: false, error: err };
    const line = `    ${id}${shp.open}${lbl}${shp.close}`;
    if (subgraphId && clusterMap[subgraphId]) {
      const lines = source.split("\n");
      const idEsc = regexEscape(subgraphId);
      const headerRe = new RegExp(`^\\s*subgraph\\s+${idEsc}(\\s|\\[|$)`, "i");
      const subgraphHeaderRe = /^\s*subgraph\b/i;
      const endRe = /^\s*end\s*$/i;
      let headerIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (headerRe.test(lines[i])) { headerIdx = i; break; }
      }
      if (headerIdx !== -1) {
        let depth = 1, endIdx = -1;
        for (let i = headerIdx + 1; i < lines.length; i++) {
          if (subgraphHeaderRe.test(lines[i])) depth++;
          else if (endRe.test(lines[i])) { depth--; if (depth === 0) { endIdx = i; break; } }
        }
        if (endIdx !== -1) {
          lines.splice(endIdx, 0, line);
          return { ok: true, source: lines.join("\n") };
        }
      }
    }
    const nodeDeclRegex = /^\s*[A-Za-z_]\w*\s*[\[(\{]/;
    return { ok: true, source: insertAfterLastMatch(source, nodeDeclRegex, line) };
  }

  function addEdgeToSource(source, src, tgt, label) {
    const srcExists = !!(nodeMap[src] || clusterMap[src]);
    const tgtExists = !!(nodeMap[tgt] || clusterMap[tgt]);
    if (!srcExists) return { ok: false, error: `source '${src}' non esiste` };
    if (!tgtExists) return { ok: false, error: `target '${tgt}' non esiste` };
    if (/[|\n]/.test(label)) return { ok: false, error: "edge label: niente | o newline" };
    const arrow = label ? `-->|${label}|` : `-->`;
    const line = `    ${src} ${arrow} ${tgt}`;
    return { ok: true, source: appendLineToSource(source, line) };
  }

  function stripEdgeLabels(line) {
    return line
      .replace(/\|[^|\n]*\|/g, " ")
      .replace(/(--)\s+[^-\n]*?\s+(-+[>xo])/g, "$1$2")
      .replace(/(-\.)\s*[^.\n]*?\s*(\.-+[>xo])/g, "$1$2")
      .replace(/(==)\s+[^=\n]*?\s+(==+[>xo])/g, "$1$2");
  }

  function deleteEdgeFromSource(source, src, tgt, ordinal) {
    const sEsc = regexEscape(src), tEsc = regexEscape(tgt);
    const edgeRe = new RegExp(`\\b${sEsc}\\b\\s*${EDGE_CONN}\\s*\\b${tEsc}\\b`);
    const lines = source.split("\n");
    let matched = 0;
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripEdgeLabels(lines[i])
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
      if (!edgeRe.test(stripped)) continue;
      if (matched !== ordinal) { matched++; continue; }
      const arrowSegs = (stripped.match(new RegExp(`${EDGE_CONN}\\s*\\w+`, "g")) || []).length;
      const chainLine = arrowSegs > 1;
      lines.splice(i, 1);
      return { ok: true, source: lines.join("\n"), chainLine };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} not found` };
  }

  function deleteNodeFromSource(source, id) {
    const idRe = new RegExp(`\\b${regexEscape(id)}\\b`);
    function stripLabels(line) {
      return line
        .replace(/\|[^|\n]*\|/g, " ")
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
    }
    function refsId(line) { return idRe.test(stripLabels(line)); }
    function isEdgeLine(line) { return /[-=.~][-=.~<>xo]*[>xo]/.test(line); }
    function isSubgraphMarker(line) {
      return /^\s*subgraph\b/i.test(line) || /^\s*end\s*$/i.test(line);
    }
    function isNodeDeclLineForId(line) {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*[\[(\{]/);
      return m && m[1] === id;
    }
    const kept = [];
    let removedDecl = false, removedOther = 0;
    for (const line of source.split("\n")) {
      if (isSubgraphMarker(line)) { kept.push(line); continue; }
      if (!refsId(line)) { kept.push(line); continue; }
      if (isNodeDeclLineForId(line)) { removedDecl = true; continue; }
      if (isEdgeLine(line)) { removedOther++; continue; }
      removedOther++;
    }
    if (!removedDecl && removedOther === 0) {
      return { ok: false, error: `no reference to '${id}' found` };
    }
    return { ok: true, source: kept.join("\n"), removedDecl, removedOther };
  }

  // Walks the source block between `subgraph ID` and its matching `end`, and
  // returns the set of node IDs (keys of nodeMap) referenced inside — including
  // those contained in nested subgraphs, since dragging the outer cluster must
  // physically move every descendant for the auto-derived bbox to follow.
  // Direct children of a subgraph (depth=1 only): nodes and nested subgraphs
  // declared at the top level inside `subgraph id ... end`. Used to compute
  // a cluster's bounding envelope as nodes ∪ inner-cluster-rects, instead of
  // nodes-only — otherwise nested subgraph rects (with their own internal
  // padding) get ignored and the outer cluster's margins go asymmetric.
  function findSubgraphDirectChildren(source, id) {
    const idEsc = regexEscape(id);
    const headerRe = new RegExp(`^\\s*subgraph\\s+${idEsc}(\\s|\\[|$)`, "i");
    const subgraphHeaderRe = /^\s*subgraph\s+([A-Za-z_]\w*)/i;
    const endRe = /^\s*end\s*$/i;
    const wordRe = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    const lines = source.split("\n");
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headerRe.test(lines[i])) { headerIdx = i; break; }
    }
    const result = { nodes: new Set(), subgraphs: new Set() };
    if (headerIdx === -1) return result;
    let depth = 1;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const sgMatch = line.match(subgraphHeaderRe);
      if (sgMatch) {
        if (depth === 1) result.subgraphs.add(sgMatch[1]);
        depth++;
        continue;
      }
      if (endRe.test(line)) { depth--; if (depth === 0) break; continue; }
      if (depth !== 1) continue;
      const matches = line.match(wordRe) || [];
      for (const w of matches) {
        if (nodeMap[w]) result.nodes.add(w);
      }
    }
    return result;
  }

  function findSubgraphMembers(source, id) {
    const idEsc = regexEscape(id);
    const headerRe = new RegExp(`^\\s*subgraph\\s+${idEsc}(\\s|\\[|$)`, "i");
    const anySubgraphRe = /^\s*subgraph\b/i;
    const endRe = /^\s*end\s*$/i;
    const wordRe = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    const lines = source.split("\n");
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headerRe.test(lines[i])) { headerIdx = i; break; }
    }
    if (headerIdx === -1) return new Set();
    const members = new Set();
    let depth = 1;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (anySubgraphRe.test(line)) { depth++; continue; }
      if (endRe.test(line)) { depth--; if (depth === 0) break; continue; }
      const matches = line.match(wordRe) || [];
      for (const w of matches) {
        if (nodeMap[w]) members.add(w);
      }
    }
    return members;
  }

  function deleteSubgraphFromSource(source, id) {
    const idEsc = regexEscape(id);
    const headerRe = new RegExp(`^\\s*subgraph\\s+${idEsc}(\\s|\\[|$)`, "i");
    const anySubgraphRe = /^\s*subgraph\b/i;
    const endRe = /^\s*end\s*$/i;
    const lines = source.split("\n");
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headerRe.test(lines[i])) {
        if (headerIdx !== -1) {
          return { ok: false, error: `subgraph ${id}: ambiguous header` };
        }
        headerIdx = i;
      }
    }
    if (headerIdx === -1) return { ok: false, error: `subgraph ${id}: not found` };
    let depth = 1, endIdx = -1;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (anySubgraphRe.test(lines[i])) depth++;
      else if (endRe.test(lines[i])) {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx === -1) return { ok: false, error: `subgraph ${id}: 'end' not found` };
    // Remove higher index first to keep the lower one valid.
    lines.splice(endIdx, 1);
    lines.splice(headerIdx, 1);
    return { ok: true, source: lines.join("\n") };
  }

  // Walk source tracking subgraph nesting; return {nodeId: owningSubgraphId} for
  // every node id referenced inside any subgraph block (decl or bare ref).
  function computeNodeSubgraphOwners(source) {
    const owners = {};
    const stack = [];
    for (const line of source.split("\n")) {
      const sg = line.match(/^\s*subgraph\s+([A-Za-z_]\w*)/i);
      if (sg) { stack.push(sg[1]); continue; }
      if (/^\s*end\s*$/i.test(line)) { stack.pop(); continue; }
      if (!stack.length) continue;
      const stripped = line
        .replace(/\|[^|\n]*\|/g, " ")
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
      const ids = stripped.match(/\b[A-Za-z_]\w*\b/g) || [];
      for (const id of ids) {
        if (id === "subgraph" || id === "end") continue;
        if (!nodeMap[id]) continue;
        if (!owners[id]) owners[id] = stack[stack.length - 1];
      }
    }
    return owners;
  }

  // Mermaid node-shape body (after the id). Ordered longest-first so
  // double-bracket variants match before their single-bracket prefixes.
  const NODE_SHAPE_BODY = String.raw`(?:\[\[[^\]\n]*\]\]|\[\([^)\n]*\)\]|\(\[[^\]\n]*\]\)|\[\/[^\\\n]*\\\]|\[\\[^\/\n]*\/\]|\[\/[^\/\n]*\/\]|\[\\[^\\\n]*\\\]|\[[^\]\n]*\]|\(\(\([^)\n]*\)\)\)|\(\([^)\n]*\)\)|\([^)\n]*\)|\{\{[^}\n]*\}\}|\{[^}\n]*\}|>[^\]\n]*\])`;

  // Reparent a list of nodes and/or subgraph blocks to a target subgraph,
  // or to the root level if targetId is null. For each moved node we pull
  // out its standalone declaration line (with shape/label) wherever it
  // lives and re-emit it at the target — so the node is actually MOVED
  // rather than left in place with only a bare-id reference added in the
  // destination. Nodes that only appear inline in edges (no standalone
  // decl line) fall back to a bare-id member line. For moved subgraphs,
  // the entire `subgraph X ... end` block is cut and reinserted at the
  // target. Validates against cycles (target inside a moved subgraph).
  function moveToSubgraphInSource(source, ids, targetId) {
    const subgraphHeaderRe = /^\s*subgraph\b/i;
    const endRe = /^\s*end\s*$/i;
    const SHAPE_BODY = NODE_SHAPE_BODY;

    function findSubgraphRange(lines, sgId) {
      const idEsc = regexEscape(sgId);
      const headerRe = new RegExp(`^\\s*subgraph\\s+${idEsc}(\\s|\\[|$)`, "i");
      let headerIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (headerRe.test(lines[i])) { headerIdx = i; break; }
      }
      if (headerIdx === -1) return null;
      let d = 1, endIdx = -1;
      for (let i = headerIdx + 1; i < lines.length; i++) {
        if (subgraphHeaderRe.test(lines[i])) d++;
        else if (endRe.test(lines[i])) { d--; if (d === 0) { endIdx = i; break; } }
      }
      if (endIdx === -1) return null;
      return { headerIdx, endIdx };
    }

    // Validate: target can't be inside any moved subgraph block (cycle).
    if (targetId) {
      let probeLines = source.split("\n");
      for (const id of ids) {
        if (!clusterMap[id]) continue;
        const range = findSubgraphRange(probeLines, id);
        if (!range) continue;
        const tgtEsc = regexEscape(targetId);
        const tgtRe = new RegExp(`^\\s*subgraph\\s+${tgtEsc}(\\s|\\[|$)`, "i");
        for (let i = range.headerIdx + 1; i < range.endIdx; i++) {
          if (tgtRe.test(probeLines[i])) {
            return { ok: false, error: `'${targetId}' is inside '${id}': move not allowed (cycle)` };
          }
        }
      }
    }

    let lines = source.split("\n");

    // Phase A: cut subgraph blocks for any moved subgraph id. Process largest
    // first to keep nested cuts well-defined.
    const cutBlocks = []; // [{ id, blockLines }]
    const movedSubgraphIds = ids.filter(id => clusterMap[id]);
    for (const id of movedSubgraphIds) {
      if (id === targetId) {
        return { ok: false, error: `'${id}' is already the destination` };
      }
      const range = findSubgraphRange(lines, id);
      if (!range) {
        return { ok: false, error: `subgraph '${id}' not found in source` };
      }
      const blockLines = lines.slice(range.headerIdx, range.endIdx + 1);
      lines = lines.slice(0, range.headerIdx).concat(lines.slice(range.endIdx + 1));
      cutBlocks.push({ id, blockLines });
    }

    // Phase B: for each moved node, pull out its standalone declaration
    // line (id + shape/label, optional `:::class`) — at any depth — and
    // capture it for re-insertion at the target. Also drop bare-identifier
    // member lines inside subgraphs. A node whose declaration sits inside
    // a moved subgraph (already cut in Phase A) won't be found here; we
    // remember which nodes originally had a decl in the source so we can
    // skip the bare-id fallback for them (they travel with their subgraph).
    const movedNodeIds = ids.filter(id => nodeMap[id]);
    const movedNodeLines = {}; // id -> captured decl line (left-trimmed) or null
    const declOnlyInsideMovedSg = {}; // id -> true when decl existed pre-cut but got cut with a subgraph
    if (movedNodeIds.length > 0) {
      const escIds = movedNodeIds.map(regexEscape).join("|");
      const declRe = new RegExp(`^(\\s*)(${escIds})\\s*${SHAPE_BODY}(\\s*:::\\s*\\w+)?\\s*$`);
      const bareRe = new RegExp(`^\\s*(?:${escIds})\\s*$`);

      // Pre-scan the ORIGINAL source (before Phase A's cuts) to know which
      // moved nodes had a standalone decl somewhere — used to decide the
      // fallback in Phase C when no decl survives in `lines`.
      const origHadDecl = {};
      for (const line of source.split("\n")) {
        const m = declRe.exec(line);
        if (m) origHadDecl[m[2]] = true;
      }

      for (const id of movedNodeIds) movedNodeLines[id] = null;
      const cleaned = [];
      let depth = 0;
      for (const line of lines) {
        if (subgraphHeaderRe.test(line)) { cleaned.push(line); depth++; continue; }
        if (endRe.test(line)) { cleaned.push(line); depth = Math.max(0, depth - 1); continue; }
        const dm = declRe.exec(line);
        if (dm) {
          const nid = dm[2];
          if (movedNodeLines[nid] == null) movedNodeLines[nid] = line.replace(/^\s+/, "");
          continue; // drop the decl from its current location
        }
        if (depth > 0 && bareRe.test(line)) continue;
        cleaned.push(line);
      }
      lines = cleaned;

      // Mark nodes whose decl was eaten by a moved subgraph in Phase A.
      for (const id of movedNodeIds) {
        if (movedNodeLines[id] == null && origHadDecl[id]) declOnlyInsideMovedSg[id] = true;
      }
    }

    // Phase C: insert at target. For root, append node-id member lines and
    // the cut blocks at end of file. For a target subgraph, splice them in
    // just before its closing `end`.
    function appendInside(lines, sgId, contentLines) {
      const range = findSubgraphRange(lines, sgId);
      if (!range) return null;
      lines.splice(range.endIdx, 0, ...contentLines);
      return lines;
    }

    const insertPieces = [];
    for (const id of movedNodeIds) {
      const decl = movedNodeLines[id];
      if (decl) insertPieces.push(`    ${decl}`);
      else if (declOnlyInsideMovedSg[id]) continue; // decl travels with its subgraph
      else insertPieces.push(`    ${id}`); // edges-only node: bare-id fallback
    }
    for (const { blockLines } of cutBlocks) insertPieces.push(...blockLines);

    if (insertPieces.length === 0) {
      return { ok: false, error: __("editor.nothing_to_move") };
    }
    if (targetId) {
      const result = appendInside(lines, targetId, insertPieces);
      if (!result) return { ok: false, error: `subgraph '${targetId}' not found` };
      lines = result;
    } else {
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.splice(lines.length - 1, 0, ...insertPieces);
      } else {
        lines.push(...insertPieces);
      }
    }

    return { ok: true, source: lines.join("\n") };
  }

  // Detect "legacy" sources where a node's standalone declaration sits at
  // root (or in a different subgraph) while a bare-identifier member line
  // for it appears inside a subgraph S. The new editor moves the decl
  // itself into the target; legacy sources keep the decl outside and only
  // use a bare ref to mark membership. Returns one entry per legacy node:
  //   { id, subgraphId }    (the subgraph that holds the bare ref)
  function findLegacyBareRefs(source) {
    const lines = source.split("\n");
    const headerRe = /^\s*subgraph\s+([A-Za-z_]\w*)/i;
    const endRe = /^\s*end\s*$/i;
    const declRe = new RegExp(`^\\s*([A-Za-z_]\\w*)\\s*${NODE_SHAPE_BODY}(\\s*:::\\s*\\w+)?\\s*$`);
    const bareRe = /^\s*([A-Za-z_]\w*)\s*$/;

    // First pass: collect each node's decl line and its subgraph path.
    const declAt = {}; // id -> { sgPath: [...] }
    const bareRefs = []; // { id, sgPath, lineIdx }
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const sg = line.match(headerRe);
      if (sg) { stack.push(sg[1]); continue; }
      if (endRe.test(line)) { stack.pop(); continue; }
      const dm = declRe.exec(line);
      if (dm) {
        const id = dm[1];
        if (!declAt[id]) declAt[id] = { sgPath: [...stack] };
        continue;
      }
      const br = bareRe.exec(line);
      if (br) {
        const id = br[1];
        if (id === "end" || id === "subgraph") continue;
        bareRefs.push({ id, sgPath: [...stack], lineIdx: i });
      }
    }

    const legacy = [];
    const seen = new Set();
    for (const br of bareRefs) {
      if (br.sgPath.length === 0) continue; // bare ref at root — not a legacy pattern we fix
      const decl = declAt[br.id];
      if (!decl) continue; // edges-only node, nothing to move
      const directParent = br.sgPath[br.sgPath.length - 1];
      // If decl is already inside `directParent` (same subgraph or a nested
      // child of it), the bare ref is redundant noise but not a legacy
      // miss-placement. Skip — we don't want to touch already-good sources.
      if (decl.sgPath.includes(directParent)) continue;
      const key = br.id + "→" + directParent;
      if (seen.has(key)) continue;
      seen.add(key);
      legacy.push({ id: br.id, subgraphId: directParent });
    }
    return legacy;
  }

  // Rewrite a legacy source so every node's decl line sits inside the
  // subgraph that currently holds only its bare ref. Reuses
  // moveToSubgraphInSource, grouping moves by target subgraph.
  function normalizeLegacyBareRefs(source) {
    const legacy = findLegacyBareRefs(source);
    if (legacy.length === 0) return { ok: true, source, changed: 0 };
    // Group node ids by target subgraph.
    const byTarget = {};
    for (const { id, subgraphId } of legacy) {
      if (!byTarget[subgraphId]) byTarget[subgraphId] = [];
      byTarget[subgraphId].push(id);
    }
    let next = source;
    let changed = 0;
    for (const sgId of Object.keys(byTarget)) {
      const r = moveToSubgraphInSource(next, byTarget[sgId], sgId);
      if (!r.ok) return { ok: false, error: r.error };
      next = r.source;
      changed += byTarget[sgId].length;
    }
    return { ok: true, source: next, changed };
  }

  // Per-session flag: once the user has accepted OR declined the legacy
  // normalize prompt for this load, don't ask again until the page is
  // reloaded — even if subsequent edits create new bare-ref patterns.
  let _legacyPromptHandled = false;

  async function maybePromptLegacyNormalize() {
    if (_legacyPromptHandled) return;
    const legacy = findLegacyBareRefs(currentSource);
    if (legacy.length === 0) return;
    _legacyPromptHandled = true;
    const msg = `Found ${legacy.length} nodes in legacy format (declaration outside subgraph + bare-ref inside). Normalize the source by moving declarations inside the subgraph?`;
    const ok = await confirmDialog(msg, {
      title: __("editor.normalize_title"),
      confirmLabel: __("editor.normalize_btn"),
      cancelLabel: __("editor.normalize_cancel"),
    });
    if (!ok) return;
    const r = normalizeLegacyBareRefs(currentSource);
    if (!r.ok) { setStatus(`normalize: ${r.error}`, true); return; }
    if (r.changed === 0) return;
    currentSource = r.source;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(__("editor.op.normalized", r.changed));
  }

  function addSubgraphToSource(source, id, title, memberIds, parentId) {
    if (!/^[A-Za-z_][\w]*$/.test(id)) return { ok: false, error: __("editor.err.id_invalid", id) };
    if (nodeMap[id] || clusterMap[id]) return { ok: false, error: __("editor.err.id_exists", id) };
    if (title && /[\]\n]/.test(title)) return { ok: false, error: "title cannot contain ] or newline" };
    const head = title ? `subgraph ${id} [${title}]` : `subgraph ${id}`;
    const blockLines = [head, ...memberIds.map(m => `    ${m}`), "end"];

    // Root-level: just append the block.
    if (!parentId) {
      if (source.length && !source.endsWith("\n")) source += "\n";
      return { ok: true, source: source + blockLines.join("\n") + "\n" };
    }

    // Nested: locate parent's range, strip member lines from its direct body
    // (depth 1 inside parent), then splice the new subgraph block before
    // parent's closing `end`. The members live now only inside the new
    // subgraph, so Mermaid renders the nesting correctly.
    const lines = source.split("\n");
    const subgraphHeaderRe = /^\s*subgraph\b/i;
    const endRe = /^\s*end\s*$/i;
    const idEsc = regexEscape(parentId);
    const headerRe = new RegExp(`^\\s*subgraph\\s+${idEsc}(\\s|\\[|$)`, "i");
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headerRe.test(lines[i])) { headerIdx = i; break; }
    }
    if (headerIdx === -1) return { ok: false, error: `parent '${parentId}' not found` };
    let d = 1, endIdx = -1;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (subgraphHeaderRe.test(lines[i])) d++;
      else if (endRe.test(lines[i])) { d--; if (d === 0) { endIdx = i; break; } }
    }
    if (endIdx === -1) return { ok: false, error: `parent '${parentId}' missing end` };

    const escIds = memberIds.map(regexEscape).join("|");
    const memberLineRe = new RegExp(`^\\s*(?:${escIds})\\s*$`);
    const before = lines.slice(0, headerIdx + 1);
    const body = lines.slice(headerIdx + 1, endIdx);
    const after = lines.slice(endIdx); // includes parent's `end`

    // Drop member lines that are direct (depth-1) members of parent.
    // Don't touch lines inside nested subgraphs of parent.
    const cleanedBody = [];
    let bodyDepth = 0;
    for (const line of body) {
      if (subgraphHeaderRe.test(line)) { cleanedBody.push(line); bodyDepth++; continue; }
      if (endRe.test(line)) { cleanedBody.push(line); bodyDepth--; continue; }
      if (bodyDepth === 0 && memberLineRe.test(line)) continue;
      cleanedBody.push(line);
    }
    const newLines = before.concat(cleanedBody, blockLines, after);
    return { ok: true, source: newLines.join("\n") };
  }

  // Member ids + parent captured when the subgraph modal opens, so the user
  // can't change selection mid-modal and create a subgraph from a stale set.
  let _subgraphPendingIds = null;
  let _subgraphPendingParent = null;

  function applyAddSubgraph() {
    if (!requireValidSource("+ subgraph")) return;
    if (selectedNodeIds.size < 2) {
      setStatus(__("editor.err.select_2_shift"), true);
      return;
    }
    const ids = [...selectedNodeIds];
    const owners = computeNodeSubgraphOwners(currentSource);
    // Determine common parent: all selected nodes must share the same
    // parent subgraph (or all be at root). When they do, the new subgraph
    // is nested inside that parent. Mixed selection is refused — there's
    // no unambiguous "one parent" to nest under.
    const parent = owners[ids[0]] || null;
    for (const id of ids) {
      const o = owners[id] || null;
      if (o !== parent) {
        setStatus(__("editor.mixed_selection", id, o || "root", parent || "root"), true);
        return;
      }
    }
    openAddSubgraphModal(ids, parent);
  }

  // Edit mode: when non-null, the subgraph modal edits this existing subgraph.
  let _editSubgraphOriginalId = null;
  function setSubgraphModalMode(isEdit) {
    const title = document.querySelector("#addSubgraphModal h2");
    const okBtn = document.getElementById("subgraphOkBtn");
    if (isEdit) {
      if (title) title.textContent = __("editor.edit_subgraph");
      if (okBtn) okBtn.textContent = __("common.save");
    } else {
      if (title) title.textContent = __("editor.new_subgraph");
      if (okBtn) okBtn.textContent = __("common.create");
    }
  }
  function openAddSubgraphModal(ids, parentId) {
    _editSubgraphOriginalId = null;
    setSubgraphModalMode(false);
    _subgraphPendingIds = ids;
    _subgraphPendingParent = parentId || null;
    document.getElementById("addSubgraphModal").classList.remove("hidden");
    document.getElementById("subgraphModalError").textContent = "";
    document.getElementById("subgraphIdInput").value = "";
    document.getElementById("subgraphTitleInput").value = "";
    // The collapsible flag is a property of an existing subgraph — only offered
    // when editing, hidden during creation.
    document.getElementById("subgraphCollapsibleField").classList.add("hidden");
    document.getElementById("subgraphCollapsibleInput").checked = false;
    const where = parentId ? ` (nested in ${parentId})` : "";
    document.getElementById("subgraphMembersInfo").textContent =
      `${ids.length} nodes${where}: ${ids.join(", ")}`;
    setTimeout(() => document.getElementById("subgraphIdInput").focus(), 0);
  }
  function openEditSubgraphModal(subgraphId) {
    if (!requireValidSource("edit subgraph")) return;
    if (!clusterMap[subgraphId]) { setStatus(`subgraph '${subgraphId}' not found`, true); return; }
    const title = getSubgraphTitleInSource(currentSource, subgraphId);
    if (title === null) { setStatus(`subgraph '${subgraphId}': header not found`, true); return; }
    _editSubgraphOriginalId = subgraphId;
    _subgraphPendingIds = null;
    _subgraphPendingParent = null;
    setSubgraphModalMode(true);
    document.getElementById("addSubgraphModal").classList.remove("hidden");
    document.getElementById("subgraphModalError").textContent = "";
    document.getElementById("subgraphIdInput").value = subgraphId;
    document.getElementById("subgraphTitleInput").value = title;
    document.getElementById("subgraphMembersInfo").textContent = "";
    document.getElementById("subgraphCollapsibleField").classList.remove("hidden");
    document.getElementById("subgraphCollapsibleInput").checked = collapsibleIds.has(subgraphId);
    setTimeout(() => {
      const inp = document.getElementById("subgraphIdInput");
      inp.focus(); inp.select();
    }, 0);
  }
  function closeAddSubgraphModal() {
    document.getElementById("addSubgraphModal").classList.add("hidden");
    _subgraphPendingIds = null;
    _subgraphPendingParent = null;
    _editSubgraphOriginalId = null;
    setSubgraphModalMode(false);
  }

  async function submitAddSubgraphModal() {
    if (_editSubgraphOriginalId) { await submitEditSubgraphModal(); return; }
    const ids = _subgraphPendingIds;
    const parent = _subgraphPendingParent;
    if (!ids) { closeAddSubgraphModal(); return; }
    const idRaw = document.getElementById("subgraphIdInput").value.trim();
    const titleRaw = document.getElementById("subgraphTitleInput").value;
    const errorEl = document.getElementById("subgraphModalError");
    errorEl.textContent = "";
    if (!idRaw) { errorEl.textContent = __("editor.err.id_required"); return; }
    if (!/^[A-Za-z_][\w]*$/.test(idRaw)) { errorEl.textContent = __("editor.err.id_invalid", idRaw); return; }
    if (nodeMap[idRaw] || clusterMap[idRaw]) { errorEl.textContent = __("editor.err.id_exists", idRaw); return; }
    const title = titleRaw.trim();
    const result = addSubgraphToSource(currentSource, idRaw, title, ids, parent);
    if (!result.ok) { errorEl.textContent = result.error; return; }
    currentSource = result.source;
    markDirtySource();
    deselectNode();
    closeAddSubgraphModal();
    await renderDiagram();
    pushHistory();
    setStatus(__("editor.op.subgraph_added", idRaw, ids.length));
  }

  async function submitEditSubgraphModal() {
    const oldId = _editSubgraphOriginalId;
    const newId = document.getElementById("subgraphIdInput").value.trim();
    const newTitle = document.getElementById("subgraphTitleInput").value.trim();
    const errorEl = document.getElementById("subgraphModalError");
    errorEl.textContent = "";
    if (!newId) { errorEl.textContent = __("editor.err.id_required"); return; }
    if (!/^[A-Za-z_][\w]*$/.test(newId)) { errorEl.textContent = __("editor.err.id_invalid", newId); return; }
    if (newId !== oldId && (nodeMap[newId] || clusterMap[newId])) {
      errorEl.textContent = __("editor.err.id_exists", newId); return;
    }

    let next = currentSource;
    if (newId !== oldId) {
      const r = renameIdInSource(next, oldId, newId);
      if (!r.ok) { errorEl.textContent = r.error; return; }
      next = r.source;
    }
    const r2 = rewriteSubgraphLabelInSource(next, newId, newTitle);
    if (!r2.ok) { errorEl.textContent = r2.error; return; }
    next = r2.source;

    if (newId !== oldId && positions[oldId] !== undefined) {
      positions[newId] = positions[oldId];
      delete positions[oldId];
      markDirtyLayout();
    }
    if (newId !== oldId) renameIdInEdgeAnchors(oldId, newId);
    // Carry the collapsible/collapsed flags across a rename, then apply the
    // checkbox value to the (possibly new) id.
    if (newId !== oldId) {
      if (collapsibleIds.has(oldId)) { collapsibleIds.delete(oldId); collapsibleIds.add(newId); }
      if (collapsedIds.has(oldId)) { collapsedIds.delete(oldId); collapsedIds.add(newId); }
    }
    if (setSubgraphCollapsible(newId, document.getElementById("subgraphCollapsibleInput").checked)) {
      markDirtyLayout();
    }
    if (selectedClusterIds.has(oldId)) {
      selectedClusterIds.delete(oldId);
      selectedClusterIds.add(newId);
    }
    currentSource = next;
    markDirtySource();
    closeAddSubgraphModal();
    await renderDiagram();
    pushHistory();
    const renamed = newId !== oldId ? `${oldId} → ${newId}` : newId;
    setStatus(__("editor.op.subgraph_renamed", renamed));
  }

  async function handleDeleteSubgraphClick(id) {
    if (!await confirmDialog(__("editor.delete_subgraph_confirm", id),
      { confirmLabel: __("common.delete"), danger: true })) return;
    let result = deleteSubgraphFromSource(currentSource, id);
    if (!result.ok) { setStatus(`delete subgraph: ${result.error}`, true); return; }
    let next = result.source;
    // Also drop any `style ID ...` line tied to this subgraph id.
    const stripped = setNodeStyleInSource(next, id, null);
    if (stripped.ok) next = stripped.source;
    currentSource = next;
    markDirtySource();
    if (selectedClusterIds.has(id)) {
      if (clusterMap[id]) clusterMap[id].g.classList.remove("selected");
      selectedClusterIds.delete(id);
      updateToolbarState();
      broadcastSelection();
    }
    await renderDiagram();
    pushHistory();
    setStatus(__("editor.op.subgraph_deleted", id));
  }

  // ── Edge/node delete actions ────────────────────────────────────────────

  // Inserts an invisible thick-stroke "hit path" alongside each visible edge
  // path so clicks land easily even on thin or curved lines. The hit path's
  // `d` is kept in sync by rerouteEdge.
  function ensureEdgeHitPath(edge) {
    if (edge.hitPath && edge.hitPath.parentNode) return edge.hitPath;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const hp = document.createElementNS(SVG_NS, "path");
    hp.setAttribute("class", "edge-hit");
    hp.setAttribute("d", edge.path.getAttribute("d") || "");
    hp.setAttribute("fill", "none");
    hp.setAttribute("stroke", "rgba(0,0,0,0)");
    hp.setAttribute("stroke-width", "14");
    hp.setAttribute("pointer-events", "stroke");
    hp.style.cursor = "pointer";
    // Insert after the visible path so it sits on top in stacking order.
    edge.path.parentNode.insertBefore(hp, edge.path.nextSibling);
    edge.hitPath = hp;
    return hp;
  }

  function attachEdgeClickHandlers() {
    for (const edge of edges) {
      const hit = ensureEdgeHitPath(edge);
      const targets = [hit];
      if (edge.label) targets.push(edge.label);
      for (const t of targets) {
        if (t === edge.label) t.style.pointerEvents = "auto";
        t.addEventListener("click", (ev) => {
          if (connectingState) return;
          ev.stopPropagation(); ev.preventDefault();
          toggleEdgeSelection(edge, ev.ctrlKey || ev.metaKey || ev.shiftKey);
        });
        t.addEventListener("dblclick", (ev) => {
          if (connectingState) return;
          if (isReadOnly) return; // spectator: no label edit
          ev.stopPropagation(); ev.preventDefault();
          startEdgeLabelEdit(edge);
        });
      }
    }
  }

  async function handleDeleteEdgeClick(edge) {
    const label = `${edge.source} → ${edge.target}` +
      (edge.ordinal > 0 ? ` (#${edge.ordinal + 1})` : "");
    if (!await confirmDialog(__("editor.delete_edge_confirm", label),
      { confirmLabel: __("common.delete"), danger: true })) return;
    const result = deleteEdgeFromSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`delete edge: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    deselectEdge();
    await renderDiagram();
    pushHistory();
    const warn = result.chainLine ? " (was in a chain: entire line removed)" : "";
    setStatus(__("editor.op.edge_deleted", label) + warn);
  }

  // Batch-deletes the currently selected edges (with confirm). For multiple
  // ordinals on the same (src,tgt) pair we delete in descending-ordinal order:
  // each delete shifts subsequent ordinals down by one, so lower-ordinal keys
  // remain valid as we go.
  async function deleteSelectedEdges() {
    if (selectedEdgeKeys.size === 0) return;
    if (!requireValidSource("remove edge")) return;
    const tuples = [];
    for (const k of selectedEdgeKeys) {
      const e = findEdgeByKey(k);
      if (e) tuples.push({ source: e.source, target: e.target, ordinal: e.ordinal });
    }
    if (tuples.length === 0) return;
    tuples.sort((a, b) => b.ordinal - a.ordinal);
    const label = tuples.length === 1
      ? `${tuples[0].source} → ${tuples[0].target}` + (tuples[0].ordinal > 0 ? ` (#${tuples[0].ordinal + 1})` : "")
      : `${tuples.length} edges`;
    if (!await confirmDialog(__("editor.delete_edge_confirm", label),
      { confirmLabel: __("common.delete"), danger: true })) return;
    let next = currentSource, ok = 0, errs = [], chainWarn = false;
    for (const t of tuples) {
      const r = deleteEdgeFromSource(next, t.source, t.target, t.ordinal);
      if (r.ok) { next = r.source; ok++; if (r.chainLine) chainWarn = true; }
      else errs.push(`${t.source}→${t.target}#${t.ordinal}: ${r.error}`);
    }
    if (ok > 0) {
      currentSource = next;
      markDirtySource();
      deselectEdge();
      await renderDiagram();
      pushHistory();
      const warn = chainWarn ? " (some edges were in a chain: full line removed)" : "";
      setStatus(tuples.length === 1
        ? __("editor.op.edge_deleted", label) + warn
        : `− ${ok}/${tuples.length} edges${errs.length ? " err: " + errs.join("; ") : ""}` + warn,
        errs.length > 0);
    } else if (errs.length) {
      setStatus(`delete: ${errs.join("; ")}`, true);
    }
  }

  // Batch-deletes the currently selected nodes (with confirm). Shared by the
  // Delete button and the Delete/Backspace keys.
  async function deleteSelectedNodes() {
    if (selectedNodeIds.size === 0) return;
    if (!requireValidSource("remove node")) return;
    const ids = [...selectedNodeIds];
    const label = ids.length === 1 ? `node '${ids[0]}'` : `${ids.length} nodes`;
    if (!await confirmDialog(__("editor.delete_node_confirm", label),
      { confirmLabel: __("common.delete"), danger: true })) return;
    let next = currentSource, ok = 0, errs = [];
    for (const id of ids) {
      const r = deleteNodeFromSource(next, id);
      if (r.ok) {
        next = r.source; ok++;
        if (positions[id] !== undefined) { delete positions[id]; markDirtyLayout(); }
      } else errs.push(`${id}: ${r.error}`);
    }
    if (ok > 0) {
      currentSource = next;
      markDirtySource();
      deselectNode();
      await renderDiagram();
      pushHistory();
      setStatus(ids.length === 1 ? __("editor.op.node_deleted", ids[0]) : `− ${ok}/${ids.length} nodes${errs.length ? " err: " + errs.join("; ") : ""}`,
                errs.length > 0);
    } else if (errs.length) {
      setStatus(`delete: ${errs.join("; ")}`, true);
    }
  }

  // Unified delete: dispatches to the right handler based on selection kind.
  async function applyDelete() {
    if (connectingState) return;
    const kind = selectionKind();
    if (kind === "node") return deleteSelectedNodes();
    if (kind === "edge") return deleteSelectedEdges();
    if (kind === "subgraph") return handleDeleteSubgraphClick([...selectedClusterIds][0]);
  }

  // ── Connect mode (ghost edge) ───────────────────────────────────────────

  async function handleConnectClick(id) {
    if (connectingState !== "edge-target") return;
    if (_ghostCleanup) { _ghostCleanup(); _ghostCleanup = null; }
    const src = connectSource, tgt = id;
    cancelConnectMode();
    if (src === tgt) { setStatus(__("editor.err.self_loop", src, tgt), true); return; }
    // Count existing edges between src and tgt: the new edge will have
    // ordinal = that count (ordinals are 0-based, in document order).
    const newOrdinal = edges.filter(e => e.source === src && e.target === tgt).length;
    // Create the edge unlabeled. User adds a label later via dblclick on
    // the edge — avoids the browser prompt() (some browsers silently block
    // repeated prompts) and matches the inline-edit flow used elsewhere.
    const result = addEdgeToSource(currentSource, src, tgt, "");
    if (!result.ok) { setStatus(`add edge: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    // Set selection synchronously *before* awaiting render: the target
    // click still bubbles up to diagramEl (line ~4360) and would deselect
    // any edge it sees set. The one-shot flag tells that listener to
    // skip this click — and renderDiagram's restore-selection logic will
    // apply the visual highlight from selectedEdgeKeys once the new edge
    // is in the DOM.
    deselectNode();
    deselectCluster();
    selectedEdgeKeys.clear();
    selectedEdgeKeys.add(`${src}|${tgt}|${newOrdinal}`);
    _skipNextDiagramClick = true;
    await renderDiagram();
    pushHistory();
    setStatus(__("editor.op.edge_added", src, tgt));
  }

  function startGhostEdge(svgEl, srcId) {
    if (_ghostCleanup) { _ghostCleanup(); _ghostCleanup = null; }
    const sc = nodeCenter(srcId);
    if (!sc || !svgEl) return null;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "ghost-edge");
    line.setAttribute("x1", sc.x); line.setAttribute("y1", sc.y);
    line.setAttribute("x2", sc.x); line.setAttribute("y2", sc.y);
    line.setAttribute("stroke", "#88c0d0");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "6 4");
    line.setAttribute("pointer-events", "none");
    line.setAttribute("opacity", "0.85");
    svgEl.appendChild(line);
    function onMove(e) {
      const pt = screenToSvg(svgEl, e.clientX, e.clientY);
      line.setAttribute("x2", pt.x); line.setAttribute("y2", pt.y);
    }
    document.addEventListener("pointermove", onMove);
    return function cleanup() {
      document.removeEventListener("pointermove", onMove);
      if (line.parentNode) line.parentNode.removeChild(line);
    };
  }

  // +Edge is selection-driven: a single source node must already be selected
  // when the user clicks the button. Clicking again while in target-pick mode
  // cancels.
  function startConnectMode() {
    if (connectingState === "edge-target") { cancelConnectMode(); return; }
    if (!requireValidSource("+ Edge")) return;
    let src = null;
    if (selectedNodeIds.size === 1 && selectedClusterIds.size === 0) src = [...selectedNodeIds][0];
    else if (selectedClusterIds.size === 1 && selectedNodeIds.size === 0) src = [...selectedClusterIds][0];
    else {
      setStatus(__("editor.select_1_source"), true);
      return;
    }
    connectingState = "edge-target";
    connectSource = src;
    document.body.classList.add("connecting");
    if (nodeMap[src]) nodeMap[src].g.classList.add("connect-source");
    else if (clusterMap[src]) clusterMap[src].g.classList.add("connect-source");
    addEdgeBtn.classList.add("active");
    addEdgeBtn.innerHTML = '<svg class="icon"><use href="#icon-x"/></svg>';
    addEdgeBtn.title = __("editor.add_edge_cancel");
    const svgEl = diagramEl.querySelector("svg");
    _ghostCleanup = startGhostEdge(svgEl, src);
    setStatus(__("editor.source_link", src));
  }
  function cancelConnectMode() {
    if (_ghostCleanup) { _ghostCleanup(); _ghostCleanup = null; }
    connectingState = null;
    if (connectSource) {
      if (nodeMap[connectSource]) nodeMap[connectSource].g.classList.remove("connect-source");
      else if (clusterMap[connectSource]) clusterMap[connectSource].g.classList.remove("connect-source");
    }
    connectSource = null;
    document.body.classList.remove("connecting");
    addEdgeBtn.classList.remove("active");
    addEdgeBtn.innerHTML = '<svg class="icon"><use href="#icon-arrow-link"/></svg>';
    addEdgeBtn.title = __("editor.add_edge_hint");
    updateToolbarState();
    setStatus("");
  }

  // ── Move-to-subgraph: pick a target subgraph (or root) for the current
  // selection. Reuses connectingState as a mode flag, value "move-target".
  let _moveSelectionIds = null;

  function startMoveMode() {
    if (connectingState === "move-target") { cancelMoveMode(); return; }
    if (connectingState) return;
    if (!requireValidSource("> Subgraph")) return;
    const ids = [];
    if (selectedNodeIds.size > 0) ids.push(...selectedNodeIds);
    if (selectedClusterIds.size > 0) ids.push(...selectedClusterIds);
    if (ids.length === 0) {
      setStatus(__("editor.select_1_or_more"), true);
      return;
    }
    connectingState = "move-target";
    _moveSelectionIds = ids;
    document.body.classList.add("moving");
    moveToSubgraphBtn.classList.add("active");
    moveToSubgraphBtn.innerHTML = '<svg class="icon"><use href="#icon-x"/></svg>';
    moveToSubgraphBtn.title = __("editor.move_cancel");
    setStatus(__("editor.move_hint", ids.length === 1 ? ids[0] : ids.length + " elementi"));
  }

  function cancelMoveMode() {
    connectingState = null;
    _moveSelectionIds = null;
    document.body.classList.remove("moving");
    if (moveToSubgraphBtn) {
      moveToSubgraphBtn.classList.remove("active");
      moveToSubgraphBtn.innerHTML = '<svg class="icon"><use href="#icon-log-in"/></svg>';
      moveToSubgraphBtn.title = __("editor.move_btn_hint");
    }
    updateToolbarState();
    setStatus("");
  }

  async function handleMoveTargetClick(targetId) {
    if (connectingState !== "move-target") return;
    const ids = _moveSelectionIds;
    cancelMoveMode();
    if (!ids || ids.length === 0) return;
    if (targetId && ids.includes(targetId)) {
      setStatus(__("editor.err.dest_is_selection"), true);
      return;
    }
    // Capture pre-move world translates for every node whose parent will
    // change: directly moved nodes plus descendants of moved subgraphs.
    // We restore these world coords after the re-render by adjusting each
    // node's local translate to compensate for the new parent translate.
    const preserveIds = new Set();
    for (const id of ids) {
      if (nodeMap[id]) preserveIds.add(id);
      else if (clusterMap[id]) {
        const members = findSubgraphMembers(currentSource, id);
        for (const m of members) preserveIds.add(m);
      }
    }
    const oldWorld = {};
    for (const pid of preserveIds) {
      const n = nodeMap[pid];
      if (!n) continue;
      oldWorld[pid] = getWorldTranslate(n.g);
    }
    const result = moveToSubgraphInSource(currentSource, ids, targetId);
    if (!result.ok) { setStatus(`move: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    // After Mermaid re-layout, derive a fresh local translate for each
    // preserved node such that its world position matches the captured one.
    let restored = 0;
    for (const pid of Object.keys(oldWorld)) {
      const n = nodeMap[pid];
      if (!n) continue;
      const newParent = getElementParentTranslate(n.g);
      const newLocalX = oldWorld[pid].x - newParent.x;
      const newLocalY = oldWorld[pid].y - newParent.y;
      setNodeTranslate(n.g, newLocalX, newLocalY);
      positions[pid] = { x: newLocalX, y: newLocalY };
      restored++;
    }
    if (restored > 0) {
      for (const pid of Object.keys(oldWorld)) {
        if (nodeMap[pid]) rerouteNodeEdges(pid);
      }
      updateAllClusterBounds();
      markDirtyLayout();
    }
    pushHistory();
    const where = targetId ? `→ ${targetId}` : "→ root";
    setStatus(`moved ${ids.length} elements ${where}`);
  }

  // ── Pan / zoom ───────────────────────────────────────────────────────────

  function applyViewState(svgEl) {
    if (!viewState) return;
    svgEl.setAttribute("viewBox",
      `${viewState.x} ${viewState.y} ${viewState.width} ${viewState.height}`);
    updateSelectionHaloScale(svgEl);
    // Collapse buttons are sized in world units counter-scaled to the zoom, so
    // they need a rebuild whenever the viewBox changes to stay constant on-screen.
    renderCollapseButtons();
  }

  // The selection halo filter uses feMorphology with `radius` in user units,
  // so a fixed 2/1 px halo disappears when the viewBox is zoomed out. Keep
  // the halo at a constant *screen* pixel size by scaling the morphology
  // radii inversely with the current zoom (user-units per screen-pixel).
  // Called from applyViewState — fires on every pan/zoom / wheel / pinch /
  // resize. Cheap: two attribute writes.
  const HALO_OUTER_PX = 4;
  const HALO_INNER_PX = 2;
  function updateSelectionHaloScale(svgEl) {
    if (!viewState) return;
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // preserveAspectRatio="xMidYMid meet" → uniform scale = min(rect/view).
    const scale = Math.min(rect.width / viewState.width, rect.height / viewState.height);
    if (!isFinite(scale) || scale <= 0) return;
    const u = 1 / scale; // user units per screen pixel
    const filt = document.getElementById("aq-sel-outline");
    if (!filt) return;
    const dOuter = filt.querySelector('feMorphology[result="dOuter"]');
    const dInner = filt.querySelector('feMorphology[result="dInner"]');
    if (dOuter) dOuter.setAttribute("radius", String(HALO_OUTER_PX * u));
    if (dInner) dInner.setAttribute("radius", String(HALO_INNER_PX * u));
  }
  // preserveAspectRatio="xMidYMid meet" scales the viewBox uniformly to fit
  // the rect: scale = min(rect.w/vb.w, rect.h/vb.h), then centers it. The
  // axis with the looser ratio gets letterboxed (an offset on that side).
  // Pan/zoom math must account for this or one axis pans slower than the other.
  function clientToView(mx, my, rect) {
    const scale = Math.min(rect.width / viewState.width, rect.height / viewState.height);
    const ox = (rect.width  - viewState.width  * scale) / 2;
    const oy = (rect.height - viewState.height * scale) / 2;
    return {
      x: viewState.x + (mx - ox) / scale,
      y: viewState.y + (my - oy) / scale,
    };
  }
  // Solve for viewState.{x,y} so that (mx,my) maps to the given view-space
  // anchor under the *current* viewState.{width,height}. Inverse of clientToView.
  function viewOriginForAnchor(anchorVX, anchorVY, mx, my, rect) {
    const scale = Math.min(rect.width / viewState.width, rect.height / viewState.height);
    const ox = (rect.width  - viewState.width  * scale) / 2;
    const oy = (rect.height - viewState.height * scale) / 2;
    return {
      x: anchorVX - (mx - ox) / scale,
      y: anchorVY - (my - oy) / scale,
    };
  }
  // View-space units per displayed pixel (same on both axes under meet).
  function viewUnitsPerPixel(rect) {
    return Math.max(viewState.width / rect.width, viewState.height / rect.height);
  }
  // Apply a viewport pushed by the scepter holder (follow mode). Mutates
  // viewState in place WITHOUT marking it dirty, so the snap doesn't bounce
  // back to peers as if it were a local pan.
  function applyHolderView(view) {
    if (!view) return;
    const x = +view.x, y = +view.y, w = +view.w, h = +view.h;
    if (!Number.isFinite(x) || !Number.isFinite(y)
        || !Number.isFinite(w) || !Number.isFinite(h)
        || w <= 0 || h <= 0) return;
    viewState = { x, y, width: w, height: h };
    const svgEl = diagramEl.querySelector("svg");
    if (svgEl) applyViewState(svgEl);
  }
  function fitView() {
    if (!initialViewBox) return;
    viewState = { ...initialViewBox };
    const svgEl = diagramEl.querySelector("svg");
    if (svgEl) applyViewState(svgEl);
    viewDirty = true;
  }

  // Compute the world-space bbox of the current selection (nodes + cluster +
  // edge if any). Returns {minX, minY, maxX, maxY} or null if nothing useful.
  function selectionWorldBbox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;
    const include = (x1, y1, x2, y2) => {
      if (!Number.isFinite(x1) || !Number.isFinite(y1)) return;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
      found = true;
    };
    for (const id of selectedNodeIds) {
      const n = nodeMap[id];
      if (!n) continue;
      let bb; try { bb = n.g.getBBox(); } catch (_) { continue; }
      const t = getWorldTranslate(n.g);
      include(t.x + bb.x, t.y + bb.y, t.x + bb.x + bb.width, t.y + bb.y + bb.height);
    }
    for (const cid of selectedClusterIds) {
      const c = clusterMap[cid];
      if (!c) continue;
      const bb = getClusterRectWorldBbox(c);
      if (bb) include(bb.minX, bb.minY, bb.maxX, bb.maxY);
    }
    for (const k of selectedEdgeKeys) {
      const edge = findEdgeByKey(k);
      if (!edge || !edge.path) continue;
      let bb; try { bb = edge.path.getBBox(); } catch (_) { bb = null; }
      if (!bb) continue;
      const t = getElementParentTranslate(edge.path);
      include(t.x + bb.x, t.y + bb.y, t.x + bb.x + bb.width, t.y + bb.y + bb.height);
    }
    return found ? { minX, minY, maxX, maxY } : null;
  }

  // Pan (no zoom change) the current view so the selection's bbox sits
  // centered in the viewport. No-op if nothing is selected.
  function centerOnSelection() {
    if (!viewState) return false;
    const bb = selectionWorldBbox();
    if (!bb) { setStatus(__("editor.status.nothing_center"), true); return false; }
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    viewState.x = cx - viewState.width / 2;
    viewState.y = cy - viewState.height / 2;
    const svgEl = diagramEl.querySelector("svg");
    if (svgEl) applyViewState(svgEl);
    viewDirty = true;
    return true;
  }
  function zoomStep(z) {
    if (!viewState) return;
    const svgEl = diagramEl.querySelector("svg");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const anchor = clientToView(cx, cy, rect);
    const minW = initialViewBox.width / 10;
    const maxW = initialViewBox.width * 10;
    const newW = viewState.width / z;
    if (newW < minW || newW > maxW) return;
    viewState.width = newW;
    viewState.height = viewState.height / z;
    const origin = viewOriginForAnchor(anchor.x, anchor.y, cx, cy, rect);
    viewState.x = origin.x;
    viewState.y = origin.y;
    applyViewState(svgEl);
    viewDirty = true;
  }
  // Rubber-band selection. Left-mouse-down on background starts a candidate
  // marquee; once the pointer moves past MARQUEE_THRESHOLD_PX we begin
  // drawing a dashed rect overlay in view-space coords. On release we
  // intersect that rect (AABB) against every node and cluster bbox and
  // commit the result. Shift/Ctrl/Cmd held at pointerdown → additive
  // (union with existing selection); otherwise the result replaces the
  // current selection.
  function startMarquee(ev, svgEl) {
    const MARQUEE_THRESHOLD_PX = 4;
    const pointerId = ev.pointerId;
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    const rect0 = svgEl.getBoundingClientRect();
    const start = clientToView(ev.clientX - rect0.left, ev.clientY - rect0.top, rect0);
    const sx0 = ev.clientX, sy0 = ev.clientY;
    let overlay = null;
    let started = false;
    let lastView = start;

    function ensureOverlay() {
      if (overlay) return;
      overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      overlay.setAttribute("class", "marquee");
      overlay.setAttribute("fill", "rgba(136,192,208,0.12)");
      overlay.setAttribute("stroke", "#88c0d0");
      overlay.setAttribute("stroke-dasharray", "4 3");
      overlay.setAttribute("pointer-events", "none");
      // Keep the dashed border 1 device-pixel wide regardless of zoom.
      overlay.setAttribute("vector-effect", "non-scaling-stroke");
      overlay.setAttribute("stroke-width", "1");
      svgEl.appendChild(overlay);
    }
    function paint() {
      const x = Math.min(start.x, lastView.x);
      const y = Math.min(start.y, lastView.y);
      const w = Math.abs(lastView.x - start.x);
      const h = Math.abs(lastView.y - start.y);
      overlay.setAttribute("x", x);
      overlay.setAttribute("y", y);
      overlay.setAttribute("width", w);
      overlay.setAttribute("height", h);
    }
    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      if (!started) {
        const ddx = e.clientX - sx0, ddy = e.clientY - sy0;
        if (Math.abs(ddx) < MARQUEE_THRESHOLD_PX && Math.abs(ddy) < MARQUEE_THRESHOLD_PX) return;
        started = true;
        ensureOverlay();
      }
      const rect = svgEl.getBoundingClientRect();
      lastView = clientToView(e.clientX - rect.left, e.clientY - rect.top, rect);
      paint();
    }
    function onUp(e) {
      if (e && e.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (!started) return; // below threshold → let the normal click handler run
      // Suppress the trailing diagramEl click so it doesn't immediately
      // clear the selection we just made.
      _skipNextDiagramClick = true;
      const mMinX = Math.min(start.x, lastView.x);
      const mMaxX = Math.max(start.x, lastView.x);
      const mMinY = Math.min(start.y, lastView.y);
      const mMaxY = Math.max(start.y, lastView.y);
      // Containment test: an element is picked only if its entire AABB sits
      // inside the marquee. Strict-inclusion semantics — matches Figma's
      // left-to-right drag behavior and avoids accidental grabs of large
      // subgraphs that just happen to overlap the box edge.
      const contains = (aMinX, aMinY, aMaxX, aMaxY) =>
        aMinX >= mMinX && aMaxX <= mMaxX && aMinY >= mMinY && aMaxY <= mMaxY;

      const pickedNodes = [];
      for (const [id, n] of Object.entries(nodeMap)) {
        let bb; try { bb = n.g.getBBox(); } catch (_) { continue; }
        const t = getWorldTranslate(n.g);
        if (contains(t.x + bb.x, t.y + bb.y, t.x + bb.x + bb.width, t.y + bb.y + bb.height)) {
          pickedNodes.push(id);
        }
      }
      const pickedClusters = [];
      for (const [id, c] of Object.entries(clusterMap)) {
        const bb = getClusterRectWorldBbox(c);
        if (!bb) continue;
        if (contains(bb.minX, bb.minY, bb.maxX, bb.maxY)) pickedClusters.push(id);
      }

      if (!additive) {
        // Replace: clear everything, then add picks. Inline-clear (don't call
        // deselect* which each broadcast separately) — one broadcast at the
        // end is enough.
        for (const sid of selectedNodeIds) {
          if (nodeMap[sid]) nodeMap[sid].g.classList.remove("selected");
        }
        selectedNodeIds.clear();
        for (const cid of selectedClusterIds) {
          if (clusterMap[cid]) clusterMap[cid].g.classList.remove("selected");
        }
        selectedClusterIds.clear();
        for (const k of selectedEdgeKeys) {
          const prev = findEdgeByKey(k);
          if (prev) prev.path.classList.remove("selected");
        }
        selectedEdgeKeys.clear();
      }
      for (const id of pickedNodes) {
        if (!selectedNodeIds.has(id)) {
          selectedNodeIds.add(id);
          if (nodeMap[id]) nodeMap[id].g.classList.add("selected");
        }
      }
      for (const id of pickedClusters) {
        if (!selectedClusterIds.has(id)) {
          selectedClusterIds.add(id);
          if (clusterMap[id]) clusterMap[id].g.classList.add("selected");
        }
      }
      updateToolbarState();
      renderEdgeHotspots();
      const total = selectedNodeIds.size + selectedClusterIds.size;
      if (total === 0) setStatus("");
      else if (total === 1 && selectedNodeIds.size === 1) {
        setStatus(__("editor.status.selected", [...selectedNodeIds][0]));
      } else if (total === 1 && selectedClusterIds.size === 1) {
        setStatus(__("editor.status.selected_subgraph", [...selectedClusterIds][0]));
      } else {
        setStatus(__("editor.status.selected_n", total));
      }
      broadcastSelection();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function setupPanZoom(svgEl) {
    if (initialViewBox === null) {
      const vb = svgEl.viewBox.baseVal;
      initialViewBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
    }
    if (viewState === null) viewState = { ...initialViewBox };
    applyViewState(svgEl);

    // Unified pan + pinch-zoom using Pointer Events. Tracking up to 2
    // simultaneous pointers covers mouse pan, single-finger pan, and
    // two-finger pinch-zoom on touch devices. CSS sets `touch-action: none`
    // on #diagram so the browser's own gestures (page scroll, page pinch)
    // don't compete with these handlers.
    const activePointers = new Map(); // pointerId -> {clientX, clientY}
    let mode = null;     // 'pan' | 'pinch' | null
    let panStart = null; // {rect, x, y, vx, vy}
    let pinchStart = null; // {dist, rect, anchorVX, anchorVY, vw, vh}
    let docOn = false;

    function ensureDoc() {
      if (docOn) return;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerUp);
      docOn = true;
    }
    function clearDoc() {
      if (!docOn) return;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      docOn = false;
    }

    function startPinch() {
      const pts = [...activePointers.values()];
      const dx = pts[0].clientX - pts[1].clientX;
      const dy = pts[0].clientY - pts[1].clientY;
      const dist = Math.hypot(dx, dy);
      const cx = (pts[0].clientX + pts[1].clientX) / 2;
      const cy = (pts[0].clientY + pts[1].clientY) / 2;
      const rect = svgEl.getBoundingClientRect();
      const mx = cx - rect.left, my = cy - rect.top;
      const anchor = clientToView(mx, my, rect);
      pinchStart = {
        dist: dist > 1 ? dist : 1, rect,
        vw: viewState.width, vh: viewState.height,
        // Anchor: the view-space coord under the midpoint when pinch began;
        // we keep this point pinned under the fingers' midpoint as they move.
        anchorVX: anchor.x,
        anchorVY: anchor.y,
      };
    }
    function startPanFromPointer(p) {
      mode = "pan";
      const rect = svgEl.getBoundingClientRect();
      panStart = { rect, x: p.clientX, y: p.clientY, vx: viewState.x, vy: viewState.y };
      svgEl.classList.add("panning");
    }

    function onPointerDown(e) {
      // Middle-mouse pan works anywhere on the canvas (incl. over nodes /
      // subgraphs / edges). For non-middle-button events we keep the
      // background-only behavior so per-element drag handlers can take
      // precedence.
      const isMiddleMouse = e.pointerType === "mouse" && e.button === 1;
      if (!isMiddleMouse) {
        if (e.target.closest("g.node")) return;
        if (e.target.closest("g.cluster")) return;
        if (e.target.closest("g.edgePaths path")) return;
        if (e.target.closest("g.edgeLabels > g")) return;
      }
      if (connectingState) return;
      // Mouse left button on background → rubber-band (marquee) selection.
      // The marquee owns its own pointermove/pointerup listeners, so we
      // return here BEFORE the pan path. Touch/pen single-contact still
      // pans (button === 0 on primary contact); we restrict marquee to
      // pointerType === "mouse" so touch panning isn't hijacked.
      if (e.pointerType === "mouse" && e.button === 0) {
        e.preventDefault();
        startMarquee(e, svgEl);
        return;
      }
      // Mouse: pan only with the middle button. Touch/pen: single-contact
      // pan still works (button === 0 on primary contact).
      if (e.pointerType === "mouse" && e.button !== 1) return;
      e.preventDefault();
      activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      ensureDoc();
      if (activePointers.size === 1) {
        startPanFromPointer(e);
      } else if (activePointers.size === 2) {
        svgEl.classList.remove("panning");
        mode = "pinch";
        startPinch();
      }
    }

    function onPointerMove(e) {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      if (mode === "pan" && activePointers.size === 1) {
        const rect = panStart.rect;
        const k = viewUnitsPerPixel(rect);
        viewState.x = panStart.vx - (e.clientX - panStart.x) * k;
        viewState.y = panStart.vy - (e.clientY - panStart.y) * k;
        applyViewState(svgEl);
        viewDirty = true;
        return;
      }
      if (mode === "pinch" && activePointers.size === 2) {
        const pts = [...activePointers.values()];
        const dx = pts[0].clientX - pts[1].clientX;
        const dy = pts[0].clientY - pts[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return;
        const z = dist / pinchStart.dist;
        const newW = pinchStart.vw / z;
        const newH = pinchStart.vh / z;
        const minW = initialViewBox.width / 10;
        const maxW = initialViewBox.width * 10;
        if (newW < minW || newW > maxW) return;
        viewState.width = newW;
        viewState.height = newH;
        const cx = (pts[0].clientX + pts[1].clientX) / 2;
        const cy = (pts[0].clientY + pts[1].clientY) / 2;
        const rect = pinchStart.rect;
        const mx = cx - rect.left, my = cy - rect.top;
        const origin = viewOriginForAnchor(pinchStart.anchorVX, pinchStart.anchorVY, mx, my, rect);
        viewState.x = origin.x;
        viewState.y = origin.y;
        applyViewState(svgEl);
        viewDirty = true;
      }
    }

    function onPointerUp(e) {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.delete(e.pointerId);
      if (activePointers.size === 1 && mode === "pinch") {
        // 2 → 1 finger: gracefully switch back to pan from the survivor.
        const survivor = [...activePointers.values()][0];
        startPanFromPointer(survivor);
      } else if (activePointers.size === 0) {
        mode = null;
        svgEl.classList.remove("panning");
        clearDoc();
      }
    }

    svgEl.addEventListener("pointerdown", onPointerDown);
    svgEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const anchor = clientToView(mx, my, rect);
      const z = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      let newW = viewState.width / z;
      let newH = viewState.height / z;
      const minW = initialViewBox.width / 10;
      const maxW = initialViewBox.width * 10;
      if (newW < minW || newW > maxW) return;
      viewState.width = newW;
      viewState.height = newH;
      const origin = viewOriginForAnchor(anchor.x, anchor.y, mx, my, rect);
      viewState.x = origin.x;
      viewState.y = origin.y;
      applyViewState(svgEl);
      viewDirty = true;
    }, { passive: false });
  }

  // ── Selection / palette ──────────────────────────────────────────────────

  function toggleNodeSelection(id, additive) {
    if (additive) {
      // Shift/Ctrl/Cmd+click: toggle membership without disturbing existing
      // subgraph selection (mixed node+cluster groups). Edges are mutually
      // exclusive with nodes/clusters — additive node-click drops them.
      deselectEdge();
      if (selectedNodeIds.has(id)) {
        selectedNodeIds.delete(id);
        if (nodeMap[id]) nodeMap[id].g.classList.remove("selected");
      } else {
        selectedNodeIds.add(id);
        if (nodeMap[id]) nodeMap[id].g.classList.add("selected");
      }
      updateToolbarState();
      const nN = selectedNodeIds.size, nC = selectedClusterIds.size;
      if (nN === 0 && nC === 0) setStatus("");
      else if (nC === 0 && nN === 1) setStatus(__("editor.status.selected", [...selectedNodeIds][0]));
      else setStatus(__("editor.status.selected_n", nN + nC));
      broadcastSelection();
      return;
    }
    // Plain click: replace selection with [id]; clicking the only-selected node deselects.
    if (selectedNodeIds.size === 1 && selectedNodeIds.has(id) && selectedClusterIds.size === 0) {
      deselectNode(); return;
    }
    deselectCluster();
    deselectEdge();
    for (const sid of selectedNodeIds) {
      if (nodeMap[sid]) nodeMap[sid].g.classList.remove("selected");
    }
    selectedNodeIds.clear();
    selectedNodeIds.add(id);
    if (nodeMap[id]) nodeMap[id].g.classList.add("selected");
    updateToolbarState();
    setStatus(__("editor.status.selected", id));
    broadcastSelection();
  }
  function deselectNode() {
    for (const sid of selectedNodeIds) {
      if (nodeMap[sid]) nodeMap[sid].g.classList.remove("selected");
    }
    selectedNodeIds.clear();
    updateToolbarState();
    broadcastSelection();
  }

  // Selection bus: derive the current selection kind from state.
  // Returns one of: 'node' (1+ nodes only), 'edge' (1+ edges only),
  // 'subgraph' (exactly 1 subgraph only), 'subgraphs' (2+ subgraphs only),
  // 'mixed' (nodes + subgraphs), null.
  function selectionKind() {
    const nN = selectedNodeIds.size;
    const nE = selectedEdgeKeys.size;
    const nC = selectedClusterIds.size;
    if (nN === 0 && nE === 0 && nC === 0) return null;
    if (nE > 0) return "edge"; // edges stay mutually exclusive
    if (nN > 0 && nC > 0) return "mixed";
    if (nN > 0) return "node";
    return nC === 1 ? "subgraph" : "subgraphs";
  }
  // Returns the sole selected edge key (when exactly one is selected) or null.
  // Use for operations that only make sense on a single edge: bend handles,
  // toggle style, cycle arrow, reverse, edit label.
  function singleEdgeKey() {
    return selectedEdgeKeys.size === 1 ? [...selectedEdgeKeys][0] : null;
  }

  // Single source of truth for toolbar enable/disable. Called after every
  // selection change. Skips the "+Edge target step" because in that mode the
  // button is repurposed as Cancel and stays clickable.
  function updateToolbarState() {
    if (connectingState === "edge-target") return; // managed by startConnectMode
    if (connectingState === "move-target") return; // managed by startMoveMode
    const kind = selectionKind();
    const nNodes = selectedNodeIds.size;
    if (addEdgeBtn)      addEdgeBtn.disabled      = !((kind === "node" && nNodes === 1) || kind === "subgraph");
    if (addSubgraphBtn)  addSubgraphBtn.disabled  = !(kind === "node" && nNodes >= 2);
    // Delete: enabled only for single-kind selections. Mixed and multi-
    // subgraph are intentionally disabled to keep destructive ops unambiguous.
    if (deleteBtn)       deleteBtn.disabled       = !(kind === "node" || kind === "edge" || kind === "subgraph");
    // Edge-style / arrow / reverse only act on a single edge — the source
    // mutations are per-(src,tgt,ord) tuple. Disable on multi-edge selection.
    const singleEdge = (kind === "edge" && selectedEdgeKeys.size === 1);
    if (toggleEdgeStyleBtn) toggleEdgeStyleBtn.disabled = !singleEdge;
    if (cycleEdgeArrowBtn)  cycleEdgeArrowBtn.disabled  = !singleEdge;
    if (reverseEdgeBtn)     reverseEdgeBtn.disabled     = !singleEdge;
    const alignEnabled = (kind === "node" && nNodes >= 2);
    const distributeEnabled = (kind === "node" && nNodes >= 3);
    if (alignVBtn)        alignVBtn.disabled        = !alignEnabled;
    if (alignHBtn)        alignHBtn.disabled        = !alignEnabled;
    if (distributeHBtn)   distributeHBtn.disabled   = !distributeEnabled;
    if (distributeVBtn)   distributeVBtn.disabled   = !distributeEnabled;
    if (moveToSubgraphBtn) {
      moveToSubgraphBtn.disabled = !(kind === "node" || kind === "subgraph" || kind === "subgraphs" || kind === "mixed");
    }
    // Palette: the swatch row swaps to the active selection's group and marks
    // swatches inert when there's nothing to apply to (still double-click
    // editable). Shape applies only to nodes.
    renderActivePalette();
    const shapeEnabled = (kind === "node");
    if (shapePaletteEl) {
      for (const b of shapePaletteEl.querySelectorAll("button")) b.disabled = !shapeEnabled;
    }
    updateNotesPanel();
  }

  function toggleClusterSelection(id, additive) {
    if (additive) {
      // Shift/Ctrl/Cmd+click: toggle membership without disturbing nodes
      // already in the selection. Edges are mutually exclusive with nodes/
      // clusters — additive cluster-click drops them.
      deselectEdge();
      if (selectedClusterIds.has(id)) {
        selectedClusterIds.delete(id);
        if (clusterMap[id]) clusterMap[id].g.classList.remove("selected");
      } else {
        selectedClusterIds.add(id);
        if (clusterMap[id]) clusterMap[id].g.classList.add("selected");
      }
      updateToolbarState();
      const nN = selectedNodeIds.size, nC = selectedClusterIds.size;
      if (nC === 0 && nN === 0) setStatus("");
      else if (nN === 0 && nC === 1) setStatus(__("editor.status.selected_subgraph", [...selectedClusterIds][0]));
      else setStatus(__("editor.status.selected_n", nN + nC));
      broadcastSelection();
      return;
    }
    // Plain click: replace selection with [id]; clicking the only-selected cluster deselects.
    if (selectedClusterIds.size === 1 && selectedClusterIds.has(id) && selectedNodeIds.size === 0) {
      deselectCluster(); return;
    }
    deselectNode();
    deselectEdge();
    for (const cid of selectedClusterIds) {
      if (clusterMap[cid]) clusterMap[cid].g.classList.remove("selected");
    }
    selectedClusterIds.clear();
    selectedClusterIds.add(id);
    if (clusterMap[id]) clusterMap[id].g.classList.add("selected");
    updateToolbarState();
    setStatus(__("editor.status.selected_subgraph", id));
    broadcastSelection();
  }
  function deselectCluster() {
    for (const cid of selectedClusterIds) {
      if (clusterMap[cid]) clusterMap[cid].g.classList.remove("selected");
    }
    selectedClusterIds.clear();
    updateToolbarState();
    broadcastSelection();
  }

  function edgeKey(edge) { return `${edge.source}|${edge.target}|${edge.ordinal}`; }
  function findEdgeByKey(key) {
    for (const e of edges) if (edgeKey(e) === key) return e;
    return null;
  }
  function toggleEdgeSelection(edge, additive) {
    const key = edgeKey(edge);
    if (additive) {
      // Shift/Ctrl/Cmd+click: toggle membership without disturbing the rest.
      deselectNode();
      deselectCluster();
      if (selectedEdgeKeys.has(key)) {
        selectedEdgeKeys.delete(key);
        edge.path.classList.remove("selected");
      } else {
        selectedEdgeKeys.add(key);
        edge.path.classList.add("selected");
      }
      updateToolbarState();
      renderEdgeHotspots();
      const n = selectedEdgeKeys.size;
      if (n === 0) setStatus("");
      else if (n === 1) {
        const e = findEdgeByKey([...selectedEdgeKeys][0]);
        const lbl = e ? `${e.source} → ${e.target}` + (e.ordinal > 0 ? ` (#${e.ordinal + 1})` : "") : "";
        setStatus(__("editor.status.selected_edge", lbl));
      } else setStatus(__("editor.status.selected_edges_n", n));
      broadcastSelection();
      return;
    }
    // Plain click: replace selection with [edge]; clicking the only-selected edge deselects.
    if (selectedEdgeKeys.size === 1 && selectedEdgeKeys.has(key)) { deselectEdge(); return; }
    deselectNode();
    deselectCluster();
    for (const k of selectedEdgeKeys) {
      const prev = findEdgeByKey(k);
      if (prev) prev.path.classList.remove("selected");
    }
    selectedEdgeKeys.clear();
    selectedEdgeKeys.add(key);
    edge.path.classList.add("selected");
    const lbl = `${edge.source} → ${edge.target}` + (edge.ordinal > 0 ? ` (#${edge.ordinal + 1})` : "");
    setStatus(__("editor.status.selected_edge", lbl));
    updateToolbarState();
    renderEdgeHotspots();
    broadcastSelection();
  }
  function deselectEdge() {
    for (const k of selectedEdgeKeys) {
      const prev = findEdgeByKey(k);
      if (prev) prev.path.classList.remove("selected");
    }
    selectedEdgeKeys.clear();
    updateToolbarState();
    renderEdgeHotspots();
    broadcastSelection();
  }

  function setNodeStyleInSource(source, nodeId, styleStr) {
    const idEsc = regexEscape(nodeId);
    const styleRe = new RegExp(`^\\s*style\\s+${idEsc}\\b.*$`, "m");
    if (styleStr === null) {
      if (!styleRe.test(source)) return { ok: true, source, changed: false };
      const lines = source.split("\n").filter(l =>
        !new RegExp(`^\\s*style\\s+${idEsc}\\b`).test(l));
      return { ok: true, source: lines.join("\n"), changed: true };
    }
    const line = `    style ${nodeId} ${styleStr}`;
    if (styleRe.test(source)) {
      return { ok: true, source: source.replace(styleRe, line), changed: true };
    }
    if (!source.endsWith("\n")) source += "\n";
    return { ok: true, source: source + line + "\n", changed: true };
  }

  // Apply palette slot `slot` (0..6) to the current selection, or clear the
  // styling when slot === "reset". Each selected id is routed to its own bucket
  // and gets the preset for its OWN group: in a mixed node+subgraph selection a
  // single slot applies palettes.nodes[slot] to nodes and palettes.subgraphs[slot]
  // to subgraphs by index (the three palettes share slot identity).
  async function applyPaletteColor(slot) {
    if (!requireValidSource("apply color")) return;
    const reset = slot === "reset";
    const edgeSelected = selectedEdgeKeys.size > 0;
    const ids = edgeSelected ? [...selectedEdgeKeys]
              : [...selectedNodeIds, ...selectedClusterIds];
    if (!ids.length) { setStatus(__("editor.err.select_node_or_subgraph"), true); return; }
    let next = currentSource, sourceChanged = false, anyDeleted = false, applied = 0;
    for (const id of ids) {
      const isSubgraph = !edgeSelected && !!clusterMap[id];
      const bucket = edgeSelected ? edgeStyles : (isSubgraph ? subgraphStyles : nodeStyles);
      let props = null;
      if (!reset) {
        if (edgeSelected) {
          const pr = palettes.edges[slot];
          props = { stroke: pr.stroke, color: pr.color };
        } else {
          const pr = (isSubgraph ? palettes.subgraphs : palettes.nodes)[slot];
          props = { fill: pr.fill, stroke: pr.stroke, color: pr.color };
        }
      }
      let touched = false;
      if (props) {
        const prev = bucket[id];
        if (!prev || !shallowEq(prev, props)) {
          bucket[id] = Object.assign({}, prev || {}, props);
          touched = true;
        }
      } else if (bucket[id]) {
        delete bucket[id];
        touched = true;
        anyDeleted = true;
      }
      // Defensive: a stale `style <id> …` left in the source by the legacy
      // code path (or another tab) would shadow the bucket via Mermaid's
      // native pass — drop it so the bucket is the single source of truth.
      // Only applies to nodes/subgraphs (edges never had inline `style …`).
      if (!edgeSelected) {
        const r = setNodeStyleInSource(next, id, null);
        if (r.changed) { next = r.source; sourceChanged = true; touched = true; }
      }
      if (touched) applied++;
    }
    if (!applied) { setStatus(__("editor.err.color_no_change")); return; }
    markDirtyLayout();
    // Full re-render is needed when (a) source mutated, or (b) any entry was
    // deleted from a bucket — in that case applyVisualStyles can't restore the
    // Mermaid-default look because it doesn't know what was there originally,
    // so we let Mermaid re-render from clean source.
    if (sourceChanged || anyDeleted) {
      if (sourceChanged) { currentSource = next; markDirtySource(); }
      await renderDiagram();
    } else {
      // Pure additive bucket change: skip Mermaid round-trip and just restyle
      // the existing SVG. Avoids the re-layout flash from re-parsing.
      const svgEl = diagramEl.querySelector("svg");
      if (svgEl) applyVisualStyles(svgEl);
    }
    pushHistory();
    const name = reset ? __("editor.color_reset") : PALETTE_NAMES[slot];
    const label = edgeSelected
      ? (() => { const e = findEdgeByKey(ids[0]); return e ? `${e.source} → ${e.target}` : ids[0]; })()
      : ids[0];
    setStatus(ids.length === 1 ? `${label}: color ${name}`
                               : `color ${name} → ${applied}/${ids.length} elementi`);
  }

  // ── Contextual palette row ─────────────────────────────────────────────────
  // One swatch row that swaps with the selection: edge → edge palette; only
  // subgraph(s) → subgraph palette; nodes (or mixed node+subgraph) → node
  // palette. When nothing is selected the row is sticky (keeps the last group)
  // and swatches are inert for applying but still double-click-editable.
  let lastPaletteGroup = "nodes";
  let currentPaletteGroup = null;
  const paletteGroupLabelEl = document.getElementById("paletteGroupLabel");

  function paletteApplyEnabled() {
    return selectedEdgeKeys.size > 0 || selectedNodeIds.size > 0 || selectedClusterIds.size > 0;
  }
  function selectionPaletteGroup() {
    if (selectedEdgeKeys.size > 0) return "edges";
    if (selectedClusterIds.size > 0 && selectedNodeIds.size === 0) return "subgraphs";
    if (selectedNodeIds.size > 0 || selectedClusterIds.size > 0) return "nodes";
    return lastPaletteGroup;
  }

  function buildSwatches(group) {
    colorPaletteEl.innerHTML = "";
    const presets = palettes[group];
    for (let i = 0; i < presets.length; i++) {
      const pr = presets[i];
      const btn = document.createElement("button");
      btn.className = "color-swatch";
      btn.type = "button";
      btn.dataset.slot = String(i);
      // Edge swatches have no fill — preview the line color (stroke).
      btn.style.background = group === "edges" ? pr.stroke : pr.fill;
      if (group !== "edges" && pr.stroke) btn.style.borderColor = pr.stroke;
      btn.title = PALETTE_NAMES[i];
      let clickTimer = null;
      btn.addEventListener("click", () => {
        // Disambiguate single-click (apply) from double-click (edit): a brief
        // delay lets a second click cancel the apply before it fires.
        if (clickTimer) return;
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (paletteApplyEnabled()) applyPaletteColor(i);
        }, 180);
      });
      btn.addEventListener("dblclick", () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openPresetEditor(currentPaletteGroup, i);
      });
      colorPaletteEl.appendChild(btn);
    }
    // Reset swatch — clears styling; not editable, applies instantly.
    const reset = document.createElement("button");
    reset.className = "color-swatch";
    reset.type = "button";
    reset.dataset.reset = "1";
    reset.textContent = "×";
    reset.title = __("editor.color_reset");
    reset.addEventListener("click", () => { if (paletteApplyEnabled()) applyPaletteColor("reset"); });
    colorPaletteEl.appendChild(reset);
  }

  // Rebuild the swatch row for the active group (only when the group changed)
  // and reflect whether applying is currently possible.
  function renderActivePalette() {
    if (!colorPaletteEl) return;
    const hasSel = paletteApplyEnabled();
    const group = selectionPaletteGroup();
    if (hasSel) lastPaletteGroup = group;
    if (group !== currentPaletteGroup) {
      currentPaletteGroup = group;
      buildSwatches(group);
    }
    for (const b of colorPaletteEl.querySelectorAll("button")) {
      b.classList.toggle("swatch-inert", !hasSel);
    }
    if (paletteGroupLabelEl) {
      paletteGroupLabelEl.textContent = __("editor.palette_group." + group);
    }
  }

  // ── Preset editor modal ────────────────────────────────────────────────────
  const palettePresetModal = document.getElementById("palettePresetModal");
  const presetChannelsEl = document.getElementById("palettePresetChannels");
  const presetPreviewEl = document.getElementById("palettePresetPreview");
  const presetEyedropBtn = document.getElementById("palettePresetEyedrop");
  const presetTitleEl = document.getElementById("palettePresetTitle");
  // Working state of the open editor: { group, slot, values:{prop:hex} }.
  let presetEdit = null;
  let presetPicking = false;

  function openPresetEditor(group, slot) {
    const pr = palettes[group][slot];
    const values = {}, hsv = {};
    // Keep an HSV working copy per channel so dragging V/S to an extreme (e.g.
    // black) doesn't lose the hue when we round-trip through hex.
    for (const [prop] of PALETTE_CHANNELS[group]) {
      values[prop] = pr[prop];
      hsv[prop] = rgbToHsv(hexToRgb(pr[prop]));
    }
    presetEdit = { group, slot, values, hsv };
    if (presetTitleEl) {
      presetTitleEl.textContent =
        `${__("editor.palette_group." + group)} · ${PALETTE_NAMES[slot]}`;
    }
    buildPresetChannels();
    updatePresetPreview();
    palettePresetModal.classList.remove("hidden");
  }

  function closePresetEditor() {
    endEyedropper();
    palettePresetModal.classList.add("hidden");
    presetEdit = null;
  }

  // HSV channels: Hue 0–360°, Saturation/Value 0–100%.
  const HSV_CHANNELS = [
    { k: "h", label: "H", max: 360, unit: "°" },
    { k: "s", label: "S", max: 100, unit: "" },
    { k: "v", label: "V", max: 100, unit: "" },
  ];
  function fmtHsv(k, val) { return Math.round(val) + (k === "h" ? "°" : ""); }

  function buildPresetChannels() {
    presetChannelsEl.innerHTML = "";
    for (const [prop, key] of PALETTE_CHANNELS[presetEdit.group]) {
      const hsv = presetEdit.hsv[prop];
      const wrap = document.createElement("div");
      wrap.className = "pp-channel";
      wrap.dataset.prop = prop;
      const head = document.createElement("div");
      head.className = "pp-channel-head";
      head.innerHTML =
        `<span class="pp-swatch"></span>` +
        `<span class="pp-channel-name">${__("editor.palette_channel." + key)}</span>` +
        `<span class="pp-hex"></span>`;
      wrap.appendChild(head);
      // H/S/V on a single row: letter on top, slider below, value beneath.
      const sliders = document.createElement("div");
      sliders.className = "pp-sliders";
      for (const { k, label, max } of HSV_CHANNELS) {
        const row = document.createElement("label");
        row.className = "pp-slider";
        row.innerHTML =
          `<span class="pp-ch">${label}</span>` +
          `<input type="range" min="0" max="${max}" value="${Math.round(hsv[k])}" data-ch="${k}">` +
          `<span class="pp-val">${fmtHsv(k, hsv[k])}</span>`;
        const input = row.querySelector("input");
        input.addEventListener("input", () => {
          presetEdit.hsv[prop][k] = +input.value;
          presetEdit.values[prop] = rgbToHex(hsvToRgb(presetEdit.hsv[prop]));
          row.querySelector(".pp-val").textContent = fmtHsv(k, +input.value);
          paintPresetChannel(wrap, prop);
          updatePresetPreview();
        });
        sliders.appendChild(row);
      }
      wrap.appendChild(sliders);
      presetChannelsEl.appendChild(wrap);
      paintPresetChannel(wrap, prop);
    }
  }

  function paintPresetChannel(wrap, prop) {
    const hex = presetEdit.values[prop];
    wrap.querySelector(".pp-swatch").style.background = hex;
    wrap.querySelector(".pp-hex").textContent = hex;
  }

  // Refresh slider positions/labels from presetEdit.values (used by eyedropper).
  // Recomputes the HSV working copy from the (new) hex first.
  function syncPresetChannels() {
    for (const wrap of presetChannelsEl.querySelectorAll(".pp-channel")) {
      const prop = wrap.dataset.prop;
      presetEdit.hsv[prop] = rgbToHsv(hexToRgb(presetEdit.values[prop]));
      const hsv = presetEdit.hsv[prop];
      for (const input of wrap.querySelectorAll("input[data-ch]")) {
        const k = input.dataset.ch;
        input.value = Math.round(hsv[k]);
        input.parentElement.querySelector(".pp-val").textContent = fmtHsv(k, hsv[k]);
      }
      paintPresetChannel(wrap, prop);
    }
    updatePresetPreview();
  }

  function updatePresetPreview() {
    if (!presetPreviewEl || !presetEdit) return;
    const v = presetEdit.values;
    if (presetEdit.group === "edges") {
      presetPreviewEl.style.background = "";
      presetPreviewEl.style.border = "none";
      presetPreviewEl.innerHTML =
        `<span class="pp-edge-line" style="background:${v.stroke}"></span>` +
        `<span class="pp-edge-label" style="color:${v.color}">Abc</span>`;
    } else {
      presetPreviewEl.innerHTML = `<span style="color:${v.color}">Abc</span>`;
      presetPreviewEl.style.background = v.fill;
      presetPreviewEl.style.border = `2px solid ${v.stroke}`;
    }
  }

  function savePresetEdit() {
    if (!presetEdit) return;
    const { group, slot, values } = presetEdit;
    const target = palettes[group][slot];
    let changed = false;
    for (const [prop] of PALETTE_CHANNELS[group]) {
      if (target[prop] !== values[prop]) { target[prop] = values[prop]; changed = true; }
    }
    closePresetEditor();
    if (!changed) return;
    markDirtyLayout();
    pushHistory();
    // Repaint the swatch row if the edited group is the one on screen.
    if (group === currentPaletteGroup) { currentPaletteGroup = null; renderActivePalette(); }
    setStatus(`palette ${__("editor.palette_group." + group)} · ${PALETTE_NAMES[slot]}`);
  }

  // ── Eyedropper ──────────────────────────────────────────────────────────────
  // Arm a one-shot pick: the next click on a graph element loads its colors
  // into the open preset editor. The modal dims + stops intercepting pointer
  // events so the canvas underneath is clickable.
  function armEyedropper() {
    if (!presetEdit) return;
    presetPicking = true;
    // Hide the modal entirely so the canvas underneath is fully clickable; it
    // reappears (endEyedropper) once an element is picked or the pick cancelled.
    palettePresetModal.classList.add("hidden");
    document.body.classList.add("eyedropper-active");
    setStatus(__("editor.eyedropper_picking"));
  }
  function endEyedropper() {
    if (!presetPicking) return;
    presetPicking = false;
    document.body.classList.remove("eyedropper-active");
    if (presetEdit) palettePresetModal.classList.remove("hidden");
  }

  // Read the concrete colors of a node/subgraph/edge by id/key — prefer the
  // stored bucket, fall back to the rendered SVG's computed styles.
  function readElementColors(kind, idOrKey) {
    if (kind === "node") {
      const n = nodeMap[idOrKey]; if (!n) return null;
      const store = nodeStyles[idOrKey] || {};
      const shape = [...n.g.children].find((c) =>
        /^(rect|polygon|circle|ellipse|path)$/.test(c.tagName.toLowerCase()));
      const cs = shape ? getComputedStyle(shape) : null;
      return {
        fill: store.fill || (cs && cssColorToHex(cs.fill)) || "#5e81ac",
        stroke: store.stroke || (cs && cssColorToHex(cs.stroke)) || "#3b5371",
        color: store.color || readLabelHex(n.g) || "#eceff4",
      };
    }
    if (kind === "subgraph") {
      const c = clusterMap[idOrKey]; if (!c) return null;
      const store = subgraphStyles[idOrKey] || {};
      const cs = c.bg ? getComputedStyle(c.bg) : null;
      return {
        fill: store.fill || (cs && cssColorToHex(cs.fill)) || "#4c566a",
        stroke: store.stroke || (cs && cssColorToHex(cs.stroke)) || "#2e3440",
        color: store.color || (c.label && readLabelHex(c.label)) || "#eceff4",
      };
    }
    if (kind === "edge") {
      const e = findEdgeByKey(idOrKey); if (!e) return null;
      const store = edgeStyles[idOrKey] || {};
      const cs = e.path ? getComputedStyle(e.path) : null;
      const stroke = store.stroke || (cs && cssColorToHex(cs.stroke)) || "#88c0d0";
      return {
        stroke,
        color: store.color || (e.label && readLabelHex(e.label)) || stroke,
        fill: stroke,
      };
    }
    return null;
  }
  function readLabelHex(g) {
    const t = g.querySelector("text, tspan");
    return t ? cssColorToHex(getComputedStyle(t).fill) : null;
  }

  // Resolve a click in pick mode to {kind,id} using the rendered SVG groups.
  function pickColorsFromEvent(e) {
    const nodeG = e.target.closest("g.node");
    if (nodeG) {
      const id = Object.keys(nodeMap).find((k) => nodeMap[k].g === nodeG);
      if (id) return readElementColors("node", id);
    }
    const clusterG = e.target.closest("g.cluster");
    if (clusterG) {
      const id = Object.keys(clusterMap).find((k) => clusterMap[k].g === clusterG
        || clusterMap[k].bg === e.target || (clusterMap[k].g && clusterMap[k].g.contains(e.target)));
      if (id) return readElementColors("subgraph", id);
    }
    const pathEl = e.target.closest("path.flowchart-link, g.edgePaths path");
    if (pathEl) {
      const e2 = edges.find((ed) => ed.path === pathEl);
      if (e2) return readElementColors("edge", edgeKey(e2));
    }
    const labelG = e.target.closest("g.edgeLabel, g.edgeLabels > g");
    if (labelG) {
      const e2 = edges.find((ed) => ed.label && (ed.label === labelG || ed.label.contains(e.target)));
      if (e2) return readElementColors("edge", edgeKey(e2));
    }
    return null;
  }

  function loadPickedColors(colors) {
    if (!presetEdit || !colors) return;
    let any = false;
    for (const [prop] of PALETTE_CHANNELS[presetEdit.group]) {
      if (colors[prop]) { presetEdit.values[prop] = colors[prop]; any = true; }
    }
    if (any) { syncPresetChannels(); setStatus(__("editor.eyedropper_done")); }
  }

  function initPresetEditor() {
    if (!palettePresetModal) return;
    const okBtn = document.getElementById("palettePresetOk");
    const cancelBtn = document.getElementById("palettePresetCancel");
    if (okBtn) okBtn.addEventListener("click", savePresetEdit);
    if (cancelBtn) cancelBtn.addEventListener("click", closePresetEditor);
    if (presetEyedropBtn) presetEyedropBtn.addEventListener("click", armEyedropper);
    const backdrop = palettePresetModal.querySelector(".modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", () => { if (!presetPicking) closePresetEditor(); });
    // One-shot color pick: while armed, intercept the next canvas pointerdown
    // before it reaches the selection/drag handlers (capture phase + stop).
    diagramEl.addEventListener("pointerdown", (e) => {
      if (!presetPicking) return;
      e.preventDefault();
      e.stopPropagation();
      const colors = pickColorsFromEvent(e);
      endEyedropper();
      if (colors) loadPickedColors(colors);
      else setStatus(__("editor.eyedropper_miss"), true);
      // Swallow the trailing click this pointerdown produces so it neither
      // selects the picked element nor closes the modal via the backdrop.
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); cleanup(); };
      const cleanup = () => { document.removeEventListener("click", swallow, true); clearTimeout(t); };
      document.addEventListener("click", swallow, true);
      const t = setTimeout(cleanup, 350);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (presetPicking) { e.stopPropagation(); endEyedropper(); setStatus(""); return; }
      if (!palettePresetModal.classList.contains("hidden")) { e.stopPropagation(); closePresetEditor(); }
    }, true);
  }

  // ── Shape change ─────────────────────────────────────────────────────────

  function changeShapeInSource(source, nodeId, newShape) {
    const idEsc = regexEscape(nodeId);
    const shapesByLen = [...SHAPES].sort((a, b) => b.open.length - a.open.length);
    for (const shape of shapesByLen) {
      const re = new RegExp(`\\b${idEsc}(\\s*)${regexEscape(shape.open)}([^]*?)${regexEscape(shape.close)}`);
      const m = source.match(re);
      if (!m) continue;
      const content = m[2];
      const err = validateLabelForShape(content, newShape);
      if (err) return { ok: false, error: err };
      const replaced = `${nodeId}${m[1]}${newShape.open}${content}${newShape.close}`;
      return { ok: true, source: source.replace(re, replaced) };
    }
    return { ok: false, error: `declaration of ${nodeId} not found` };
  }

  async function applyShapeToSelected(shape) {
    if (!requireValidSource("change shape")) return;
    if (selectedNodeIds.size === 0) { setStatus(__("editor.err.select_node"), true); return; }
    const ids = [...selectedNodeIds];
    let next = currentSource, applied = 0, errs = [];
    for (const id of ids) {
      const r = changeShapeInSource(next, id, shape);
      if (r.ok) { next = r.source; applied++; }
      else errs.push(`${id}: ${r.error}`);
    }
    if (!applied) { setStatus(`change shape: ${errs.join("; ")}`, true); return; }
    currentSource = next;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(ids.length === 1 ? `${ids[0]}: shape → ${shape.name}`
                               : `shape → ${shape.name} (${applied}/${ids.length})${errs.length ? " err: " + errs.join("; ") : ""}`,
              errs.length > 0);
  }

  function buildShapePalette() {
    for (const shape of SHAPES) {
      const btn = document.createElement("button");
      btn.className = "shape-mini";
      btn.type = "button";
      btn.title = `Change shape → ${shape.name}`;
      btn.innerHTML = `<svg viewBox="0 0 40 28">${SHAPE_PREVIEWS[shape.key] || ""}</svg>`;
      btn.addEventListener("click", () => applyShapeToSelected(shape));
      shapePaletteEl.appendChild(btn);
    }
  }

  // ── Add Node modal ───────────────────────────────────────────────────────

  let modalSelectedShape = SHAPES[0];

  function buildShapeGrid() {
    const grid = document.getElementById("shapeGrid");
    grid.innerHTML = "";
    for (const shape of SHAPES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "shape-btn";
      btn.dataset.shapeKey = shape.key;
      btn.innerHTML =
        `<svg viewBox="0 0 40 28">${SHAPE_PREVIEWS[shape.key] || ""}</svg>` +
        `<span>${shape.name}</span>`;
      btn.addEventListener("click", () => selectShape(shape));
      grid.appendChild(btn);
    }
    selectShape(SHAPES[0]);
  }

  function selectShape(shape) {
    modalSelectedShape = shape;
    const grid = document.getElementById("shapeGrid");
    for (const b of grid.querySelectorAll(".shape-btn")) {
      b.classList.toggle("selected", b.dataset.shapeKey === shape.key);
    }
  }

  let _addNodeTargetSubgraph = null;
  // Edit mode: when non-null, the node modal edits this existing node instead
  // of creating a new one. Submit dispatches accordingly.
  let _editNodeOriginalId = null;
  function setNodeModalMode(isEdit) {
    const title = document.querySelector("#addNodeModal h2");
    const okBtn = document.getElementById("nodeOkBtn");
    if (isEdit) {
      if (title) title.textContent = __("editor.edit_node");
      if (okBtn) okBtn.textContent = __("common.save");
    } else {
      if (title) title.textContent = __("editor.new_node");
      if (okBtn) okBtn.textContent = __("common.create");
    }
  }
  function openAddNodeModal() {
    if (!requireValidSource("add node")) return;
    _editNodeOriginalId = null;
    setNodeModalMode(false);
    _addNodeTargetSubgraph = (selectedClusterIds.size === 1 ? [...selectedClusterIds][0] : null);
    document.getElementById("addNodeModal").classList.remove("hidden");
    document.getElementById("modalError").textContent = "";
    const hint = document.getElementById("addNodeSubgraphHint");
    if (hint) {
      if (_addNodeTargetSubgraph) {
        hint.textContent = __("editor.node_in_subgraph", _addNodeTargetSubgraph);
        hint.classList.remove("hidden");
      } else {
        hint.textContent = "";
        hint.classList.add("hidden");
      }
    }
    document.getElementById("nodeIdInput").value = "";
    document.getElementById("nodeLabelInput").value = "";
    selectShape(SHAPES[0]);
    setTimeout(() => document.getElementById("nodeIdInput").focus(), 0);
  }
  function openEditNodeModal(nodeId) {
    if (!requireValidSource("edit node")) return;
    if (!nodeMap[nodeId]) { setStatus(`node '${nodeId}' not found`, true); return; }
    const shape = detectNodeShapeInSource(currentSource, nodeId) || SHAPES[0];
    const label = getNodeLabelInSource(currentSource, nodeId) ?? "";
    _editNodeOriginalId = nodeId;
    _addNodeTargetSubgraph = null;
    setNodeModalMode(true);
    document.getElementById("addNodeModal").classList.remove("hidden");
    document.getElementById("modalError").textContent = "";
    const hint = document.getElementById("addNodeSubgraphHint");
    if (hint) { hint.textContent = ""; hint.classList.add("hidden"); }
    document.getElementById("nodeIdInput").value = nodeId;
    document.getElementById("nodeLabelInput").value = label;
    selectShape(shape);
    setTimeout(() => {
      const inp = document.getElementById("nodeIdInput");
      inp.focus(); inp.select();
    }, 0);
  }
  function closeAddNodeModal() {
    document.getElementById("addNodeModal").classList.add("hidden");
    _addNodeTargetSubgraph = null;
    _editNodeOriginalId = null;
    setNodeModalMode(false);
  }

  async function submitAddNodeModal() {
    if (_editNodeOriginalId) { await submitEditNodeModal(); return; }
    const id = document.getElementById("nodeIdInput").value.trim();
    const label = document.getElementById("nodeLabelInput").value.trim();
    const errorEl = document.getElementById("modalError");
    errorEl.textContent = "";
    if (!id) { errorEl.textContent = __("editor.err.id_required"); return; }
    const targetSg = _addNodeTargetSubgraph;
    const result = addNodeToSource(currentSource, id, label, modalSelectedShape, targetSg);
    if (!result.ok) { errorEl.textContent = result.error; return; }
    currentSource = result.source;
    markDirtySource();
    closeAddNodeModal();
    await renderDiagram();
    placeNodeAtViewportCenter(id);
    pushHistory();
    setStatus(targetSg
      ? `+ node ${id} in ${targetSg} (${modalSelectedShape.name})`
      : `+ node ${id} (${modalSelectedShape.name})`);
  }

  // Edit-mode submit: rename id (propagating to edges/subgraph members/notes/
  // style lines/positions), then rewrite the declaration's label+shape.
  async function submitEditNodeModal() {
    const oldId = _editNodeOriginalId;
    const newId = document.getElementById("nodeIdInput").value.trim();
    const newLabel = document.getElementById("nodeLabelInput").value.trim();
    const errorEl = document.getElementById("modalError");
    errorEl.textContent = "";
    if (!newId) { errorEl.textContent = __("editor.err.id_required"); return; }
    if (!/^[A-Za-z_][\w]*$/.test(newId)) { errorEl.textContent = __("editor.err.id_invalid", newId); return; }
    if (newId !== oldId && (nodeMap[newId] || clusterMap[newId])) {
      errorEl.textContent = __("editor.err.id_exists", newId); return;
    }

    let next = currentSource;
    if (newId !== oldId) {
      const r = renameIdInSource(next, oldId, newId);
      if (!r.ok) { errorEl.textContent = r.error; return; }
      next = r.source;
    }
    const r2 = rewriteNodeDeclInSource(next, newId, newLabel, modalSelectedShape);
    if (!r2.ok) { errorEl.textContent = r2.error; return; }
    next = r2.source;

    if (newId !== oldId && positions[oldId] !== undefined) {
      positions[newId] = positions[oldId];
      delete positions[oldId];
      markDirtyLayout();
    }
    if (newId !== oldId) renameIdInEdgeAnchors(oldId, newId);
    // Selection follows the renamed node.
    if (selectedNodeIds.has(oldId)) {
      selectedNodeIds.delete(oldId);
      selectedNodeIds.add(newId);
    }
    currentSource = next;
    markDirtySource();
    closeAddNodeModal();
    await renderDiagram();
    pushHistory();
    const renamed = newId !== oldId ? `${oldId} → ${newId}` : newId;
    setStatus(`✎ node ${renamed} (${modalSelectedShape.name})`);
  }

  // Move a freshly-added node so its visual center sits at the current
  // viewport center, instead of wherever Mermaid's auto-layout dropped it
  // (often offscreen relative to the user's pan/zoom).
  function placeNodeAtViewportCenter(id) {
    const n = nodeMap[id];
    if (!n || !viewState) return;
    const cx = viewState.x + viewState.width / 2;
    const cy = viewState.y + viewState.height / 2;
    const parentT = getElementParentTranslate(n.g);
    const tx = cx - parentT.x - n.centerLocal.x;
    const ty = cy - parentT.y - n.centerLocal.y;
    setNodeTranslate(n.g, tx, ty);
    positions[id] = { x: tx, y: ty };
    markDirtyLayout();
    rerouteNodeEdges(id);
    updateAllClusterBounds();
  }

  // ── Save (atomic POST + optimistic locking) ──────────────────────────────

  // ── Autosave (PATCH /draft) ──────────────────────────────────────────────

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtClock(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function updateAutosaveBadge() {
    if (!autosaveBadgeEl) return;
    // Visible while we have something dirty (since last explicit Save) AND
    // at least one autosave has succeeded — confirms work is safe on server.
    if (lastDraftFlushAt && (dirtySource || dirtyLayout)) {
      autosaveBadgeEl.textContent = "auto-saved " + fmtClock(lastDraftFlushAt);
      autosaveBadgeEl.classList.remove("hidden");
    } else {
      autosaveBadgeEl.classList.add("hidden");
    }
  }

  async function flushDraft(opts) {
    opts = opts || {};
    if (saveInProgress) return;
    if (!canWrite || !lockHeldByMe()) return;
    if (!dirtySource && !dirtyLayout) return;
    if (!lastParseValid) return;
    if (draftFlushInFlight) { draftFlushPending = true; return; }

    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    draftFlushInFlight = true;

    const snapSource = currentSource;
    const snapLayout = buildLayoutPayload();
    const expected = currentRevisionId;
    try {
      const { status, json } = await api("PATCH",
        `/api/diagrams/${encodeURIComponent(slug)}/draft`,
        {
          source: snapSource,
          layout: snapLayout,
          expected_revision_id: expected,
        });
      if (status === 200 && json) {
        lastDraftFlushAt = Date.now();
        if (json.updated_at) lastUpdatedAt = json.updated_at;
        updateAutosaveBadge();
      } else if (status === 423 || status === 409) {
        // 423 locked: we no longer hold the scepter. 409 conflict: head moved.
        // Either way, refresh presence so the UI reflects reality.
        presencePing(false);
        if (status === 409 && json) openConflictModal(json.current_revision_id);
      }
      // 4xx other → silently ignore; next event will retry.
    } catch (_) { /* network error: next event will retry */ }
    finally {
      draftFlushInFlight = false;
      if (draftFlushPending) {
        draftFlushPending = false;
        // RAM may have changed during the in-flight call; loop once more.
        if (dirtySource || dirtyLayout) flushDraft({ immediate: true });
      }
    }
  }

  /** Synchronous best-effort flush on page unload via fetch keepalive. */
  function flushDraftBeacon() {
    if (!canWrite || !lockHeldByMe()) return;
    if (!dirtySource && !dirtyLayout) return;
    if (!lastParseValid) return;
    try {
      fetch(`/api/diagrams/${encodeURIComponent(slug)}/draft`, {
        method: "PATCH", keepalive: true,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          source: currentSource,
          layout: buildLayoutPayload(),
          expected_revision_id: currentRevisionId,
        }),
      });
    } catch (_) { /* ignore */ }
  }

  async function save() {
    if (saveInProgress) return;
    if (!lastParseValid) {
      setStatus(__("editor.status.invalid_save"), true);
      return;
    }
    if (!dirtySource && !dirtyLayout) {
      setStatus(__("editor.status.nothing_to_save"));
      return;
    }
    saveInProgress = true;
    saveBtn.disabled = true;
    setStatus(__("editor.status.saving"));
    // Cancel any pending autosave; the explicit POST will carry current state.
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    try {
      const { status, json } = await api("POST", `/api/diagrams/${encodeURIComponent(slug)}`, {
        source: currentSource,
        layout: buildLayoutPayload(),
        expected_revision_id: currentRevisionId,
      });
      if (status === 200 && json) {
        currentRevisionId = json.revision_id;
        if (json.updated_at) lastUpdatedAt = json.updated_at;
        lastDraftFlushAt = null;
        clearDirty();
        setStatus(__("editor.status.saved", currentRevisionId));
      } else if (status === 409 && json && json.error === "inactive_tab") {
        presencePing(true);
        showToast(__("editor.toast.moved_tab"), "warn");
      } else if (status === 409 && json) {
        openConflictModal(json.current_revision_id);
      } else if (status === 423) {
        presencePing(false);
        showToast(__("editor.toast.lost_scepter"), "warn");
      } else {
        setStatus(`save failed: HTTP ${status}` + (json && json.error ? ` — ${json.error}` : ""), true);
      }
    } catch (e) {
      setStatus(`save failed: ${e.message}`, true);
    } finally {
      saveInProgress = false;
      saveBtn.disabled = false;
    }
  }

  function resetLayout() {
    positions = {};
    markDirtyLayout();
    renderDiagram().then(() => setStatus(__("editor.status.layout_reset")));
  }

  // ── Reload (discard local) ───────────────────────────────────────────────

  async function reloadFromServer() {
    setStatus(__("editor.status.reloading"));
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}`);
      if (status !== 200 || !json) throw new Error(`HTTP ${status}`);
      loadFromDto(json);
      setStatus(__("editor.status.reloaded"));
    } catch (e) {
      setStatus(`reload failed: ${e.message}`, true);
    }
  }

  function loadFromDto(dto) {
    currentSource = dto.source || "";
    const L = dto.layout || {};
    positions      = Array.isArray(L.positions)      ? {} : (L.positions      || {});
    edgeAnchors    = Array.isArray(L.edgeAnchors)    ? {} : (L.edgeAnchors    || {});
    edgeBend       = Array.isArray(L.edgeBend)       ? {} : (L.edgeBend       || {});
    nodeStyles     = Array.isArray(L.nodeStyles)     ? {} : (L.nodeStyles     || {});
    subgraphStyles = Array.isArray(L.subgraphStyles) ? {} : (L.subgraphStyles || {});
    edgeStyles     = Array.isArray(L.edgeStyles)     ? {} : (L.edgeStyles     || {});
    palettes       = normalizePalettes(L.palettes);
    currentPaletteGroup = null; // force swatch rebuild — colors may have changed
    renderActivePalette();
    migrateAllBends();
    extractInlineStylesFromSource();
    currentRevisionId = dto.revision_id;
    if (dto.updated_at) lastUpdatedAt = dto.updated_at;
    if (dto.title && dto.title !== currentTitle) {
      currentTitle = dto.title;
      titleEl.textContent = currentTitle;
      document.title = currentTitle + " — Aquata";
    }
    clearDirty();
    // Keep selection across remote reloads: renderDiagram's restore-selection
    // pass drops only ids that no longer exist in the new source, so picking
    // a node (or its note panel binding) survives the scepter holder's edits.
    // Keep viewState/initialViewBox — preserves the viewer's current pan/zoom
    // across remote-update reloads (poll, checkout, reload). renderDiagram
    // recomputes initialViewBox from the new geometry but keeps viewState if set.
    history = []; historyPtr = -1;
    return renderDiagram().then(() => pushHistory());
  }

  // ── Polling for remote changes ───────────────────────────────────────────

  async function pollHead() {
    if (document.hidden || saveInProgress || draftFlushInFlight) return;
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}`);
      if (status !== 200 || !json) return;
      if (!json.revision_id) return;

      const revChanged    = json.revision_id !== currentRevisionId;
      const updatedChanged = json.updated_at && lastUpdatedAt && json.updated_at !== lastUpdatedAt;
      const sameRevButNewerContent = !revChanged && updatedChanged;

      if (!revChanged && !sameRevButNewerContent) {
        // Even if nothing diverged, refresh updated_at baseline (first poll).
        if (!lastUpdatedAt && json.updated_at) lastUpdatedAt = json.updated_at;
        return;
      }

      // If I hold the lock, the divergence is from my own autosave: just
      // refresh the baseline and don't reload (would clobber my in-flight RAM).
      if (lockHeldByMe()) {
        lastUpdatedAt = json.updated_at || lastUpdatedAt;
        return;
      }

      // I don't hold the lock → I'm a viewer (or just ceded the turn).
      // The dirty flags reflect *checkpoint*-divergence (last explicit Save),
      // but they're irrelevant for sync: I can't Save anyway, and my last
      // edits are already autosaved on the head row. Always mirror the server.
      await loadFromDto(json);
      if (sameRevButNewerContent) {
        showToast(__("editor.toast.live_update"));
      } else {
        showToast(__("editor.toast.server_update"));
      }
    } catch (_) { /* ignore polling errors silently */ }
  }

  // ── UI: history modal ────────────────────────────────────────────────────

  async function openHistoryModal() {
    const modal = document.getElementById("historyModal");
    const list = document.getElementById("historyList");
    list.innerHTML = "<p class='muted-small'>Caricando…</p>";
    modal.classList.remove("hidden");
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}/history`);
      if (status !== 200 || !json) throw new Error(`HTTP ${status}`);
      renderHistoryList(json);
    } catch (e) {
      list.innerHTML = `<p class='muted-small' style='color:#bf616a'>Errore: ${e.message}</p>`;
    }
  }
  function closeHistoryModal() {
    document.getElementById("historyModal").classList.add("hidden");
  }
  function renderHistoryList(data) {
    const list = document.getElementById("historyList");
    list.innerHTML = "";

    // Top row: the live working copy (#working). Always shown so the user
    // can see that edits land here, not on the saved snapshots.
    if (data.current) {
      const cur = data.current;
      const basedOn = cur.source_revision_id ? `based on #${cur.source_revision_id}` : "(never saved)";
      const row = document.createElement("div");
      row.className = "history-row is-head";
      row.innerHTML = `
        <span class="history-id">#working</span>
        <span class="history-meta">
          ${basedOn}
          ${cur.updated_at ? `• last edit ${escapeHtml(cur.updated_at)}` : ""}
          • working copy live (auto-saved)
        </span>
        <button disabled>editing</button>
      `;
      list.appendChild(row);
    }

    const revs = (data.revisions || []).slice().reverse();
    if (revs.length === 0) {
      const note = document.createElement("p");
      note.className = "muted-small";
      note.textContent = __("editor.no_snapshots");
      list.appendChild(note);
      return;
    }
    for (const r of revs) {
      const isBranchPoint = r.id === data.head_revision_id;
      const row = document.createElement("div");
      row.className = "history-row" + (isBranchPoint ? " is-branch" : "");
      row.innerHTML = `
        <span class="history-id">#${r.id}</span>
        <span class="history-meta">
          ${r.parent_id ? `← #${r.parent_id}` : "(root)"}
          • ${r.created_at}
          ${r.message ? `• ${escapeHtml(r.message)}` : ""}
          ${isBranchPoint ? "• branch point di #working" : ""}
        </span>
        <button data-rev-id="${r.id}">Carica</button>
      `;
      row.querySelector("button").addEventListener("click", () => checkout(r.id));
      list.appendChild(row);
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function checkout(revisionId) {
    if (dirtySource || dirtyLayout) {
      if (!await confirmDialog(
        __("editor.checkout_warn", revisionId),
        { confirmLabel: __("editor.checkout_btn"), danger: true })) return;
    }
    try {
      const { status, json } = await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/checkout`, {
        revision_id: revisionId,
      });
      if (status !== 200 || !json) throw new Error(`HTTP ${status}`);
      closeHistoryModal();
      await loadFromDto(json);
      setStatus(__("editor.status.checkout", revisionId));
    } catch (e) {
      setStatus(`checkout failed: ${e.message}`, true);
    }
  }

  // ── UI: rename modal ─────────────────────────────────────────────────────

  function openRenameModal() {
    const modal = document.getElementById("renameModal");
    document.getElementById("renameTitleInput").value = currentTitle;
    document.getElementById("renameError").textContent = "";
    modal.classList.remove("hidden");
    setTimeout(() => document.getElementById("renameTitleInput").focus(), 0);
  }
  function closeRenameModal() {
    document.getElementById("renameModal").classList.add("hidden");
  }
  async function submitRenameModal() {
    const newTitle = document.getElementById("renameTitleInput").value.trim();
    const errorEl = document.getElementById("renameError");
    errorEl.textContent = "";
    if (!newTitle) { errorEl.textContent = "title required"; return; }
    if (newTitle === currentTitle) { closeRenameModal(); return; }
    try {
      const { status, json } = await api("PATCH", `/api/diagrams/${encodeURIComponent(slug)}`, {
        title: newTitle,
      });
      if (status !== 200 || !json) {
        errorEl.textContent = (json && json.error) || `HTTP ${status}`;
        return;
      }
      currentTitle = json.title;
      titleEl.textContent = currentTitle;
      document.title = currentTitle + " — Aquata";
      closeRenameModal();
      setStatus(__("editor.status.renamed"));
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  // ── UI: conflict modal ───────────────────────────────────────────────────

  let conflictRemoteRevisionId = null;

  function openConflictModal(remoteRevId) {
    conflictRemoteRevisionId = remoteRevId;
    document.getElementById("conflictModal").classList.remove("hidden");
  }
  function closeConflictModal() {
    document.getElementById("conflictModal").classList.add("hidden");
  }

  async function conflictOverwrite() {
    closeConflictModal();
    // Fetch latest head to get a fresh expected_revision_id, then re-save
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}`);
      if (status !== 200 || !json) throw new Error(`HTTP ${status}`);
      currentRevisionId = json.revision_id;
      await save();
    } catch (e) {
      setStatus(`overwrite failed: ${e.message}`, true);
    }
  }

  async function conflictReload() {
    closeConflictModal();
    await reloadFromServer();
  }

  // ── UI: remote update banner ─────────────────────────────────────────────

  function showRemoteUpdateBanner(remoteRevId) {
    const el = document.getElementById("remoteUpdateBanner");
    el.classList.remove("hidden");
    el.innerHTML = `
      <span><strong>Remote update available</strong> (rev ${remoteRevId}).
        You have unsaved local changes.</span>
      <button id="remoteUpdateView">See history</button>
      <button id="remoteUpdateReload" class="primary">Reload (lose changes)</button>
      <button id="remoteUpdateDismiss">×</button>
    `;
    document.getElementById("remoteUpdateView").addEventListener("click", () => {
      hideRemoteUpdateBanner();
      openHistoryModal();
    });
    document.getElementById("remoteUpdateReload").addEventListener("click", async () => {
      hideRemoteUpdateBanner();
      await reloadFromServer();
    });
    document.getElementById("remoteUpdateDismiss").addEventListener("click", hideRemoteUpdateBanner);
  }
  function hideRemoteUpdateBanner() {
    document.getElementById("remoteUpdateBanner").classList.add("hidden");
    pendingRemoteRevisionId = null;
  }

  // ── UI: toast ────────────────────────────────────────────────────────────

  function showToast(message, kind) {
    let el = document.getElementById("liveToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "liveToast";
      document.body.appendChild(el);
    }
    el.className = (kind || "info");
    el.textContent = message;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove("show"), 3500);
  }

  // ── Phase 3: presence + scepter + edit-request + share ────────────────────

  const HEARTBEAT_MS = 15000;     // server TTL 60s; refresh every 15s
  const REQUEST_POLL_MS = 4000;   // poll incoming/outgoing edit-requests every 4s

  // Last presence DTO returned by the server.
  let presenceState = { viewers: [], holder_id: null, holder_view: null, my_active_tab_id: null, lock: lockState };
  let claimNextHeartbeat = false;

  // Follow-the-holder viewport sync. The local user toggles `followingHolder`
  // via a button on the holder's peer-tag; while true, every presence DTO that
  // carries a `holder_view` snaps the local viewport. `viewDirty` is set by
  // any local pan/zoom and, when this client is the holder, drives broadcast
  // of viewState in the next selection-poll round-trip.
  let viewDirty = false;
  let followingHolder = false;
  let lastSentFollowing = false;

  function lockHeldByMe() {
    return presenceState.holder_id === me.id;
  }
  function lockHeldByOther() {
    return presenceState.holder_id !== null && presenceState.holder_id !== me.id;
  }
  function iAmActiveTab() {
    return presenceState.my_active_tab_id === TAB_ID;
  }

  function updatePresenceState(s) {
    if (!s) return;
    const wasHolder = lockHeldByMe();
    const wasActive = iAmActiveTab();
    presenceState = {
      viewers: s.viewers || [],
      holder_id: s.holder_id !== undefined ? s.holder_id : null,
      holder_view: s.holder_view || null,
      my_active_tab_id: s.my_active_tab_id !== undefined ? s.my_active_tab_id : null,
      lock: s.lock || presenceState.lock,
    };
    lockState = presenceState.lock;
    const nowHolder = lockHeldByMe();
    const nowActive = iAmActiveTab();
    if (wasHolder && !nowHolder) {
      showToast(__("editor.toast.scepter_lost"), "warn");
    } else if (!wasHolder && nowHolder) {
      showToast(__("editor.toast.scepter_gained"));
      myEditRequest = null;
      // First-broadcast: make sure followers can sync on our current viewport
      // even if we don't pan/zoom right away.
      viewDirty = true;
    }
    if (nowHolder && wasActive && !nowActive) {
      showToast(__("editor.toast.moved_other_tab"), "warn");
    }

    // Follow-the-holder bookkeeping. Cases that auto-disable follow:
    //   - I just became the holder (can't follow myself);
    //   - The room has no holder anymore.
    // We deliberately do NOT touch lastSentFollowing on auto-disable, so the
    // next sendSelection naturally observes the mismatch and pushes the
    // new flag to the server (otherwise a stale is_following=1 would linger
    // on our row and the new holder would see a phantom follower indicator).
    let autoDisabled = false;
    if (nowHolder && followingHolder) {
      followingHolder = false;
      autoDisabled = true;
    } else if (presenceState.holder_id === null && followingHolder) {
      followingHolder = false;
      autoDisabled = true;
    } else if (followingHolder && presenceState.holder_view) {
      applyHolderView(presenceState.holder_view);
    }
    if (autoDisabled) {
      // Out-of-band flush so peers see the indicator drop immediately.
      sendSelection(true);
    }

    renderLockBanner();
    renderViewerList();
    renderPeerSelections();
    applyReadOnlyMode();
  }

  function applyReadOnlyMode() {
    const blocked = !canWrite
      || lockHeldByOther()
      || (permission === "view")
      || (lockHeldByMe() && !iAmActiveTab());
    isReadOnly = blocked;
    document.body.classList.toggle("readonly", blocked);
    if (sourceCM) sourceCM.setOption("readOnly", blocked ? "nocursor" : false);
    else if (sourceEditor) sourceEditor.readOnly = blocked;
    // Selection is kept alive in readonly so the viewer can point at elements
    // for the rest of the room (the selection is broadcast via the presence
    // channel). Edit-only toolbar buttons remain disabled via updateToolbarState
    // + the body.readonly CSS dimming.
    updateToolbarState();
  }

  function lockHolderLabel() {
    const hid = presenceState.holder_id;
    if (!hid) return "";
    if (hid === me.id) return "you";
    const v = (presenceState.viewers || []).find(x => x.user_id === hid);
    return v ? (v.display_name || v.email || ("user #" + hid)) : ("user #" + hid);
  }

  function renderLockBanner() {
    if (!lockBannerEl) return;
    lockBannerEl.classList.remove("hidden", "lock-mine", "lock-other", "lock-free", "lock-readonly");
    lockActionsEl.innerHTML = "";

    if (permission === "view") {
      lockBannerEl.classList.add("lock-readonly");
      lockMessageEl.textContent = __("editor.lock.readonly");
      return;
    }

    if (lockHeldByMe()) {
      if (iAmActiveTab()) {
        lockBannerEl.classList.add("lock-mine");
        lockMessageEl.textContent = __("editor.lock.mine");
      } else {
        lockBannerEl.classList.add("lock-readonly");
        lockMessageEl.textContent = __("editor.lock.other_tab");
        const switchBtn = document.createElement("button");
        switchBtn.className = "primary";
        switchBtn.textContent = __("editor.lock.other_tab_btn");
        switchBtn.addEventListener("click", () => claimActiveTab(true));
        lockActionsEl.appendChild(switchBtn);
      }
      return;
    }

    if (lockHeldByOther()) {
      lockBannerEl.classList.add("lock-other");
      lockMessageEl.textContent = __("editor.lock.other_user", lockHolderLabel());
      if (myEditRequest && myEditRequest.status === "pending") {
        const span = document.createElement("span");
        span.textContent = __("editor.lock.requesting");
        span.style.marginRight = "10px";
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = __("editor.lock.request_cancel");
        cancelBtn.addEventListener("click", cancelMyRequest);
        lockActionsEl.appendChild(span);
        lockActionsEl.appendChild(cancelBtn);
      } else {
        const reqBtn = document.createElement("button");
        reqBtn.className = "primary";
        reqBtn.textContent = __("editor.lock.request_btn");
        reqBtn.addEventListener("click", requestEdit);
        lockActionsEl.appendChild(reqBtn);
      }
      return;
    }

    // No holder (transient: server will promote on next heartbeat).
    lockBannerEl.classList.add("lock-free");
    lockMessageEl.textContent = __("editor.lock.unassigned");
  }

  // Send a heartbeat now, optionally claiming this tab as the active one.
  async function presencePing(claim) {
    try {
      const { status, json } = await api(
        "POST",
        `/api/diagrams/${encodeURIComponent(slug)}/presence/heartbeat`,
        { tab_id: TAB_ID, claim_active: !!claim }
      );
      if (status === 200 && json) updatePresenceState(json);
    } catch (_) { /* ignore */ }
  }

  // Debounced "I want to be the active tab" call. Triggered on focus,
  // typing, canvas mousedown, save attempt, etc.
  let lastClaimAt = 0;
  function claimActiveTab(force) {
    const now = Date.now();
    if (!force && now - lastClaimAt < 1500) {
      claimNextHeartbeat = true;
      return;
    }
    lastClaimAt = now;
    presencePing(true);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (document.hidden) return;
      const claim = claimNextHeartbeat;
      claimNextHeartbeat = false;
      presencePing(claim);
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ── Selection broadcast (presence side-channel) ─────────────────────────
  // The selection endpoint is a fast, lightweight UPDATE (no scepter logic),
  // so we can poll it every ~1.5s for near-realtime peer selection without
  // contending with promotion. It also doubles as a presence touch — keeps
  // last_seen_at fresh between the slower 15s heartbeats.

  // Adaptive polling: the room is FAST (snappy) when there's actual peer
  // collaboration to mirror; SLOW (~3x cheaper) when the room is quiet or I'm
  // alone. The transition is reactive — each tick picks the next interval
  // from the freshest presence DTO. Worst-case lag for a peer to become
  // visible after they wake up is one SLOW tick.
  const PEER_SELECTION_POLL_FAST_MS = 1500;
  const PEER_SELECTION_POLL_SLOW_MS = 5000;
  let peerSelectionTimer = null;
  let selectionDebTimer = null;
  let lastSentSelectionKey = "__unset__";

  function currentSelection() {
    const nodes = [...selectedNodeIds];
    const edges = [...selectedEdgeKeys];
    const clusters = [...selectedClusterIds];
    if (nodes.length === 0 && edges.length === 0 && clusters.length === 0) return null;
    // `cluster` (single string) is kept for backward compat with peers running
    // the older client; new clients prefer `clusters` (array).
    return { nodes, edges, clusters, cluster: clusters[0] || null };
  }

  async function sendSelection(force) {
    const sel = currentSelection();
    const key = sel ? JSON.stringify(sel) : "";
    // Piggybacks: viewport broadcast (when I'm the holder and just moved) and
    // follow-flag toggle. These let the same round-trip serve all three
    // presence side-channels without spawning extra endpoints.
    const includeView = viewDirty && lockHeldByMe() && viewState;
    const includeFollowFlag = followingHolder !== lastSentFollowing;
    if (!force && key === lastSentSelectionKey && !includeView && !includeFollowFlag) return;
    lastSentSelectionKey = key;
    const body = { tab_id: TAB_ID, selection: sel };
    if (includeView) {
      body.view = {
        x: viewState.x, y: viewState.y,
        w: viewState.width, h: viewState.height,
      };
      viewDirty = false;
    }
    if (includeFollowFlag) {
      body.is_following = followingHolder;
      lastSentFollowing = followingHolder;
    }
    try {
      const { status, json } = await api(
        "POST",
        `/api/diagrams/${encodeURIComponent(slug)}/presence/selection`,
        body
      );
      if (status === 200 && json) updatePresenceState(json);
    } catch (_) { /* ignore */ }
  }

  // Debounced trigger: called from selection-change hooks. Coalesces rapid
  // toggles (e.g. shift-clicking multiple nodes) into one network call.
  function broadcastSelection() {
    if (selectionDebTimer) clearTimeout(selectionDebTimer);
    selectionDebTimer = setTimeout(() => sendSelection(false), 250);
  }

  // Pick the next poll cadence from the latest presence DTO. FAST when there
  // is mutual collaboration to mirror; SLOW when the room is quiet.
  function nextSelectionPollMs() {
    const viewers = presenceState.viewers || [];
    if (viewers.length <= 1) return PEER_SELECTION_POLL_SLOW_MS;
    const peerActive = viewers.some(
      v => v.user_id !== me.id && (v.selection || v.is_following)
    );
    const meActive = !!currentSelection() || followingHolder;
    return (peerActive || meActive)
      ? PEER_SELECTION_POLL_FAST_MS
      : PEER_SELECTION_POLL_SLOW_MS;
  }
  function scheduleNextSelectionPoll() {
    peerSelectionTimer = setTimeout(async () => {
      peerSelectionTimer = null;
      if (!document.hidden) {
        // Force-fetch so we receive peers' updates even when our own selection
        // hasn't changed. The server UPDATE is a single indexed row — cheap.
        await sendSelection(true);
      }
      // sendSelection() updates presenceState; nextSelectionPollMs reads it.
      scheduleNextSelectionPoll();
    }, nextSelectionPollMs());
  }
  function startPeerSelectionPoll() {
    stopPeerSelectionPoll();
    scheduleNextSelectionPoll();
  }
  function stopPeerSelectionPoll() {
    if (peerSelectionTimer !== null) {
      clearTimeout(peerSelectionTimer);
      peerSelectionTimer = null;
    }
  }

  // Palette for peer selection highlights. Nord-muted tones; red is reserved
  // for the local user's own selection so peers never collide visually.
  const PEER_PALETTE = [
    "#88c0d0", // frost blue
    "#a3be8c", // green
    "#ebcb8b", // yellow
    "#d08770", // orange
    "#b48ead", // violet
    "#8fbcbb", // teal
    "#5e81ac", // dark blue
    "#d381c9", // pink
    "#e5e9f0", // pale
    "#81a1c1", // light blue
  ];

  // Deterministic palette slot for a user id. Knuth multiplicative hash to
  // spread small ids across the palette without obvious clustering.
  function peerSlot(userId) {
    return ((userId * 2654435761) >>> 0) % PEER_PALETTE.length;
  }
  function peerColor(userId) {
    return PEER_PALETTE[peerSlot(userId)];
  }
  function peerLabel(v) {
    return v.display_name || v.email || ("user #" + v.user_id);
  }

  // Render the overlay for peers' selections. Called on every presence DTO
  // update and after each renderDiagram (DOM is rebuilt from scratch there).
  function renderPeerSelections() {
    const svgEl = diagramEl.querySelector("svg");
    if (!svgEl) return;
    // Clear: top-level overlay group + any cloned edge rings parented next
    // to the original paths (we tag them with class .peer-edge-ring).
    const oldOverlay = svgEl.querySelector(":scope > g.peer-selections");
    if (oldOverlay) oldOverlay.remove();
    for (const el of svgEl.querySelectorAll(".peer-edge-ring")) el.remove();

    const viewers = presenceState.viewers || [];
    const peers = viewers
      .filter(v => v.user_id !== me.id && v.selection)
      .sort((a, b) => a.user_id - b.user_id);
    if (peers.length === 0) return;

    const SVG_NS = "http://www.w3.org/2000/svg";
    const overlay = document.createElementNS(SVG_NS, "g");
    overlay.setAttribute("class", "peer-selections");
    svgEl.appendChild(overlay);

    // Stack offset per (element, peer) pair: rings are flush (offset 0) when a
    // single peer highlights an element, and grow outward only when more than
    // one peer is on the same one. Computed before draw so order is stable.
    const elementStack = new Map(); // key → next slot index
    function slotFor(key) {
      const n = elementStack.get(key) || 0;
      elementStack.set(key, n + 1);
      return n;
    }

    for (const p of peers) {
      const color = peerColor(p.user_id);
      const sel = p.selection || {};
      for (const nid of (sel.nodes || [])) {
        drawNodeOrClusterRing(overlay, nodeMap[nid], color, slotFor("n:" + nid));
      }
      // Prefer `clusters` (new clients); fall back to single `cluster` (older).
      const peerClusters = Array.isArray(sel.clusters) ? sel.clusters
                         : (sel.cluster ? [sel.cluster] : []);
      for (const cid of peerClusters) {
        if (clusterMap[cid]) {
          drawNodeOrClusterRing(overlay, clusterMap[cid], color, slotFor("c:" + cid));
        }
      }
      for (const ek of (sel.edges || [])) {
        const e = findEdgeByKey(ek);
        if (e) drawEdgeRing(e, color);
      }
    }
  }

  // Draw a single bbox ring in svg-user coords. Works for both
  // `nodeMap[id]` (uses .g) and `clusterMap[id]` (uses .bg when available,
  // falling back to .g). Computes the world box via getBoundingClientRect()
  // converted back through svgEl.getScreenCTM().inverse() — this avoids any
  // ambiguity around how getCTM() interacts with the outer g.root translate
  // or with viewBox transforms.
  function drawNodeOrClusterRing(overlay, ref, color, stack) {
    if (!ref) return;
    const target = ref.bg || ref.g;
    if (!target || !target.getBoundingClientRect) return;
    const svgEl = overlay.ownerSVGElement || overlay.parentNode;
    if (!svgEl || !svgEl.getScreenCTM) return;
    const screenCtm = svgEl.getScreenCTM();
    if (!screenCtm) return;
    const inv = screenCtm.inverse();
    const cr = target.getBoundingClientRect();
    if (cr.width === 0 || cr.height === 0) return;
    const pt = svgEl.createSVGPoint();
    pt.x = cr.left; pt.y = cr.top;
    const tl = pt.matrixTransform(inv);
    pt.x = cr.right; pt.y = cr.bottom;
    const br = pt.matrixTransform(inv);
    const pad = 4 + stack * 3;
    const x = Math.min(tl.x, br.x) - pad;
    const y = Math.min(tl.y, br.y) - pad;
    const w = Math.abs(br.x - tl.x) + pad * 2;
    const h = Math.abs(br.y - tl.y) + pad * 2;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "peer-ring");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", w);
    rect.setAttribute("height", h);
    rect.setAttribute("rx", "6");
    rect.setAttribute("ry", "6");
    rect.setAttribute("stroke", color);
    overlay.appendChild(rect);
  }

  // Edge ring: clone the path and place it as a sibling so it inherits the
  // original's parent transforms (edges live in g.edgePaths at outer-root
  // level — coords in their `d` attr are not viewport-relative).
  function drawEdgeRing(edge, color) {
    if (!edge.path || !edge.path.parentNode) return;
    const clone = edge.path.cloneNode(false);
    // Strip Mermaid's inline styling (style="stroke:...;stroke-width:...;
    // marker-end:url(#...)") so our peer-ring CSS actually wins — and so the
    // clone doesn't paint a duplicate arrowhead on top of the original.
    clone.removeAttribute("style");
    clone.removeAttribute("marker-end");
    clone.removeAttribute("marker-start");
    clone.removeAttribute("stroke-dasharray");
    clone.setAttribute("class", "peer-edge-ring peer-ring");
    clone.setAttribute("stroke", color);
    clone.setAttribute("fill", "none");
    // Insert AFTER the original so it draws on top, but BEFORE any sibling
    // .selected highlight that the local user might have on a different edge.
    edge.path.parentNode.insertBefore(clone, edge.path.nextSibling);
  }

  // Render a compact viewer list in the lock banner: "● me", "● Alice", …
  // The colored dot mirrors the peer's selection-ring color. The current
  // user is shown without a color (their selection is the standard red).
  //
  // Extras:
  //   - On the holder's tag, non-holders see a Follow toggle button that
  //     syncs their pan/zoom to the holder's at every presence update.
  //   - When I am the holder, viewers who are currently following me show a
  //     small eye glyph on their tag.
  function renderViewerList() {
    if (!lockViewersEl) return;
    const viewers = presenceState.viewers || [];
    if (viewers.length <= 1) {
      lockViewersEl.innerHTML = "";
      return;
    }
    const holderId = presenceState.holder_id;
    const iHoldScepter = lockHeldByMe();
    const frag = document.createDocumentFragment();
    for (const v of viewers) {
      const isMe = v.user_id === me.id;
      const isHolder = v.user_id === holderId;
      const tag = document.createElement("span");
      tag.className = "peer-tag"
        + (isMe ? " me" : "")
        + (isHolder ? " holder" : "");
      if (!isMe) {
        const sw = document.createElement("span");
        sw.className = "peer-swatch";
        sw.style.background = peerColor(v.user_id);
        tag.appendChild(sw);
      }
      tag.appendChild(document.createTextNode(peerLabel(v)));

      // Follow toggle (only on the holder's tag, only for non-holder viewers).
      if (isHolder && !isMe) {
        const btn = document.createElement("button");
        btn.className = "peer-follow-btn" + (followingHolder ? " active" : "");
        btn.type = "button";
        btn.title = followingHolder
          ? __("editor.follow.active")
          : __("editor.follow.inactive");
        btn.setAttribute("aria-pressed", followingHolder ? "true" : "false");
        btn.innerHTML = '<svg class="icon"><use href="#icon-eye' + (followingHolder ? '' : '-closed') + '"/></svg>';
        btn.addEventListener("click", toggleFollowHolder);
        tag.appendChild(btn);
      }
      // "Following me" indicator (only visible to the holder, on followers).
      if (iHoldScepter && !isMe && v.is_following) {
        const ind = document.createElement("span");
        ind.className = "peer-follow-ind";
        ind.title = __("editor.follow.tooltip");
        ind.innerHTML = '<svg class="icon"><use href="#icon-eye"/></svg>';
        tag.appendChild(ind);
      }
      frag.appendChild(tag);
    }
    lockViewersEl.innerHTML = "";
    lockViewersEl.appendChild(frag);
  }

  function toggleFollowHolder() {
    if (lockHeldByMe()) return; // safety: I can't follow myself
    if (presenceState.holder_id === null) return;
    followingHolder = !followingHolder;
    // Re-render immediately so the button reflects state without waiting for
    // the next presence tick. If we just enabled follow, snap right now to
    // the last-known holder_view so the user sees an instant effect.
    if (followingHolder && presenceState.holder_view) {
      applyHolderView(presenceState.holder_view);
    }
    renderViewerList();
    // Flush the new flag to the server out-of-band: peers (especially the
    // holder) should see the indicator without the ~1.5s polling delay.
    sendSelection(true);
  }

  async function presenceJoin() {
    try {
      const { status, json } = await api(
        "POST",
        `/api/diagrams/${encodeURIComponent(slug)}/presence`,
        { tab_id: TAB_ID }
      );
      if (status === 200 && json) updatePresenceState(json);
    } catch (_) { /* ignore */ }
  }

  function presenceLeaveBeacon() {
    try {
      const blob = new Blob(
        [JSON.stringify({ tab_id: TAB_ID })],
        { type: "application/json" }
      );
      navigator.sendBeacon(`/api/diagrams/${encodeURIComponent(slug)}/presence/leave`, blob);
    } catch (_) { /* ignore */ }
  }

  async function requestEdit() {
    const note = (prompt(__("editor.prompt_note")) || "").trim();
    try {
      const { status, json } = await api("POST",
        `/api/diagrams/${encodeURIComponent(slug)}/edit-requests`, { note });
      if ((status === 200 || status === 201) && json && json.request) {
        myEditRequest = json.request;
        renderLockBanner();
        showToast(__("editor.toast.request_sent"));
      } else {
        showToast(__("editor.toast.request_failed"), "warn");
      }
    } catch (_) { /* ignore */ }
  }

  async function cancelMyRequest() {
    if (!myEditRequest || !myEditRequest.id) return;
    try {
      await api("DELETE", `/api/diagrams/${encodeURIComponent(slug)}/edit-requests/${myEditRequest.id}`, {});
    } catch (_) { /* ignore */ }
    myEditRequest = null;
    renderLockBanner();
  }

  async function pollMyEditRequest() {
    if (document.hidden) return;
    if (!canWrite) return;
    if (lockHeldByMe()) { myEditRequest = null; return; }
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}/edit-requests/mine`);
      if (status !== 200 || !json) return;
      const prev = myEditRequest;
      myEditRequest = json.request;
      if (myEditRequest && myEditRequest.status === "rejected"
          && prev && prev.status === "pending") {
        showToast(__("editor.toast.request_denied"), "warn");
        myEditRequest = null;
      }
      renderLockBanner();
    } catch (_) { /* ignore */ }
  }

  async function pollIncomingRequests() {
    if (document.hidden) return;
    if (!lockHeldByMe()) {
      pendingIncomingReqs = [];
      hideIncomingBanner();
      return;
    }
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}/edit-requests`);
      if (status !== 200 || !json) return;
      pendingIncomingReqs = json.requests || [];
      renderIncomingBanner();
    } catch (_) { /* ignore */ }
  }

  function renderIncomingBanner() {
    if (!incomingReqEl) return;
    if (pendingIncomingReqs.length === 0) {
      incomingReqEl.classList.add("hidden");
      incomingReqEl.innerHTML = "";
      return;
    }
    const r = pendingIncomingReqs[0];
    incomingReqEl.classList.remove("hidden");
    incomingReqEl.innerHTML = "";
    const who = r.requester_name || r.requester_email || ("user #" + r.requester_id);
    const note = r.note ? ` — "${escapeHtml(r.note)}"` : "";
    const msg = document.createElement("span");
    msg.innerHTML = `<strong>${escapeHtml(who)}</strong> requests the turn${note}`;
    const acc = document.createElement("button");
    acc.className = "primary"; acc.textContent = __("editor.lock.yield");
    acc.addEventListener("click", () => acceptRequest(r.id));
    const dec = document.createElement("button");
    dec.className = "danger"; dec.textContent = __("editor.lock.deny");
    dec.addEventListener("click", () => declineRequest(r.id));
    incomingReqEl.appendChild(msg);
    incomingReqEl.appendChild(acc);
    incomingReqEl.appendChild(dec);
  }
  function hideIncomingBanner() {
    if (!incomingReqEl) return;
    incomingReqEl.classList.add("hidden");
    incomingReqEl.innerHTML = "";
  }

  async function acceptRequest(id) {
    // Flush autosave so the requester inherits whatever I had typed but not
    // explicitly saved.
    if ((dirtySource || dirtyLayout) && lastParseValid) {
      await flushDraft({ immediate: true });
    }
    try {
      await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/edit-requests/${id}/accept`, {});
      // Server has atomically transferred the scepter. Refresh presence so
      // we move into spectator state immediately.
      await presencePing(false);
      clearDirty();
      hideIncomingBanner();
      pollHead();
      showToast(__("editor.toast.scepter_yielded"));
    } catch (_) { /* ignore */ }
  }

  async function declineRequest(id) {
    try {
      await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/edit-requests/${id}/decline`, {});
      pendingIncomingReqs = pendingIncomingReqs.filter(r => r.id !== id);
      renderIncomingBanner();
    } catch (_) { /* ignore */ }
  }

  // ── Share modal ──────────────────────────────────────────────────────────

  async function openShareModal() {
    document.getElementById("shareModal").classList.remove("hidden");
    document.getElementById("shareError").textContent = "";
    document.getElementById("shareEmailInput").value = "";
    await loadShareList();
  }
  function closeShareModal() {
    document.getElementById("shareModal").classList.add("hidden");
  }
  async function loadShareList() {
    const list = document.getElementById("shareList");
    list.innerHTML = "<p class='share-empty'>Caricando…</p>";
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}/shares`);
      if (status !== 200 || !json) throw new Error("HTTP " + status);
      renderShareList(json.shares || []);
    } catch (e) {
      list.innerHTML = `<p class='share-empty'>Errore: ${escapeHtml(e.message || "")}</p>`;
    }
  }
  function renderShareList(shares) {
    const list = document.getElementById("shareList");
    if (!shares.length) {
      list.innerHTML = "<p class='share-empty'>Nessuna condivisione.</p>";
      return;
    }
    list.innerHTML = "";
    for (const s of shares) {
      const row = document.createElement("div");
      row.className = "share-row" + (s.disabled ? " disabled" : "");
      const who = s.user_name ? `${s.user_name} <small>${s.user_email}</small>` : s.user_email;
      row.innerHTML = `
        <span class="share-user">${who || ("user #" + s.user_id)}</span>
        <span class="share-perm">${escapeHtml(s.permission)}</span>
      `;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = __("common.remove");
      removeBtn.addEventListener("click", async () => {
        if (!await confirmDialog(__("dashboard.remove_share_confirm"),
          { confirmLabel: __("common.remove"), danger: true })) return;
        try {
          await api("DELETE", `/api/diagrams/${encodeURIComponent(slug)}/shares/${s.user_id}`, {});
          await loadShareList();
        } catch (_) { /* ignore */ }
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    }
  }
  async function submitShareAdd(e) {
    e.preventDefault();
    const email = document.getElementById("shareEmailInput").value.trim();
    const perm  = document.getElementById("sharePermInput").value;
    const errEl = document.getElementById("shareError");
    errEl.textContent = "";
    if (!email) { errEl.textContent = __("dashboard.email_required"); return; }
    try {
      const { status, json } = await api("POST",
        `/api/diagrams/${encodeURIComponent(slug)}/shares`, { email, permission: perm });
      if (status === 201) {
        document.getElementById("shareEmailInput").value = "";
        await loadShareList();
      } else {
        errEl.textContent = (json && json.error) ? json.error : ("HTTP " + status);
      }
    } catch (ex) {
      errEl.textContent = ex.message || String(ex);
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  reloadBtn.addEventListener("click", async () => {
    if (dirtySource || dirtyLayout) {
      if (!await confirmDialog(__("editor.reload_confirm"),
        { confirmLabel: __("editor.reload_btn"), danger: true })) return;
    }
    await reloadFromServer();
  });
  resetBtn.addEventListener("click", resetLayout);
  addNodeBtn.addEventListener("click", openAddNodeModal);
  addEdgeBtn.addEventListener("click", startConnectMode);
  if (toggleEdgeStyleBtn) {
    toggleEdgeStyleBtn.addEventListener("click", applyToggleEdgeStyle);
  }
  if (cycleEdgeArrowBtn) cycleEdgeArrowBtn.addEventListener("click", applyCycleEdgeArrow);
  if (reverseEdgeBtn) reverseEdgeBtn.addEventListener("click", applyReverseEdge);
  if (alignVBtn) alignVBtn.addEventListener("click", applyAlignV);
  if (alignHBtn) alignHBtn.addEventListener("click", applyAlignH);
  if (distributeHBtn) distributeHBtn.addEventListener("click", () => applyDistribute("h"));
  if (distributeVBtn) distributeVBtn.addEventListener("click", () => applyDistribute("v"));
  if (moveToSubgraphBtn) moveToSubgraphBtn.addEventListener("click", startMoveMode);
  if (addSubgraphBtn) addSubgraphBtn.addEventListener("click", applyAddSubgraph);
  if (deleteBtn) deleteBtn.addEventListener("click", applyDelete);
  exportBtn.addEventListener("click", exportSource);
  saveBtn.addEventListener("click", save);
  fitBtn.addEventListener("click", fitView);
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  historyBtn.addEventListener("click", openHistoryModal);
  renameBtn.addEventListener("click", openRenameModal);
  if (shareBtn) {
    shareBtn.addEventListener("click", openShareModal);
    document.getElementById("shareCloseBtn").addEventListener("click", closeShareModal);
    document.getElementById("shareAddForm").addEventListener("submit", submitShareAdd);
  }
  exportSvgBtn.addEventListener("click", exportSvg);
  exportPngBtn.addEventListener("click", exportPng);

  document.getElementById("nodeCancelBtn").addEventListener("click", closeAddNodeModal);
  document.getElementById("nodeOkBtn").addEventListener("click", submitAddNodeModal);
  document.getElementById("addNodeModal").querySelector(".modal-backdrop")
    .addEventListener("click", closeAddNodeModal);
  for (const inputId of ["nodeIdInput", "nodeLabelInput"]) {
    document.getElementById(inputId).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitAddNodeModal(); }
      else if (e.key === "Escape") { e.preventDefault(); closeAddNodeModal(); }
    });
  }

  document.getElementById("confirmDialogOkBtn").addEventListener("click", () => _confirmDialogClose(true));
  document.getElementById("confirmDialogCancelBtn").addEventListener("click", () => _confirmDialogClose(false));
  document.getElementById("confirmDialogModal").querySelector(".modal-backdrop")
    .addEventListener("click", () => _confirmDialogClose(false));
  document.getElementById("confirmDialogModal").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); _confirmDialogClose(true); }
    else if (e.key === "Escape") { e.preventDefault(); _confirmDialogClose(false); }
  });

  document.getElementById("subgraphCancelBtn").addEventListener("click", closeAddSubgraphModal);
  document.getElementById("subgraphOkBtn").addEventListener("click", submitAddSubgraphModal);
  document.getElementById("addSubgraphModal").querySelector(".modal-backdrop")
    .addEventListener("click", closeAddSubgraphModal);
  for (const inputId of ["subgraphIdInput", "subgraphTitleInput"]) {
    document.getElementById(inputId).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitAddSubgraphModal(); }
      else if (e.key === "Escape") { e.preventDefault(); closeAddSubgraphModal(); }
    });
  }

  document.getElementById("renameCancelBtn").addEventListener("click", closeRenameModal);
  document.getElementById("renameOkBtn").addEventListener("click", submitRenameModal);
  document.getElementById("renameModal").querySelector(".modal-backdrop")
    .addEventListener("click", closeRenameModal);
  document.getElementById("renameTitleInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitRenameModal(); }
    else if (e.key === "Escape") { e.preventDefault(); closeRenameModal(); }
  });

  document.getElementById("historyCloseBtn").addEventListener("click", closeHistoryModal);
  document.getElementById("historyModal").querySelector(".modal-backdrop")
    .addEventListener("click", closeHistoryModal);

  document.getElementById("conflictHistoryBtn").addEventListener("click", () => {
    closeConflictModal(); openHistoryModal();
  });
  document.getElementById("conflictOverwriteBtn").addEventListener("click", conflictOverwrite);
  document.getElementById("conflictReloadBtn").addEventListener("click", conflictReload);
  document.getElementById("conflictCancelBtn").addEventListener("click", closeConflictModal);

  // ── Side-panel prefs (localStorage) ──────────────────────────────────────
  // Persist source/notes panel width + collapsed state across reloads. Single
  // global key (not per-diagram): the user's preferred workspace layout is the
  // same regardless of which diagram is open.
  const PANEL_PREFS_KEY = "aquata.editor.panels";
  function loadPanelPrefs() {
    try {
      const raw = localStorage.getItem(PANEL_PREFS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (_) { return {}; }
  }
  function updatePanelPref(side, patch) {
    const prefs = loadPanelPrefs();
    prefs[side] = { ...(prefs[side] || {}), ...patch };
    try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs)); }
    catch (_) { /* quota / private-mode: ignore */ }
  }

  function attachResizer(handle, panel, side) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // No-op while the panel is collapsed — the handle becomes a passive
      // strip until the user re-expands the panel via the toggle button.
      if (panel.classList.contains("collapsed")) return;
      e.preventDefault();
      const pointerId = e.pointerId;
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      function onMove(ev) {
        if (ev.pointerId !== pointerId) return;
        const delta = ev.clientX - startX;
        const w = Math.max(120, Math.min(window.innerWidth - 200,
          side === "left" ? startWidth + delta : startWidth - delta));
        panel.style.width = w + "px";
      }
      function onUp(ev) {
        if (ev && ev.pointerId !== pointerId) return;
        handle.classList.remove("dragging");
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        // Persist the final width once the drag settles.
        const finalW = panel.getBoundingClientRect().width;
        if (finalW > 0) updatePanelPref(side, { width: finalW });
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });
  }
  attachResizer(resizer, sourcePanel, "left");
  attachResizer(resizerRight, notesPanel, "right");

  // Apply saved prefs after resizers are wired. Width clamps to current
  // viewport in case the window shrunk since the value was stored.
  function restorePanelState(panel, btn, side, collapsedArrow, expandedArrow) {
    const p = loadPanelPrefs()[side];
    if (!p) return;
    if (typeof p.width === "number" && p.width >= 120) {
      panel.style.width = Math.min(p.width, window.innerWidth - 200) + "px";
    }
    if (p.collapsed) {
      // Stash the width so the next expand restores the user's preferred size
      // (mirrors what togglePanelCollapse does when collapsing live).
      if (panel.style.width) {
        panel.dataset.expandedWidth = panel.style.width;
        panel.style.width = "";
      }
      panel.classList.add("collapsed");
      btn.textContent = collapsedArrow;
      btn.title = __("editor.expand");
    }
  }
  restorePanelState(sourcePanel, togglePanelBtn, "left", "»", "«");
  restorePanelState(notesPanel, toggleNotesPanelBtn, "right", "«", "»");

  // Collapse helper: the resizers write `style="width: Xpx"` inline, which
  // beats the `.collapsed { width: 30px }` rule on specificity. Stash the
  // user's chosen width on the element when collapsing so we can both
  // restore it on expand and let the .collapsed rule actually take effect.
  function togglePanelCollapse(panel, btn, collapsedArrow, expandedArrow) {
    const willCollapse = !panel.classList.contains("collapsed");
    if (willCollapse) {
      if (panel.style.width) panel.dataset.expandedWidth = panel.style.width;
      panel.style.width = "";
    } else {
      if (panel.dataset.expandedWidth) {
        panel.style.width = panel.dataset.expandedWidth;
        delete panel.dataset.expandedWidth;
      }
    }
    panel.classList.toggle("collapsed", willCollapse);
    btn.textContent = willCollapse ? collapsedArrow : expandedArrow;
    btn.title = willCollapse ? __("editor.expand") : __("editor.collapse");
    updatePanelPref(panel.id === "sourcePanel" ? "left" : "right",
      { collapsed: willCollapse });
  }

  toggleNotesPanelBtn.addEventListener("click", () => {
    togglePanelCollapse(notesPanel, toggleNotesPanelBtn, "«", "»");
  });

  notesTextarea.addEventListener("input", () => {
    if (_notesSuppressInput) return;
    if (!_notesCurrentId) return;
    // Debounce: apply to currentSource on a short delay so rapid typing
    // coalesces into one source rewrite + autosave cycle.
    if (_notesAutosaveTimer) clearTimeout(_notesAutosaveTimer);
    _notesAutosaveTimer = setTimeout(() => {
      _notesAutosaveTimer = null;
      applyNoteEdit();
    }, 400);
  });
  notesTextarea.addEventListener("blur", () => {
    if (_notesAutosaveTimer) {
      clearTimeout(_notesAutosaveTimer);
      _notesAutosaveTimer = null;
    }
    // pushHistory only when an actual write to the source happens — keeps
    // undo discrete (one entry per coalesced note edit, not per keystroke).
    if (applyNoteEdit()) pushHistory();
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirtySource || dirtyLayout) { e.preventDefault(); e.returnValue = ""; }
  });

  sourceEditor.addEventListener("input", () => {
    if (sourceCM) return;
    currentSource = sourceEditor.value;
    markDirtySource();
    scheduleTextareaRender();
  });

  togglePanelBtn.addEventListener("click", () => {
    togglePanelCollapse(sourcePanel, togglePanelBtn, "»", "«");
  });

  document.addEventListener("keydown", (e) => {
    const inInput = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) ||
                    (e.target.closest && e.target.closest(".cm-editor"));
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); save(); return; }
    if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); return; }
    if (mod && ((e.shiftKey && (e.key === "z" || e.key === "Z")) || e.key === "y" || e.key === "Y")) {
      e.preventDefault(); redo(); return;
    }
    if (inInput) return;
    if (e.key === "Escape") {
      if (connectingState === "edge-target") { cancelConnectMode(); return; }
      if (connectingState === "move-target") { cancelMoveMode(); return; }
      if (connectingState) { cancelConnectMode(); return; }
      if (selectedNodeIds.size > 0) { deselectNode(); setStatus(""); }
      if (selectedClusterIds.size > 0) { deselectCluster(); setStatus(""); }
      if (selectedEdgeKeys.size > 0) { deselectEdge(); setStatus(""); }
      return;
    }
    if (e.key === "0" || e.key === "Home") { e.preventDefault(); fitView(); return; }
    // Center the view on the current selection. "." also covers Numpad Decimal
    // when NumLock is on; with NumLock off the same key fires "Delete" which
    // is already bound to applyDelete — both behaviors are intentional.
    if (e.key === "." || e.key === "c" || e.key === "C") {
      if (selectionKind() !== null) { e.preventDefault(); centerOnSelection(); }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace")) {
      if (selectionKind() !== null) { e.preventDefault(); applyDelete(); }
      return;
    }
    if (e.key === "+" || (e.key === "=" && e.shiftKey === false)) { e.preventDefault(); zoomStep(1.2); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomStep(1 / 1.2); return; }
    if ((e.key === "n" || e.key === "N") && !e.altKey) {
      if (addNodeBtn && !addNodeBtn.disabled) { e.preventDefault(); openAddNodeModal(); }
      return;
    }
    if ((e.key === "e" || e.key === "E") && !e.altKey) {
      if (addEdgeBtn && !addEdgeBtn.disabled) { e.preventDefault(); startConnectMode(); }
      return;
    }
  });

  diagramEl.addEventListener("click", (e) => {
    // One-shot: the click that just finalized a connect (target node click)
    // bubbles here AFTER handleConnectClick set selectedEdgeKey on the new
    // edge. Skipping this one click prevents the canvas listener from
    // immediately deselecting that edge.
    if (_skipNextDiagramClick) { _skipNextDiagramClick = false; return; }
    // Move-to-subgraph mode: click on empty canvas (no node/cluster/edge)
    // means "move to root". Cluster pointerdown intercepts the in-cluster
    // case before this fires.
    if (connectingState === "move-target") {
      const onSomething = e.target.closest("g.node, g.cluster, path.flowchart-link, g.edgeLabel, g.edgeLabels");
      if (!onSomething) { handleMoveTargetClick(null); return; }
      return; // node click during move-target: ignore (Esc to cancel)
    }
    // Shift/Ctrl/Cmd held: user is mid-multiselect and missed an element —
    // preserve the current selection instead of clearing it.
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (!e.target.closest("g.node") && selectedNodeIds.size > 0) {
      deselectNode();
      setStatus("");
    }
    if (!e.target.closest("g.cluster, .collapse-hit") && selectedClusterIds.size > 0) {
      deselectCluster();
      setStatus("");
    }
    if (!e.target.closest("path.flowchart-link, g.edgeLabel, g.edgeLabels, g.edge-bend, g.edge-hotspots") && selectedEdgeKeys.size > 0) {
      deselectEdge();
      setStatus("");
    }
  });

  // ── Init ─────────────────────────────────────────────────────────────────

  // Inject reusable SVG filter defs into the document so CSS can reference
  // them by id from inside any SVG (Mermaid output, peer rings, etc.).
  // `aq-sel-outline` paints a crisp dilated black halo behind the source
  // geometry — used by edges (`path.flowchart-link.selected`), nodes
  // (`.node.selected > <shape>`), and subgraphs (`g.cluster.selected > …`).
  // SVG2 feMorphology dilates by exact pixel radius (no Gaussian blur),
  // so the outline edge is sharp.
  (function injectSvgFilters() {
    if (document.getElementById("aq-svg-filters")) return;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.id = "aq-svg-filters";
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    // `filterUnits="userSpaceOnUse"` with a huge absolute region: the default
    // (objectBoundingBox + percentages) collapses to zero for vertical-only
    // edges (bbox width = 0) and clips arrowheads on near-vertical paths
    // (markers extend beyond the path bbox). userSpaceOnUse with a region
    // larger than any plausible diagram side-steps both — browsers clip
    // internally to the visible area so the perf cost is negligible.
    // Double-ring "knockout" halo: a 1px black inner ring against a 1px white
    // outer ring. On dark backgrounds the white outer ring contrasts; on light
    // backgrounds the black inner ring contrasts — at least one is always
    // visible without resorting to mix-blend-mode (which would also invert
    // the element's own colour). The original SourceGraphic is composited on
    // top last so the user's edge / node colour stays untouched.
    svg.innerHTML = `
      <defs>
        <filter id="aq-sel-outline" filterUnits="userSpaceOnUse"
                x="-100000" y="-100000" width="200000" height="200000">
          <feMorphology in="SourceGraphic" operator="dilate" radius="2" result="dOuter"/>
          <feMorphology in="SourceGraphic" operator="dilate" radius="1" result="dInner"/>
          <feFlood flood-color="#fff" result="white"/>
          <feComposite in="white" in2="dOuter" operator="in" result="ringOuter"/>
          <feFlood flood-color="#000" result="black"/>
          <feComposite in="black" in2="dInner" operator="in" result="ringInner"/>
          <feMerge>
            <feMergeNode in="ringOuter"/>
            <feMergeNode in="ringInner"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>`;
    document.body.appendChild(svg);
  })();

  renderActivePalette();
  initPresetEditor();
  buildShapeGrid();
  buildShapePalette();
  initSourceEditor();
  updateUndoRedoBtns();
  updateDirtyBadge();
  updateToolbarState();

  (async () => {
    try {
      await renderDiagram();
      pushHistory();
      setStatus(__("editor.status.ready"));
      await maybePromptLegacyNormalize();
    } catch (e) {
      setSourceValidity(false, e.message || String(e));
      setSourceValue(currentSource);
      setStatus(__("editor.status.render_error", e.message), true);
    }
    setInterval(pollHead, 5000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollHead(); });

    // Phase 3: share button visibility (only owner / admin can manage shares)
    if (shareBtn && (permission === "owner" || me.id === bootstrap.owner_id /* admins handled server-side */)) {
      shareBtn.classList.remove("hidden");
    }
    if (permission === "owner" || (bootstrap.permission === "edit") || permission === "edit" || permission === "view") {
      // Show banner for any participant
      renderLockBanner();
      applyReadOnlyMode();
    }

    // Join presence: the server may auto-promote us to scepter holder if it
    // is currently free. Heartbeat runs from every connected client (not only
    // the holder), so promotion stays current as people come and go.
    await presenceJoin();
    startHeartbeat();
    startPeerSelectionPoll();

    // Becoming "active" in this tab: clicking, typing, focusing the window,
    // or hitting save all imply intent to edit here. Each event re-claims
    // active_tab_id so multi-tab handover happens within one heartbeat.
    window.addEventListener("focus", () => claimActiveTab(false));
    diagramEl.addEventListener("pointerdown", () => claimActiveTab(false));
    sourceEditor.addEventListener("focus", () => claimActiveTab(false));
    sourceEditor.addEventListener("input", () => claimActiveTab(false));

    // Poll edit-requests (mine if waiting, incoming if editor) every 4s.
    requestPollTimer = setInterval(() => {
      pollMyEditRequest();
      pollIncomingRequests();
    }, 4000);

    // Clean exit: tell the server my presence is gone. The request lands via
    // sendBeacon even after the page is unloaded. If another of my tabs is
    // alive, its next heartbeat refreshes the row before any peer notices.
    window.addEventListener("pagehide", () => {
      if (lockHeldByMe()) flushDraftBeacon();
      presenceLeaveBeacon();
    });

    window.__editorReady = true;
  })();
})();
