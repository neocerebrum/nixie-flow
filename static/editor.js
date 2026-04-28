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

  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });

  // ── Constants ───────────────────────────────────────────────────────────

  const SHAPES = [
    { key: "rect",       name: "Rettangolo",    open: "[",   close: "]"   },
    { key: "rounded",    name: "Arrotondato",   open: "(",   close: ")"   },
    { key: "stadium",    name: "Stadio",        open: "([",  close: "])"  },
    { key: "subroutine", name: "Subroutine",    open: "[[",  close: "]]"  },
    { key: "cylinder",   name: "Cilindro",      open: "[(",  close: ")]"  },
    { key: "circle",     name: "Cerchio",       open: "((",  close: "))"  },
    { key: "diamond",    name: "Rombo",         open: "{",   close: "}"   },
    { key: "hexagon",    name: "Esagono",       open: "{{",  close: "}}"  },
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

  const PALETTE = [
    { name: "blue",   fill: "#5e81ac", stroke: "#3b5371", color: "#eceff4" },
    { name: "cyan",   fill: "#88c0d0", stroke: "#5b8898", color: "#2e3440" },
    { name: "green",  fill: "#a3be8c", stroke: "#738a5f", color: "#2e3440" },
    { name: "yellow", fill: "#ebcb8b", stroke: "#b79855", color: "#2e3440" },
    { name: "orange", fill: "#d08770", stroke: "#9a5540", color: "#2e3440" },
    { name: "red",    fill: "#bf616a", stroke: "#8e3b44", color: "#eceff4" },
    { name: "purple", fill: "#b48ead", stroke: "#815b7e", color: "#eceff4" },
    { name: "reset",  reset: true },
  ];

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const reloadBtn = document.getElementById("reloadBtn");
  const resetBtn = document.getElementById("resetBtn");
  const addNodeBtn = document.getElementById("addNodeBtn");
  const delNodeBtn = document.getElementById("delNodeBtn");
  const addEdgeBtn = document.getElementById("addEdgeBtn");
  const delEdgeBtn = document.getElementById("delEdgeBtn");
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

  // ── State ────────────────────────────────────────────────────────────────

  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

  // bootstrap data injected by EditorController
  const bootstrap = JSON.parse(document.getElementById("bootstrap-data").textContent);

  let currentSource = bootstrap.source || "";
  // Normalize to plain object: PHP json_decode($x, true) of "{}" gives [] which
  // JSON.stringify silently strips when we add custom keys to it.
  let positions = (bootstrap.layout && bootstrap.layout.positions) || {};
  if (Array.isArray(positions)) positions = {};
  let currentRevisionId = bootstrap.revision_id;
  let currentTitle = bootstrap.title;
  const slug = bootstrap.slug;

  let nodeMap = {};
  let edges = [];
  let dirtySource = false;
  let dirtyLayout = false;
  let connectingState = null;
  let connectSource = null;
  let selectedNodeId = null;
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
  const incomingReqEl  = document.getElementById("incomingRequestBanner");
  const shareBtn       = document.getElementById("shareBtn");

  // ── API helper (Plesk quirk: always send body + CT) ──────────────────────

  async function api(method, path, body) {
    const isReadOnly = method === "GET" || method === "HEAD";
    const init = {
      method,
      headers: {
        "X-CSRF-Token": csrfToken,
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
      setParseStatus("error", errorMsg || "sorgente non valido");
    }
  }

  function requireValidSource(actionName) {
    if (!lastParseValid) {
      setStatus(`sorgente invalido — correggi la textarea prima di '${actionName}'`, true);
      return false;
    }
    return true;
  }

  function setParseStatus(kind, message) {
    if (kind === "ok") {
      parseStatusEl.className = "ok";
      parseStatusEl.textContent = "✓ valid";
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
    if (!str) { setStatus("nessun diagramma da esportare", true); return; }
    downloadBlob(new Blob([str], { type: "image/svg+xml;charset=utf-8" }), `${slug}.svg`);
    setStatus(`exported: ${slug}.svg`);
  }

  async function exportPng() {
    const str = serializeSvg();
    if (!str) { setStatus("nessun diagramma da esportare", true); return; }
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
    canvas.toBlob(b => { downloadBlob(b, `${slug}.png`); setStatus(`exported: ${slug}.png`); }, "image/png");
  }

  function exportSource() {
    if (!currentSource) return;
    const blob = new Blob([currentSource], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${slug}.mmd`);
    setStatus(`exported: ${slug}.mmd`);
  }

  // ── Render ──────────────────────────────────────────────────────────────

  async function renderDiagram() {
    const parsed = await mermaid.parse(currentSource);
    if (parsed === false) throw new Error("sorgente non valido");
    const { svg } = await mermaid.render("mmd-out", currentSource);
    diagramEl.innerHTML = svg;
    const svgEl = diagramEl.querySelector("svg");
    svgEl.removeAttribute("style");
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

    indexNodesAndEdges(svgEl);
    applySavedPositions();
    rerouteAllEdges();
    recomputeViewBoxFromNodes(svgEl);
    attachDragHandlers(svgEl);
    attachLabelEditors();
    attachEdgeClickHandlers();
    setupPanZoom(svgEl);
    if (!skipSourceSync) setSourceValue(currentSource);
    setSourceValidity(true);
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
    nodeMap = {}; edges = [];
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
      edgeIdx++;
    }
  }

  function extractNodeId(g) {
    const id = g.getAttribute("id") || "";
    const m = id.match(/^flowchart-(.+?)-\d+$/);
    if (m) return m[1];
    if (id && !id.includes("-")) return id;
    return g.getAttribute("data-id") || null;
  }

  function getNodeTranslate(g) {
    // Firefox fix (Ariel commit ccbfbf4): consolidate() may return null
    const t = g.transform.baseVal.consolidate();
    if (t) return { x: t.matrix.e, y: t.matrix.f };
    return { x: 0, y: 0 };
  }

  function setNodeTranslate(g, x, y) {
    g.setAttribute("transform", `translate(${x}, ${y})`);
  }

  function applySavedPositions() {
    for (const [id, pos] of Object.entries(positions)) {
      const n = nodeMap[id];
      if (!n) { console.warn(`orphan position for missing node: ${id}`); continue; }
      setNodeTranslate(n.g, pos.x, pos.y);
    }
  }

  function nodeCenter(id) {
    const n = nodeMap[id];
    if (!n) return null;
    const t = getNodeTranslate(n.g);
    return { x: t.x + n.centerLocal.x, y: t.y + n.centerLocal.y };
  }

  // Detect the primitive shape used by Mermaid for this node, so edges can clip
  // to the actual outline (diamond, circle, hexagon...) instead of the bbox.
  function detectSvgShape(g) {
    for (const child of g.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "polygon") {
        return { type: "polygon", points: parsePolygonPoints(child.getAttribute("points") || "") };
      }
      if (tag === "circle") {
        return {
          type: "circle",
          cx: parseFloat(child.getAttribute("cx")) || 0,
          cy: parseFloat(child.getAttribute("cy")) || 0,
          r: parseFloat(child.getAttribute("r")) || 0,
        };
      }
      if (tag === "ellipse") {
        return {
          type: "ellipse",
          cx: parseFloat(child.getAttribute("cx")) || 0,
          cy: parseFloat(child.getAttribute("cy")) || 0,
          rx: parseFloat(child.getAttribute("rx")) || 0,
          ry: parseFloat(child.getAttribute("ry")) || 0,
        };
      }
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

  function rerouteEdge(edge) {
    const sn = nodeMap[edge.source];
    const tn = nodeMap[edge.target];
    if (!sn || !tn) return;
    const sT = getNodeTranslate(sn.g);
    const tT = getNodeTranslate(tn.g);
    // Centers in svg coords (translate + local center)
    const scx = sT.x + sn.centerLocal.x, scy = sT.y + sn.centerLocal.y;
    const tcx = tT.x + tn.centerLocal.x, tcy = tT.y + tn.centerLocal.y;
    const dx = tcx - scx, dy = tcy - scy;
    const sBoundary = findShapeBoundary(sn, dx, dy);
    const tBoundary = findShapeBoundary(tn, -dx, -dy);
    const sx = sT.x + sBoundary.x, sy = sT.y + sBoundary.y;
    const tx = tT.x + tBoundary.x, ty = tT.y + tBoundary.y;
    edge.path.setAttribute("d", `M ${sx},${sy} L ${tx},${ty}`);
    if (edge.label) {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      edge.label.setAttribute("transform", `translate(${mx}, ${my})`);
    }
  }

  function rerouteAllEdges() { for (const e of edges) rerouteEdge(e); }

  function recomputeViewBoxFromNodes(svgEl) {
    const ids = Object.keys(nodeMap);
    if (ids.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const g = nodeMap[id].g;
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
    if (minX === Infinity) return;
    const pad = 30;
    const x = minX - pad, y = minY - pad;
    const w = (maxX - minX) + 2 * pad;
    const h = (maxY - minY) + 2 * pad;
    svgEl.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    initialViewBox = { x, y, width: w, height: h };
    viewState = { ...initialViewBox };
  }

  function rerouteNodeEdges(id) {
    const n = nodeMap[id];
    if (!n) return;
    for (const e of n.incomingEdges) rerouteEdge(e);
    for (const e of n.outgoingEdges) rerouteEdge(e);
  }

  function attachDragHandlers(svgEl) {
    for (const [id, n] of Object.entries(nodeMap)) {
      n.g.addEventListener("mousedown", (ev) => startDrag(ev, svgEl, id));
    }
  }

  function screenToSvg(svgEl, clientX, clientY) {
    const pt = svgEl.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function startDrag(ev, svgEl, id) {
    if (connectingState) {
      ev.preventDefault();
      handleConnectClick(id);
      return;
    }
    ev.preventDefault();
    const n = nodeMap[id];
    n.g.classList.add("dragging");
    const start = screenToSvg(svgEl, ev.clientX, ev.clientY);
    const origin = getNodeTranslate(n.g);

    function onMove(e) {
      const cur = screenToSvg(svgEl, e.clientX, e.clientY);
      const nx = origin.x + (cur.x - start.x);
      const ny = origin.y + (cur.y - start.y);
      setNodeTranslate(n.g, nx, ny);
      rerouteNodeEdges(id);
    }
    function onUp() {
      n.g.classList.remove("dragging");
      const t = getNodeTranslate(n.g);
      if (t.x !== origin.x || t.y !== origin.y) {
        positions[id] = { x: t.x, y: t.y };
        markDirtyLayout();
        pushHistory();
        setStatus(`${id} → (${t.x.toFixed(0)}, ${t.y.toFixed(0)})`, false);
      } else {
        toggleNodeSelection(id);
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
    if (/[|\n]/.test(label)) return "label non puo' contenere | o newline";
    for (const ch of shape.close) {
      if (label.includes(ch)) {
        return `label non puo' contenere '${ch}' (closer della forma ${shape.name})`;
      }
    }
    return null;
  }

  function rewriteNodeLabelInSource(source, nodeId, newLabel) {
    const idEsc = regexEscape(nodeId);
    const shapesByLen = [...SHAPES].sort((a, b) => b.open.length - a.open.length);
    let winner = null, winnerMatch = null, winnerCount = 0;
    for (const shape of shapesByLen) {
      const openEsc = regexEscape(shape.open);
      const closeEsc = regexEscape(shape.close);
      const re = new RegExp(`\\b${idEsc}(\\s*)${openEsc}([^]*?)${closeEsc}`, "g");
      const matches = [...source.matchAll(re)];
      if (matches.length === 0) continue;
      if (!winner) { winner = shape; winnerMatch = matches[0]; winnerCount = matches.length; }
    }
    if (!winner) return { ok: false, error: `nodo ${nodeId}: dichiarazione non trovata` };
    if (winnerCount > 1) return { ok: false, error: `nodo ${nodeId}: ambigua (${winnerCount} match)` };
    const err = validateLabelForShape(newLabel, winner);
    if (err) return { ok: false, error: err };
    const m = winnerMatch;
    const before = source.slice(0, m.index);
    const after = source.slice(m.index + m[0].length);
    const newDecl = `${nodeId}${m[1]}${winner.open}${newLabel}${winner.close}`;
    return { ok: true, source: before + newDecl + after };
  }

  function rewriteEdgeLabelInSource(source, src, tgt, newLabel) {
    if (/[|\n]/.test(newLabel)) return { ok: false, error: "edge label: niente | o newline" };
    const sEsc = regexEscape(src), tEsc = regexEscape(tgt);
    const re = new RegExp(
      `(\\b${sEsc}\\s*[-=.~<>xo]+)\\|([^|\\n]*)\\|(\\s*[-=.~<>xo]*\\s*\\b${tEsc}\\b)`, "g"
    );
    const matches = [...source.matchAll(re)];
    if (matches.length === 0) return { ok: false, error: `edge ${src}→${tgt}: label non trovata` };
    if (matches.length > 1) return { ok: false, error: `edge ${src}→${tgt}: ambigua` };
    const m = matches[0];
    const before = source.slice(0, m.index);
    const after = source.slice(m.index + m[0].length);
    return { ok: true, source: before + m[1] + "|" + newLabel + "|" + m[3] + after };
  }

  function startLabelEdit(el, kind, meta) {
    const rect = el.getBoundingClientRect();
    const input = document.createElement("input");
    input.type = "text";
    input.value = getLabelText(el);
    Object.assign(input.style, {
      position: "fixed", left: `${rect.left - 4}px`, top: `${rect.top - 4}px`,
      minWidth: `${Math.max(rect.width + 40, 140)}px`,
      height: `${Math.max(rect.height + 8, 28)}px`,
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
      const oldText = getLabelText(el);
      cleanup();
      if (newText === oldText || newText === "") return;
      if (!requireValidSource("edit label")) return;
      const result = kind === "node"
        ? rewriteNodeLabelInSource(currentSource, meta.nodeId, newText)
        : rewriteEdgeLabelInSource(currentSource, meta.source, meta.target, newText);
      if (!result.ok) { setStatus(`edit rifiutato: ${result.error}`, true); return; }
      currentSource = result.source;
      markDirtySource();
      const who = kind === "node" ? meta.nodeId : `${meta.source}→${meta.target}`;
      await renderDiagram();
      pushHistory();
      setStatus(`${who}: "${oldText}" → "${newText}"`);
    }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    function onBlur() { commit(); }
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }

  function attachLabelEditors() {
    for (const [id, n] of Object.entries(nodeMap)) {
      const labelEl = findLabelTextElement(n.g);
      if (!labelEl) continue;
      labelEl.style.cursor = "text";
      labelEl.addEventListener("dblclick", (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        startLabelEdit(labelEl, "node", { nodeId: id });
      });
    }
    for (const edge of edges) {
      if (!edge.label) continue;
      const labelEl = findLabelTextElement(edge.label);
      if (!labelEl || !getLabelText(labelEl)) continue;
      labelEl.style.cursor = "text";
      labelEl.addEventListener("dblclick", (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        startLabelEdit(labelEl, "edge", { source: edge.source, target: edge.target });
      });
    }
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

  function addNodeToSource(source, id, label, shape) {
    if (!/^[A-Za-z_][\w]*$/.test(id)) {
      return { ok: false, error: `ID non valido: '${id}'` };
    }
    if (nodeMap[id]) return { ok: false, error: `nodo '${id}' esiste gia'` };
    const shp = shape || SHAPES[0];
    const lbl = label || id;
    const err = validateLabelForShape(lbl, shp);
    if (err) return { ok: false, error: err };
    const line = `    ${id}${shp.open}${lbl}${shp.close}`;
    const nodeDeclRegex = /^\s*[A-Za-z_]\w*\s*[\[(\{]/;
    return { ok: true, source: insertAfterLastMatch(source, nodeDeclRegex, line) };
  }

  function addEdgeToSource(source, src, tgt, label) {
    if (!nodeMap[src]) return { ok: false, error: `source '${src}' non esiste` };
    if (!nodeMap[tgt]) return { ok: false, error: `target '${tgt}' non esiste` };
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
    const edgeRe = new RegExp(`\\b${sEsc}\\b\\s*[-=.~][-=.~<>xo]*\\s*\\b${tEsc}\\b`);
    const lines = source.split("\n");
    let matched = 0;
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripEdgeLabels(lines[i])
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/\([^)\n]*\)/g, " ")
        .replace(/\{[^}\n]*\}/g, " ");
      if (!edgeRe.test(stripped)) continue;
      if (matched !== ordinal) { matched++; continue; }
      const arrowSegs = (stripped.match(/[-=.~][-=.~<>xo]*\s*\w+/g) || []).length;
      const chainLine = arrowSegs > 1;
      lines.splice(i, 1);
      return { ok: true, source: lines.join("\n"), chainLine };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} non trovata` };
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
      return { ok: false, error: `nessun riferimento a '${id}' trovato` };
    }
    return { ok: true, source: kept.join("\n"), removedDecl, removedOther };
  }

  function attachEdgeClickHandlers() {
    for (const edge of edges) {
      const targets = [edge.path];
      if (edge.label) targets.push(edge.label);
      for (const t of targets) {
        t.style.pointerEvents = "auto";
        t.addEventListener("click", (ev) => {
          if (connectingState !== "delete-edge") return;
          ev.stopPropagation(); ev.preventDefault();
          handleDeleteEdgeClick(edge);
        });
      }
    }
  }

  async function handleDeleteEdgeClick(edge) {
    cancelConnectMode();
    const label = `${edge.source} → ${edge.target}` +
      (edge.ordinal > 0 ? ` (#${edge.ordinal + 1})` : "");
    if (!confirm(`Eliminare la freccia ${label}?`)) return;
    const result = deleteEdgeFromSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`delete edge: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    const warn = result.chainLine ? " (era in una chain: rimossa l'intera riga)" : "";
    setStatus(`− edge ${label}${warn}`);
  }

  async function handleConnectClick(id) {
    if (connectingState === "delete") {
      cancelConnectMode();
      if (!confirm(`Eliminare il nodo '${id}' e tutti i suoi riferimenti?`)) return;
      const result = deleteNodeFromSource(currentSource, id);
      if (!result.ok) { setStatus(`delete: ${result.error}`, true); return; }
      currentSource = result.source;
      markDirtySource();
      if (positions[id] !== undefined) { delete positions[id]; markDirtyLayout(); }
      await renderDiagram();
      pushHistory();
      const parts = [];
      if (result.removedDecl) parts.push("decl");
      if (result.removedOther) parts.push(`${result.removedOther} refs`);
      setStatus(`− node ${id} (rimossi: ${parts.join(" + ")})`);
      return;
    }
    if (connectingState === "source") {
      connectSource = id;
      nodeMap[id].g.classList.add("connect-source");
      connectingState = "target";
      const svgEl = diagramEl.querySelector("svg");
      _ghostCleanup = startGhostEdge(svgEl, id);
      setStatus(`source: ${id}. Ora clicca il target.`);
      return;
    }
    if (connectingState === "target") {
      if (_ghostCleanup) { _ghostCleanup(); _ghostCleanup = null; }
      const src = connectSource, tgt = id;
      cancelConnectMode();
      if (src === tgt) { setStatus(`self-loop ${src}→${tgt} non supportato`, true); return; }
      const label = (prompt(`Label della freccia ${src} → ${tgt} (vuoto = senza label):`, "") || "").trim();
      const result = addEdgeToSource(currentSource, src, tgt, label);
      if (!result.ok) { setStatus(`add edge: ${result.error}`, true); return; }
      currentSource = result.source;
      markDirtySource();
      await renderDiagram();
      pushHistory();
      setStatus(`+ edge ${src} → ${tgt}${label ? ` |${label}|` : ""}`);
    }
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
    document.addEventListener("mousemove", onMove);
    return function cleanup() {
      document.removeEventListener("mousemove", onMove);
      if (line.parentNode) line.parentNode.removeChild(line);
    };
  }

  function startConnectMode() {
    if (connectingState) { cancelConnectMode(); return; }
    if (!requireValidSource("+ Edge")) return;
    connectingState = "source"; connectSource = null;
    document.body.classList.add("connecting");
    addEdgeBtn.classList.add("active"); addEdgeBtn.textContent = "Cancel";
    setStatus("clicca il nodo sorgente (Esc per annullare)");
  }
  function startDeleteMode() {
    if (connectingState) { cancelConnectMode(); return; }
    if (!requireValidSource("− Node")) return;
    connectingState = "delete";
    document.body.classList.add("deleting");
    delNodeBtn.classList.add("active", "danger"); delNodeBtn.textContent = "Cancel";
    setStatus("clicca il nodo da eliminare (Esc per annullare)");
  }
  function startDeleteEdgeMode() {
    if (connectingState) { cancelConnectMode(); return; }
    if (!requireValidSource("− Edge")) return;
    connectingState = "delete-edge";
    document.body.classList.add("deleting-edge");
    delEdgeBtn.classList.add("active", "danger"); delEdgeBtn.textContent = "Cancel";
    setStatus("clicca la freccia da eliminare (Esc per annullare)");
  }
  function cancelConnectMode() {
    if (_ghostCleanup) { _ghostCleanup(); _ghostCleanup = null; }
    connectingState = null;
    if (connectSource && nodeMap[connectSource]) {
      nodeMap[connectSource].g.classList.remove("connect-source");
    }
    connectSource = null;
    document.body.classList.remove("connecting", "deleting", "deleting-edge");
    addEdgeBtn.classList.remove("active"); addEdgeBtn.textContent = "+ Edge";
    delNodeBtn.classList.remove("active", "danger"); delNodeBtn.textContent = "− Node";
    delEdgeBtn.classList.remove("active", "danger"); delEdgeBtn.textContent = "− Edge";
    setStatus("");
  }

  // ── Pan / zoom ───────────────────────────────────────────────────────────

  function applyViewState(svgEl) {
    if (!viewState) return;
    svgEl.setAttribute("viewBox",
      `${viewState.x} ${viewState.y} ${viewState.width} ${viewState.height}`);
  }
  function fitView() {
    if (!initialViewBox) return;
    viewState = { ...initialViewBox };
    const svgEl = diagramEl.querySelector("svg");
    if (svgEl) applyViewState(svgEl);
  }
  function zoomStep(z) {
    if (!viewState) return;
    const svgEl = diagramEl.querySelector("svg");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const vx = viewState.x + cx * viewState.width / rect.width;
    const vy = viewState.y + cy * viewState.height / rect.height;
    const minW = initialViewBox.width / 10;
    const maxW = initialViewBox.width * 10;
    const newW = viewState.width / z;
    if (newW < minW || newW > maxW) return;
    viewState.width = newW;
    viewState.height = viewState.height / z;
    viewState.x = vx - cx * viewState.width / rect.width;
    viewState.y = vy - cy * viewState.height / rect.height;
    applyViewState(svgEl);
  }
  function setupPanZoom(svgEl) {
    if (initialViewBox === null) {
      const vb = svgEl.viewBox.baseVal;
      initialViewBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
    }
    if (viewState === null) viewState = { ...initialViewBox };
    applyViewState(svgEl);
    svgEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("g.node")) return;
      if (e.target.closest("g.edgePaths path")) return;
      if (e.target.closest("g.edgeLabels > g")) return;
      if (connectingState) return;
      if (e.button !== 0) return;
      e.preventDefault();
      svgEl.classList.add("panning");
      const rect = svgEl.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startVX = viewState.x, startVY = viewState.y;
      function onMove(ev) {
        const dxView = (ev.clientX - startX) * viewState.width / rect.width;
        const dyView = (ev.clientY - startY) * viewState.height / rect.height;
        viewState.x = startVX - dxView;
        viewState.y = startVY - dyView;
        applyViewState(svgEl);
      }
      function onUp() {
        svgEl.classList.remove("panning");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    svgEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const vx = viewState.x + mx * viewState.width / rect.width;
      const vy = viewState.y + my * viewState.height / rect.height;
      const z = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      let newW = viewState.width / z;
      let newH = viewState.height / z;
      const minW = initialViewBox.width / 10;
      const maxW = initialViewBox.width * 10;
      if (newW < minW || newW > maxW) return;
      viewState.width = newW;
      viewState.height = newH;
      viewState.x = vx - mx * viewState.width / rect.width;
      viewState.y = vy - my * viewState.height / rect.height;
      applyViewState(svgEl);
    }, { passive: false });
  }

  // ── Selection / palette ──────────────────────────────────────────────────

  function toggleNodeSelection(id) {
    if (selectedNodeId === id) { deselectNode(); return; }
    if (selectedNodeId && nodeMap[selectedNodeId]) {
      nodeMap[selectedNodeId].g.classList.remove("selected");
    }
    selectedNodeId = id;
    nodeMap[id].g.classList.add("selected");
    setStatus(`selected: ${id}`);
  }
  function deselectNode() {
    if (selectedNodeId && nodeMap[selectedNodeId]) {
      nodeMap[selectedNodeId].g.classList.remove("selected");
    }
    selectedNodeId = null;
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

  async function applyPaletteColor(color) {
    if (!requireValidSource("applica colore")) return;
    if (!selectedNodeId) { setStatus("seleziona prima un nodo (click su un box)", true); return; }
    const id = selectedNodeId;
    const styleStr = color.reset ? null
      : `fill:${color.fill},stroke:${color.stroke},color:${color.color}`;
    const result = setNodeStyleInSource(currentSource, id, styleStr);
    if (!result.changed) {
      setStatus(`${id}: colore gia' applicato (o reset su nodo senza style)`);
      return;
    }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    if (nodeMap[id]) {
      nodeMap[id].g.classList.add("selected");
      selectedNodeId = id;
    }
    pushHistory();
    setStatus(`${id}: color ${color.name}`);
  }

  function buildPalette() {
    for (const color of PALETTE) {
      const btn = document.createElement("button");
      btn.className = "color-swatch";
      btn.type = "button";
      if (color.reset) {
        btn.dataset.reset = "1"; btn.textContent = "×";
        btn.title = "Reset colore (rimuove style)";
      } else {
        btn.style.background = color.fill;
        btn.title = color.name;
      }
      btn.addEventListener("click", () => applyPaletteColor(color));
      colorPaletteEl.appendChild(btn);
    }
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
    return { ok: false, error: `dichiarazione di ${nodeId} non trovata` };
  }

  async function applyShapeToSelected(shape) {
    if (!requireValidSource("cambia forma")) return;
    if (!selectedNodeId) { setStatus("seleziona un nodo prima", true); return; }
    const id = selectedNodeId;
    const result = changeShapeInSource(currentSource, id, shape);
    if (!result.ok) { setStatus(`cambia forma: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    if (nodeMap[id]) { nodeMap[id].g.classList.add("selected"); selectedNodeId = id; }
    pushHistory();
    setStatus(`${id}: forma → ${shape.name}`);
  }

  function buildShapePalette() {
    for (const shape of SHAPES) {
      const btn = document.createElement("button");
      btn.className = "shape-mini";
      btn.type = "button";
      btn.title = `Cambia forma → ${shape.name}`;
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

  function openAddNodeModal() {
    if (!requireValidSource("aggiungi nodo")) return;
    document.getElementById("addNodeModal").classList.remove("hidden");
    document.getElementById("modalError").textContent = "";
    document.getElementById("nodeIdInput").value = "";
    document.getElementById("nodeLabelInput").value = "";
    selectShape(SHAPES[0]);
    setTimeout(() => document.getElementById("nodeIdInput").focus(), 0);
  }
  function closeAddNodeModal() { document.getElementById("addNodeModal").classList.add("hidden"); }

  async function submitAddNodeModal() {
    const id = document.getElementById("nodeIdInput").value.trim();
    const label = document.getElementById("nodeLabelInput").value.trim();
    const errorEl = document.getElementById("modalError");
    errorEl.textContent = "";
    if (!id) { errorEl.textContent = "ID obbligatorio"; return; }
    const result = addNodeToSource(currentSource, id, label, modalSelectedShape);
    if (!result.ok) { errorEl.textContent = result.error; return; }
    currentSource = result.source;
    markDirtySource();
    closeAddNodeModal();
    await renderDiagram();
    pushHistory();
    setStatus(`+ node ${id} (${modalSelectedShape.name})`);
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
      autosaveBadgeEl.textContent = "auto-salvato " + fmtClock(lastDraftFlushAt);
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
    if (currentRevisionId == null) return;
    if (draftFlushInFlight) { draftFlushPending = true; return; }

    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    draftFlushInFlight = true;

    const snapSource = currentSource;
    const snapPositions = JSON.parse(JSON.stringify(positions));
    const expected = currentRevisionId;
    try {
      const { status, json } = await api("PATCH",
        `/api/diagrams/${encodeURIComponent(slug)}/draft`,
        {
          source: snapSource,
          layout: { version: 1, positions: snapPositions },
          expected_revision_id: expected,
        });
      if (status === 200 && json) {
        if (json.lock) updateLockFromDto(json.lock);
        lastDraftFlushAt = Date.now();
        if (json.updated_at) lastUpdatedAt = json.updated_at;
        updateAutosaveBadge();
      } else if (status === 423 && json) {
        if (json.lock) updateLockFromDto(json.lock);
      } else if (status === 409 && json) {
        // Lock got bypassed somehow and head moved — surface as conflict.
        openConflictModal(json.current_revision_id);
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
    if (currentRevisionId == null) return;
    try {
      fetch(`/api/diagrams/${encodeURIComponent(slug)}/draft`, {
        method: "PATCH", keepalive: true,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          source: currentSource,
          layout: { version: 1, positions },
          expected_revision_id: currentRevisionId,
        }),
      });
    } catch (_) { /* ignore */ }
  }

  async function save() {
    if (saveInProgress) return;
    if (!lastParseValid) {
      setStatus("sorgente invalido — impossibile salvare", true);
      return;
    }
    if (!dirtySource && !dirtyLayout) {
      setStatus("niente da salvare");
      return;
    }
    saveInProgress = true;
    saveBtn.disabled = true;
    setStatus("salvando…");
    // Cancel any pending autosave; the explicit POST will carry current state.
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    try {
      const { status, json } = await api("POST", `/api/diagrams/${encodeURIComponent(slug)}`, {
        source: currentSource,
        layout: { version: 1, positions },
        expected_revision_id: currentRevisionId,
      });
      if (status === 200 && json) {
        currentRevisionId = json.revision_id;
        if (json.lock) updateLockFromDto(json.lock);
        if (json.updated_at) lastUpdatedAt = json.updated_at;
        lastDraftFlushAt = null;
        clearDirty();
        setStatus(`salvato (rev ${currentRevisionId})`);
      } else if (status === 409 && json) {
        openConflictModal(json.current_revision_id);
      } else if (status === 423 && json) {
        if (json.lock) updateLockFromDto(json.lock);
        showToast("Hai perso il turno di editing — qualcun altro sta modificando.", "warn");
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
    renderDiagram().then(() => setStatus("layout resettato (salva per persistere)"));
  }

  // ── Reload (discard local) ───────────────────────────────────────────────

  async function reloadFromServer() {
    setStatus("ricaricando…");
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}`);
      if (status !== 200 || !json) throw new Error(`HTTP ${status}`);
      loadFromDto(json);
      setStatus("ricaricato dal server");
    } catch (e) {
      setStatus(`reload failed: ${e.message}`, true);
    }
  }

  function loadFromDto(dto) {
    currentSource = dto.source || "";
    positions = (dto.layout && dto.layout.positions) || {};
    if (Array.isArray(positions)) positions = {};
    currentRevisionId = dto.revision_id;
    if (dto.updated_at) lastUpdatedAt = dto.updated_at;
    if (dto.title && dto.title !== currentTitle) {
      currentTitle = dto.title;
      titleEl.textContent = currentTitle;
      document.title = currentTitle + " — Aquata";
    }
    clearDirty();
    selectedNodeId = null;
    initialViewBox = null;
    viewState = null;
    history = []; historyPtr = -1;
    return renderDiagram().then(() => pushHistory());
  }

  // ── Polling for remote changes ───────────────────────────────────────────

  async function pollHead() {
    if (document.hidden || saveInProgress || draftFlushInFlight) return;
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(slug)}`);
      if (status !== 200 || !json) return;
      if (json.lock) updateLockFromDto(json.lock);
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
        showToast("Aggiornamento live dall'editor");
      } else {
        showToast("Diagramma aggiornato dal server");
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
    const revs = (data.revisions || []).slice().reverse();
    if (revs.length === 0) {
      list.innerHTML = "<p class='muted-small'>Nessuna revisione</p>";
      return;
    }
    for (const r of revs) {
      const isHead = r.id === data.head_revision_id;
      const row = document.createElement("div");
      row.className = "history-row" + (isHead ? " is-head" : "");
      row.innerHTML = `
        <span class="history-id">#${r.id}</span>
        <span class="history-meta">
          ${r.parent_id ? `← #${r.parent_id}` : "(root)"}
          • ${r.created_at}
          ${r.message ? `• ${escapeHtml(r.message)}` : ""}
        </span>
        <button data-rev-id="${r.id}" ${isHead ? "disabled" : ""}>
          ${isHead ? "head" : "Vai a"}
        </button>
      `;
      const btn = row.querySelector("button");
      if (!isHead) btn.addEventListener("click", () => checkout(r.id));
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
      if (!confirm("Hai modifiche non salvate. Saltando perderai le modifiche locali. Continuare?")) return;
    }
    try {
      const { status, json } = await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/checkout`, {
        revision_id: revisionId,
      });
      if (status !== 200 || !json) throw new Error(`HTTP ${status}`);
      closeHistoryModal();
      await loadFromDto(json);
      setStatus(`checkout → rev ${revisionId}`);
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
    if (!newTitle) { errorEl.textContent = "titolo obbligatorio"; return; }
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
      setStatus("rinominato");
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
      <span><strong>Aggiornamento remoto disponibile</strong> (rev ${remoteRevId}).
        Hai modifiche locali non salvate.</span>
      <button id="remoteUpdateView">Vedi cronologia</button>
      <button id="remoteUpdateReload" class="primary">Ricarica (perdi modifiche)</button>
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

  // ── Phase 3: lock + edit-request + share ─────────────────────────────────

  const HEARTBEAT_MS = 30000;     // server TTL is 90s; we refresh every 30s
  const REQUEST_POLL_MS = 4000;   // poll incoming/outgoing edit-requests every 4s

  function lockHeldByMe() {
    return lockState && lockState.is_active && lockState.user_id === me.id;
  }
  function lockHeldByOther() {
    return lockState && lockState.is_active && lockState.user_id !== me.id;
  }

  function updateLockFromDto(newLock) {
    const wasMine  = lockHeldByMe();
    const wasOther = lockHeldByOther();
    lockState = newLock;
    const nowMine  = lockHeldByMe();
    const nowOther = lockHeldByOther();
    if (wasMine && !nowMine) {
      showToast("Hai perso il turno di editing.", "warn");
    }
    if (wasOther && !nowOther && !lockState.is_active && permission !== "view") {
      showToast("Il turno di editing è ora libero — riprovo ad acquisirlo.");
      tryAcquireLock();
    }
    renderLockBanner();
    applyReadOnlyMode();
  }

  function applyReadOnlyMode() {
    const blocked = !canWrite || lockHeldByOther() || (permission === "view");
    isReadOnly = blocked;
    document.body.classList.toggle("readonly", blocked);
    if (sourceCM) sourceCM.setOption("readOnly", blocked ? "nocursor" : false);
    else if (sourceEditor) sourceEditor.readOnly = blocked;
  }

  function lockHolderLabel() {
    if (!lockState || !lockState.user_id) return "";
    if (lockState.user_id === me.id) return "tu";
    return "utente #" + lockState.user_id;
  }

  function renderLockBanner() {
    if (!lockBannerEl) return;
    lockBannerEl.classList.remove("hidden", "lock-mine", "lock-other", "lock-free", "lock-readonly");
    lockActionsEl.innerHTML = "";

    if (permission === "view") {
      lockBannerEl.classList.add("lock-readonly");
      lockMessageEl.textContent = "Sola lettura — non hai permesso di modifica.";
      return;
    }

    if (lockHeldByMe()) {
      lockBannerEl.classList.add("lock-mine");
      lockMessageEl.textContent = "Stai modificando (turno tuo).";
      const releaseBtn = document.createElement("button");
      releaseBtn.textContent = "Rilascia turno";
      releaseBtn.title = "Lascia il turno libero per altri";
      releaseBtn.addEventListener("click", releaseLock);
      lockActionsEl.appendChild(releaseBtn);
      return;
    }

    if (lockHeldByOther()) {
      lockBannerEl.classList.add("lock-other");
      lockMessageEl.textContent = "Sta modificando: " + lockHolderLabel() + " — sola lettura.";
      if (myEditRequest && myEditRequest.status === "pending") {
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Annulla richiesta";
        cancelBtn.addEventListener("click", cancelMyRequest);
        const span = document.createElement("span");
        span.textContent = "Richiesta inviata, in attesa…";
        span.style.marginRight = "10px";
        lockActionsEl.appendChild(span);
        lockActionsEl.appendChild(cancelBtn);
      } else if (myEditRequest && myEditRequest.status === "granted" && myEditRequest.grant_open) {
        const takeBtn = document.createElement("button");
        takeBtn.className = "primary";
        takeBtn.textContent = "Prendi il turno";
        takeBtn.addEventListener("click", tryAcquireLock);
        lockActionsEl.appendChild(takeBtn);
      } else {
        const reqBtn = document.createElement("button");
        reqBtn.className = "primary";
        reqBtn.textContent = "Richiedi turno";
        reqBtn.addEventListener("click", requestEdit);
        lockActionsEl.appendChild(reqBtn);
      }
      return;
    }

    // Lock free (and I'm not editor yet)
    lockBannerEl.classList.add("lock-free");
    lockMessageEl.textContent = "Turno libero.";
    const takeBtn = document.createElement("button");
    takeBtn.className = "primary";
    takeBtn.textContent = "Prendi turno";
    takeBtn.addEventListener("click", tryAcquireLock);
    lockActionsEl.appendChild(takeBtn);
  }

  async function tryAcquireLock() {
    if (!canWrite) return false;
    try {
      const { status, json } = await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/lock`, {});
      if (json && json.lock) updateLockFromDto(json.lock);
      if (status === 200) {
        myEditRequest = null;
        startHeartbeat();
        renderLockBanner();
        return true;
      }
      return false;
    } catch (_) { return false; }
  }

  async function releaseLock() {
    // Flush any pending autosave before giving up the turn so the next editor
    // (or my next session) inherits the freshest state.
    if ((dirtySource || dirtyLayout) && lastParseValid) {
      await flushDraft({ immediate: true });
    }
    stopHeartbeat();
    try {
      await api("DELETE", `/api/diagrams/${encodeURIComponent(slug)}/lock`, {});
    } catch (_) { /* ignore */ }
    lockState = { user_id: null, since: null, is_active: false, expires_at: null };
    clearDirty();
    renderLockBanner();
    applyReadOnlyMode();
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const { status, json } = await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/lock/heartbeat`, {});
        if (json && json.lock) updateLockFromDto(json.lock);
        if (status === 410) {
          stopHeartbeat();
          showToast("Lock scaduto o preso da altri.", "warn");
        }
      } catch (_) { /* ignore */ }
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  async function requestEdit() {
    const note = (prompt("Aggiungi una nota (opzionale) per chi sta modificando:") || "").trim();
    try {
      const { status, json } = await api("POST",
        `/api/diagrams/${encodeURIComponent(slug)}/edit-requests`, { note });
      if ((status === 200 || status === 201) && json && json.request) {
        myEditRequest = json.request;
        if (json.lock) updateLockFromDto(json.lock); else renderLockBanner();
        showToast("Richiesta inviata.");
      } else {
        showToast("Impossibile inviare la richiesta.", "warn");
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
      if (myEditRequest && myEditRequest.status === "granted" && myEditRequest.grant_open) {
        if (!prev || prev.status !== "granted") {
          showToast("Il tuo turno è stato accordato — premi 'Prendi il turno'.");
        }
      } else if (myEditRequest && myEditRequest.status === "rejected"
                 && prev && prev.status === "pending") {
        showToast("Richiesta rifiutata.", "warn");
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
    const who = r.requester_name || r.requester_email || ("utente #" + r.requester_id);
    const note = r.note ? ` — "${escapeHtml(r.note)}"` : "";
    const msg = document.createElement("span");
    msg.innerHTML = `<strong>${escapeHtml(who)}</strong> chiede il turno${note}`;
    const acc = document.createElement("button");
    acc.className = "primary"; acc.textContent = "Cedi";
    acc.addEventListener("click", () => acceptRequest(r.id));
    const dec = document.createElement("button");
    dec.className = "danger"; dec.textContent = "Rifiuta";
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
    // explicitly saved. No need for the old "perdi modifiche" prompt because
    // the draft is preserved in the head row.
    if ((dirtySource || dirtyLayout) && lastParseValid) {
      await flushDraft({ immediate: true });
    }
    try {
      await api("POST", `/api/diagrams/${encodeURIComponent(slug)}/edit-requests/${id}/accept`, {});
      stopHeartbeat();
      lockState = { user_id: null, since: null, is_active: false, expires_at: null };
      // Work is autosaved on head row; clear dirty so the "modificato" badge
      // doesn't linger for a passive viewer.
      clearDirty();
      hideIncomingBanner();
      renderLockBanner();
      applyReadOnlyMode();
      // Force an immediate poll so I see the new editor's first edits without
      // waiting for the next 5s tick.
      pollHead();
      showToast("Turno ceduto.");
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
        <span class="share-user">${who || ("utente #" + s.user_id)}</span>
        <span class="share-perm">${escapeHtml(s.permission)}</span>
      `;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Rimuovi";
      removeBtn.addEventListener("click", async () => {
        if (!confirm("Rimuovere la condivisione con questo utente?")) return;
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
    if (!email) { errEl.textContent = "Email obbligatoria"; return; }
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
      if (!confirm("Scartare le modifiche locali e ricaricare dal server?")) return;
    }
    await reloadFromServer();
  });
  resetBtn.addEventListener("click", resetLayout);
  addNodeBtn.addEventListener("click", openAddNodeModal);
  delNodeBtn.addEventListener("click", startDeleteMode);
  addEdgeBtn.addEventListener("click", startConnectMode);
  delEdgeBtn.addEventListener("click", startDeleteEdgeMode);
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

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizer.classList.add("dragging");
    const startX = e.clientX;
    const startWidth = sourcePanel.getBoundingClientRect().width;
    function onMove(ev) {
      const w = Math.max(120, Math.min(window.innerWidth - 200, startWidth + (ev.clientX - startX)));
      sourcePanel.style.width = w + "px";
    }
    function onUp() {
      resizer.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
    const collapsed = sourcePanel.classList.toggle("collapsed");
    togglePanelBtn.textContent = collapsed ? "»" : "«";
    togglePanelBtn.title = collapsed ? "Espandi" : "Collassa";
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
      if (connectingState) { cancelConnectMode(); return; }
      if (selectedNodeId) { deselectNode(); setStatus(""); }
      return;
    }
    if (e.key === "0" || e.key === "Home") { e.preventDefault(); fitView(); return; }
    if ((e.key === "Delete" || e.key === "Backspace")) {
      if (selectedNodeId && requireValidSource("rimuovi nodo")) {
        e.preventDefault();
        const id = selectedNodeId;
        if (confirm(`Eliminare il nodo '${id}' e tutti i suoi riferimenti?`)) {
          const result = deleteNodeFromSource(currentSource, id);
          if (result.ok) {
            currentSource = result.source;
            markDirtySource();
            if (positions[id] !== undefined) { delete positions[id]; markDirtyLayout(); }
            deselectNode();
            renderDiagram().then(() => { pushHistory(); setStatus(`− node ${id}`); });
          }
        }
      }
      return;
    }
    if (e.key === "+" || (e.key === "=" && e.shiftKey === false)) { e.preventDefault(); zoomStep(1.2); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomStep(1 / 1.2); return; }
  });

  diagramEl.addEventListener("click", (e) => {
    if (!e.target.closest("g.node") && selectedNodeId) {
      deselectNode();
      setStatus("");
    }
  });

  // ── Init ─────────────────────────────────────────────────────────────────

  buildPalette();
  buildShapeGrid();
  buildShapePalette();
  initSourceEditor();
  updateUndoRedoBtns();
  updateDirtyBadge();

  (async () => {
    try {
      await renderDiagram();
      pushHistory();
      setStatus("pronto");
    } catch (e) {
      setSourceValidity(false, e.message || String(e));
      setSourceValue(currentSource);
      setStatus(`render error: ${e.message}`, true);
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

    // Try to acquire the lock automatically when entering with edit perm.
    if (canWrite) {
      const taken = await tryAcquireLock();
      if (taken) startHeartbeat();
    }

    // Poll edit-requests (mine if waiting, incoming if editor) every 4s.
    requestPollTimer = setInterval(() => {
      pollMyEditRequest();
      pollIncomingRequests();
    }, 4000);

    window.addEventListener("beforeunload", () => {
      if (lockHeldByMe()) {
        // Order matters: flush draft first (so I don't lose pending edits),
        // then release the lock. Both via fetch keepalive — the request will
        // complete in the background even after the page is gone.
        flushDraftBeacon();
        try {
          fetch(`/api/diagrams/${encodeURIComponent(slug)}/lock`, {
            method: "DELETE", keepalive: true,
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: "{}",
          });
        } catch (_) { /* ignore */ }
      }
    });

    window.__editorReady = true;
  })();
})();
