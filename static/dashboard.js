/* Aquata dashboard interactions: new diagram modal + delete confirmation. */
(function () {
  "use strict";

  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

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
    if (!title) { errorEl.textContent = "Titolo obbligatorio"; return; }

    const body = {
      title,
      source: "graph TD\n    A[Nodo iniziale]\n",
    };
    if (slug) body.slug = slug;

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
    list.innerHTML = "<p class='share-empty'>Caricando…</p>";
    try {
      const { status, json } = await api("GET", `/api/diagrams/${encodeURIComponent(currentShareSlug)}/shares`);
      if (status !== 200 || !json) throw new Error("HTTP " + status);
      renderShareList(json.shares || []);
    } catch (e) {
      list.innerHTML = `<p class='share-empty'>Errore: ${escapeHtml(e.message || "")}</p>`;
    }
  }
  function renderShareList(shares) {
    const list = document.getElementById("dashShareList");
    if (!shares.length) {
      list.innerHTML = "<p class='share-empty'>Nessuna condivisione.</p>";
      return;
    }
    list.innerHTML = "";
    for (const s of shares) {
      const row = document.createElement("div");
      row.className = "share-row" + (s.disabled ? " disabled" : "");
      const who = s.user_name
        ? `${escapeHtml(s.user_name)} <small>${escapeHtml(s.user_email || "")}</small>`
        : escapeHtml(s.user_email || ("utente #" + s.user_id));
      row.innerHTML = `
        <span class="share-user">${who}</span>
        <span class="share-perm">${escapeHtml(s.permission)}</span>
      `;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Rimuovi";
      removeBtn.addEventListener("click", async () => {
        if (!confirm("Rimuovere la condivisione con questo utente?")) return;
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
    if (!email) { errEl.textContent = "Email obbligatoria"; return; }
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

  // ── Delete buttons ───────────────────────────────────────────────────────

  for (const btn of document.querySelectorAll(".diagram-delete")) {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const slug = btn.dataset.slug;
      const title = btn.dataset.title || slug;
      if (!confirm(`Eliminare il diagramma "${title}"?\n(Verrà spostato nel cestino, recuperabile da admin.)`)) return;
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
          alert(`Eliminazione fallita: HTTP ${status}`);
        }
      } catch (err) {
        alert(`Eliminazione fallita: ${err.message}`);
      }
    });
  }
})();
