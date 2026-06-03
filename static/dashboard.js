/* Aquata dashboard interactions: new diagram modal + delete confirmation. */
(function () {
  "use strict";

  const _t = window.__i18n || {};
  function __(key, ...args) {
    let s = _t[key] !== undefined ? _t[key] : key;
    if (args.length) { let i = 0; s = s.replace(/%[sd]/g, () => args[i++] ?? ""); }
    return s;
  }

  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
  // Set on project pages; null on the dashboard. Used to file new/duplicated
  // diagrams under the current project and to preselect it in the move modal.
  const projectSlug = window.__projectSlug || null;

  // ── In-app dialogs (replace native confirm/alert which Firefox can block) ─
  let _confirmResolve = null;
  function confirmDialog(message, opts) {
    opts = opts || {};
    document.getElementById("confirmDialogTitle").textContent = opts.title || __("common.confirm");
    document.getElementById("confirmDialogMessage").textContent = message;
    const okBtn = document.getElementById("confirmDialogOkBtn");
    okBtn.textContent = opts.confirmLabel || __("common.confirm");
    document.getElementById("confirmDialogCancelBtn").textContent = opts.cancelLabel || __("common.cancel");
    okBtn.classList.toggle("danger", !!opts.danger);
    okBtn.classList.toggle("primary", !opts.danger);
    document.getElementById("confirmDialogModal").classList.remove("hidden");
    setTimeout(() => okBtn.focus(), 0);
    return new Promise(res => { _confirmResolve = res; });
  }
  function _confirmClose(result) {
    document.getElementById("confirmDialogModal").classList.add("hidden");
    const r = _confirmResolve; _confirmResolve = null;
    if (r) r(result);
  }

  let _infoResolve = null;
  function infoDialog(message, opts) {
    opts = opts || {};
    document.getElementById("infoDialogTitle").textContent = opts.title || __("common.alert");
    document.getElementById("infoDialogMessage").textContent = message;
    const okBtn = document.getElementById("infoDialogOkBtn");
    okBtn.classList.toggle("danger", !!opts.danger);
    okBtn.classList.toggle("primary", !opts.danger);
    document.getElementById("infoDialogModal").classList.remove("hidden");
    setTimeout(() => okBtn.focus(), 0);
    return new Promise(res => { _infoResolve = res; });
  }
  function _infoClose() {
    document.getElementById("infoDialogModal").classList.add("hidden");
    const r = _infoResolve; _infoResolve = null;
    if (r) r();
  }
  document.getElementById("confirmDialogOkBtn").addEventListener("click", () => _confirmClose(true));
  document.getElementById("confirmDialogCancelBtn").addEventListener("click", () => _confirmClose(false));
  document.getElementById("confirmDialogModal").querySelector(".modal-backdrop")
    .addEventListener("click", () => _confirmClose(false));
  document.getElementById("infoDialogOkBtn").addEventListener("click", _infoClose);
  document.getElementById("infoDialogModal").querySelector(".modal-backdrop")
    .addEventListener("click", _infoClose);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("confirmDialogModal").classList.contains("hidden")) _confirmClose(false);
    else if (!document.getElementById("infoDialogModal").classList.contains("hidden")) _infoClose();
  });

  async function api(method, path, body) {
    const isReadOnly = method === "GET" || method === "HEAD";
    const init = { method, headers: { "X-CSRF-Token": csrfToken } };
    if (!isReadOnly) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body || {});
    }
    const r = await fetch(path, init);
    let json = null;
    if (r.status !== 204) {
      try { json = await r.json(); } catch (_) {}
    }
    return { status: r.status, json };
  }

  // ── New diagram modal ────────────────────────────────────────────────────

  const modal = document.getElementById("newDiagramModal");
  const titleInput = document.getElementById("newDiagramTitle");
  const slugInput = document.getElementById("newDiagramSlug");
  const errorEl = document.getElementById("newDiagramError");

  function openModal() {
    titleInput.value = "";
    slugInput.value = "";
    errorEl.textContent = "";
    modal.classList.remove("hidden");
    setTimeout(() => titleInput.focus(), 0);
  }
  function closeModal() { modal.classList.add("hidden"); }

  async function submitModal() {
    const title = titleInput.value.trim();
    const slug = slugInput.value.trim();
    errorEl.textContent = "";
    if (!title) { errorEl.textContent = __("dashboard.title_required"); return; }

    const body = {
      title,
      source: "graph TD\n    A[Nodo iniziale]\n",
    };
    if (slug) body.slug = slug;
    if (projectSlug) body.project = projectSlug;

    try {
      const { status, json } = await api("POST", "/api/diagrams", body);
      if (status === 201 && json && json.slug) {
        location.href = `/editor/${encodeURIComponent(json.slug)}`;
        return;
      }
      errorEl.textContent = (json && json.error) || `HTTP ${status}`;
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  document.getElementById("newDiagramBtn").addEventListener("click", openModal);
  document.getElementById("newDiagramCancelBtn").addEventListener("click", closeModal);
  document.getElementById("newDiagramOkBtn").addEventListener("click", submitModal);
  modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
  for (const inp of [titleInput, slugInput]) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitModal(); }
      else if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    });
  }

  // ── Share modal (dashboard) ──────────────────────────────────────────────

  const shareModal = document.getElementById("dashShareModal");
  let currentShareSlug = null;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function openDashShareModal(slug, title) {
    currentShareSlug = slug;
    document.getElementById("dashShareTitle").textContent = title || slug;
    document.getElementById("dashShareError").textContent = "";
    document.getElementById("dashShareEmailInput").value = "";
    shareModal.classList.remove("hidden");
    await reloadShareList();
  }
  function closeDashShareModal() {
    shareModal.classList.add("hidden");
    currentShareSlug = null;
  }
  async function reloadShareList() {
    if (!currentShareSlug) return;
    const list = document.getElementById("dashShareList");
    list.innerHTML = `<p class='share-empty'>${escapeHtml(__("dashboard.loading"))}</p>`;
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(currentShareSlug)}/shares`);
      if (status !== 200 || !json) throw new Error("HTTP " + status);
      renderShareList(json.shares || []);
    } catch (e) {
      list.innerHTML = `<p class='share-empty'>${escapeHtml(__("common.error"))}: ${escapeHtml(e.message || "")}</p>`;
    }
  }
  function renderShareList(shares) {
    const list = document.getElementById("dashShareList");
    if (!shares.length) {
      list.innerHTML = `<p class='share-empty'>${escapeHtml(__("dashboard.no_shares"))}</p>`;
      return;
    }
    list.innerHTML = "";
    for (const s of shares) {
      const row = document.createElement("div");
      row.className = "share-row" + (s.disabled ? " disabled" : "");
      const who = s.user_name
        ? `${escapeHtml(s.user_name)} <small>${escapeHtml(s.user_email || "")}</small>`
        : escapeHtml(s.user_email || (__("dashboard.user_fallback") + s.user_id));
      row.innerHTML = `
        <span class="share-user">${who}</span>
        <span class="share-perm">${escapeHtml(s.permission)}</span>
      `;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = __("common.remove");
      removeBtn.addEventListener("click", async () => {
        if (!await confirmDialog(__("dashboard.remove_share_confirm"),
          { confirmLabel: __("common.remove"), danger: true })) return;
        try {
          await api("DELETE", `/api/diagrams/${encodeURIComponent(currentShareSlug)}/shares/${s.user_id}`);
          await reloadShareList();
        } catch (_) { /* ignore */ }
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    }
  }
  async function submitShareAdd(e) {
    e.preventDefault();
    if (!currentShareSlug) return;
    const email = document.getElementById("dashShareEmailInput").value.trim();
    const perm  = document.getElementById("dashSharePermInput").value;
    const errEl = document.getElementById("dashShareError");
    errEl.textContent = "";
    if (!email) { errEl.textContent = __("dashboard.email_required"); return; }
    try {
      const { status, json } = await api("POST",
        `/api/diagrams/${encodeURIComponent(currentShareSlug)}/shares`,
        { email, permission: perm });
      if (status === 201) {
        document.getElementById("dashShareEmailInput").value = "";
        await reloadShareList();
      } else {
        errEl.textContent = (json && json.error) ? json.error : ("HTTP " + status);
      }
    } catch (ex) {
      errEl.textContent = ex.message || String(ex);
    }
  }

  if (shareModal) {
    document.getElementById("dashShareCloseBtn").addEventListener("click", closeDashShareModal);
    shareModal.querySelector(".modal-backdrop").addEventListener("click", closeDashShareModal);
    document.getElementById("dashShareAddForm").addEventListener("submit", submitShareAdd);
    for (const btn of document.querySelectorAll(".diagram-share")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openDashShareModal(btn.dataset.slug, btn.dataset.title);
      });
    }
  }

  // ── Share project modal (cascades to all diagrams in the project) ─────────

  const projShareModal = document.getElementById("projShareModal");
  if (projShareModal) {
    let currentProjShareSlug = null;
    const pErr = () => document.getElementById("projShareError");

    const openProjShareModal = async (slug, title) => {
      currentProjShareSlug = slug;
      document.getElementById("projShareTitle").textContent = title || slug;
      pErr().textContent = "";
      document.getElementById("projShareEmailInput").value = "";
      projShareModal.classList.remove("hidden");
      await reloadProjShareList();
    };
    const closeProjShareModal = () => {
      projShareModal.classList.add("hidden");
      currentProjShareSlug = null;
    };
    async function reloadProjShareList() {
      if (!currentProjShareSlug) return;
      const list = document.getElementById("projShareList");
      list.innerHTML = `<p class='share-empty'>${escapeHtml(__("dashboard.loading"))}</p>`;
      try {
        const { status, json } = await api("GET", `/api/projects/${encodeURIComponent(currentProjShareSlug)}/shares`);
        if (status !== 200 || !json) throw new Error("HTTP " + status);
        renderProjShareList(json.shares || []);
      } catch (e) {
        list.innerHTML = `<p class='share-empty'>${escapeHtml(__("common.error"))}: ${escapeHtml(e.message || "")}</p>`;
      }
    }
    function renderProjShareList(shares) {
      const list = document.getElementById("projShareList");
      if (!shares.length) {
        list.innerHTML = `<p class='share-empty'>${escapeHtml(__("dashboard.no_shares"))}</p>`;
        return;
      }
      list.innerHTML = "";
      for (const s of shares) {
        const row = document.createElement("div");
        row.className = "share-row" + (s.disabled ? " disabled" : "");
        const who = s.user_name
          ? `${escapeHtml(s.user_name)} <small>${escapeHtml(s.user_email || "")}</small>`
          : escapeHtml(s.user_email || (__("dashboard.user_fallback") + s.user_id));
        row.innerHTML = `
          <span class="share-user">${who}</span>
          <span class="share-perm">${escapeHtml(s.permission)}</span>
        `;
        const removeBtn = document.createElement("button");
        removeBtn.textContent = __("common.remove");
        removeBtn.addEventListener("click", async () => {
          if (!await confirmDialog(__("dashboard.remove_project_share_confirm"),
            { confirmLabel: __("common.remove"), danger: true })) return;
          try {
            await api("DELETE", `/api/projects/${encodeURIComponent(currentProjShareSlug)}/shares/${s.user_id}`);
            await reloadProjShareList();
          } catch (_) { /* ignore */ }
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      }
    }
    async function submitProjShareAdd(e) {
      e.preventDefault();
      if (!currentProjShareSlug) return;
      const email = document.getElementById("projShareEmailInput").value.trim();
      const perm  = document.getElementById("projSharePermInput").value;
      pErr().textContent = "";
      if (!email) { pErr().textContent = __("dashboard.email_required"); return; }
      try {
        const { status, json } = await api("POST",
          `/api/projects/${encodeURIComponent(currentProjShareSlug)}/shares`,
          { email, permission: perm });
        if (status === 201) {
          document.getElementById("projShareEmailInput").value = "";
          await reloadProjShareList();
        } else {
          pErr().textContent = (json && json.error) ? json.error : ("HTTP " + status);
        }
      } catch (ex) {
        pErr().textContent = ex.message || String(ex);
      }
    }

    document.getElementById("projShareCloseBtn").addEventListener("click", closeProjShareModal);
    projShareModal.querySelector(".modal-backdrop").addEventListener("click", closeProjShareModal);
    document.getElementById("projShareAddForm").addEventListener("submit", submitProjShareAdd);
    for (const btn of document.querySelectorAll(".project-share, #shareProjectHeaderBtn")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openProjShareModal(btn.dataset.slug, btn.dataset.title);
      });
    }
  }

  // ── Rename modal ─────────────────────────────────────────────────────────

  const renameModal = document.getElementById("renameDiagramModal");
  const renameInput = document.getElementById("renameDiagramTitle");
  const renameError = document.getElementById("renameDiagramError");
  let renameCurrentSlug = null;

  function openRenameModal(slug, title) {
    renameCurrentSlug = slug;
    renameInput.value = title || "";
    renameError.textContent = "";
    renameModal.classList.remove("hidden");
    setTimeout(() => { renameInput.focus(); renameInput.select(); }, 0);
  }
  function closeRenameModal() {
    renameModal.classList.add("hidden");
    renameCurrentSlug = null;
  }
  async function submitRename() {
    if (!renameCurrentSlug) return;
    const newTitle = renameInput.value.trim();
    renameError.textContent = "";
    if (!newTitle) { renameError.textContent = __("dashboard.title_required"); return; }
    try {
      const { status, json } = await api("PATCH",
        `/api/diagrams/${encodeURIComponent(renameCurrentSlug)}`,
        { title: newTitle });
      if (status === 200) {
        // Aggiorna in-place le card che puntano a questo slug
        for (const btn of document.querySelectorAll(`[data-slug="${CSS.escape(renameCurrentSlug)}"]`)) {
          btn.dataset.title = newTitle;
        }
        const card = document.querySelector(`.diagram-share[data-slug="${CSS.escape(renameCurrentSlug)}"]`)?.closest(".diagram-card");
        if (card) {
          const h = card.querySelector("h3");
          if (h) h.textContent = newTitle;
        }
        closeRenameModal();
      } else {
        renameError.textContent = (json && json.error) || ("HTTP " + status);
      }
    } catch (e) {
      renameError.textContent = e.message || String(e);
    }
  }

  if (renameModal) {
    document.getElementById("renameDiagramCancelBtn").addEventListener("click", closeRenameModal);
    document.getElementById("renameDiagramOkBtn").addEventListener("click", submitRename);
    renameModal.querySelector(".modal-backdrop").addEventListener("click", closeRenameModal);
    renameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitRename(); }
      else if (e.key === "Escape") { e.preventDefault(); closeRenameModal(); }
    });
    for (const btn of document.querySelectorAll(".diagram-rename")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openRenameModal(btn.dataset.slug, btn.dataset.title);
      });
    }
  }

  // ── New project modal ────────────────────────────────────────────────────

  const projectModal = document.getElementById("newProjectModal");
  if (projectModal) {
    const pTitle = document.getElementById("newProjectTitle");
    const pSlug = document.getElementById("newProjectSlug");
    const pError = document.getElementById("newProjectError");

    const openProjectModal = () => {
      pTitle.value = ""; pSlug.value = ""; pError.textContent = "";
      projectModal.classList.remove("hidden");
      setTimeout(() => pTitle.focus(), 0);
    };
    const closeProjectModal = () => projectModal.classList.add("hidden");

    const submitProjectModal = async () => {
      const title = pTitle.value.trim();
      const slug = pSlug.value.trim();
      pError.textContent = "";
      if (!title) { pError.textContent = __("dashboard.title_required"); return; }
      const body = { title };
      if (slug) body.slug = slug;
      try {
        const { status, json } = await api("POST", "/api/projects", body);
        if (status === 201 && json && json.slug) {
          location.href = `/project/${encodeURIComponent(json.slug)}`;
          return;
        }
        pError.textContent = (json && json.error) || `HTTP ${status}`;
      } catch (e) { pError.textContent = e.message; }
    };

    const newProjectBtn = document.getElementById("newProjectBtn");
    if (newProjectBtn) newProjectBtn.addEventListener("click", openProjectModal);
    document.getElementById("newProjectCancelBtn").addEventListener("click", closeProjectModal);
    document.getElementById("newProjectOkBtn").addEventListener("click", submitProjectModal);
    projectModal.querySelector(".modal-backdrop").addEventListener("click", closeProjectModal);
    for (const inp of [pTitle, pSlug]) {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submitProjectModal(); }
        else if (e.key === "Escape") { e.preventDefault(); closeProjectModal(); }
      });
    }
  }

  // ── Rename project modal ─────────────────────────────────────────────────

  const renameProjectModal = document.getElementById("renameProjectModal");
  if (renameProjectModal) {
    const rpInput = document.getElementById("renameProjectTitle");
    const rpError = document.getElementById("renameProjectError");
    let rpSlug = null;

    const openRenameProject = (slug, title) => {
      rpSlug = slug;
      rpInput.value = title || "";
      rpError.textContent = "";
      renameProjectModal.classList.remove("hidden");
      setTimeout(() => { rpInput.focus(); rpInput.select(); }, 0);
    };
    const closeRenameProject = () => { renameProjectModal.classList.add("hidden"); rpSlug = null; };

    const submitRenameProject = async () => {
      if (!rpSlug) return;
      const newTitle = rpInput.value.trim();
      rpError.textContent = "";
      if (!newTitle) { rpError.textContent = __("dashboard.title_required"); return; }
      try {
        const { status, json } = await api("PATCH",
          `/api/projects/${encodeURIComponent(rpSlug)}`, { title: newTitle });
        if (status === 200) { location.reload(); }
        else { rpError.textContent = (json && json.error) || `HTTP ${status}`; }
      } catch (e) { rpError.textContent = e.message || String(e); }
    };

    document.getElementById("renameProjectCancelBtn").addEventListener("click", closeRenameProject);
    document.getElementById("renameProjectOkBtn").addEventListener("click", submitRenameProject);
    renameProjectModal.querySelector(".modal-backdrop").addEventListener("click", closeRenameProject);
    rpInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitRenameProject(); }
      else if (e.key === "Escape") { e.preventDefault(); closeRenameProject(); }
    });
    for (const btn of document.querySelectorAll(".project-rename, #renameProjectHeaderBtn")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openRenameProject(btn.dataset.slug, btn.dataset.title);
      });
    }
  }

  // ── Delete project buttons ───────────────────────────────────────────────

  for (const btn of document.querySelectorAll(".project-delete")) {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const slug = btn.dataset.slug;
      const title = btn.dataset.title || slug;
      if (!await confirmDialog(
        __("dashboard.delete_project_confirm", title),
        { confirmLabel: __("common.delete"), danger: true })) return;
      try {
        const { status } = await api("DELETE", `/api/projects/${encodeURIComponent(slug)}`);
        if (status === 204) { location.reload(); }
        else { await infoDialog(__("dashboard.delete_failed", "HTTP " + status), { title: __("common.error"), danger: true }); }
      } catch (err) {
        await infoDialog(__("dashboard.delete_failed", err.message), { title: __("common.error"), danger: true });
      }
    });
  }

  // ── Move diagram modal ───────────────────────────────────────────────────

  const moveModal = document.getElementById("moveDiagramModal");
  if (moveModal) {
    const moveSelect = document.getElementById("moveProjectSelect");
    const moveError = document.getElementById("moveDiagramError");
    let moveSlug = null;

    const openMoveModal = async (slug, title) => {
      moveSlug = slug;
      document.getElementById("moveDiagramTitle").textContent = title || slug;
      moveError.textContent = "";
      moveSelect.innerHTML = `<option value="">${escapeHtml(__("dashboard.move.unfiled"))}</option>`;
      moveModal.classList.remove("hidden");
      try {
        const { status, json } = await api("GET", "/api/projects");
        if (status === 200 && Array.isArray(json)) {
          for (const p of json) {
            const opt = document.createElement("option");
            opt.value = p.slug;
            opt.textContent = p.title || p.slug;
            if (projectSlug && p.slug === projectSlug) opt.selected = true;
            moveSelect.appendChild(opt);
          }
        }
      } catch (_) { /* leave just the unfiled option */ }
    };
    const closeMoveModal = () => { moveModal.classList.add("hidden"); moveSlug = null; };

    const submitMove = async () => {
      if (!moveSlug) return;
      moveError.textContent = "";
      const target = moveSelect.value; // "" → unfiled
      try {
        const { status, json } = await api("POST",
          `/api/diagrams/${encodeURIComponent(moveSlug)}/move`,
          { project: target || null });
        if (status === 200) { location.reload(); }
        else { moveError.textContent = (json && json.error) || `HTTP ${status}`; }
      } catch (e) { moveError.textContent = e.message || String(e); }
    };

    document.getElementById("moveDiagramCancelBtn").addEventListener("click", closeMoveModal);
    document.getElementById("moveDiagramOkBtn").addEventListener("click", submitMove);
    moveModal.querySelector(".modal-backdrop").addEventListener("click", closeMoveModal);
    for (const btn of document.querySelectorAll(".diagram-move")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openMoveModal(btn.dataset.slug, btn.dataset.title);
      });
    }
  }

  // ── Duplicate diagram buttons ────────────────────────────────────────────

  for (const btn of document.querySelectorAll(".diagram-duplicate")) {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const slug = btn.dataset.slug;
      const title = btn.dataset.title || slug;
      if (!await confirmDialog(
        __("dashboard.duplicate_confirm", title),
        { confirmLabel: __("dashboard.duplicate") })) return;
      const body = {};
      if (projectSlug) body.project = projectSlug; // keep the copy in this project
      try {
        const { status, json } = await api("POST",
          `/api/diagrams/${encodeURIComponent(slug)}/duplicate`, body);
        if (status === 201) { location.reload(); }
        else { await infoDialog((json && json.error) || ("HTTP " + status), { title: __("common.error"), danger: true }); }
      } catch (err) {
        await infoDialog(err.message || String(err), { title: __("common.error"), danger: true });
      }
    });
  }

  // ── Delete buttons ───────────────────────────────────────────────────────

  for (const btn of document.querySelectorAll(".diagram-delete")) {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const slug = btn.dataset.slug;
      const title = btn.dataset.title || slug;
      if (!await confirmDialog(
        __("dashboard.delete_confirm", title),
        { confirmLabel: __("common.delete"), danger: true })) return;
      try {
        const { status } = await api("DELETE", `/api/diagrams/${encodeURIComponent(slug)}`);
        if (status === 204) {
          // Rimuovi la card dal DOM
          const card = btn.closest(".diagram-card");
          if (card) card.remove();
          // Se era l'ultima, mostra empty state
          if (document.querySelectorAll(".diagram-card").length === 0) {
            location.reload();
          }
        } else {
          await infoDialog(__("dashboard.delete_failed", "HTTP " + status), { title: __("common.error"), danger: true });
        }
      } catch (err) {
        await infoDialog(__("dashboard.delete_failed", err.message), { title: __("common.error"), danger: true });
      }
    });
  }
})();
