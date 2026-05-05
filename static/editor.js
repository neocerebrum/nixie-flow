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
  const addEdgeBtn = document.getElementById("addEdgeBtn");
  const addSubgraphBtn = document.getElementById("addSubgraphBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const toggleEdgeStyleBtn = document.getElementById("toggleEdgeStyleBtn");
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
  let currentRevisionId = bootstrap.revision_id;
  let currentTitle = bootstrap.title;
  const slug = bootstrap.slug;

  let nodeMap = {};
  let clusterMap = {};
  let edges = [];
  let dirtySource = false;
  let dirtyLayout = false;
  let connectingState = null;
  let connectSource = null;
  let selectedNodeIds = new Set(); // multi-select via Shift/Ctrl/Cmd+click
  let selectedClusterId = null;
  let selectedEdgeKey = null; // "<src>|<tgt>|<ordinal>"
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
    updateAllClusterBounds();
    rerouteAllEdges();
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
    if (selectedClusterId) {
      if (clusterMap[selectedClusterId]) clusterMap[selectedClusterId].g.classList.add("selected");
      else selectedClusterId = null;
    }
    if (selectedEdgeKey) {
      const e = findEdgeByKey(selectedEdgeKey);
      if (e) e.path.classList.add("selected");
      else selectedEdgeKey = null;
    }
    updateToolbarState();
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
      // Remember the offset between the rect and the original member bbox so we
      // can resize the rect later while preserving Mermaid's original padding.
      let padding = null;
      let labelOffset = null;
      if (bg && bg.tagName.toLowerCase() === "rect") {
        const ct = getNodeTranslate(g);
        const rx = parseFloat(bg.getAttribute("x")) || 0;
        const ry = parseFloat(bg.getAttribute("y")) || 0;
        const rw = parseFloat(bg.getAttribute("width")) || 0;
        const rh = parseFloat(bg.getAttribute("height")) || 0;
        const wx1 = ct.x + rx, wy1 = ct.y + ry;
        const wx2 = wx1 + rw, wy2 = wy1 + rh;
        const mb = computeMemberWorldBboxFromIds(members);
        if (mb) {
          padding = {
            left:   mb.minX - wx1,
            top:    mb.minY - wy1,
            right:  wx2 - mb.maxX,
            bottom: wy2 - mb.maxY,
            rx, ry,
          };
        }
        if (label) {
          const lt = getNodeTranslate(label);
          labelOffset = { dx: lt.x - rx - rw / 2, dy: lt.y - ry };
        }
      }
      clusterMap[id] = {
        g, bg, label, members, padding, labelOffset,
        incomingEdges: [], outgoingEdges: [],
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
      if (clusterMap[source]) clusterMap[source].outgoingEdges.push(edge);
      if (clusterMap[target]) clusterMap[target].incomingEdges.push(edge);
      edgeIdx++;
    }
  }

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
    for (const [id, pos] of Object.entries(positions)) {
      const n = nodeMap[id];
      if (!n) { console.warn(`orphan position for missing node: ${id}`); continue; }
      setNodeTranslate(n.g, pos.x, pos.y);
    }
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

  function detectSvgShape(g) {
    for (const child of g.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "polygon") {
        const tr = getElementLocalTranslate(child);
        const raw = parsePolygonPoints(child.getAttribute("points") || "");
        const points = raw.map(p => ({ x: p.x + tr.x, y: p.y + tr.y }));
        return { type: "polygon", points };
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

  function rerouteEdge(edge) {
    const sn = endpointInfo(edge.source);
    const tn = endpointInfo(edge.target);
    if (!sn || !tn) return;
    const sT = getWorldTranslate(sn.g);
    const tT = getWorldTranslate(tn.g);
    const scx = sT.x + sn.centerLocal.x, scy = sT.y + sn.centerLocal.y;
    const tcx = tT.x + tn.centerLocal.x, tcy = tT.y + tn.centerLocal.y;
    const dx = tcx - scx, dy = tcy - scy;
    const sBoundary = findShapeBoundary(sn, dx, dy);
    const tBoundary = findShapeBoundary(tn, -dx, -dy);
    // Endpoints in WORLD coords first…
    const sxW = sT.x + sBoundary.x, syW = sT.y + sBoundary.y;
    const txW = tT.x + tBoundary.x, tyW = tT.y + tBoundary.y;
    // …then convert to the path element's own parent frame. Subgraph-internal
    // edges live inside a nested <g class="root"> with its own transform.
    const eFrame = getElementParentTranslate(edge.path);
    const sx = sxW - eFrame.x, sy = syW - eFrame.y;
    const tx = txW - eFrame.x, ty = tyW - eFrame.y;
    const sIsCluster = !!clusterMap[edge.source];
    const tIsCluster = !!clusterMap[edge.target];
    let labelX, labelY;
    if (sIsCluster || tIsCluster) {
      const dist = Math.hypot(tx - sx, ty - sy) || 1;
      const cl = Math.max(40, Math.min(200, dist * 0.3));
      let snx, sny;
      if (sIsCluster) {
        const nrm = clusterOutwardNormal(sn, sBoundary);
        snx = nrm.x; sny = nrm.y;
      } else {
        snx = (tx - sx) / dist; sny = (ty - sy) / dist;
      }
      let tnx, tny;
      if (tIsCluster) {
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

  function updateClusterBounds(clusterId) {
    const c = clusterMap[clusterId];
    if (!c || !c.bg || !c.padding) return;
    if (c.bg.tagName.toLowerCase() !== "rect") return;
    if (!c.members || c.members.size === 0) return;
    const mb = computeMemberWorldBboxFromIds(c.members);
    if (!mb) return;
    const pad = c.padding;
    const newCx = mb.minX - pad.left - pad.rx;
    const newCy = mb.minY - pad.top - pad.ry;
    const newW = (mb.maxX - mb.minX) + pad.left + pad.right;
    const newH = (mb.maxY - mb.minY) + pad.top + pad.bottom;
    setNodeTranslate(c.g, newCx, newCy);
    c.bg.setAttribute("width", newW);
    c.bg.setAttribute("height", newH);
    if (c.label && c.labelOffset) {
      setNodeTranslate(c.label, pad.rx + newW / 2 + c.labelOffset.dx, pad.ry + c.labelOffset.dy);
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
      target.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("g.node")) return;
        // Mouse: ignore non-primary buttons. Touch/pen: button is 0 only on
        // the primary contact, which is what we want.
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        if (!ev.isPrimary) return;
        if (isReadOnly) return; // spectator: no selection / drag
        ev.preventDefault();
        ev.stopPropagation();
        if (connectingState === "edge-target") { handleConnectClick(id); return; }
        if (connectingState) return;
        startClusterDrag(ev, svgEl, id);
      });
    }
  }

  function startClusterDrag(ev, svgEl, id) {
    const c = clusterMap[id];
    if (!c) return;
    const pointerId = ev.pointerId;
    const members = findSubgraphMembers(currentSource, id);
    const memberStates = [];
    for (const mid of members) {
      const n = nodeMap[mid];
      if (!n) continue;
      const t = getNodeTranslate(n.g);
      memberStates.push({ id: mid, n, originX: t.x, originY: t.y });
    }
    const clusterOrigin = getNodeTranslate(c.g);
    const start = screenToSvg(svgEl, ev.clientX, ev.clientY);
    let moved = false;

    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      const cur = screenToSvg(svgEl, e.clientX, e.clientY);
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      if (!moved && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) moved = true;
      setNodeTranslate(c.g, clusterOrigin.x + dx, clusterOrigin.y + dy);
      for (const m of memberStates) {
        setNodeTranslate(m.n.g, m.originX + dx, m.originY + dy);
        rerouteNodeEdges(m.id);
      }
      // Edges incident to the cluster itself (cluster↔cluster or cluster↔node)
      // aren't on any member's edge list — reroute them explicitly.
      if (c.incomingEdges) for (const e of c.incomingEdges) rerouteEdge(e);
      if (c.outgoingEdges) for (const e of c.outgoingEdges) rerouteEdge(e);
    }
    function onUp(e) {
      if (e && e.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (!moved) {
        toggleClusterSelection(id);
        return;
      }
      let changed = 0;
      for (const m of memberStates) {
        const t = getNodeTranslate(m.n.g);
        if (t.x !== m.originX || t.y !== m.originY) {
          positions[m.id] = { x: t.x, y: t.y };
          changed++;
        }
      }
      if (changed > 0) {
        markDirtyLayout();
        pushHistory();
        setStatus(`subgraph ${id}: spostati ${changed} nodi`, false);
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

  function startDrag(ev, svgEl, id) {
    if (connectingState) {
      ev.preventDefault();
      handleConnectClick(id);
      return;
    }
    if (isReadOnly) return; // spectator: no selection / drag
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (!ev.isPrimary) return;
    ev.preventDefault();
    const pointerId = ev.pointerId;
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (additive) {
      // Shift/Ctrl/Cmd+click: don't drag, just toggle selection on pointerup.
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
    n.g.classList.add("dragging");
    const start = screenToSvg(svgEl, ev.clientX, ev.clientY);
    const origin = getNodeTranslate(n.g);

    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      const cur = screenToSvg(svgEl, e.clientX, e.clientY);
      const nx = origin.x + (cur.x - start.x);
      const ny = origin.y + (cur.y - start.y);
      setNodeTranslate(n.g, nx, ny);
      rerouteNodeEdges(id);
      updateAllClusterBounds();
    }
    function onUp(e) {
      if (e && e.pointerId !== pointerId) return;
      n.g.classList.remove("dragging");
      const t = getNodeTranslate(n.g);
      if (t.x !== origin.x || t.y !== origin.y) {
        positions[id] = { x: t.x, y: t.y };
        markDirtyLayout();
        pushHistory();
        setStatus(`${id} → (${t.x.toFixed(0)}, ${t.y.toFixed(0)})`, false);
      } else {
        toggleNodeSelection(id, false);
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
      return { ok: false, error: `subgraph ${id}: header non trovato (forma 'subgraph "Title"' non supportata)` };
    }
    if (matchCount > 1) return { ok: false, error: `subgraph ${id}: header ambiguo (${matchCount} match)` };
    const newLine = newLabel === ""
      ? `${leading}${trailing}`
      : `${leading} [${newLabel}]${trailing}`;
    lines[matchIdx] = newLine;
    return { ok: true, source: lines.join("\n") };
  }

  // Line-based edge label rewrite. Handles:
  //   - existing label  → replace
  //   - missing label   → insert |newLabel|
  //   - newLabel === '' → remove existing label (leaving plain edge)
  // Disambiguates multiple <src>→<tgt> via ordinal (matches the same scan as
  // deleteEdgeFromSource). Refuses chain lines (A --> B --> C).
  function rewriteEdgeLabelInSource(source, src, tgt, ordinal, newLabel) {
    if (/[|\n]/.test(newLabel)) return { ok: false, error: "edge label: niente | o newline" };
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
      if (arrowSegs > 1) {
        return { ok: false, error: "edge in chain: dividi la linea per modificarne la label" };
      }
      const re = new RegExp(`(\\b${sEsc})(\\s+)([-=.~][-=.~<>xo]*)(\\s*)(?:\\|([^|\\n]*)\\|(\\s*))?(${tEsc}\\b)`);
      const m = lines[i].match(re);
      if (!m) return { ok: false, error: `edge ${src}→${tgt}: pattern interno non trovato` };
      const arrow = m[3];
      const rebuilt = newLabel === ""
        ? `${m[1]} ${arrow} ${m[7]}`
        : `${m[1]} ${arrow}|${newLabel}| ${m[7]}`;
      lines[i] = lines[i].replace(re, rebuilt);
      return { ok: true, source: lines.join("\n") };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} non trovata` };
  }

  // Toggle edge style between solid and dashed for a specific (src,tgt,ordinal)
  // edge, line-based. Supports common connector forms only; thick (==>) and
  // less common variants are refused with an explanatory error.
  function toggleEdgeStyleInSource(source, src, tgt, ordinal) {
    const sEsc = regexEscape(src), tEsc = regexEscape(tgt);
    const edgeRe = new RegExp(`\\b${sEsc}\\b\\s*[-=.~][-=.~<>xo]*\\s*\\b${tEsc}\\b`);
    const STYLE_TOGGLE = {
      "-->": "-.->",
      "-.->": "-->",
      "---": "-.-",
      "-.-": "---",
    };
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
      if (arrowSegs > 1) {
        return { ok: false, error: "edge in chain: dividi la linea per cambiare stile" };
      }
      const re = new RegExp(`(\\b${sEsc}\\s+)([-=.~][-=.~<>xo]*)(\\s*(?:\\|[^|\\n]*\\|\\s*)?${tEsc}\\b)`);
      const m = lines[i].match(re);
      if (!m) return { ok: false, error: `edge ${src}→${tgt}: pattern interno non trovato` };
      const newConn = STYLE_TOGGLE[m[2]];
      if (!newConn) return { ok: false, error: `connettore '${m[2]}': toggle non supportato (solo --> ↔ -.->, --- ↔ -.-)` };
      lines[i] = lines[i].replace(re, `${m[1]}${newConn}${m[3]}`);
      return { ok: true, source: lines.join("\n"), from: m[2], to: newConn };
    }
    return { ok: false, error: `edge ${src}→${tgt} #${ordinal} non trovata` };
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
    input.placeholder = "label (vuoto = rimuove)";
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
      if (!result.ok) { setStatus(`edit rifiutato: ${result.error}`, true); return; }
      currentSource = result.source;
      markDirtySource();
      await renderDiagram();
      pushHistory();
      const lbl = `${edge.source}→${edge.target}`;
      if (newText === "") setStatus(`${lbl}: label rimossa`);
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
    if (!selectedEdgeKey) { setStatus("seleziona prima un edge", true); return; }
    if (!requireValidSource("toggle edge style")) return;
    const edge = findEdgeByKey(selectedEdgeKey);
    if (!edge) return;
    const result = toggleEdgeStyleInSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`toggle stile: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(`${edge.source}→${edge.target}: ${result.from} → ${result.to}`);
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
      if (newText === oldText) return;
      if (kind !== "subgraph" && newText === "") return;
      if (!requireValidSource("edit label")) return;
      let result;
      let who;
      if (kind === "node") {
        result = rewriteNodeLabelInSource(currentSource, meta.nodeId, newText);
        who = meta.nodeId;
      } else if (kind === "subgraph") {
        result = rewriteSubgraphLabelInSource(currentSource, meta.subgraphId, newText);
        who = `subgraph ${meta.subgraphId}`;
      } else {
        // Edge editing goes through startEdgeLabelEdit; this branch shouldn't fire.
        return;
      }
      if (!result.ok) { setStatus(`edit rifiutato: ${result.error}`, true); return; }
      currentSource = result.source;
      markDirtySource();
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
        if (isReadOnly) return; // spectator: no label edit
        ev.stopPropagation(); ev.preventDefault();
        startLabelEdit(labelEl, "node", { nodeId: id });
      });
    }
    for (const [id, c] of Object.entries(clusterMap)) {
      const labelEl = findLabelTextElement(c.g);
      if (!labelEl) continue;
      labelEl.style.cursor = "text";
      labelEl.addEventListener("dblclick", (ev) => {
        if (isReadOnly) return; // spectator: no label edit
        ev.stopPropagation(); ev.preventDefault();
        startLabelEdit(labelEl, "subgraph", { subgraphId: id });
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

  const NOTE_RE = /^%%\s+([A-Za-z_][\w]*)\s+(.*)$/;
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
      if (m && m[1] === id) return m[2];
    }
    return null;
  }

  // Returns the source with the note for `id` set to `encoded` (a single-line
  // already-encoded payload), or removed if `encoded` is empty/null. Updates
  // the first matching line; appends at the end if none exists.
  function upsertNoteInSource(source, id, encoded) {
    const lines = source.split("\n");
    let foundIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(NOTE_RE);
      if (m && m[1] === id) { foundIdx = i; break; }
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
    lines[foundIdx] = `%% ${id} ${encoded}`;
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
    if (selectedNodeIds.size === 1 && !selectedClusterId && !selectedEdgeKey) {
      kind = "node"; id = [...selectedNodeIds][0];
    } else if (selectedClusterId && selectedNodeIds.size === 0 && !selectedEdgeKey) {
      kind = "subgraph"; id = selectedClusterId;
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

  // Walks the source block between `subgraph ID` and its matching `end`, and
  // returns the set of node IDs (keys of nodeMap) referenced inside — including
  // those contained in nested subgraphs, since dragging the outer cluster must
  // physically move every descendant for the auto-derived bbox to follow.
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
          return { ok: false, error: `subgraph ${id}: header ambiguo` };
        }
        headerIdx = i;
      }
    }
    if (headerIdx === -1) return { ok: false, error: `subgraph ${id}: non trovato` };
    let depth = 1, endIdx = -1;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (anySubgraphRe.test(lines[i])) depth++;
      else if (endRe.test(lines[i])) {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx === -1) return { ok: false, error: `subgraph ${id}: 'end' non trovato` };
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

  function addSubgraphToSource(source, id, title, memberIds) {
    if (!/^[A-Za-z_][\w]*$/.test(id)) return { ok: false, error: `ID non valido: '${id}'` };
    if (nodeMap[id] || clusterMap[id]) return { ok: false, error: `'${id}' esiste gia'` };
    if (title && /[\]\n]/.test(title)) return { ok: false, error: "titolo non puo' contenere ] o newline" };
    const head = title ? `subgraph ${id} [${title}]` : `subgraph ${id}`;
    const body = memberIds.map(m => `    ${m}`).join("\n");
    const block = `${head}\n${body}\nend`;
    if (source.length && !source.endsWith("\n")) source += "\n";
    return { ok: true, source: source + block + "\n" };
  }

  async function applyAddSubgraph() {
    if (!requireValidSource("+ subgraph")) return;
    if (selectedNodeIds.size < 2) {
      setStatus("seleziona almeno 2 nodi (Shift+click)", true);
      return;
    }
    const ids = [...selectedNodeIds];
    const owners = computeNodeSubgraphOwners(currentSource);
    const conflicts = ids.filter(id => owners[id]);
    if (conflicts.length) {
      setStatus(`gia' in altro subgraph: ${conflicts.join(", ")}`, true);
      return;
    }
    const idRaw = (prompt("ID del subgraph (lettere/numeri/_, unico):", "") || "").trim();
    if (!idRaw) { setStatus("creazione subgraph annullata"); return; }
    if (!/^[A-Za-z_][\w]*$/.test(idRaw)) { setStatus(`ID non valido: '${idRaw}'`, true); return; }
    if (nodeMap[idRaw] || clusterMap[idRaw]) { setStatus(`'${idRaw}' esiste gia'`, true); return; }
    const titleRaw = prompt("Titolo del subgraph (vuoto = usa ID):", "");
    if (titleRaw === null) { setStatus("creazione subgraph annullata"); return; }
    const title = titleRaw.trim();
    const result = addSubgraphToSource(currentSource, idRaw, title, ids);
    if (!result.ok) { setStatus(`+ subgraph: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    deselectNode();
    await renderDiagram();
    pushHistory();
    setStatus(`+ subgraph ${idRaw} con ${ids.length} nodi`);
  }

  async function handleDeleteSubgraphClick(id) {
    if (!confirm(`Eliminare il subgraph '${id}' (i contenuti restano)?`)) return;
    let result = deleteSubgraphFromSource(currentSource, id);
    if (!result.ok) { setStatus(`delete subgraph: ${result.error}`, true); return; }
    let next = result.source;
    // Also drop any `style ID ...` line tied to this subgraph id.
    const stripped = setNodeStyleInSource(next, id, null);
    if (stripped.ok) next = stripped.source;
    currentSource = next;
    markDirtySource();
    if (selectedClusterId === id) deselectCluster();
    await renderDiagram();
    pushHistory();
    setStatus(`− subgraph ${id}`);
  }

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
          if (isReadOnly) return; // spectator: no selection
          ev.stopPropagation(); ev.preventDefault();
          toggleEdgeSelection(edge);
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
    if (!confirm(`Eliminare la freccia ${label}?`)) return;
    const result = deleteEdgeFromSource(currentSource, edge.source, edge.target, edge.ordinal);
    if (!result.ok) { setStatus(`delete edge: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    deselectEdge();
    await renderDiagram();
    pushHistory();
    const warn = result.chainLine ? " (era in una chain: rimossa l'intera riga)" : "";
    setStatus(`− edge ${label}${warn}`);
  }

  // Batch-deletes the currently selected nodes (with confirm). Shared by the
  // Delete button and the Delete/Backspace keys.
  async function deleteSelectedNodes() {
    if (selectedNodeIds.size === 0) return;
    if (!requireValidSource("rimuovi nodo")) return;
    const ids = [...selectedNodeIds];
    const label = ids.length === 1 ? `il nodo '${ids[0]}'` : `${ids.length} nodi`;
    if (!confirm(`Eliminare ${label} e tutti i riferimenti?`)) return;
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
      setStatus(ids.length === 1 ? `− node ${ids[0]}` : `− ${ok}/${ids.length} nodi${errs.length ? " err: " + errs.join("; ") : ""}`,
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
    if (kind === "edge") {
      const edge = findEdgeByKey(selectedEdgeKey);
      if (edge) return handleDeleteEdgeClick(edge);
      return;
    }
    if (kind === "subgraph") return handleDeleteSubgraphClick(selectedClusterId);
  }

  async function handleConnectClick(id) {
    if (connectingState !== "edge-target") return;
    if (_ghostCleanup) { _ghostCleanup(); _ghostCleanup = null; }
    const src = connectSource, tgt = id;
    cancelConnectMode();
    if (src === tgt) { setStatus(`self-loop ${src}→${tgt} non supportato`, true); return; }
    const labelRaw = prompt(`Label della freccia ${src} → ${tgt} (vuoto = senza label):`, "");
    if (labelRaw === null) { setStatus("creazione edge annullata"); return; }
    const label = labelRaw.trim();
    const result = addEdgeToSource(currentSource, src, tgt, label);
    if (!result.ok) { setStatus(`add edge: ${result.error}`, true); return; }
    currentSource = result.source;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(`+ edge ${src} → ${tgt}${label ? ` |${label}|` : ""}`);
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
    if (selectedNodeIds.size === 1) src = [...selectedNodeIds][0];
    else if (selectedClusterId) src = selectedClusterId;
    else {
      setStatus("seleziona prima 1 nodo o 1 subgraph come sorgente", true);
      return;
    }
    connectingState = "edge-target";
    connectSource = src;
    document.body.classList.add("connecting");
    if (nodeMap[src]) nodeMap[src].g.classList.add("connect-source");
    else if (clusterMap[src]) clusterMap[src].g.classList.add("connect-source");
    addEdgeBtn.classList.add("active"); addEdgeBtn.textContent = "Cancel";
    const svgEl = diagramEl.querySelector("svg");
    _ghostCleanup = startGhostEdge(svgEl, src);
    setStatus(`source: ${src}. Ora clicca il target (Esc per annullare).`);
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
    addEdgeBtn.classList.remove("active"); addEdgeBtn.textContent = "+ Edge";
    updateToolbarState();
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
      pinchStart = {
        dist: dist > 1 ? dist : 1, rect,
        vw: viewState.width, vh: viewState.height,
        // Anchor: the view-space coord under the midpoint when pinch began;
        // we keep this point pinned under the fingers' midpoint as they move.
        anchorVX: viewState.x + mx * viewState.width / rect.width,
        anchorVY: viewState.y + my * viewState.height / rect.height,
      };
    }
    function startPanFromPointer(p) {
      mode = "pan";
      const rect = svgEl.getBoundingClientRect();
      panStart = { rect, x: p.clientX, y: p.clientY, vx: viewState.x, vy: viewState.y };
      svgEl.classList.add("panning");
    }

    function onPointerDown(e) {
      // Background-only: drags on nodes/edges/clusters/labels are handled
      // by their own pointerdown listeners.
      if (e.target.closest("g.node")) return;
      if (e.target.closest("g.cluster")) return;
      if (e.target.closest("g.edgePaths path")) return;
      if (e.target.closest("g.edgeLabels > g")) return;
      if (connectingState) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
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
        const dxView = (e.clientX - panStart.x) * viewState.width / rect.width;
        const dyView = (e.clientY - panStart.y) * viewState.height / rect.height;
        viewState.x = panStart.vx - dxView;
        viewState.y = panStart.vy - dyView;
        applyViewState(svgEl);
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
        viewState.x = pinchStart.anchorVX - mx * viewState.width / rect.width;
        viewState.y = pinchStart.anchorVY - my * viewState.height / rect.height;
        applyViewState(svgEl);
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

  function toggleNodeSelection(id, additive) {
    if (additive) {
      // Shift/Ctrl/Cmd+click: toggle membership without disturbing the rest.
      deselectCluster();
      deselectEdge();
      if (selectedNodeIds.has(id)) {
        selectedNodeIds.delete(id);
        if (nodeMap[id]) nodeMap[id].g.classList.remove("selected");
      } else {
        selectedNodeIds.add(id);
        if (nodeMap[id]) nodeMap[id].g.classList.add("selected");
      }
      updateToolbarState();
      const n = selectedNodeIds.size;
      setStatus(n === 0 ? "" : (n === 1 ? `selected: ${[...selectedNodeIds][0]}` : `selected: ${n} nodi`));
      return;
    }
    // Plain click: replace selection with [id]; clicking the only-selected node deselects.
    if (selectedNodeIds.size === 1 && selectedNodeIds.has(id)) { deselectNode(); return; }
    deselectCluster();
    deselectEdge();
    for (const sid of selectedNodeIds) {
      if (nodeMap[sid]) nodeMap[sid].g.classList.remove("selected");
    }
    selectedNodeIds.clear();
    selectedNodeIds.add(id);
    if (nodeMap[id]) nodeMap[id].g.classList.add("selected");
    updateToolbarState();
    setStatus(`selected: ${id}`);
  }
  function deselectNode() {
    for (const sid of selectedNodeIds) {
      if (nodeMap[sid]) nodeMap[sid].g.classList.remove("selected");
    }
    selectedNodeIds.clear();
    updateToolbarState();
  }

  // Selection bus: derive the current selection kind from state.
  // Returns one of: 'node' (1+ nodes), 'edge' (1 edge), 'subgraph' (1 subgraph), null.
  function selectionKind() {
    if (selectedNodeIds.size > 0) return "node";
    if (selectedEdgeKey) return "edge";
    if (selectedClusterId) return "subgraph";
    return null;
  }

  // Single source of truth for toolbar enable/disable. Called after every
  // selection change. Skips the "+Edge target step" because in that mode the
  // button is repurposed as Cancel and stays clickable.
  function updateToolbarState() {
    if (connectingState === "edge-target") return; // managed by startConnectMode
    const kind = selectionKind();
    const nNodes = selectedNodeIds.size;
    if (addEdgeBtn)      addEdgeBtn.disabled      = !((kind === "node" && nNodes === 1) || kind === "subgraph");
    if (addSubgraphBtn)  addSubgraphBtn.disabled  = !(kind === "node" && nNodes >= 2);
    if (deleteBtn)       deleteBtn.disabled       = (kind === null);
    if (toggleEdgeStyleBtn) toggleEdgeStyleBtn.disabled = (kind !== "edge");
    // Palette: Colore agisce su nodi e subgraph; Forma solo su nodi.
    const colorEnabled = (kind === "node") || (kind === "subgraph");
    const shapeEnabled = (kind === "node");
    if (colorPaletteEl) {
      for (const b of colorPaletteEl.querySelectorAll("button")) b.disabled = !colorEnabled;
    }
    if (shapePaletteEl) {
      for (const b of shapePaletteEl.querySelectorAll("button")) b.disabled = !shapeEnabled;
    }
    updateNotesPanel();
  }

  function toggleClusterSelection(id) {
    if (selectedClusterId === id) { deselectCluster(); return; }
    deselectNode();
    deselectEdge();
    if (selectedClusterId && clusterMap[selectedClusterId]) {
      clusterMap[selectedClusterId].g.classList.remove("selected");
    }
    selectedClusterId = id;
    clusterMap[id].g.classList.add("selected");
    updateToolbarState();
    setStatus(`selected subgraph: ${id}`);
  }
  function deselectCluster() {
    if (selectedClusterId && clusterMap[selectedClusterId]) {
      clusterMap[selectedClusterId].g.classList.remove("selected");
    }
    selectedClusterId = null;
    updateToolbarState();
  }

  function edgeKey(edge) { return `${edge.source}|${edge.target}|${edge.ordinal}`; }
  function findEdgeByKey(key) {
    for (const e of edges) if (edgeKey(e) === key) return e;
    return null;
  }
  function toggleEdgeSelection(edge) {
    const key = edgeKey(edge);
    if (selectedEdgeKey === key) { deselectEdge(); return; }
    deselectNode();
    deselectCluster();
    if (selectedEdgeKey) {
      const prev = findEdgeByKey(selectedEdgeKey);
      if (prev) prev.path.classList.remove("selected");
    }
    selectedEdgeKey = key;
    edge.path.classList.add("selected");
    const lbl = `${edge.source} → ${edge.target}` + (edge.ordinal > 0 ? ` (#${edge.ordinal + 1})` : "");
    setStatus(`selected edge: ${lbl}`);
    updateToolbarState();
  }
  function deselectEdge() {
    if (selectedEdgeKey) {
      const prev = findEdgeByKey(selectedEdgeKey);
      if (prev) prev.path.classList.remove("selected");
    }
    selectedEdgeKey = null;
    updateToolbarState();
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
    const ids = selectedNodeIds.size > 0 ? [...selectedNodeIds]
              : (selectedClusterId ? [selectedClusterId] : []);
    if (!ids.length) { setStatus("seleziona prima un nodo o un subgraph", true); return; }
    const styleStr = color.reset ? null
      : `fill:${color.fill},stroke:${color.stroke},color:${color.color}`;
    let next = currentSource, applied = 0;
    for (const id of ids) {
      const r = setNodeStyleInSource(next, id, styleStr);
      if (r.changed) { next = r.source; applied++; }
    }
    if (!applied) { setStatus(`colore gia' applicato (o reset senza style)`); return; }
    currentSource = next;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(ids.length === 1 ? `${ids[0]}: color ${color.name}`
                               : `color ${color.name} → ${applied}/${ids.length} elementi`);
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
    if (selectedNodeIds.size === 0) { setStatus("seleziona un nodo prima", true); return; }
    const ids = [...selectedNodeIds];
    let next = currentSource, applied = 0, errs = [];
    for (const id of ids) {
      const r = changeShapeInSource(next, id, shape);
      if (r.ok) { next = r.source; applied++; }
      else errs.push(`${id}: ${r.error}`);
    }
    if (!applied) { setStatus(`cambia forma: ${errs.join("; ")}`, true); return; }
    currentSource = next;
    markDirtySource();
    await renderDiagram();
    pushHistory();
    setStatus(ids.length === 1 ? `${ids[0]}: forma → ${shape.name}`
                               : `forma → ${shape.name} (${applied}/${ids.length})${errs.length ? " err: " + errs.join("; ") : ""}`,
              errs.length > 0);
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
        if (json.updated_at) lastUpdatedAt = json.updated_at;
        lastDraftFlushAt = null;
        clearDirty();
        setStatus(`salvato (rev ${currentRevisionId})`);
      } else if (status === 409 && json && json.error === "inactive_tab") {
        presencePing(true);
        showToast("Modifica spostata in un'altra tua scheda. Riprova.", "warn");
      } else if (status === 409 && json) {
        openConflictModal(json.current_revision_id);
      } else if (status === 423) {
        presencePing(false);
        showToast("Non hai più lo scettro — qualcun altro sta modificando.", "warn");
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
    selectedNodeIds.clear();
    selectedClusterId = null;
    selectedEdgeKey = null;
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

    // Top row: the live working copy (#working). Always shown so the user
    // can see that edits land here, not on the saved snapshots.
    if (data.current) {
      const cur = data.current;
      const basedOn = cur.source_revision_id ? `basato su #${cur.source_revision_id}` : "(mai salvato)";
      const row = document.createElement("div");
      row.className = "history-row is-head";
      row.innerHTML = `
        <span class="history-id">#working</span>
        <span class="history-meta">
          ${basedOn}
          ${cur.updated_at ? `• ultimo edit ${escapeHtml(cur.updated_at)}` : ""}
          • working copy live (autosalvata)
        </span>
        <button disabled>in modifica</button>
      `;
      list.appendChild(row);
    }

    const revs = (data.revisions || []).slice().reverse();
    if (revs.length === 0) {
      const note = document.createElement("p");
      note.className = "muted-small";
      note.textContent = "Nessuna snapshot — premi Salva per crearne una.";
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
      if (!confirm("Le modifiche dopo l'ultima snapshot non sono state salvate come snapshot. Caricando #" + revisionId + " il working copy verrà sostituito. Continuare?")) return;
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

  // ── Phase 3: presence + scepter + edit-request + share ────────────────────

  const HEARTBEAT_MS = 15000;     // server TTL 60s; refresh every 15s
  const REQUEST_POLL_MS = 4000;   // poll incoming/outgoing edit-requests every 4s

  // Last presence DTO returned by the server.
  let presenceState = { viewers: [], holder_id: null, my_active_tab_id: null, lock: lockState };
  let claimNextHeartbeat = false;

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
      my_active_tab_id: s.my_active_tab_id !== undefined ? s.my_active_tab_id : null,
      lock: s.lock || presenceState.lock,
    };
    lockState = presenceState.lock;
    const nowHolder = lockHeldByMe();
    const nowActive = iAmActiveTab();
    if (wasHolder && !nowHolder) {
      showToast("Hai perso lo scettro di modifica.", "warn");
    } else if (!wasHolder && nowHolder) {
      showToast("Hai lo scettro: puoi modificare.");
      myEditRequest = null;
    }
    if (nowHolder && wasActive && !nowActive) {
      showToast("Modifica trasferita a un'altra tua scheda.", "warn");
    }
    renderLockBanner();
    applyReadOnlyMode();
  }

  function applyReadOnlyMode() {
    const blocked = !canWrite
      || lockHeldByOther()
      || (permission === "view")
      || (lockHeldByMe() && !iAmActiveTab());
    const wasReadOnly = isReadOnly;
    isReadOnly = blocked;
    document.body.classList.toggle("readonly", blocked);
    if (sourceCM) sourceCM.setOption("readOnly", blocked ? "nocursor" : false);
    else if (sourceEditor) sourceEditor.readOnly = blocked;
    // Entering spectator mode: drop any existing selection so the highlight
    // doesn't linger ambiguously while the user can no longer act on it.
    if (blocked && !wasReadOnly) {
      deselectNode();
      deselectCluster();
      deselectEdge();
      updateToolbarState();
    }
  }

  function lockHolderLabel() {
    const hid = presenceState.holder_id;
    if (!hid) return "";
    if (hid === me.id) return "tu";
    const v = (presenceState.viewers || []).find(x => x.user_id === hid);
    return v ? (v.display_name || v.email || ("utente #" + hid)) : ("utente #" + hid);
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
      if (iAmActiveTab()) {
        lockBannerEl.classList.add("lock-mine");
        lockMessageEl.textContent = "Hai lo scettro: puoi modificare.";
      } else {
        lockBannerEl.classList.add("lock-readonly");
        lockMessageEl.textContent = "Aperto in un'altra tua scheda. Clicca qui per modificare in questa.";
        const switchBtn = document.createElement("button");
        switchBtn.className = "primary";
        switchBtn.textContent = "Modifica qui";
        switchBtn.addEventListener("click", () => claimActiveTab(true));
        lockActionsEl.appendChild(switchBtn);
      }
      return;
    }

    if (lockHeldByOther()) {
      lockBannerEl.classList.add("lock-other");
      lockMessageEl.textContent = "Sta modificando: " + lockHolderLabel() + " — sola lettura.";
      if (myEditRequest && myEditRequest.status === "pending") {
        const span = document.createElement("span");
        span.textContent = "Richiesta inviata, in attesa…";
        span.style.marginRight = "10px";
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Annulla richiesta";
        cancelBtn.addEventListener("click", cancelMyRequest);
        lockActionsEl.appendChild(span);
        lockActionsEl.appendChild(cancelBtn);
      } else {
        const reqBtn = document.createElement("button");
        reqBtn.className = "primary";
        reqBtn.textContent = "Chiedi lo scettro";
        reqBtn.addEventListener("click", requestEdit);
        lockActionsEl.appendChild(reqBtn);
      }
      return;
    }

    // No holder (transient: server will promote on next heartbeat).
    lockBannerEl.classList.add("lock-free");
    lockMessageEl.textContent = "Scettro non ancora assegnato…";
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
    const note = (prompt("Aggiungi una nota (opzionale) per chi sta modificando:") || "").trim();
    try {
      const { status, json } = await api("POST",
        `/api/diagrams/${encodeURIComponent(slug)}/edit-requests`, { note });
      if ((status === 200 || status === 201) && json && json.request) {
        myEditRequest = json.request;
        renderLockBanner();
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
      if (myEditRequest && myEditRequest.status === "rejected"
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
    acc.className = "primary"; acc.textContent = "Cedi scettro";
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
      showToast("Scettro ceduto.");
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
  addEdgeBtn.addEventListener("click", startConnectMode);
  if (toggleEdgeStyleBtn) {
    toggleEdgeStyleBtn.addEventListener("click", applyToggleEdgeStyle);
  }
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
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });
  }
  attachResizer(resizer, sourcePanel, "left");
  attachResizer(resizerRight, notesPanel, "right");

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
    btn.title = willCollapse ? "Espandi" : "Collassa";
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
      if (connectingState) { cancelConnectMode(); return; }
      if (selectedNodeIds.size > 0) { deselectNode(); setStatus(""); }
      if (selectedClusterId) { deselectCluster(); setStatus(""); }
      if (selectedEdgeKey) { deselectEdge(); setStatus(""); }
      return;
    }
    if (e.key === "0" || e.key === "Home") { e.preventDefault(); fitView(); return; }
    if ((e.key === "Delete" || e.key === "Backspace")) {
      if (selectionKind() !== null) { e.preventDefault(); applyDelete(); }
      return;
    }
    if (e.key === "+" || (e.key === "=" && e.shiftKey === false)) { e.preventDefault(); zoomStep(1.2); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomStep(1 / 1.2); return; }
  });

  diagramEl.addEventListener("click", (e) => {
    if (!e.target.closest("g.node") && selectedNodeIds.size > 0) {
      deselectNode();
      setStatus("");
    }
    if (!e.target.closest("g.cluster") && selectedClusterId) {
      deselectCluster();
      setStatus("");
    }
    if (!e.target.closest("path.flowchart-link, g.edgeLabel, g.edgeLabels") && selectedEdgeKey) {
      deselectEdge();
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
  updateToolbarState();

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

    // Join presence: the server may auto-promote us to scepter holder if it
    // is currently free. Heartbeat runs from every connected client (not only
    // the holder), so promotion stays current as people come and go.
    await presenceJoin();
    startHeartbeat();

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
