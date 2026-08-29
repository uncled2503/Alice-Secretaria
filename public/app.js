const state = { activeConversationId: null, pollHandle: null, clinicId: null };

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  });
  children.forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
}

// Popup de erro no meio da tela, some sozinho depois de um tempo - sem isso,
// uma chamada que falha so aparece no console (que ninguem olha) e o resto
// da tela fica silenciosamente vazio.
function showError(message) {
  console.error(message);
  let container = document.getElementById("error-toast-container");
  if (!container) {
    container = el("div", { id: "error-toast-container" }, []);
    document.body.appendChild(container);
  }

  const toast = el("div", { class: "error-toast" }, [message]);
  container.appendChild(toast);

  setTimeout(() => toast.classList.add("error-toast-hide"), 4000);
  toast.addEventListener("transitionend", () => toast.remove());
  setTimeout(() => toast.remove(), 5000); // rede de seguranca se o transitionend nao disparar
}

// Modal de confirmacao no meio da tela, no lugar do dialogo nativo feio do
// navegador. Retorna uma Promise<boolean> - so pode ser usado dentro de
// uma funcao async, com "if (!(await showConfirm(msg))) return;".
function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-overlay");
    const okBtn = document.getElementById("confirm-ok-btn");
    const cancelBtn = document.getElementById("confirm-cancel-btn");
    document.getElementById("confirm-message").textContent = message;

    const cleanup = (result) => {
      overlay.style.display = "none";
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlayClick);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => {
      if (e.target === overlay) cleanup(false);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlayClick);
    overlay.style.display = "flex";
  });
}

// Captura QUALQUER erro de JS (nao so falha de fetch) e mostra no banner.
// Sem isso, um bug num pedaco do script trava tudo que vem depois em silencio
// (nenhum listener registrado apos o ponto do erro chega a existir) e a unica
// pista fica escondida no console do DevTools, que ninguem abre.
window.addEventListener("error", (e) => {
  showError(`Erro de JS: ${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  showError(`Promise rejeitada sem tratamento: ${e.reason?.message ?? e.reason}`);
});

// Injeta o clinicId automaticamente (query string no GET, campo no body do
// POST/PUT) pra nao precisar repetir isso em toda chamada individual.
async function api(path, options = {}) {
  const opts = { ...options };
  const method = (opts.method || "GET").toUpperCase();
  let finalPath = path;

  if (state.clinicId) {
    if (method === "GET") {
      finalPath += (path.includes("?") ? "&" : "?") + `clinicId=${encodeURIComponent(state.clinicId)}`;
    } else if (typeof opts.body === "string") {
      try {
        const parsed = JSON.parse(opts.body);
        parsed.clinicId = state.clinicId;
        opts.body = JSON.stringify(parsed);
      } catch {
        // body nao e JSON (raro nas nossas chamadas) - segue sem injetar
      }
    }
  }

  let res;
  try {
    res = await fetch(`/api${finalPath}`, opts);
  } catch (err) {
    showError(`Falha de rede chamando ${path}: ${err.message}`);
    throw err;
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.clone().json())?.error ?? "";
    } catch {
      // resposta nao e JSON, ignora
    }
    if (res.status === 401 || res.status === 403) {
      showAuthGate(detail || null);
    } else if (!options.silentStatuses?.includes(res.status)) {
      showError(`API ${path} -> HTTP ${res.status}${detail ? " (" + detail + ")" : ""}`);
    }
    const err = new Error(`API ${path} -> ${res.status}`);
    err.status = res.status;
    err.detail = detail || "";
    throw err;
  }
  return res.json();
}

// --- Icones (inline SVG, sem biblioteca externa) ---
const ICONS = {
  home: '<path d="M3 11l9-8 9 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10v10h5v-6h4v6h5V10" stroke-linecap="round" stroke-linejoin="round"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" stroke-linecap="round"/><circle cx="17" cy="8.5" r="2.4"/><path d="M15.5 14.2c2.4.4 4 2.3 4.5 5.3" stroke-linecap="round"/>',
  grid: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  chat: '<path d="M4 5h16v11H9l-4 4V5z" stroke-linejoin="round"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18" /><path d="M8 3v4M16 3v4" stroke-linecap="round"/>',
  send: '<path d="M4 11l16-7-6.5 16-3-6.5L4 11z" stroke-linejoin="round"/>',
  repeat: '<path d="M4 7h11a4 4 0 0 1 4 4v1" stroke-linecap="round"/><path d="M9 4L4 7l5 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 17H9a4 4 0 0 1-4-4v-1" stroke-linecap="round"/><path d="M15 20l5-3-5-3" stroke-linecap="round" stroke-linejoin="round"/>',
  box: '<path d="M3 8l9-5 9 5-9 5-9-5z" stroke-linejoin="round"/><path d="M3 8v8l9 5 9-5V8" stroke-linejoin="round"/><path d="M12 13v8" />',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" stroke-linejoin="round"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" stroke-linejoin="round"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 8h1M8 12h1M8 16h1M12 8h1M12 12h1M12 16h1M16 8h1M16 12h1M16 16h1" stroke-linecap="round"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8" stroke-linecap="round"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" stroke-linejoin="round"/>',
  check: '<path d="M4 12l6 6L20 6" stroke-linecap="round" stroke-linejoin="round"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-1c0-1 .6-1.5 1.3-2 .7-.5 1.2-1 1.2-2a2.5 2.5 0 0 0-5 0" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-linecap="round" stroke-linejoin="round"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7" stroke-linecap="round"/>',
  swap: '<path d="M7 4v13M7 17l-3-3M7 17l3-3" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 20V7M17 7l-3 3M17 7l3 3" stroke-linecap="round" stroke-linejoin="round"/>',
  pencil: '<path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z" stroke-linejoin="round"/><path d="M13 7l4 4" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke-linecap="round"/>',
};

function renderIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICONS[name] || ""}</svg>`;
}

function paintIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((elm) => {
    elm.innerHTML = renderIcon(elm.dataset.icon);
  });
}

paintIcons();

// --- Tema (claro/escuro) ---
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  btn.innerHTML = `<span class="nav-icon" data-icon="${theme === "dark" ? "moon" : "sun"}"></span> Tema`;
  paintIcons(btn);
}

(function initTheme() {
  let saved = "light";
  try {
    saved = localStorage.getItem("alice_theme") || "light";
  } catch {
    // ignora se localStorage indisponivel
  }
  applyTheme(saved);
})();

document.getElementById("theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("alice_theme", next);
  } catch {
    // ignora
  }
});

// --- Login (controle de acesso de verdade - role="admin" opera qualquer
// clinica, role="client" fica travado na propria, ver getClinic no backend).
// O painel inteiro fica escondido atras da tela de login ate autenticar. ---
function showAuthGate(message) {
  document.getElementById("auth-gate").style.display = "flex";
  document.getElementById("app-root").style.display = "none";
  const errorEl = document.getElementById("auth-gate-error");
  if (message) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
  }
}

function hideAuthGate() {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("app-root").style.display = "";
}

function applyRoleUI() {
  const isAdmin = state.staff?.role === "admin";
  const clinicsTab = document.querySelector('#settings-tabs button[data-sub="clinics"]');
  if (clinicsTab) clinicsTab.style.display = isAdmin ? "" : "none";

  const label = document.getElementById("staff-session-label");
  if (label && state.staff) label.textContent = state.staff.name;
}

async function bootApp() {
  applyRoleUI();
  try {
    await loadClinics();
  } catch (err) {
    console.error("Falha ao carregar clinicas:", err);
  }
  await refreshAll();
  if (!state.pollHandle) state.pollHandle = setInterval(refreshAll, 5000);
}

async function checkAuthAndBoot() {
  const me = await api("/staff/me").catch(() => null);
  if (!me) {
    showAuthGate();
    return;
  }
  state.staff = me;
  hideAuthGate();
  await bootApp();
}

document.getElementById("btn-staff-session").addEventListener("click", async () => {
  if (!state.staff) return;
  if (!await showConfirm(`Sair da conta de ${state.staff.name}?`)) return;
  await api("/staff/logout", { method: "POST" });
  // Recarrega a pagina inteira - garante que nenhum dado da conta anterior
  // (conversa aberta, clinica selecionada, etc.) sobrevive pra proxima conta
  // que logar nesse mesmo navegador.
  location.reload();
});

document.getElementById("auth-gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("auth-gate-username").value.trim();
  const password = document.getElementById("auth-gate-password").value;
  const errorEl = document.getElementById("auth-gate-error");
  errorEl.style.display = "none";

  const res = await fetch("/api/staff/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    errorEl.textContent = body.error || "Não foi possível entrar.";
    errorEl.style.display = "block";
    return;
  }
  document.getElementById("auth-gate-form").reset();
  // Recarrega a pagina inteira em vez de so chamar checkAuthAndBoot - assim
  // nenhum estado de uma conta logada antes nesse navegador (conversa aberta,
  // clinica selecionada) sobrevive pra sessao nova.
  location.reload();
});

// --- Navegacao (sidebar) ---
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "settings") {
      const activeSub = document.querySelector("#settings-tabs button.active");
      openSettingsSub(activeSub ? activeSub.dataset.sub : "clinic-data");
    } else {
      stopChannelPolling();
    }
  });
});

// --- Contatos ---
async function loadContacts() {
  const contacts = await api("/contacts");
  state.contacts = contacts;
  document.getElementById("contacts-count").textContent = `${contacts.length} contato(s)`;
  renderContactsTable(contacts);
}

function renderContactsTable(contacts) {
  const body = document.getElementById("contacts-body");
  body.innerHTML = "";
  for (const c of contacts) {
    const deleteBtn = el("button", { type: "button", class: "btn-icon-danger", title: "Excluir contato" }, [
      el("span", { class: "nav-icon", "data-icon": "trash" }, []),
    ]);
    deleteBtn.addEventListener("click", () => deleteContact(c));

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [
          el("div", { class: "contact-name-cell" }, [
            el("div", { class: "crm-avatar" }, [initials(c.name)]),
            el("span", {}, [c.name ?? "(sem nome)"]),
          ]),
        ]),
        el("td", {}, [c.phone]),
        el("td", {}, [el("span", { class: "badge badge-neutral" }, ["WhatsApp"])]),
        el("td", {}, [new Date(c.createdAt).toLocaleDateString("pt-BR")]),
        el("td", {}, [deleteBtn]),
      ])
    );
  }
  paintIcons(body);
}

async function deleteContact(contact) {
  const label = contact.name ? `${contact.name} (${contact.phone})` : contact.phone;
  if (!await showConfirm(`Excluir o contato ${label}? Isso apaga o histórico de conversas e agendamentos dele. Não pode ser desfeito.`)) return;
  await api(`/contacts/${contact.id}`, { method: "DELETE" });
  await loadContacts();
}

document.getElementById("contacts-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = (state.contacts || []).filter(
    (c) => (c.name ?? "").toLowerCase().includes(q) || c.phone.includes(q)
  );
  renderContactsTable(filtered);
});

document.getElementById("btn-toggle-contact-form").addEventListener("click", () => {
  const form = document.getElementById("contact-form");
  form.style.display = form.style.display === "none" ? "flex" : "none";
});

document.getElementById("contact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("ct-name").value.trim();
  const phone = document.getElementById("ct-phone").value.trim();
  if (!phone) return;

  await api("/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, phone }),
  });

  e.target.reset();
  document.getElementById("contact-form").style.display = "none";
  await loadContacts();
});

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// Avatar com a foto de perfil do WhatsApp quando disponivel; cai pras iniciais
// (mesmo comportamento de antes) se nao tiver foto ou se a URL falhar ao carregar.
function avatarNode(name, url, className) {
  const wrap = el("div", { class: className }, url ? [] : [initials(name)]);
  if (url) {
    const img = el("img", { class: "avatar-img", src: url, alt: "" });
    img.addEventListener("error", () => {
      wrap.innerHTML = "";
      wrap.appendChild(document.createTextNode(initials(name)));
    });
    wrap.appendChild(img);
  }
  return wrap;
}

function formatConvTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function formatMsgTime(iso) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatDateSep(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Hoje";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// --- CRM ---
async function loadCrmBoard() {
  const columns = await api("/crm/board");
  state.crmColumns = columns;
  renderCrmBoard(columns, document.getElementById("crm-search").value);
}

function renderCrmBoard(columns, query) {
  const q = (query || "").trim().toLowerCase();
  const stageOptions = columns.map((c) => ({ id: c.id, label: c.label }));
  const board = document.getElementById("crm-board");
  board.innerHTML = "";

  for (const col of columns) {
    const patients = q
      ? col.patients.filter((p) => (p.name ?? "").toLowerCase().includes(q) || p.phone.includes(q))
      : col.patients;

    const cardsBox = el("div", { class: "crm-cards-drop" });
    for (const p of patients) {
      const select = el(
        "select",
        {},
        stageOptions.map((opt) => el("option", { value: opt.id }, [opt.label]))
      );
      select.value = col.id;
      select.addEventListener("change", () => moveStage(p.id, select.value));
      select.addEventListener("mousedown", (e) => e.stopPropagation()); // nao inicia drag ao abrir o select

      const card = el("div", { class: "crm-card", draggable: "true" }, [
        el("div", { class: "crm-card-top" }, [
          el("div", { class: "crm-avatar" }, [initials(p.name)]),
          el("div", { class: "name" }, [p.name ?? "(sem nome)"]),
        ]),
        el("div", { class: "phone" }, [p.phone]),
        select,
      ]);

      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", p.id);
        e.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));

      cardsBox.appendChild(card);
    }

    cardsBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      cardsBox.classList.add("drag-over");
    });
    cardsBox.addEventListener("dragleave", () => cardsBox.classList.remove("drag-over"));
    cardsBox.addEventListener("drop", (e) => {
      e.preventDefault();
      cardsBox.classList.remove("drag-over");
      const patientId = e.dataTransfer.getData("text/plain");
      if (patientId) moveStage(patientId, col.id);
    });

    board.appendChild(
      el("div", { class: "crm-column" }, [
        el("div", { class: "crm-column-header" }, [
          el("span", { class: "crm-column-dot", style: `background:${col.color}` }, []),
          el("span", {}, [col.label]),
          el("span", { class: "crm-column-count" }, [`(${patients.length})`]),
        ]),
        cardsBox,
      ])
    );
  }
}

document.getElementById("crm-search").addEventListener("input", (e) => {
  if (state.crmColumns) renderCrmBoard(state.crmColumns, e.target.value);
});

const STAGE_KIND_LABELS = {
  aberta: "Aberta",
  avaliacao_agendada: "Avaliação agendada",
  ganho: "Ganho",
  pos_procedimento: "Pós-procedimento",
  perdido: "Perdido",
};

async function loadStagesConfig() {
  const stages = await api("/funnel-stages");
  const body = document.getElementById("stages-body");
  body.innerHTML = "";

  for (const stage of stages) {
    const orderInput = el("input", { type: "number" });
    orderInput.value = stage.order;
    const labelInput = el("input", { type: "text" });
    labelInput.value = stage.label;
    const colorInput = el("input", { type: "color" });
    colorInput.value = stage.color;
    const kindSelect = el(
      "select",
      {},
      Object.entries(STAGE_KIND_LABELS).map(([id, label]) => el("option", { value: id }, [label]))
    );
    kindSelect.value = stage.kind;

    const saveBtn = el("button", { class: "btn-save" }, ["Salvar"]);
    saveBtn.addEventListener("click", async () => {
      saveBtn.textContent = "Salvando...";
      await api(`/funnel-stages/${stage.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order: Number(orderInput.value),
          label: labelInput.value,
          color: colorInput.value,
          kind: kindSelect.value,
        }),
      });
      saveBtn.textContent = "Salvo!";
      setTimeout(() => (saveBtn.textContent = "Salvar"), 1500);
      await loadCrmBoard();
    });

    const deleteBtn = el("button", { class: "btn-discard" }, ["Remover"]);
    deleteBtn.addEventListener("click", async () => {
      if (!await showConfirm(`Remover a etapa "${stage.label}"? Pacientes nela vão pra primeira etapa restante.`)) return;
      await api(`/funnel-stages/${stage.id}`, { method: "DELETE" });
      await loadStagesConfig();
      await loadCrmBoard();
    });

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [orderInput]),
        el("td", {}, [labelInput]),
        el("td", {}, [colorInput]),
        el("td", {}, [kindSelect]),
        el("td", { class: "actions" }, [saveBtn, deleteBtn]),
      ])
    );
  }
}

document.getElementById("stage-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = document.getElementById("st-label").value.trim();
  const color = document.getElementById("st-color").value;
  const kind = document.getElementById("st-kind").value;
  if (!label) return;

  await api("/funnel-stages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, color, kind }),
  });

  e.target.reset();
  await loadStagesConfig();
  await loadCrmBoard();
});

async function moveStage(patientId, stage) {
  await api(`/patients/${patientId}/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage }),
  });
  await loadCrmBoard();
}

// --- Chat ---
state.chatFilter = "all";

async function loadConversations() {
  const conversations = await api("/conversations");
  state.conversations = conversations;
  renderConversationsList();
}

function renderConversationsList() {
  const conversations = state.conversations || [];
  const aliceCount = conversations.filter((c) => !c.humanTakeover).length;
  const humanCount = conversations.filter((c) => c.humanTakeover).length;
  const tabs = document.getElementById("chat-filter-tabs");
  tabs.children[0].textContent = `Todos (${conversations.length})`;
  tabs.children[1].textContent = `Alice (${aliceCount})`;
  tabs.children[2].textContent = `Humano (${humanCount})`;

  const filtered = conversations.filter((c) => {
    if (state.chatFilter === "alice") return !c.humanTakeover;
    if (state.chatFilter === "human") return c.humanTakeover;
    return true;
  });

  const list = document.getElementById("conversations-list");
  list.innerHTML = "";
  for (const c of filtered) {
    const li = el("li", { "data-id": c.id }, [
      avatarNode(c.patient.name, c.patient.avatarUrl, "avatar"),
      el("div", { class: "conv-text" }, [
        el("div", { class: "conv-top-row" }, [
          el("div", { class: "name" }, [c.patient.name ?? c.patient.phone]),
          el("div", { class: "conv-time" }, [formatConvTime(c.lastMessageAt)]),
        ]),
        el("div", { class: "preview" }, [c.lastMessage ?? ""]),
      ]),
    ]);
    if (c.id === state.activeConversationId) li.classList.add("active");
    li.addEventListener("click", () => openConversation(c.id));
    list.appendChild(li);
  }
}

document.getElementById("chat-filter-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  document.querySelectorAll("#chat-filter-tabs button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.chatFilter = btn.dataset.filter;
  renderConversationsList();
});

// Volta o painel de Chat pro estado vazio - usado quando a conversa aberta
// deixa de existir/fazer sentido (contato apagado, ou trocou de clinica no
// seletor do admin) pra nao deixar mensagem de outra clinica na tela.
function resetChatPane() {
  document.getElementById("chat-messages").innerHTML = "";
  document.getElementById("chat-messages").style.display = "none";
  document.getElementById("chat-header").style.display = "none";
  document.getElementById("chat-controls").style.display = "none";
  document.getElementById("chat-empty").style.display = "flex";
  document.querySelectorAll("#conversations-list li").forEach((li) => li.classList.remove("active"));
}

async function loadMessages(conversationId) {
  let messages;
  try {
    messages = await api(`/conversations/${conversationId}/messages`, { silentStatuses: [404] });
  } catch (err) {
    if (err.status === 404) {
      // A conversa foi apagada (ex: contato excluido) enquanto ainda estava
      // aberta no Chat - limpa o estado pra parar de tentar recarregar ela
      // a cada poll, em vez de repetir o erro pra sempre.
      if (state.activeConversationId === conversationId) {
        state.activeConversationId = null;
        resetChatPane();
      }
      return;
    }
    throw err;
  }
  const box = document.getElementById("chat-messages");
  box.innerHTML = "";
  let lastDay = null;
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      box.appendChild(el("div", { class: "chat-date-sep" }, [formatDateSep(m.createdAt)]));
      lastDay = day;
    }
    if (m.role === "system") {
      box.appendChild(
        el("div", { class: "chat-event" }, [
          el("span", { class: "nav-icon", "data-icon": "swap" }, []),
          el("div", {}, [
            el("div", { class: "chat-event-text" }, [m.content]),
            el("div", { class: "chat-event-meta" }, [
              m.authorName ? `${m.authorName} · ${formatMsgTime(m.createdAt)}` : formatMsgTime(m.createdAt),
            ]),
          ]),
        ])
      );
      continue;
    }

    const bubble = el("div", { class: `msg ${m.role}` }, [
      el("span", { class: "msg-text" }, [m.content]),
      el("span", { class: "msg-time" }, [formatMsgTime(m.createdAt)]),
    ]);
    if (m.authorName) bubble.prepend(el("div", { class: "msg-author" }, [m.authorName]));
    box.appendChild(bubble);
  }
  paintIcons(box);
  box.scrollTop = box.scrollHeight;
}

async function openConversation(id) {
  state.activeConversationId = id;
  document.querySelectorAll("#conversations-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });

  const conv = (state.conversations || []).find((c) => c.id === id);
  const header = document.getElementById("chat-header");
  document.getElementById("chat-empty").style.display = "none";
  document.getElementById("chat-messages").style.display = "flex";
  if (conv) {
    header.style.display = "flex";
    header.innerHTML = "";
    header.appendChild(avatarNode(conv.patient.name, conv.patient.avatarUrl, "chat-avatar"));
    header.appendChild(
      el("div", {}, [
        el("div", { class: "name" }, [conv.patient.name ?? "(sem nome)"]),
        el("div", { class: "phone" }, [conv.patient.phone]),
      ])
    );

    // Data de nascimento (usada pela automação de aniversário)
    const birthInput = el("input", { type: "date", class: "chat-birthdate", title: "Data de nascimento (para a mensagem de aniversário)" });
    if (conv.patient.birthDate) birthInput.value = String(conv.patient.birthDate).slice(0, 10);
    birthInput.addEventListener("change", async () => {
      await api(`/patients/${conv.patient.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthDate: birthInput.value || null }),
      });
      conv.patient.birthDate = birthInput.value || null;
    });
    header.appendChild(el("label", { class: "chat-birthdate-wrap" }, [el("span", {}, ["🎂"]), birthInput]));

    header.appendChild(
      el("span", { class: `badge ${conv.humanTakeover ? "badge-neutral" : "badge-green"}` }, [
        conv.humanTakeover ? "Humano" : "Alice",
      ])
    );
  }

  document.getElementById("chat-controls").style.display = "flex";
  updateToggleButton(conv?.humanTakeover ?? false);
  await loadMessages(id);
}

function updateToggleButton(humanTakeover) {
  const btn = document.getElementById("btn-toggle-human");
  btn.textContent = humanTakeover ? "Devolver conversa para a Alice" : "Assumir conversa manualmente";
  btn.dataset.humanTakeover = String(humanTakeover);
}

document.getElementById("btn-toggle-human").addEventListener("click", async () => {
  if (!state.activeConversationId) return;
  const isHuman = document.getElementById("btn-toggle-human").dataset.humanTakeover === "true";
  if (isHuman) {
    await api(`/conversations/${state.activeConversationId}/resume`, { method: "POST" });
    updateToggleButton(false);
  } else {
    updateToggleButton(true);
  }
});

document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text || !state.activeConversationId) return;
  input.value = "";
  await api(`/conversations/${state.activeConversationId}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  updateToggleButton(true);
  await loadMessages(state.activeConversationId);
});

// --- Agenda ---
state.agendaRangeDays = 1;

const AGENDA_HOUR_START = 7;
const AGENDA_HOUR_END = 20; // exclusivo - ultima linha e 19:00-20:00
const AGENDA_DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function renderAgendaGrid(appointments, days) {
  const grid = document.getElementById("agenda-grid");
  grid.innerHTML = "";
  const hours = [];
  for (let h = AGENDA_HOUR_START; h < AGENDA_HOUR_END; h++) hours.push(h);

  grid.style.gridTemplateColumns = `56px repeat(${days.length}, 1fr)`;
  grid.style.gridTemplateRows = `auto repeat(${hours.length}, 46px)`;

  grid.appendChild(el("div", { class: "agenda-grid-header", style: "grid-column:1;grid-row:1" }, []));

  const today = new Date();
  days.forEach((day, di) => {
    const header = el("div", { class: `agenda-grid-header${sameDay(day, today) ? " today" : ""}`, style: `grid-column:${di + 2};grid-row:1` }, [
      el("div", {}, [AGENDA_DOW[day.getDay()]]),
      el("div", { class: "day-date" }, [String(day.getDate())]),
    ]);
    grid.appendChild(header);
  });

  const cellByKey = new Map();
  hours.forEach((h, hi) => {
    grid.appendChild(
      el("div", { class: "agenda-hour-label", style: `grid-column:1;grid-row:${hi + 2}` }, [`${h}:00`])
    );
    days.forEach((day, di) => {
      const cell = el("div", { class: "agenda-cell", style: `grid-column:${di + 2};grid-row:${hi + 2}` }, []);
      grid.appendChild(cell);
      cellByKey.set(`${di}-${h}`, cell);
    });
  });

  for (const a of appointments) {
    const when = new Date(a.scheduledAt);
    const di = days.findIndex((d) => sameDay(d, when));
    if (di === -1) continue;
    const hour = Math.min(Math.max(when.getHours(), AGENDA_HOUR_START), AGENDA_HOUR_END - 1);
    const cell = cellByKey.get(`${di}-${hour}`);
    if (!cell) continue;

    const topPct = (when.getMinutes() / 60) * 100;
    const heightPx = Math.max((a.procedure.durationMin / 60) * 46, 18);
    const apptStyle = `top:${topPct}%;height:${heightPx}px${a.professional?.color ? `;border-left:3px solid ${a.professional.color}` : ""}`;
    const apptEl = el(
      "div",
      { class: "agenda-appt", style: apptStyle },
      [
        el("div", { class: "t" }, [
          when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + (a.patientConfirmed ? " ✓" : ""),
        ]),
        el("div", {}, [a.patient.name ?? a.patient.phone]),
        el("div", {}, [a.procedure.name]),
        a.professional ? el("div", { class: "hint", style: "margin:0" }, [a.professional.name]) : "",
      ]
    );
    apptEl.addEventListener("click", () => openApptEditModal(a));
    cell.appendChild(apptEl);
  }

  if (appointments.length === 0) {
    grid.appendChild(
      el("div", { class: "agenda-empty-msg", style: `grid-column:1 / span ${days.length + 1};grid-row:2` }, [
        "Nenhum agendamento neste período.",
      ])
    );
  }
}

async function loadAgenda() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + state.agendaRangeDays * 24 * 60 * 60_000);
  const appointments = await api(`/appointments?start=${start.toISOString()}&end=${end.toISOString()}`);

  const useGrid = state.agendaRangeDays <= 7;
  document.getElementById("agenda-grid-wrap").style.display = useGrid ? "block" : "none";
  document.getElementById("agenda-list-wrap").style.display = useGrid ? "none" : "block";

  if (useGrid) {
    const days = [];
    for (let i = 0; i < state.agendaRangeDays; i++) days.push(new Date(start.getTime() + i * 24 * 60 * 60_000));
    renderAgendaGrid(appointments, days);
    return;
  }

  const body = document.getElementById("agenda-body");
  body.innerHTML = "";
  for (const a of appointments) {
    const row = el("tr", { style: "cursor:pointer" }, [
      el("td", {}, [new Date(a.scheduledAt).toLocaleString("pt-BR")]),
      el("td", {}, [a.patient.name ?? a.patient.phone]),
      el("td", {}, [a.procedure.name]),
      el("td", {}, [a.professional?.name || "-"]),
      el("td", {}, [a.status + (a.patientConfirmed ? " · confirmado" : "")]),
    ]);
    row.addEventListener("click", () => openApptEditModal(a));
    body.appendChild(row);
  }
}

// --- Editar/excluir/transferir agendamento ---
function openApptEditModal(appt) {
  state.editingAppointmentId = appt.id;
  document.getElementById("appt-edit-patient").textContent = `${appt.patient.name ?? appt.patient.phone} · ${appt.patient.phone}`;

  const when = new Date(appt.scheduledAt);
  const pad = (n) => String(n).padStart(2, "0");
  document.getElementById("appt-edit-when").value =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
  document.getElementById("appt-edit-status").value = appt.status;
  document.getElementById("appt-edit-confirmed").checked = !!appt.patientConfirmed;

  const select = document.getElementById("appt-edit-procedure");
  select.innerHTML = "";
  api("/procedures").then((procedures) => {
    for (const p of procedures) {
      const opt = el("option", { value: p.id }, [`${p.name} (${p.durationMin}min)`]);
      if (p.id === appt.procedure.id) opt.selected = true;
      select.appendChild(opt);
    }
  });

  const profSelect = document.getElementById("appt-edit-professional");
  profSelect.innerHTML = '<option value="">Não atribuído</option>';
  api("/professionals").then((professionals) => {
    for (const p of professionals) {
      const opt = el("option", { value: p.id }, [p.name]);
      if (p.id === appt.professional?.id) opt.selected = true;
      profSelect.appendChild(opt);
    }
  });

  document.getElementById("appt-edit-overlay").style.display = "flex";
}

function closeApptEditModal() {
  document.getElementById("appt-edit-overlay").style.display = "none";
  state.editingAppointmentId = null;
}

document.getElementById("appt-edit-close").addEventListener("click", closeApptEditModal);
document.getElementById("appt-edit-overlay").addEventListener("click", (e) => {
  if (e.target.id === "appt-edit-overlay") closeApptEditModal();
});

document.getElementById("appt-edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = state.editingAppointmentId;
  if (!id) return;
  const procedureId = document.getElementById("appt-edit-procedure").value;
  const professionalId = document.getElementById("appt-edit-professional").value;
  const when = document.getElementById("appt-edit-when").value;
  const status = document.getElementById("appt-edit-status").value;
  const patientConfirmed = document.getElementById("appt-edit-confirmed").checked;
  await api(`/appointments/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ procedureId, professionalId, scheduledAt: new Date(when).toISOString(), status, patientConfirmed }),
  });
  closeApptEditModal();
  await loadAgenda();
});

document.getElementById("appt-edit-delete").addEventListener("click", async () => {
  const id = state.editingAppointmentId;
  if (!id) return;
  if (!await showConfirm("Excluir este agendamento? Não pode ser desfeito.")) return;
  await api(`/appointments/${id}`, { method: "DELETE" });
  closeApptEditModal();
  await loadAgenda();
});

document.getElementById("agenda-view-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  document.querySelectorAll("#agenda-view-toggle button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.agendaRangeDays = Number(btn.dataset.range);
  loadAgenda();
});

document.getElementById("btn-toggle-appt-form").addEventListener("click", async () => {
  const form = document.getElementById("appointment-form");
  const opening = form.style.display === "none";
  form.style.display = opening ? "flex" : "none";
  if (opening) {
    const select = document.getElementById("ap-procedure");
    const procedures = await api("/procedures");
    select.innerHTML = "";
    for (const p of procedures) {
      select.appendChild(el("option", { value: p.id }, [`${p.name} (${p.durationMin}min)`]));
    }
  }
});

document.getElementById("appointment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const patientName = document.getElementById("ap-name").value.trim();
  const patientPhone = document.getElementById("ap-phone").value.trim();
  const procedureId = document.getElementById("ap-procedure").value;
  const when = document.getElementById("ap-when").value;
  if (!patientPhone || !procedureId || !when) return;

  await api("/appointments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientName, patientPhone, procedureId, scheduledAt: new Date(when).toISOString() }),
  });

  e.target.reset();
  document.getElementById("appointment-form").style.display = "none";
  await loadAgenda();
});

// Helpers compartilhados: preencher checklist de procedimentos + tabela padrao.
async function fillProcedureChecklist(containerId, selectedIds) {
  const selected = new Set((selectedIds || "").split(",").filter(Boolean));
  const procedures = await api("/procedures");
  const list = document.getElementById(containerId);
  list.innerHTML = "";
  for (const proc of procedures) {
    const checkbox = el("input", { type: "checkbox", value: proc.id }, []);
    if (selected.has(proc.id)) checkbox.checked = true;
    list.appendChild(el("label", {}, [checkbox, proc.name]));
  }
}

function ruleRow({ name, message, active, when, onEdit }) {
  const editBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Editar" }, [el("span", { class: "nav-icon", "data-icon": "pencil" }, [])]);
  editBtn.addEventListener("click", onEdit);
  return el("tr", {}, [
    el("td", {}, [el("div", { style: "font-weight:600" }, [name]), el("div", { class: "hint cell-truncate", style: "margin:0.1rem 0 0" }, [message])]),
    el("td", {}, [el("span", { class: `badge ${active ? "badge-green" : "badge-neutral"}` }, [active ? "Ativa" : "Pausada"])]),
    el("td", {}, [when]),
    el("td", { class: "actions" }, [editBtn]),
  ]);
}

// ======================= RENOVAÇÃO =======================
let allRenewalRules = [];

async function loadRenewalRules() {
  allRenewalRules = await api("/renewal-rules");
  renderRenewalRules();
}

function renewalWhenLabel(r) {
  const unit = r.intervalUnit === "years" ? (r.intervalValue === 1 ? "ano" : "anos") : (r.intervalValue === 1 ? "mês" : "meses");
  return `${r.intervalValue} ${unit} após o atendimento${r.onlyIfCompleted ? ", se concluído" : ""}`;
}

function renderRenewalRules() {
  const search = document.getElementById("renewal-rules-search").value.trim().toLowerCase();
  const filtered = allRenewalRules.filter((r) => !search || r.name.toLowerCase().includes(search));
  document.getElementById("renewal-rules-count").textContent = allRenewalRules.length;
  document.getElementById("renewal-rules-empty").style.display = filtered.length ? "none" : "block";
  const body = document.getElementById("renewal-rules-body");
  body.innerHTML = "";
  for (const r of filtered) {
    body.appendChild(ruleRow({ name: r.name, message: r.message, active: r.active, when: renewalWhenLabel(r), onEdit: () => openRenewalRuleModal(r) }));
  }
  paintIcons(body);
}

document.getElementById("renewal-rules-search").addEventListener("input", renderRenewalRules);
document.querySelectorAll(".rn-var-btn").forEach((btn) => {
  btn.addEventListener("click", () => insertAtCursor(document.getElementById("rn-message"), btn.dataset.var));
});
document.querySelectorAll("#rn-presets .payment-method-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("rn-interval-value").value = btn.dataset.value;
    document.getElementById("rn-interval-unit").value = btn.dataset.unit;
  });
});

async function openRenewalRuleModal(rule) {
  document.getElementById("renewal-rule-title").textContent = rule ? "Editar renovação" : "Nova renovação";
  document.getElementById("rn-id").value = rule?.id || "";
  document.getElementById("rn-name").value = rule?.name || "";
  document.getElementById("rn-interval-value").value = rule?.intervalValue || 1;
  document.getElementById("rn-interval-unit").value = rule?.intervalUnit || "months";
  document.getElementById("rn-only-completed").checked = rule ? !!rule.onlyIfCompleted : true;
  document.getElementById("rn-message").value = rule?.message || "";
  document.getElementById("rn-active").checked = rule ? !!rule.active : true;
  await fillProcedureChecklist("rn-procedures-list", rule?.procedureIds);
  document.getElementById("renewal-rule-delete-btn").style.display = rule ? "" : "none";
  document.getElementById("renewal-rule-overlay").style.display = "flex";
}
function closeRenewalRuleModal() { document.getElementById("renewal-rule-overlay").style.display = "none"; }

document.getElementById("btn-add-renewal-rule").addEventListener("click", () => openRenewalRuleModal(null));
document.getElementById("renewal-rule-close").addEventListener("click", closeRenewalRuleModal);
document.getElementById("renewal-rule-overlay").addEventListener("click", (e) => { if (e.target.id === "renewal-rule-overlay") closeRenewalRuleModal(); });
document.getElementById("renewal-rule-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("rn-id").value;
  if (!id || !(await showConfirm("Excluir essa renovação?"))) return;
  await api(`/renewal-rules/${id}`, { method: "DELETE" });
  closeRenewalRuleModal();
  await loadRenewalRules();
});
document.getElementById("renewal-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("rn-id").value;
  const payload = {
    name: document.getElementById("rn-name").value.trim(),
    message: document.getElementById("rn-message").value.trim(),
    intervalValue: Number(document.getElementById("rn-interval-value").value),
    intervalUnit: document.getElementById("rn-interval-unit").value,
    onlyIfCompleted: document.getElementById("rn-only-completed").checked,
    active: document.getElementById("rn-active").checked,
    procedureIds: Array.from(document.querySelectorAll("#rn-procedures-list input:checked")).map((c) => c.value),
  };
  if (!payload.name || !payload.message || !payload.intervalValue) return;
  const path = id ? `/renewal-rules/${id}` : "/renewal-rules";
  await api(path, { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closeRenewalRuleModal();
  await loadRenewalRules();
});

// ======================= ANIVERSÁRIO =======================
let allBirthdayRules = [];

(function fillBirthdayHours() {
  const sel = document.getElementById("bd-send-hour");
  for (let h = 0; h < 24; h++) {
    const o = el("option", { value: String(h) }, [`${String(h).padStart(2, "0")}:00`]);
    if (h === 9) o.selected = true;
    sel.appendChild(o);
  }
})();

async function loadBirthdayRules() {
  allBirthdayRules = await api("/birthday-rules");
  renderBirthdayRules();
}

function renderBirthdayRules() {
  const search = document.getElementById("birthday-rules-search").value.trim().toLowerCase();
  const filtered = allBirthdayRules.filter((r) => !search || r.name.toLowerCase().includes(search));
  document.getElementById("birthday-rules-count").textContent = allBirthdayRules.length;
  document.getElementById("birthday-rules-empty").style.display = filtered.length ? "none" : "block";
  const body = document.getElementById("birthday-rules-body");
  body.innerHTML = "";
  for (const r of filtered) {
    body.appendChild(ruleRow({ name: r.name, message: r.message, active: r.active, when: `${String(r.sendHour).padStart(2, "0")}:00`, onEdit: () => openBirthdayRuleModal(r) }));
  }
  paintIcons(body);
}

document.getElementById("birthday-rules-search").addEventListener("input", renderBirthdayRules);
document.querySelectorAll(".bd-var-btn").forEach((btn) => {
  btn.addEventListener("click", () => insertAtCursor(document.getElementById("bd-message"), btn.dataset.var));
});

function openBirthdayRuleModal(rule) {
  document.getElementById("birthday-rule-title").textContent = rule ? "Editar mensagem de aniversário" : "Nova mensagem de aniversário";
  document.getElementById("bd-id").value = rule?.id || "";
  document.getElementById("bd-name").value = rule?.name || "";
  document.getElementById("bd-send-hour").value = String(rule?.sendHour ?? 9);
  document.getElementById("bd-message").value = rule?.message || "";
  document.getElementById("bd-active").checked = rule ? !!rule.active : true;
  document.getElementById("birthday-rule-delete-btn").style.display = rule ? "" : "none";
  document.getElementById("birthday-rule-overlay").style.display = "flex";
}
function closeBirthdayRuleModal() { document.getElementById("birthday-rule-overlay").style.display = "none"; }

document.getElementById("btn-add-birthday-rule").addEventListener("click", () => openBirthdayRuleModal(null));
document.getElementById("birthday-rule-close").addEventListener("click", closeBirthdayRuleModal);
document.getElementById("birthday-rule-overlay").addEventListener("click", (e) => { if (e.target.id === "birthday-rule-overlay") closeBirthdayRuleModal(); });
document.getElementById("birthday-rule-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("bd-id").value;
  if (!id || !(await showConfirm("Excluir essa mensagem de aniversário?"))) return;
  await api(`/birthday-rules/${id}`, { method: "DELETE" });
  closeBirthdayRuleModal();
  await loadBirthdayRules();
});
document.getElementById("birthday-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("bd-id").value;
  const payload = {
    name: document.getElementById("bd-name").value.trim(),
    message: document.getElementById("bd-message").value.trim(),
    sendHour: Number(document.getElementById("bd-send-hour").value),
    active: document.getElementById("bd-active").checked,
  };
  if (!payload.name || !payload.message) return;
  const path = id ? `/birthday-rules/${id}` : "/birthday-rules";
  await api(path, { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closeBirthdayRuleModal();
  await loadBirthdayRules();
});

// ======================= RECONTATO =======================
let allFollowUpRules = [];

async function loadFollowUpRules() {
  allFollowUpRules = await api("/followup-rules");
  renderFollowUpRules();
}

function followUpTotalMinutes(r) {
  return r.afterMinutes > 0 ? r.afterMinutes : r.afterDays * 1440;
}
function followUpWhenLabel(r) {
  let mins = followUpTotalMinutes(r);
  const d = Math.floor(mins / 1440); mins -= d * 1440;
  const h = Math.floor(mins / 60); mins -= h * 60;
  const parts = [];
  if (d) parts.push(`${d} ${d === 1 ? "dia" : "dias"}`);
  if (h) parts.push(`${h}h`);
  if (mins) parts.push(`${mins}min`);
  return `Após ${parts.join(" ") || "0min"} de silêncio`;
}

function renderFollowUpRules() {
  const search = document.getElementById("followup-rules-search").value.trim().toLowerCase();
  const filtered = allFollowUpRules.filter((r) => !search || (r.name || `Recontato ${r.order}`).toLowerCase().includes(search));
  document.getElementById("followup-rules-count").textContent = allFollowUpRules.length;
  document.getElementById("followup-rules-empty").style.display = filtered.length ? "none" : "block";
  const body = document.getElementById("followup-body");
  body.innerHTML = "";
  for (const r of filtered) {
    body.appendChild(ruleRow({
      name: r.name || `Recontato ${r.order}`,
      message: r.message,
      active: r.active,
      when: followUpWhenLabel(r),
      onEdit: () => openFollowUpRuleModal(r),
    }));
  }
  paintIcons(body);
}

document.getElementById("followup-rules-search").addEventListener("input", renderFollowUpRules);
document.querySelectorAll(".fu-var-btn").forEach((btn) => {
  btn.addEventListener("click", () => insertAtCursor(document.getElementById("fu-message"), btn.dataset.var));
});
document.querySelectorAll("#fu-presets .payment-method-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("fu-d").value = btn.dataset.d;
    document.getElementById("fu-h").value = btn.dataset.h;
    document.getElementById("fu-m").value = btn.dataset.m;
  });
});

function openFollowUpRuleModal(rule) {
  document.getElementById("followup-rule-title").textContent = rule ? "Editar recontato" : "Novo recontato";
  document.getElementById("fu-id").value = rule?.id || "";
  document.getElementById("fu-name").value = rule?.name || "";
  const total = rule ? followUpTotalMinutes(rule) : 1440;
  document.getElementById("fu-d").value = Math.floor(total / 1440);
  document.getElementById("fu-h").value = Math.floor((total % 1440) / 60);
  document.getElementById("fu-m").value = total % 60;
  const repeat = rule?.repeatMode === "once" ? "once" : "every_silence";
  document.querySelector(`input[name="fu-repeat"][value="${repeat}"]`).checked = true;
  document.getElementById("fu-skip-appt").checked = rule ? !!rule.skipIfUpcomingAppt : true;
  document.getElementById("fu-window-start").value = rule?.sendWindowStart ?? "";
  document.getElementById("fu-window-end").value = rule?.sendWindowEnd ?? "";
  document.getElementById("fu-message").value = rule?.message || "";
  document.getElementById("fu-active").checked = rule ? !!rule.active : true;
  document.getElementById("followup-rule-delete-btn").style.display = rule ? "" : "none";
  document.getElementById("followup-rule-overlay").style.display = "flex";
}
function closeFollowUpRuleModal() { document.getElementById("followup-rule-overlay").style.display = "none"; }

document.getElementById("btn-add-followup-rule").addEventListener("click", () => openFollowUpRuleModal(null));
document.getElementById("followup-rule-close").addEventListener("click", closeFollowUpRuleModal);
document.getElementById("followup-rule-overlay").addEventListener("click", (e) => { if (e.target.id === "followup-rule-overlay") closeFollowUpRuleModal(); });
document.getElementById("followup-rule-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("fu-id").value;
  if (!id || !(await showConfirm("Excluir esse recontato?"))) return;
  await api(`/followup-rules/${id}`, { method: "DELETE" });
  closeFollowUpRuleModal();
  await loadFollowUpRules();
});
document.getElementById("followup-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("fu-id").value;
  const d = Number(document.getElementById("fu-d").value) || 0;
  const h = Number(document.getElementById("fu-h").value) || 0;
  const m = Number(document.getElementById("fu-m").value) || 0;
  const afterMinutes = d * 1440 + h * 60 + m;
  const wStart = document.getElementById("fu-window-start").value;
  const wEnd = document.getElementById("fu-window-end").value;
  const payload = {
    name: document.getElementById("fu-name").value.trim(),
    message: document.getElementById("fu-message").value.trim(),
    afterMinutes,
    repeatMode: document.querySelector('input[name="fu-repeat"]:checked').value,
    skipIfUpcomingAppt: document.getElementById("fu-skip-appt").checked,
    sendWindowStart: wStart === "" ? null : Number(wStart),
    sendWindowEnd: wEnd === "" ? null : Number(wEnd),
    active: document.getElementById("fu-active").checked,
  };
  if (!payload.name || !payload.message || afterMinutes <= 0) return;
  const path = id ? `/followup-rules/${id}` : "/followup-rules";
  await api(path, { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closeFollowUpRuleModal();
  await loadFollowUpRules();
});

// --- Mensagens programadas ---
async function loadBroadcastTargetOptions() {
  const columns = await api("/crm/board");
  const select = document.getElementById("bc-target-stage");
  select.innerHTML = "";
  for (const col of columns) {
    select.appendChild(el("option", { value: col.id }, [col.label]));
  }
}

const STATUS_LABELS = {
  scheduled: "Agendada",
  sending: "Enviando",
  completed: "Concluída",
  cancelled: "Cancelada",
};

let allBroadcasts = [];

async function loadBroadcasts() {
  allBroadcasts = await api("/broadcasts");
  renderBroadcasts();
}

function renderBroadcasts() {
  const search = document.getElementById("broadcasts-search").value.trim().toLowerCase();
  const filtered = allBroadcasts.filter((c) => !search || c.title.toLowerCase().includes(search));
  document.getElementById("broadcasts-count").textContent = allBroadcasts.length;
  document.getElementById("broadcasts-empty").style.display = filtered.length ? "none" : "block";

  const body = document.getElementById("broadcasts-body");
  body.innerHTML = "";
  for (const c of filtered) {
    const progress = c.total > 0 ? `${c.sent}/${c.total} enviados` : "—";
    const actionCell = el("td", {}, []);
    if (c.status === "scheduled") {
      const cancelBtn = el("button", { class: "btn-cancel" }, ["Cancelar"]);
      cancelBtn.addEventListener("click", async () => {
        await api(`/broadcasts/${c.id}/cancel`, { method: "POST" });
        await loadBroadcasts();
      });
      actionCell.appendChild(cancelBtn);
    }

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [el("div", { style: "font-weight:600" }, [c.title]), el("div", { class: "hint cell-truncate", style: "margin:0.1rem 0 0" }, [c.message])]),
        el("td", {}, [new Date(c.scheduledFor).toLocaleString("pt-BR")]),
        el("td", {}, [STATUS_LABELS[c.status] ?? c.status]),
        el("td", {}, [progress]),
        actionCell,
      ])
    );
  }
}

document.getElementById("broadcasts-search").addEventListener("input", renderBroadcasts);

// --- Modal de nova mensagem programada ---
let bcSelectedContacts = new Map(); // id -> label, pra manter selecao entre filtros de busca

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

document.querySelectorAll(".bc-var-btn").forEach((btn) => {
  btn.addEventListener("click", () => insertAtCursor(document.getElementById("bc-message"), btn.dataset.var));
});

document.getElementById("bc-target-mode").addEventListener("change", (e) => {
  document.getElementById("bc-stage-wrap").style.display = e.target.value === "stage" ? "flex" : "none";
  document.getElementById("bc-contacts-wrap").style.display = e.target.value === "contacts" ? "block" : "none";
});

function renderBcContactsList() {
  const search = document.getElementById("bc-contacts-search").value.trim().toLowerCase();
  const contacts = (state.contacts || []).filter(
    (c) => !search || (c.name ?? "").toLowerCase().includes(search) || c.phone.includes(search)
  );
  document.getElementById("bc-contacts-count").textContent = `${bcSelectedContacts.size} contato(s) selecionado(s).`;

  const list = document.getElementById("bc-contacts-list");
  list.innerHTML = "";
  for (const c of contacts.slice(0, 100)) {
    const checkbox = el("input", { type: "checkbox", value: c.id }, []);
    checkbox.checked = bcSelectedContacts.has(c.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) bcSelectedContacts.set(c.id, c.name ?? c.phone);
      else bcSelectedContacts.delete(c.id);
      document.getElementById("bc-contacts-count").textContent = `${bcSelectedContacts.size} contato(s) selecionado(s).`;
    });
    list.appendChild(el("label", {}, [checkbox, c.name ? `${c.name} (${c.phone})` : c.phone]));
  }
}

document.getElementById("bc-contacts-search").addEventListener("input", renderBcContactsList);

function openBroadcastModal() {
  document.getElementById("broadcast-form").reset();
  document.getElementById("bc-target-mode").value = "all";
  document.getElementById("bc-stage-wrap").style.display = "none";
  document.getElementById("bc-contacts-wrap").style.display = "none";
  bcSelectedContacts = new Map();
  loadBroadcastTargetOptions();
  renderBcContactsList();
  document.getElementById("broadcast-edit-overlay").style.display = "flex";
}

function closeBroadcastModal() {
  document.getElementById("broadcast-edit-overlay").style.display = "none";
}

document.getElementById("btn-add-broadcast").addEventListener("click", openBroadcastModal);
document.getElementById("broadcast-edit-close").addEventListener("click", closeBroadcastModal);
document.getElementById("broadcast-cancel-btn").addEventListener("click", closeBroadcastModal);
document.getElementById("broadcast-edit-overlay").addEventListener("click", (e) => {
  if (e.target.id === "broadcast-edit-overlay") closeBroadcastModal();
});

document.getElementById("broadcast-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("bc-title").value.trim();
  const message = document.getElementById("bc-message").value.trim();
  const when = document.getElementById("bc-when").value;
  const targetMode = document.getElementById("bc-target-mode").value;
  if (!title || !message || !when) return;

  const payload = { title, message, scheduledFor: new Date(when).toISOString() };
  if (targetMode === "stage") {
    payload.targetStage = document.getElementById("bc-target-stage").value;
  } else if (targetMode === "contacts") {
    if (bcSelectedContacts.size === 0) {
      showError("Selecione pelo menos um contato.");
      return;
    }
    payload.contactIds = Array.from(bcSelectedContacts.keys());
  }

  await api("/broadcasts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  closeBroadcastModal();
  await loadBroadcasts();
});

// --- Lembrete de consulta ---
let allReminderRules = [];

async function loadReminderRules() {
  allReminderRules = await api("/reminder-rules");
  renderReminderRules();
}

function renderReminderRules() {
  const search = document.getElementById("reminder-rules-search").value.trim().toLowerCase();
  const filtered = allReminderRules.filter((r) => !search || r.message.toLowerCase().includes(search));
  document.getElementById("reminder-rules-count").textContent = allReminderRules.length;
  document.getElementById("reminder-rules-empty").style.display = filtered.length ? "none" : "block";

  const body = document.getElementById("reminder-rules-body");
  body.innerHTML = "";
  for (const r of filtered) {
    const editBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Editar" }, [el("span", { class: "nav-icon", "data-icon": "pencil" }, [])]);
    editBtn.addEventListener("click", () => openReminderRuleModal(r));
    body.appendChild(
      el("tr", {}, [
        el("td", { class: "cell-truncate", title: r.message }, [r.message]),
        el("td", {}, [`${r.hoursBefore}h antes`]),
        el("td", {}, [el("span", { class: `badge ${r.active ? "badge-green" : "badge-neutral"}` }, [r.active ? "Ativo" : "Pausado"])]),
        el("td", { class: "actions" }, [editBtn]),
      ])
    );
  }
  paintIcons(body);
}

document.getElementById("reminder-rules-search").addEventListener("input", renderReminderRules);
document.querySelectorAll(".rr-var-btn").forEach((btn) => {
  btn.addEventListener("click", () => insertAtCursor(document.getElementById("rr-message"), btn.dataset.var));
});

function openReminderRuleModal(rule) {
  document.getElementById("reminder-rule-title").textContent = rule ? "Editar lembrete" : "Novo lembrete de consulta";
  document.getElementById("rr-id").value = rule?.id || "";
  document.getElementById("rr-hours-before").value = rule?.hoursBefore || 24;
  document.getElementById("rr-message").value = rule?.message || "";
  document.getElementById("rr-active").checked = rule ? !!rule.active : true;
  document.getElementById("reminder-rule-delete-btn").style.display = rule ? "" : "none";
  document.getElementById("reminder-rule-overlay").style.display = "flex";
}

function closeReminderRuleModal() {
  document.getElementById("reminder-rule-overlay").style.display = "none";
}

document.getElementById("btn-add-reminder-rule").addEventListener("click", () => openReminderRuleModal(null));
document.getElementById("reminder-rule-close").addEventListener("click", closeReminderRuleModal);
document.getElementById("reminder-rule-overlay").addEventListener("click", (e) => {
  if (e.target.id === "reminder-rule-overlay") closeReminderRuleModal();
});

document.getElementById("reminder-rule-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("rr-id").value;
  if (!id || !(await showConfirm("Excluir esse lembrete?"))) return;
  await api(`/reminder-rules/${id}`, { method: "DELETE" });
  closeReminderRuleModal();
  await loadReminderRules();
});

document.getElementById("reminder-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("rr-id").value;
  const payload = {
    hoursBefore: Number(document.getElementById("rr-hours-before").value),
    message: document.getElementById("rr-message").value.trim(),
    active: document.getElementById("rr-active").checked,
  };
  if (!payload.message) return;

  if (id) {
    await api(`/reminder-rules/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } else {
    await api("/reminder-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  closeReminderRuleModal();
  await loadReminderRules();
});

// --- Pos-procedimento ---
let allPpRules = [];

async function loadPostProcedureRules() {
  allPpRules = await api("/post-procedure-rules");
  renderPpRules();
}

function ppWhenLabel(r) {
  const unitLabel = r.intervalUnit === "hours" ? (r.intervalValue === 1 ? "hora" : "horas") : (r.intervalValue === 1 ? "dia" : "dias");
  return `${r.intervalValue} ${unitLabel} depois${r.onlyIfCompleted ? ", após conclusão" : ""}`;
}

function renderPpRules() {
  const search = document.getElementById("pp-rules-search").value.trim().toLowerCase();
  const filtered = allPpRules.filter((r) => !search || r.name.toLowerCase().includes(search));
  document.getElementById("pp-rules-count").textContent = allPpRules.length;
  document.getElementById("pp-rules-empty").style.display = filtered.length ? "none" : "block";

  const body = document.getElementById("pp-rules-body");
  body.innerHTML = "";
  for (const r of filtered) {
    const editBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Editar" }, [el("span", { class: "nav-icon", "data-icon": "pencil" }, [])]);
    editBtn.addEventListener("click", () => openPpRuleModal(r));
    body.appendChild(
      el("tr", {}, [
        el("td", {}, [el("div", { style: "font-weight:600" }, [r.name]), el("div", { class: "hint cell-truncate", style: "margin:0.1rem 0 0" }, [r.message])]),
        el("td", {}, [el("span", { class: `badge ${r.active ? "badge-green" : "badge-neutral"}` }, [r.active ? "Ativa" : "Pausada"])]),
        el("td", {}, [ppWhenLabel(r)]),
        el("td", { class: "actions" }, [editBtn]),
      ])
    );
  }
  paintIcons(body);
}

document.getElementById("pp-rules-search").addEventListener("input", renderPpRules);
document.querySelectorAll(".pp-var-btn").forEach((btn) => {
  btn.addEventListener("click", () => insertAtCursor(document.getElementById("pp-message"), btn.dataset.var));
});

async function openPpRuleModal(rule) {
  document.getElementById("pp-rule-title").textContent = rule ? "Editar pós-procedimento" : "Nova mensagem de pós-procedimento";
  document.getElementById("pp-id").value = rule?.id || "";
  document.getElementById("pp-name").value = rule?.name || "";
  document.getElementById("pp-interval-value").value = rule?.intervalValue || 1;
  document.getElementById("pp-interval-unit").value = rule?.intervalUnit || "days";
  document.getElementById("pp-only-completed").checked = rule ? !!rule.onlyIfCompleted : true;
  document.getElementById("pp-message").value = rule?.message || "";
  document.getElementById("pp-active").checked = rule ? !!rule.active : true;

  const selectedProcedureIds = new Set((rule?.procedureIds || "").split(",").filter(Boolean));
  const procedures = await api("/procedures");
  const list = document.getElementById("pp-procedures-list");
  list.innerHTML = "";
  for (const proc of procedures) {
    const checkbox = el("input", { type: "checkbox", value: proc.id }, []);
    if (selectedProcedureIds.has(proc.id)) checkbox.checked = true;
    list.appendChild(el("label", {}, [checkbox, proc.name]));
  }

  document.getElementById("pp-rule-delete-btn").style.display = rule ? "" : "none";
  document.getElementById("pp-rule-overlay").style.display = "flex";
}

function closePpRuleModal() {
  document.getElementById("pp-rule-overlay").style.display = "none";
}

document.getElementById("btn-add-pp-rule").addEventListener("click", () => openPpRuleModal(null));
document.getElementById("pp-rule-close").addEventListener("click", closePpRuleModal);
document.getElementById("pp-rule-overlay").addEventListener("click", (e) => {
  if (e.target.id === "pp-rule-overlay") closePpRuleModal();
});

document.getElementById("pp-rule-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("pp-id").value;
  if (!id || !(await showConfirm("Excluir essa mensagem de pós-procedimento?"))) return;
  await api(`/post-procedure-rules/${id}`, { method: "DELETE" });
  closePpRuleModal();
  await loadPostProcedureRules();
});

document.getElementById("pp-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("pp-id").value;
  const payload = {
    name: document.getElementById("pp-name").value.trim(),
    message: document.getElementById("pp-message").value.trim(),
    intervalValue: Number(document.getElementById("pp-interval-value").value),
    intervalUnit: document.getElementById("pp-interval-unit").value,
    onlyIfCompleted: document.getElementById("pp-only-completed").checked,
    active: document.getElementById("pp-active").checked,
    procedureIds: Array.from(document.querySelectorAll("#pp-procedures-list input:checked")).map((c) => c.value),
  };
  if (!payload.name || !payload.message) return;

  if (id) {
    await api(`/post-procedure-rules/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } else {
    await api("/post-procedure-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  closePpRuleModal();
  await loadPostProcedureRules();
});

// ======================= HISTÓRICO DE ATIVIDADES =======================
let activityCursor = null;
let activityFiltersLoaded = false;

async function loadActivityLog(reset = true) {
  if (!activityFiltersLoaded) {
    const f = await api("/activity-log/filters");
    const typeSel = document.getElementById("activity-filter-type");
    const areaSel = document.getElementById("activity-filter-area");
    for (const t of f.types) typeSel.appendChild(el("option", { value: t.id }, [t.label]));
    for (const a of f.areas) areaSel.appendChild(el("option", { value: a.id }, [a.label]));
    activityFiltersLoaded = true;
  }

  const list = document.getElementById("activity-list");
  if (reset) { list.innerHTML = ""; activityCursor = null; }

  const type = document.getElementById("activity-filter-type").value;
  const area = document.getElementById("activity-filter-area").value;
  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (area) qs.set("area", area);
  if (activityCursor) qs.set("cursor", activityCursor);

  const data = await api(`/activity-log?${qs.toString()}`);
  document.getElementById("activity-count").textContent = data.total;
  document.getElementById("activity-empty").style.display = data.total === 0 ? "block" : "none";

  for (const it of data.items) {
    list.appendChild(
      el("div", { class: "activity-item" }, [
        el("div", { class: "activity-icon" }, [el("span", { class: "nav-icon", "data-icon": "guide" }, [])]),
        el("div", { class: "activity-body" }, [
          el("div", { class: "activity-head" }, [
            el("strong", {}, [it.title]),
            el("span", { class: "activity-time" }, [new Date(it.createdAt).toLocaleString("pt-BR")]),
          ]),
          it.description ? el("div", { class: "activity-desc" }, [it.description]) : el("span", {}, []),
          el("div", { class: "activity-meta" }, [
            el("span", {}, [el("b", {}, ["Área: "]), it.areaLabel]),
            el("span", {}, [el("b", {}, ["Responsável: "]), it.actor]),
          ]),
        ]),
      ])
    );
  }
  paintIcons(list);

  activityCursor = data.nextCursor;
  document.getElementById("activity-more").style.display = data.nextCursor ? "inline-flex" : "none";
}

document.getElementById("activity-apply").addEventListener("click", () => loadActivityLog(true));
document.getElementById("activity-more").addEventListener("click", () => loadActivityLog(false));

// ======================= PERSONALIZAR ALICE =======================
let RULE_CATEGORY_LABELS = {};
let RULE_CATEGORY_LIST = [];
let allCustomRules = [];
let ruleCatFilter = "";

// --- Sub-abas ---
document.getElementById("rules-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-rt]");
  if (!btn) return;
  const rt = btn.dataset.rt;
  document.querySelectorAll("#rules-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".rules-panel").forEach((p) => p.classList.toggle("active", p.id === `rt-${rt}`));
  RULES_SUB_LOADERS[rt]?.();
});

async function ensureRuleCategories() {
  if (RULE_CATEGORY_LIST.length === 0) {
    RULE_CATEGORY_LIST = await api("/rules/categories");
    RULE_CATEGORY_LABELS = Object.fromEntries(RULE_CATEGORY_LIST.map((c) => [c.id, c.label]));
  }
}

// --- Regras globais ---
async function loadRules() {
  await ensureRuleCategories();
  allCustomRules = await api("/rules");
  renderRules();
}

function renderRules() {
  const pendingBox = document.getElementById("rules-pending");
  const activeBox = document.getElementById("rules-active");
  pendingBox.innerHTML = "";
  activeBox.innerHTML = "";

  const search = document.getElementById("rules-search").value.trim().toLowerCase();
  const active = allCustomRules.filter((r) => r.status === "active");
  const pending = allCustomRules.filter((r) => r.status !== "active");

  document.getElementById("rules-active-count").textContent = `(${active.length})`;

  // filtro por categoria
  const catBox = document.getElementById("rules-cat-filter");
  catBox.innerHTML = "";
  const mkCatBtn = (id, label) => {
    const b = el("button", { class: id === ruleCatFilter ? "active" : "" }, [label]);
    b.addEventListener("click", () => { ruleCatFilter = id; renderRules(); });
    return b;
  };
  catBox.appendChild(mkCatBtn("", `Todas (${active.length})`));
  for (const c of RULE_CATEGORY_LIST) {
    const n = active.filter((r) => r.category === c.id).length;
    if (n) catBox.appendChild(mkCatBtn(c.id, `${c.label} (${n})`));
  }

  // pendentes (aparecem em Início)
  for (const rule of pending) {
    const isQuestion = rule.status === "needs_clarification";
    const discardBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Descartar"]);
    discardBtn.addEventListener("click", async () => { await api(`/rules/${rule.id}`, { method: "DELETE" }); await loadRules(); });
    const children = [
      el("div", { class: "category" }, [isQuestion ? "Precisa da sua atenção" : "Sugestão pendente"]),
      el("div", { class: "raw" }, [`Você disse: "${rule.rawInput}"`]),
    ];
    if (isQuestion) {
      children.push(el("div", { class: "question" }, [rule.clarifyingQuestion]));
      children.push(el("div", { class: "hint" }, ["Descreva de novo lá em cima, já respondendo essa pergunta."]));
      children.push(el("div", { class: "actions" }, [discardBtn]));
    } else {
      const approveBtn = el("button", { class: "btn-brand btn-brand--primary btn-brand--sm" }, ["Aprovar"]);
      approveBtn.addEventListener("click", async () => { await api(`/rules/${rule.id}/approve`, { method: "POST" }); await loadRules(); });
      children.push(el("div", { class: "instruction" }, [`${RULE_CATEGORY_LABELS[rule.category] ?? rule.category}: ${rule.instruction}`]));
      children.push(el("div", { class: "actions" }, [approveBtn, discardBtn]));
    }
    pendingBox.appendChild(el("div", { class: "rule-card pending" }, children));
  }

  // ativas (Regras globais)
  const shown = active.filter((r) =>
    (!ruleCatFilter || r.category === ruleCatFilter) &&
    (!search || (r.instruction || "").toLowerCase().includes(search))
  );
  if (shown.length === 0) {
    activeBox.appendChild(el("p", { class: "hint", style: "text-align:center;padding:1rem 0" }, ["Nenhuma regra nesse filtro."]));
  }
  for (const rule of shown) {
    const editBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Editar"]);
    editBtn.addEventListener("click", () => openRuleEditModal(rule));
    const delBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Excluir"]);
    delBtn.addEventListener("click", async () => {
      if (!(await showConfirm("Excluir essa regra?"))) return;
      await api(`/rules/${rule.id}`, { method: "DELETE" });
      await loadRules();
    });
    activeBox.appendChild(el("div", { class: "rule-card-2" }, [
      el("div", { class: "rc-top" }, [el("span", { class: "rc-tag" }, [RULE_CATEGORY_LABELS[rule.category] ?? rule.category])]),
      el("div", { class: "rc-body" }, [rule.instruction ?? ""]),
      el("div", { class: "rc-actions" }, [editBtn, delBtn]),
    ]));
  }
  updateHomeStats();
}

document.getElementById("rules-search").addEventListener("input", renderRules);

document.getElementById("btn-restore-rules").addEventListener("click", async (e) => {
  e.target.disabled = true;
  await api("/rules/restore-defaults", { method: "POST" });
  e.target.disabled = false;
  await loadRules();
});

document.getElementById("rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const textArea = document.getElementById("rule-text");
  const text = textArea.value.trim();
  if (!text) return;
  const submitBtn = e.target.querySelector("button[type=submit]");
  const label = submitBtn.innerHTML;
  submitBtn.textContent = "Pensando...";
  submitBtn.disabled = true;
  try {
    await api("/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    textArea.value = "";
    await loadRules();
  } finally {
    submitBtn.innerHTML = label;
    submitBtn.disabled = false;
    paintIcons(submitBtn);
  }
});
document.querySelectorAll(".rule-cat-hint").forEach((chip) => {
  chip.addEventListener("click", () => {
    const t = document.getElementById("rule-text");
    t.focus();
    t.value = t.value ? t.value : `Sobre ${chip.textContent.toLowerCase()}: `;
  });
});

// modal de regra (manual/editar)
function openRuleEditModal(rule) {
  const sel = document.getElementById("re-category");
  if (!sel.options.length) for (const c of RULE_CATEGORY_LIST) sel.appendChild(el("option", { value: c.id }, [c.label]));
  document.getElementById("rule-edit-title").textContent = rule ? "Editar regra" : "Nova regra";
  document.getElementById("re-id").value = rule?.id || "";
  document.getElementById("re-category").value = rule?.category || RULE_CATEGORY_LIST[0]?.id || "";
  document.getElementById("re-instruction").value = rule?.instruction || "";
  document.getElementById("rule-edit-delete-btn").style.display = rule ? "" : "none";
  document.getElementById("rule-edit-overlay").style.display = "flex";
}
function closeRuleEditModal() { document.getElementById("rule-edit-overlay").style.display = "none"; }
document.getElementById("btn-add-rule").addEventListener("click", () => openRuleEditModal(null));
document.getElementById("rule-edit-close").addEventListener("click", closeRuleEditModal);
document.getElementById("rule-edit-overlay").addEventListener("click", (e) => { if (e.target.id === "rule-edit-overlay") closeRuleEditModal(); });
document.getElementById("rule-edit-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("re-id").value;
  if (!id || !(await showConfirm("Excluir essa regra?"))) return;
  await api(`/rules/${id}`, { method: "DELETE" });
  closeRuleEditModal();
  await loadRules();
});
document.getElementById("rule-edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("re-id").value;
  const payload = { category: document.getElementById("re-category").value, instruction: document.getElementById("re-instruction").value.trim() };
  if (!payload.instruction) return;
  if (id) await api(`/rules/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  else await api("/rules/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closeRuleEditModal();
  await loadRules();
});

// --- Mensagens prontas ---
let allTemplates = [];
async function loadTemplates() { allTemplates = await api("/message-templates"); renderTemplates(); }
function renderTemplates() {
  const search = document.getElementById("tpl-search").value.trim().toLowerCase();
  const list = document.getElementById("tpl-list");
  document.getElementById("tpl-count").textContent = allTemplates.length;
  const shown = allTemplates.filter((t) => !search || t.name.toLowerCase().includes(search));
  document.getElementById("tpl-empty").style.display = allTemplates.length ? "none" : "block";
  list.innerHTML = "";
  for (const t of shown) {
    const editBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Editar"]);
    editBtn.addEventListener("click", () => openTplModal(t));
    const delBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Excluir"]);
    delBtn.addEventListener("click", async () => { if (!(await showConfirm("Excluir essa mensagem?"))) return; await api(`/message-templates/${t.id}`, { method: "DELETE" }); await loadTemplates(); });
    list.appendChild(el("div", { class: "rule-card-2" }, [
      el("div", { class: "rc-top" }, [
        el("span", { class: "rc-title" }, [t.name]),
        el("span", { class: `rc-tag ${t.mode === "exact" ? "" : "muted"}` }, [t.mode === "exact" ? "envio exato" : "adapta o tom"]),
        t.active ? el("span", {}, []) : el("span", { class: "rc-tag muted" }, ["inativa"]),
      ]),
      t.whenToUse ? el("div", { class: "rc-when" }, [`Usar quando: ${t.whenToUse}`]) : el("span", {}, []),
      el("div", { class: "rc-body" }, [t.body]),
      el("div", { class: "rc-actions" }, [editBtn, delBtn]),
    ]));
  }
}
document.getElementById("tpl-search").addEventListener("input", renderTemplates);
document.querySelectorAll(".tpl-var-btn").forEach((b) => b.addEventListener("click", () => insertAtCursor(document.getElementById("tpl-body"), b.dataset.var)));
function openTplModal(t) {
  document.getElementById("tpl-title").textContent = t ? "Editar mensagem" : "Nova mensagem";
  document.getElementById("tpl-id").value = t?.id || "";
  document.getElementById("tpl-name").value = t?.name || "";
  document.querySelector(`input[name="tpl-mode"][value="${t?.mode === "exact" ? "exact" : "adapt"}"]`).checked = true;
  document.getElementById("tpl-when").value = t?.whenToUse || "";
  document.getElementById("tpl-body").value = t?.body || "";
  document.getElementById("tpl-active").checked = t ? !!t.active : true;
  document.getElementById("tpl-delete-btn").style.display = t ? "" : "none";
  document.getElementById("tpl-overlay").style.display = "flex";
}
const closeTpl = () => (document.getElementById("tpl-overlay").style.display = "none");
document.getElementById("btn-add-tpl").addEventListener("click", () => openTplModal(null));
document.getElementById("tpl-close").addEventListener("click", closeTpl);
document.getElementById("tpl-overlay").addEventListener("click", (e) => { if (e.target.id === "tpl-overlay") closeTpl(); });
document.getElementById("tpl-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("tpl-id").value;
  if (!id || !(await showConfirm("Excluir essa mensagem?"))) return;
  await api(`/message-templates/${id}`, { method: "DELETE" }); closeTpl(); await loadTemplates();
});
document.getElementById("tpl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("tpl-id").value;
  const payload = {
    name: document.getElementById("tpl-name").value.trim(),
    body: document.getElementById("tpl-body").value.trim(),
    mode: document.querySelector('input[name="tpl-mode"]:checked').value,
    whenToUse: document.getElementById("tpl-when").value.trim(),
    active: document.getElementById("tpl-active").checked,
  };
  if (!payload.name || !payload.body) return;
  await api(id ? `/message-templates/${id}` : "/message-templates", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closeTpl(); await loadTemplates();
});

// --- FAQ da clínica ---
let allFaqs = [];
async function loadFaqs() { allFaqs = await api("/faqs"); renderFaqs(); }
function renderFaqs() {
  const search = document.getElementById("faq-search").value.trim().toLowerCase();
  const list = document.getElementById("faq-list");
  document.getElementById("faq-count").textContent = allFaqs.length;
  const shown = allFaqs.filter((f) => !search || f.question.toLowerCase().includes(search) || f.answer.toLowerCase().includes(search));
  document.getElementById("faq-empty").style.display = allFaqs.length ? "none" : "block";
  list.innerHTML = "";
  for (const f of shown) {
    const editBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Editar"]);
    editBtn.addEventListener("click", () => openFaqModal(f));
    const delBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Excluir"]);
    delBtn.addEventListener("click", async () => { if (!(await showConfirm("Excluir essa FAQ?"))) return; await api(`/faqs/${f.id}`, { method: "DELETE" }); await loadFaqs(); });
    list.appendChild(el("div", { class: "rule-card-2" }, [
      el("div", { class: "rc-top" }, [
        el("span", { class: "rc-title" }, [f.question]),
        f.exactAnswer ? el("span", { class: "rc-tag" }, ["resposta exata"]) : el("span", {}, []),
        f.active ? el("span", {}, []) : el("span", { class: "rc-tag muted" }, ["inativa"]),
      ]),
      el("div", { class: "rc-body" }, [f.answer]),
      el("div", { class: "rc-actions" }, [editBtn, delBtn]),
    ]));
  }
}
document.getElementById("faq-search").addEventListener("input", renderFaqs);
function openFaqModal(f) {
  document.getElementById("faq-title").textContent = f ? "Editar FAQ" : "Nova FAQ";
  document.getElementById("fq-id").value = f?.id || "";
  document.getElementById("fq-question").value = f?.question || "";
  document.getElementById("fq-answer").value = f?.answer || "";
  document.getElementById("fq-alternates").value = f?.alternates || "";
  document.getElementById("fq-exact").checked = f ? !!f.exactAnswer : false;
  document.getElementById("fq-active").checked = f ? !!f.active : true;
  document.getElementById("faq-delete-btn").style.display = f ? "" : "none";
  document.getElementById("faq-overlay").style.display = "flex";
}
const closeFaq = () => (document.getElementById("faq-overlay").style.display = "none");
document.getElementById("btn-add-faq").addEventListener("click", () => openFaqModal(null));
document.getElementById("faq-close").addEventListener("click", closeFaq);
document.getElementById("faq-overlay").addEventListener("click", (e) => { if (e.target.id === "faq-overlay") closeFaq(); });
document.getElementById("faq-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("fq-id").value;
  if (!id || !(await showConfirm("Excluir essa FAQ?"))) return;
  await api(`/faqs/${id}`, { method: "DELETE" }); closeFaq(); await loadFaqs();
});
document.getElementById("faq-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("fq-id").value;
  const payload = {
    question: document.getElementById("fq-question").value.trim(),
    answer: document.getElementById("fq-answer").value.trim(),
    alternates: document.getElementById("fq-alternates").value.trim(),
    exactAnswer: document.getElementById("fq-exact").checked,
    active: document.getElementById("fq-active").checked,
  };
  if (!payload.question || !payload.answer) return;
  await api(id ? `/faqs/${id}` : "/faqs", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closeFaq(); await loadFaqs();
});

// --- Roteiros ---
let allPlaybooks = [];
async function loadPlaybooks() { allPlaybooks = await api("/playbooks"); renderPlaybooks(); }
function renderPlaybooks() {
  const search = document.getElementById("pb-search").value.trim().toLowerCase();
  const list = document.getElementById("pb-list");
  document.getElementById("pb-count").textContent = allPlaybooks.length;
  const shown = allPlaybooks.filter((p) => !search || p.name.toLowerCase().includes(search));
  document.getElementById("pb-empty").style.display = allPlaybooks.length ? "none" : "block";
  list.innerHTML = "";
  for (const p of shown) {
    const editBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Editar"]);
    editBtn.addEventListener("click", () => openPbModal(p));
    const delBtn = el("button", { class: "btn-brand btn-brand--secondary btn-brand--sm" }, ["Excluir"]);
    delBtn.addEventListener("click", async () => { if (!(await showConfirm("Excluir esse roteiro?"))) return; await api(`/playbooks/${p.id}`, { method: "DELETE" }); await loadPlaybooks(); });
    const steps = (p.steps || "").split("\n").filter(Boolean);
    list.appendChild(el("div", { class: "rule-card-2" }, [
      el("div", { class: "rc-top" }, [
        el("span", { class: "rc-title" }, [p.name]),
        p.active ? el("span", { class: "rc-tag" }, ["no ar"]) : el("span", { class: "rc-tag muted" }, ["inativo"]),
      ]),
      p.triggerText ? el("div", { class: "rc-when" }, [`Usar quando: ${p.triggerText}`]) : el("span", {}, []),
      el("div", { class: "rc-body" }, [steps.map((s, i) => `${i + 1}. ${s.replace(/^\d+[.)]\s*/, "")}`).join("\n")]),
      el("div", { class: "rc-actions" }, [editBtn, delBtn]),
    ]));
  }
}
document.getElementById("pb-search").addEventListener("input", renderPlaybooks);
function openPbModal(p) {
  document.getElementById("pb-title").textContent = p ? "Editar roteiro" : "Novo roteiro";
  document.getElementById("pb-id").value = p?.id || "";
  document.getElementById("pb-name").value = p?.name || "";
  document.getElementById("pb-type").value = p?.scriptType || "livre";
  document.getElementById("pb-trigger").value = p?.triggerText || "";
  document.getElementById("pb-goal").value = p?.goal || "";
  document.getElementById("pb-steps").value = p?.steps || "";
  document.getElementById("pb-active").checked = p ? !!p.active : true;
  document.getElementById("pb-delete-btn").style.display = p ? "" : "none";
  document.getElementById("pb-overlay").style.display = "flex";
}
const closePb = () => (document.getElementById("pb-overlay").style.display = "none");
document.getElementById("btn-add-pb").addEventListener("click", () => openPbModal(null));
document.getElementById("pb-close").addEventListener("click", closePb);
document.getElementById("pb-overlay").addEventListener("click", (e) => { if (e.target.id === "pb-overlay") closePb(); });
document.getElementById("pb-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("pb-id").value;
  if (!id || !(await showConfirm("Excluir esse roteiro?"))) return;
  await api(`/playbooks/${id}`, { method: "DELETE" }); closePb(); await loadPlaybooks();
});
document.getElementById("pb-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("pb-id").value;
  const payload = {
    name: document.getElementById("pb-name").value.trim(),
    scriptType: document.getElementById("pb-type").value,
    triggerText: document.getElementById("pb-trigger").value.trim(),
    goal: document.getElementById("pb-goal").value.trim(),
    steps: document.getElementById("pb-steps").value.trim(),
    active: document.getElementById("pb-active").checked,
  };
  if (!payload.name || !payload.steps) return;
  await api(id ? `/playbooks/${id}` : "/playbooks", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  closePb(); await loadPlaybooks();
});

// --- Ajustes da Alice ---
function loadAliceSettings() {
  const c = (state.clinics || []).find((x) => x.id === state.clinicId);
  if (!c) return;
  document.getElementById("as-name").value = c.assistantName || "Alice";
  document.getElementById("as-area").value = c.activityArea || "";
  document.getElementById("as-handoff").value = c.handoffPhrase || "";
  document.getElementById("as-split").checked = c.splitLongMessages !== false;
  document.getElementById("as-split-max").value = c.splitMaxMessages ?? 4;
  document.getElementById("as-split-threshold").value = c.splitThresholdChars ?? 450;
  document.getElementById("as-deposit").checked = !!c.requireDepositProof;
}
document.getElementById("alice-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    assistantName: document.getElementById("as-name").value.trim() || "Alice",
    activityArea: document.getElementById("as-area").value.trim(),
    handoffPhrase: document.getElementById("as-handoff").value.trim(),
    splitLongMessages: document.getElementById("as-split").checked,
    splitMaxMessages: Number(document.getElementById("as-split-max").value),
    splitThresholdChars: Number(document.getElementById("as-split-threshold").value),
    requireDepositProof: document.getElementById("as-deposit").checked,
  };
  await api(`/clinics/${state.clinicId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  await loadClinics();
  loadAliceSettings();
});

// --- Início: stats ---
function updateHomeStats() {
  const box = document.getElementById("rt-home-stats");
  if (!box) return;
  const activeRules = allCustomRules.filter((r) => r.status === "active").length;
  const pendingRules = allCustomRules.filter((r) => r.status !== "active").length;
  const cards = [
    ["Regras ativas", activeRules, "A Alice cumpre sozinha em toda conversa."],
    ["Precisam da sua atenção", pendingRules, pendingRules ? "Sugestões e perguntas pendentes." : "Nada pendente."],
    ["Mensagens prontas", allTemplates.length, "Textos reaproveitados no atendimento."],
    ["Roteiros no ar", allPlaybooks.filter((p) => p.active).length, "Conversas conduzidas passo a passo."],
  ];
  box.innerHTML = "";
  for (const [label, value, hint] of cards) {
    box.appendChild(el("div", { class: "card stat-card" }, [
      el("div", { class: "stat-label" }, [label]),
      el("div", { class: "stat-value" }, [String(value)]),
      el("div", { class: "stat-hint" }, [hint]),
    ]));
  }
}

const RULES_SUB_LOADERS = {
  home: () => { loadRules(); loadTemplates(); loadPlaybooks(); },
  global: loadRules,
  templates: loadTemplates,
  faq: loadFaqs,
  settings: loadAliceSettings,
  playbooks: loadPlaybooks,
};

function loadPersonalize() {
  const activeRt = document.querySelector("#rules-tabs button.active")?.dataset.rt || "home";
  RULES_SUB_LOADERS[activeRt]?.();
}


async function refreshAll() {
  // allSettled: uma aba com erro nao pode travar as outras de carregar.
  await Promise.allSettled([
    loadDashboard(),
    loadContacts(),
    loadCrmBoard(),
    loadConversations(),
    loadAgenda(),
    state.activeConversationId ? loadMessages(state.activeConversationId) : Promise.resolve(),
  ]);
}

// --- Dashboard (Inicio) ---
state.periodDays = 30;

function updateBrandName() {
  const clinic = (state.clinics || []).find((c) => c.id === state.clinicId);
  const name = clinic?.name ?? "—";
  document.getElementById("brand-clinic-name").textContent = name;
  document.getElementById("dash-greeting").textContent = `Olá, ${name}!`;
}

async function loadDashboard() {
  const end = new Date();
  const start = new Date(end.getTime() - state.periodDays * 24 * 60 * 60_000);
  const stats = await api(`/dashboard/stats?start=${start.toISOString()}&end=${end.toISOString()}`);

  document.getElementById("stat-attended").textContent = stats.attended;
  document.getElementById("stat-appointments").textContent = stats.appointmentsTotal;
  document.getElementById("stat-appointments-hint").textContent =
    stats.appointmentsTotal > 0 ? `${stats.appointmentsCompleted} concluídos` : "Nenhum no período";
  document.getElementById("stat-completed").textContent = stats.appointmentsCompleted;
  const pctDone = stats.appointmentsTotal > 0 ? Math.round((stats.appointmentsCompleted / stats.appointmentsTotal) * 100) : 0;
  const pctCancel = stats.appointmentsTotal > 0 ? Math.round((stats.appointmentsCancelled / stats.appointmentsTotal) * 100) : 0;
  document.getElementById("stat-completed-hint").textContent = `${pctDone}% de conclusão · ${pctCancel}% cancelados`;

  const totalAppts = stats.daily.reduce((sum, d) => sum + d.count, 0);
  document.getElementById("chart-total").textContent = `${totalAppts} no período`;

  const chart = document.getElementById("dash-chart");
  chart.innerHTML = "";
  const maxCount = Math.max(1, ...stats.daily.map((d) => d.count));
  const shown = stats.daily.slice(-30);
  for (const d of shown) {
    const heightPct = Math.round((d.count / maxCount) * 100);
    const bar = el("div", { class: `dash-bar${d.count > 0 ? " has-value" : ""}`, style: `height:${Math.max(heightPct, 3)}%` }, []);
    const day = new Date(d.date + "T00:00:00");
    chart.appendChild(
      el("div", { class: "dash-bar-wrap" }, [bar, el("div", { class: "dash-bar-label" }, [String(day.getDate())])])
    );
  }

  renderMiniCalendar(stats.daily);
}

function renderMiniCalendar(daily) {
  const cal = document.getElementById("mini-calendar");
  cal.innerHTML = "";
  const byDate = new Map(daily.map((d) => [d.date, d.count]));

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  document.getElementById("dash-calendar-title").textContent = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  ["D", "S", "T", "Q", "Q", "S", "S"].forEach((d) => cal.appendChild(el("div", { class: "dow" }, [d])));

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = now.toISOString().slice(0, 10);

  for (let i = 0; i < firstDay; i++) cal.appendChild(el("div", { class: "day empty" }, []));

  for (let day = 1; day <= daysInMonth; day++) {
    const key = new Date(year, month, day).toISOString().slice(0, 10);
    const classes = ["day"];
    if (key === todayKey) classes.push("today");
    if ((byDate.get(key) ?? 0) > 0) classes.push("has-appt");
    cal.appendChild(el("div", { class: classes.join(" ") }, [String(day)]));
  }
}

document.getElementById("period-row").addEventListener("click", (e) => {
  const btn = e.target.closest(".period-btn");
  if (!btn) return;
  document.querySelectorAll(".period-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.periodDays = Number(btn.dataset.days) || 30;
  loadDashboard();
});

// --- Selecao de clinica (multi-clinica) ---
async function loadClinics() {
  const clinics = await api("/clinics");
  state.clinics = clinics;
  const select = document.getElementById("clinic-select");
  select.innerHTML = "";
  for (const c of clinics) {
    select.appendChild(el("option", { value: c.id }, [c.name]));
  }

  let saved = null;
  try {
    saved = localStorage.getItem("alice_clinic_id");
  } catch {
    // localStorage indisponivel (raro) - segue sem lembrar a escolha
  }
  const initial = clinics.some((c) => c.id === saved) ? saved : clinics[0]?.id ?? null;
  state.clinicId = initial;
  select.value = initial ?? "";
  updateBrandName();

  select.addEventListener("change", () => {
    state.clinicId = select.value;
    try {
      localStorage.setItem("alice_clinic_id", state.clinicId);
    } catch {
      // ignora se nao puder salvar
    }
    state.activeConversationId = null;
    resetChatPane();
    updateBrandName();
    refreshAll();
  });
}

// --- Helpers de moeda (BRL) ---
function formatBRL(n) {
  if (n == null || Number.isNaN(n)) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function parseBRLInput(str) {
  if (!str || !str.trim()) return null;
  const cleaned = str.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
const PAYMENT_METHOD_LABELS = { dinheiro: "Dinheiro", pix: "Pix", credito: "Cartão de Crédito", debito: "Cartão de Débito" };

// --- Procedimentos ---
let allProcedures = [];

async function loadProcedures() {
  allProcedures = await api("/procedures");
  renderProcedures();
}

function renderProcedures() {
  const search = document.getElementById("procedures-search").value.trim().toLowerCase();
  const filtered = allProcedures.filter((p) => !search || p.name.toLowerCase().includes(search));
  document.getElementById("procedures-count").textContent = allProcedures.length;
  document.getElementById("procedures-empty").style.display = filtered.length ? "none" : "block";

  const body = document.getElementById("procedures-body");
  body.innerHTML = "";
  for (const proc of filtered) {
    const editBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Editar" }, [
      el("span", { class: "nav-icon", "data-icon": "pencil" }, []),
    ]);
    editBtn.addEventListener("click", () => openProcedureModal(proc));

    let priceText = "-";
    if (proc.price != null) {
      priceText = formatBRL(proc.price);
      if (proc.offerInstallments && proc.maxInstallments) {
        priceText += ` (${proc.maxInstallments}x de ${formatBRL(proc.price / proc.maxInstallments)})`;
      }
    } else if (proc.priceVariable) {
      priceText = "Variável";
    }

    const methods = (proc.paymentMethods || "").split(",").filter(Boolean);
    const methodsCell = el(
      "td",
      {},
      methods.length ? methods.map((m) => el("span", { class: "payment-badge" }, [PAYMENT_METHOD_LABELS[m] || m])) : ["-"]
    );

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [proc.name]),
        el("td", {}, [priceText]),
        methodsCell,
        el("td", { class: "cell-truncate", title: proc.description || "" }, [proc.description || "-"]),
        el("td", { class: "actions" }, [editBtn]),
      ])
    );
  }
  paintIcons(body);
}

document.getElementById("procedures-search").addEventListener("input", renderProcedures);
document.getElementById("btn-add-procedure").addEventListener("click", () => openProcedureModal(null));

function openProcedureModal(proc) {
  document.getElementById("procedure-modal-title").textContent = proc ? "Editar Serviço" : "Adicionar Serviço";
  document.getElementById("pr2-id").value = proc?.id || "";
  document.getElementById("pr2-name").value = proc?.name || "";
  document.getElementById("pr2-duration").value = proc?.durationMin || 60;
  document.getElementById("pr2-price").value = proc?.price != null ? proc.price.toFixed(2).replace(".", ",") : "";
  document.getElementById("pr2-price-variable").checked = !!proc?.priceVariable;
  document.getElementById("pr2-installments").checked = !!proc?.offerInstallments;
  document.getElementById("pr2-installments-count").value = proc?.maxInstallments || 10;
  document.getElementById("pr2-installments-count-wrap").style.display = proc?.offerInstallments ? "flex" : "none";
  document.getElementById("pr2-description").value = proc?.description || "";
  document.getElementById("pr2-desc-count").textContent = (proc?.description || "").length;
  document.getElementById("pr2-goals").value = proc?.goals || "";
  document.getElementById("pr2-benefits").value = proc?.benefits || "";
  document.getElementById("pr2-aliases").value = proc?.aliases || "";
  document.getElementById("pr2-timeline").value = proc?.resultTimeline || "";
  document.getElementById("pr2-payment-link").value = proc?.paymentLink || "";

  const activeMethods = new Set((proc?.paymentMethods || "").split(",").filter(Boolean));
  document.querySelectorAll(".payment-method-btn").forEach((btn) => {
    btn.classList.toggle("active", activeMethods.has(btn.dataset.method));
  });

  document.getElementById("procedure-delete-btn").style.display = proc ? "" : "none";
  document.getElementById("procedure-edit-overlay").style.display = "flex";
}

function closeProcedureModal() {
  document.getElementById("procedure-edit-overlay").style.display = "none";
}

document.getElementById("procedure-edit-close").addEventListener("click", closeProcedureModal);
document.getElementById("procedure-edit-overlay").addEventListener("click", (e) => {
  if (e.target.id === "procedure-edit-overlay") closeProcedureModal();
});

document.getElementById("pr2-installments").addEventListener("change", (e) => {
  document.getElementById("pr2-installments-count-wrap").style.display = e.target.checked ? "flex" : "none";
});

document.getElementById("pr2-description").addEventListener("input", (e) => {
  document.getElementById("pr2-desc-count").textContent = e.target.value.length;
});

document.querySelectorAll(".payment-method-btn").forEach((btn) => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

document.getElementById("procedure-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("pr2-id").value;
  if (!id || !await showConfirm("Remover esse procedimento?")) return;
  await api(`/procedures/${id}`, { method: "DELETE" });
  closeProcedureModal();
  await loadProcedures();
});

document.getElementById("procedure-edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("pr2-id").value;
  const offerInstallments = document.getElementById("pr2-installments").checked;
  const payload = {
    name: document.getElementById("pr2-name").value.trim(),
    durationMin: Number(document.getElementById("pr2-duration").value),
    price: parseBRLInput(document.getElementById("pr2-price").value),
    priceVariable: document.getElementById("pr2-price-variable").checked,
    offerInstallments,
    maxInstallments: offerInstallments ? Number(document.getElementById("pr2-installments-count").value) : null,
    description: document.getElementById("pr2-description").value.trim(),
    goals: document.getElementById("pr2-goals").value.trim(),
    benefits: document.getElementById("pr2-benefits").value.trim(),
    aliases: document.getElementById("pr2-aliases").value.trim(),
    resultTimeline: document.getElementById("pr2-timeline").value.trim(),
    paymentMethods: Array.from(document.querySelectorAll(".payment-method-btn.active")).map((b) => b.dataset.method),
    paymentLink: document.getElementById("pr2-payment-link").value.trim(),
  };
  if (!payload.name) return;

  if (id) {
    await api(`/procedures/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } else {
    await api("/procedures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  closeProcedureModal();
  await loadProcedures();
});

// --- Produtos ---
let allProducts = [];
let pendingProductPhoto = null;

async function loadProducts() {
  allProducts = await api("/products");
  renderProducts();
}

function renderProducts() {
  const search = document.getElementById("products-search").value.trim().toLowerCase();
  const filtered = allProducts.filter((p) => !search || p.name.toLowerCase().includes(search));
  document.getElementById("products-count").textContent = allProducts.length;
  document.getElementById("products-empty").style.display = filtered.length ? "none" : "block";

  const body = document.getElementById("products-body");
  body.innerHTML = "";
  for (const prod of filtered) {
    const thumb = prod.photoUrl
      ? el("img", { class: "product-thumb", src: prod.photoUrl, alt: "" }, [])
      : el("div", { class: "product-thumb" }, []);

    const editBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Editar" }, [
      el("span", { class: "nav-icon", "data-icon": "pencil" }, []),
    ]);
    editBtn.addEventListener("click", () => openProductModal(prod));

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [thumb]),
        el("td", {}, [prod.name]),
        el("td", {}, [prod.price != null ? formatBRL(prod.price) : "-"]),
        el("td", { class: "cell-truncate", title: prod.description || "" }, [prod.description || "-"]),
        el("td", { class: "actions" }, [editBtn]),
      ])
    );
  }
  paintIcons(body);
}

document.getElementById("products-search").addEventListener("input", renderProducts);
document.getElementById("btn-add-product").addEventListener("click", () => openProductModal(null));

function updateProductPhotoPreview() {
  const img = document.getElementById("pd-photo-preview");
  const placeholder = document.getElementById("pd-photo-placeholder");
  if (pendingProductPhoto) {
    img.src = pendingProductPhoto;
    img.style.display = "block";
    placeholder.style.display = "none";
  } else {
    img.style.display = "none";
    placeholder.style.display = "block";
  }
}

function openProductModal(prod) {
  document.getElementById("product-modal-title").textContent = prod ? "Editar Produto" : "Adicionar Produto";
  document.getElementById("pd-id").value = prod?.id || "";
  document.getElementById("pd-name").value = prod?.name || "";
  document.getElementById("pd-price").value = prod?.price != null ? prod.price.toFixed(2).replace(".", ",") : "";
  document.getElementById("pd-description").value = prod?.description || "";
  pendingProductPhoto = prod?.photoUrl || null;
  updateProductPhotoPreview();
  document.getElementById("product-delete-btn").style.display = prod ? "" : "none";
  document.getElementById("product-edit-overlay").style.display = "flex";
}

function closeProductModal() {
  document.getElementById("product-edit-overlay").style.display = "none";
}

document.getElementById("product-edit-close").addEventListener("click", closeProductModal);
document.getElementById("product-edit-overlay").addEventListener("click", (e) => {
  if (e.target.id === "product-edit-overlay") closeProductModal();
});

document.getElementById("pd-photo-drop").addEventListener("click", () => document.getElementById("pd-photo-input").click());
document.getElementById("pd-photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showError("Imagem maior que 2MB - escolha um arquivo menor.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingProductPhoto = reader.result;
    updateProductPhotoPreview();
  };
  reader.readAsDataURL(file);
});

document.getElementById("product-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("pd-id").value;
  if (!id || !await showConfirm("Remover esse produto?")) return;
  await api(`/products/${id}`, { method: "DELETE" });
  closeProductModal();
  await loadProducts();
});

document.getElementById("product-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("pd-id").value;
  const payload = {
    name: document.getElementById("pd-name").value.trim(),
    price: parseBRLInput(document.getElementById("pd-price").value),
    description: document.getElementById("pd-description").value.trim(),
    photoUrl: pendingProductPhoto,
  };
  if (!payload.name) return;

  if (id) {
    await api(`/products/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } else {
    await api("/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  closeProductModal();
  await loadProducts();
});

// --- Profissionais ---
let allProfessionals = [];
let pendingProfessionalPhoto = null;

function initialsOf(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

async function loadProfessionals() {
  allProfessionals = await api("/professionals");
  renderProfessionals();
}

function renderProfessionals() {
  const search = document.getElementById("professionals-search").value.trim().toLowerCase();
  const filtered = allProfessionals.filter((p) => !search || p.name.toLowerCase().includes(search));
  document.getElementById("professionals-count").textContent = allProfessionals.length;
  document.getElementById("professionals-empty").style.display = filtered.length ? "none" : "block";

  const grid = document.getElementById("professionals-grid");
  grid.innerHTML = "";
  for (const prof of filtered) {
    const avatar = prof.photoUrl
      ? el("img", { class: "professional-avatar", src: prof.photoUrl, alt: "" }, [])
      : el("div", { class: "professional-avatar", style: `background:${prof.color || "var(--accent)"}` }, [initialsOf(prof.name)]);

    const badges = [el("span", { class: "label" }, ["Procedimentos"])].concat(
      prof.procedures.length ? prof.procedures.map((p) => el("span", { class: "payment-badge" }, [p.name])) : [el("span", { class: "hint" }, ["Nenhum vinculado"])]
    );

    const card = el("div", { class: "professional-card" }, [
      el("div", { class: "professional-card-header" }, [
        avatar,
        el("div", { class: "professional-card-info" }, [
          el("div", { class: "name" }, [prof.name]),
          prof.instagram ? el("div", { class: "instagram" }, [prof.instagram]) : "",
          el("span", { class: `badge ${prof.active ? "badge-green" : "badge-neutral"}` }, [prof.active ? "Ativo" : "Inativo"]),
        ]),
        (() => {
          const b = el("button", { type: "button", class: "btn-icon-plain", title: "Editar" }, [el("span", { class: "nav-icon", "data-icon": "pencil" }, [])]);
          b.addEventListener("click", () => openProfessionalModal(prof));
          return b;
        })(),
      ]),
      prof.bio ? el("div", { class: "professional-card-bio" }, [prof.bio]) : "",
      el("div", { class: "professional-card-procedures" }, badges),
    ]);
    grid.appendChild(card);
  }
  paintIcons(grid);
}

document.getElementById("professionals-search").addEventListener("input", renderProfessionals);
document.getElementById("btn-add-professional").addEventListener("click", () => openProfessionalModal(null));

function updateProfessionalPhotoPreview() {
  const img = document.getElementById("pf-photo-preview");
  const placeholder = document.getElementById("pf-photo-placeholder");
  if (pendingProfessionalPhoto) {
    img.src = pendingProfessionalPhoto;
    img.style.display = "block";
    placeholder.style.display = "none";
  } else {
    img.style.display = "none";
    placeholder.style.display = "block";
  }
}

async function openProfessionalModal(prof) {
  document.getElementById("professional-modal-title").textContent = prof ? "Editar Profissional" : "Adicionar Profissional";
  document.getElementById("pf-id").value = prof?.id || "";
  document.getElementById("pf-name").value = prof?.name || "";
  document.getElementById("pf-instagram").value = prof?.instagram || "";
  document.getElementById("pf-bio").value = prof?.bio || "";
  document.getElementById("pf-active").checked = prof ? !!prof.active : true;
  document.getElementById("pf-start-hour").value = prof?.workStartHour ?? "";
  document.getElementById("pf-end-hour").value = prof?.workEndHour ?? "";
  const profDays = new Set((prof?.workDays || "").split(",").filter(Boolean));
  document.querySelectorAll("#pf-workdays input").forEach((c) => { c.checked = profDays.has(c.value); });
  pendingProfessionalPhoto = prof?.photoUrl || null;
  updateProfessionalPhotoPreview();

  document.querySelectorAll("#pf-color-grid .color-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.color === (prof?.color || ""));
  });

  const linkedIds = new Set((prof?.procedures || []).map((p) => p.id));
  const allProcedures = await api("/procedures");
  const list = document.getElementById("pf-procedures-list");
  list.innerHTML = "";
  for (const proc of allProcedures) {
    const checkbox = el("input", { type: "checkbox", value: proc.id }, []);
    if (linkedIds.has(proc.id)) checkbox.checked = true;
    list.appendChild(el("label", {}, [checkbox, proc.name]));
  }

  document.getElementById("professional-delete-btn").style.display = prof ? "" : "none";
  document.getElementById("professional-edit-overlay").style.display = "flex";
}

function closeProfessionalModal() {
  document.getElementById("professional-edit-overlay").style.display = "none";
}

document.getElementById("professional-edit-close").addEventListener("click", closeProfessionalModal);
document.getElementById("professional-edit-overlay").addEventListener("click", (e) => {
  if (e.target.id === "professional-edit-overlay") closeProfessionalModal();
});

document.querySelectorAll("#pf-color-grid .color-swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#pf-color-grid .color-swatch").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

document.getElementById("pf-photo-drop").addEventListener("click", () => document.getElementById("pf-photo-input").click());
document.getElementById("pf-photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showError("Imagem maior que 2MB - escolha um arquivo menor.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingProfessionalPhoto = reader.result;
    updateProfessionalPhotoPreview();
  };
  reader.readAsDataURL(file);
});

document.getElementById("professional-delete-btn").addEventListener("click", async () => {
  const id = document.getElementById("pf-id").value;
  if (!id || !await showConfirm("Remover esse profissional?")) return;
  await api(`/professionals/${id}`, { method: "DELETE" });
  closeProfessionalModal();
  await loadProfessionals();
});

document.getElementById("professional-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("pf-id").value;
  const activeColor = document.querySelector("#pf-color-grid .color-swatch.active");
  const startHour = document.getElementById("pf-start-hour").value;
  const endHour = document.getElementById("pf-end-hour").value;
  const workDays = Array.from(document.querySelectorAll("#pf-workdays input:checked")).map((c) => c.value).join(",");
  const payload = {
    name: document.getElementById("pf-name").value.trim(),
    instagram: document.getElementById("pf-instagram").value.trim(),
    bio: document.getElementById("pf-bio").value.trim(),
    color: activeColor ? activeColor.dataset.color : "",
    photoUrl: pendingProfessionalPhoto,
    active: document.getElementById("pf-active").checked,
    workDays: workDays || null,
    workStartHour: startHour === "" ? null : Number(startHour),
    workEndHour: endHour === "" ? null : Number(endHour),
    procedureIds: Array.from(document.querySelectorAll("#pf-procedures-list input:checked")).map((c) => c.value),
  };
  if (!payload.name) return;

  if (id) {
    await api(`/professionals/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } else {
    await api("/professionals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  closeProfessionalModal();
  await loadProfessionals();
});

async function loadClinicsList() {
  const clinics = await api("/clinics");
  const body = document.getElementById("clinics-body");
  body.innerHTML = "";
  for (const c of clinics) {
    const toggleBtn = el("button", { type: "button", class: c.active ? "btn-cancel" : "btn-approve" }, [
      c.active ? "Bloquear" : "Desbloquear",
    ]);
    toggleBtn.addEventListener("click", async () => {
      const action = c.active ? "bloquear" : "desbloquear";
      if (!await showConfirm(`Tem certeza que quer ${action} o acesso de "${c.name}"?`)) return;
      await api(`/clinics/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !c.active }),
      });
      await loadClinicsList();
    });

    const deleteBtn = el("button", { type: "button", class: "btn-icon-danger", title: "Excluir clínica (só se estiver vazia)" }, [
      el("span", { class: "nav-icon", "data-icon": "trash" }, []),
    ]);
    deleteBtn.addEventListener("click", async () => {
      if (!await showConfirm(`Excluir a clínica "${c.name}"? Só funciona se ela estiver vazia (sem contato nem conta de equipe).`)) return;
      await api(`/clinics/${c.id}`, { method: "DELETE" });
      await loadClinicsList();
    });

    const uazapiBtn = el("button", { type: "button", class: "btn-brand btn-brand--secondary btn-brand--sm" }, [
      c.configured ? "Trocar token" : "Configurar",
    ]);
    uazapiBtn.addEventListener("click", () => openClinicUazapiModal(c));

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [c.name]),
        el("td", {}, [c.whatsappPhone]),
        el("td", {}, [
          el("span", { class: `badge ${c.configured ? "badge-green" : "badge-neutral"}` }, [
            c.configured ? "Configurada" : "Pendente",
          ]),
        ]),
        el("td", {}, [
          el("span", { class: `badge ${c.connected ? "badge-green" : "badge-neutral"}` }, [
            c.connected ? "Conectado" : c.connecting ? "Conectando…" : "Desconectado",
          ]),
        ]),
        el("td", {}, [
          el("span", { class: `badge ${c.active ? "badge-green" : "badge-neutral"}` }, [
            c.active ? "Em dia" : "Bloqueada",
          ]),
        ]),
        el("td", { class: "actions" }, [uazapiBtn, toggleBtn, deleteBtn]),
      ])
    );
  }
  paintIcons(body);
}

function closeClinicUazapiModal() {
  document.getElementById("clinic-uazapi-overlay").style.display = "none";
}

async function openClinicUazapiModal(clinic) {
  const overlay = document.getElementById("clinic-uazapi-overlay");
  const tokenInput = document.getElementById("clinic-uazapi-token");
  const tokenHint = document.getElementById("clinic-uazapi-token-hint");
  const feedback = document.getElementById("clinic-uazapi-feedback");
  const saveBtn = document.getElementById("clinic-uazapi-save");

  document.getElementById("clinic-uazapi-id").value = clinic.id;
  document.getElementById("clinic-uazapi-title").textContent = `UAZAPI — ${clinic.name}`;
  document.getElementById("clinic-uazapi-url").value = "";
  tokenInput.value = "";
  tokenInput.required = !clinic.configured;
  tokenHint.textContent = "Carregando configuração…";
  feedback.style.display = "none";
  saveBtn.disabled = true;
  overlay.style.display = "flex";

  try {
    const config = await api(`/clinics/${clinic.id}/uazapi`);
    document.getElementById("clinic-uazapi-url").value = config.baseUrl;
    tokenInput.required = !config.configured;
    tokenHint.textContent = config.configured
      ? `Token atual: ${config.tokenHint}. Deixe o campo vazio para manter esse token.`
      : "Nenhum token configurado. Informe um token para salvar.";
  } catch {
    closeClinicUazapiModal();
  } finally {
    saveBtn.disabled = false;
  }
}

document.getElementById("clinic-uazapi-close").addEventListener("click", closeClinicUazapiModal);
document.getElementById("clinic-uazapi-cancel").addEventListener("click", closeClinicUazapiModal);
document.getElementById("clinic-uazapi-overlay").addEventListener("click", (event) => {
  if (event.target.id === "clinic-uazapi-overlay") closeClinicUazapiModal();
});

document.getElementById("clinic-uazapi-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.getElementById("clinic-uazapi-id").value;
  const baseUrl = document.getElementById("clinic-uazapi-url").value.trim();
  const tokenInput = document.getElementById("clinic-uazapi-token");
  const token = tokenInput.value.trim();
  const feedback = document.getElementById("clinic-uazapi-feedback");
  const saveBtn = document.getElementById("clinic-uazapi-save");
  if (!id || !baseUrl || (tokenInput.required && !token)) return;

  saveBtn.disabled = true;
  feedback.style.display = "none";
  try {
    const result = await api(`/clinics/${id}/uazapi`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, ...(token ? { token } : {}) }),
      silentStatuses: [400],
    });
    tokenInput.value = "";
    tokenInput.required = false;
    const config = await api(`/clinics/${id}/uazapi`);
    document.getElementById("clinic-uazapi-token-hint").textContent =
      `Token atual: ${config.tokenHint}. Deixe o campo vazio para manter esse token.`;
    feedback.textContent = result.webhookConfigured
      ? "Credenciais validadas e webhook configurado com sucesso."
      : "Credenciais salvas. Configure PUBLIC_BASE_URL e UAZAPI_WEBHOOK_SECRET no servidor para ativar o webhook.";
    feedback.style.color = result.webhookConfigured ? "var(--green-text)" : "var(--text-muted)";
    feedback.style.display = "block";
    await loadClinicsList();
    await loadClinics();
  } catch (error) {
    if (error.status !== 400) throw error;
    feedback.textContent = error.detail || "Não foi possível validar as credenciais da UAZAPI.";
    feedback.style.color = "#b91c1c";
    feedback.style.display = "block";
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("clinic-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("cl-name").value.trim();
  const whatsappPhone = document.getElementById("cl-phone").value.trim();
  if (!name || !whatsappPhone) return;

  await api("/clinics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, whatsappPhone }),
  });

  e.target.reset();
  await loadClinicsList();
  await loadClinics(); // atualiza o seletor no topo com a clinica nova
});

// --- Equipe (contas de atendente) ---
async function loadTeam() {
  const team = await api("/staff");
  const body = document.getElementById("team-body");
  body.innerHTML = "";
  for (const t of team) {
    const deleteBtn = el("button", { type: "button", class: "btn-icon-danger", title: "Remover conta" }, [
      el("span", { class: "nav-icon", "data-icon": "trash" }, []),
    ]);
    deleteBtn.addEventListener("click", async () => {
      if (!await showConfirm(`Remover a conta de ${t.name}?`)) return;
      await api(`/staff/${t.id}`, { method: "DELETE" });
      await loadTeam();
    });

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [t.name]),
        el("td", {}, [t.username]),
        el("td", {}, [new Date(t.createdAt).toLocaleDateString("pt-BR")]),
        el("td", {}, [deleteBtn]),
      ])
    );
  }
  paintIcons(body);
}

document.getElementById("team-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("tm-name").value.trim();
  const username = document.getElementById("tm-username").value.trim();
  const password = document.getElementById("tm-password").value;
  if (!name || !username || !password) return;

  await api("/staff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, username, password }),
  });

  e.target.reset();
  await loadTeam();
});

// --- Dados da clinica ---
function loadClinicDataForm() {
  const clinic = (state.clinics || []).find((c) => c.id === state.clinicId);
  if (!clinic) return;
  document.getElementById("cd-id").value = clinic.id;
  document.getElementById("cd-name").value = clinic.name;
  document.getElementById("cd-phone").value = clinic.whatsappPhone;
  document.getElementById("cd-timezone").value = clinic.timezone ?? "America/Sao_Paulo";
  document.getElementById("cd-start-hour").value = clinic.workStartHour ?? 9;
  document.getElementById("cd-end-hour").value = clinic.workEndHour ?? 19;

  const workDays = (clinic.workDays ?? "1,2,3,4,5,6").split(",");
  document.querySelectorAll("#cd-workdays input[type=checkbox]").forEach((box) => {
    box.checked = workDays.includes(box.value);
  });

  document.getElementById("cd-notify-phone").value = clinic.notifyPhone ?? "";
  const notifyEvents = (clinic.notifyEvents ?? "").split(",");
  document.querySelectorAll("#cd-notify-events input[type=checkbox]").forEach((box) => {
    box.checked = notifyEvents.includes(box.value);
  });

  document.getElementById("cd-persona").value = clinic.assistantPersona ?? "team";
  document.getElementById("cd-persona-name").value = clinic.assistantPersonaName ?? "";
  syncPersonaNameVisibility();
}

function syncPersonaNameVisibility() {
  const isProfessional = document.getElementById("cd-persona").value === "professional_secretary";
  document.getElementById("cd-persona-name-wrap").style.display = isProfessional ? "" : "none";
}
document.getElementById("cd-persona").addEventListener("change", syncPersonaNameVisibility);

document.getElementById("clinic-data-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("cd-id").value;
  const name = document.getElementById("cd-name").value.trim();
  const whatsappPhone = document.getElementById("cd-phone").value.trim();
  const timezone = document.getElementById("cd-timezone").value.trim();
  const workStartHour = Number(document.getElementById("cd-start-hour").value);
  const workEndHour = Number(document.getElementById("cd-end-hour").value);
  const workDays = Array.from(document.querySelectorAll("#cd-workdays input[type=checkbox]:checked"))
    .map((box) => box.value)
    .join(",");
  const notifyPhone = document.getElementById("cd-notify-phone").value.trim().replace(/\D/g, "");
  const notifyEvents = Array.from(document.querySelectorAll("#cd-notify-events input[type=checkbox]:checked"))
    .map((box) => box.value)
    .join(",");
  const assistantPersona = document.getElementById("cd-persona").value;
  const assistantPersonaName = document.getElementById("cd-persona-name").value.trim();
  if (!id || !name || !whatsappPhone.replace(/\D/g, "")) return;

  await api(`/clinics/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, whatsappPhone, timezone, workStartHour, workEndHour, workDays, notifyPhone, notifyEvents, assistantPersona, assistantPersonaName }),
  });

  await loadClinics();
  loadClinicDataForm();
});

// --- Unidades/enderecos da clinica ---
function locationFullAddress(loc) {
  const parts = [
    [loc.street, loc.number].filter(Boolean).join(", "),
    loc.complement,
    loc.neighborhood,
    [loc.city, loc.state].filter(Boolean).join(" - "),
    loc.zipCode,
    loc.country,
  ].filter(Boolean);
  return parts.join(", ");
}

function renderLocationCard(loc, index, total) {
  const nameInput = el("input", { id: `loc-name-${loc.id}`, type: "text", value: loc.name ?? "" }, []);
  const mapsInput = el("input", { id: `loc-maps-${loc.id}`, type: "text", value: loc.googleMapsUrl ?? "", placeholder: "https://maps.google.com/..." }, []);
  const siteInput = el("input", { id: `loc-site-${loc.id}`, type: "text", value: loc.website ?? "" }, []);
  const tzInput = el("input", { id: `loc-tz-${loc.id}`, type: "text", value: loc.timezone ?? "America/Sao_Paulo" }, []);
  const streetInput = el("input", { id: `loc-street-${loc.id}`, type: "text", value: loc.street ?? "" }, []);
  const numberInput = el("input", { id: `loc-number-${loc.id}`, type: "text", value: loc.number ?? "" }, []);
  const complementInput = el("input", { id: `loc-complement-${loc.id}`, type: "text", value: loc.complement ?? "", placeholder: "Ex: Conjunto 101 / Bloco B" }, []);
  const neighborhoodInput = el("input", { id: `loc-neighborhood-${loc.id}`, type: "text", value: loc.neighborhood ?? "" }, []);
  const cityInput = el("input", { id: `loc-city-${loc.id}`, type: "text", value: loc.city ?? "" }, []);
  const stateInput = el("input", { id: `loc-state-${loc.id}`, type: "text", value: loc.state ?? "" }, []);
  const zipInput = el("input", { id: `loc-zip-${loc.id}`, type: "text", value: loc.zipCode ?? "" }, []);
  const countryInput = el("input", { id: `loc-country-${loc.id}`, type: "text", value: loc.country ?? "Brasil" }, []);
  const arrivalInput = el("input", { id: `loc-arrival-${loc.id}`, type: "text", value: loc.arrivalInstructions ?? "" }, []);
  const activeCheckbox = el("input", { type: "checkbox" }, []);
  activeCheckbox.checked = loc.active;

  const preview = el("p", { class: "full-address-preview" }, [locationFullAddress(loc) || "Endereço aparecerá aqui conforme você preenche."]);
  const allAddressInputs = [streetInput, numberInput, complementInput, neighborhoodInput, cityInput, stateInput, zipInput, countryInput];
  allAddressInputs.forEach((input) =>
    input.addEventListener("input", () => {
      preview.textContent =
        locationFullAddress({
          street: streetInput.value,
          number: numberInput.value,
          complement: complementInput.value,
          neighborhood: neighborhoodInput.value,
          city: cityInput.value,
          state: stateInput.value,
          zipCode: zipInput.value,
          country: countryInput.value,
        }) || "Endereço aparecerá aqui conforme você preenche.";
    })
  );

  const upBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Mover pra cima" }, ["▲"]);
  const downBtn = el("button", { type: "button", class: "btn-icon-plain", title: "Mover pra baixo" }, ["▼"]);
  if (index === 0) upBtn.disabled = true;
  if (index === total - 1) downBtn.disabled = true;
  upBtn.addEventListener("click", () => moveLocation(loc.id, -1));
  downBtn.addEventListener("click", () => moveLocation(loc.id, 1));

  const deleteBtn = el("button", { type: "button", class: "btn-icon-danger", title: "Excluir unidade" }, [
    el("span", { class: "nav-icon", "data-icon": "trash" }, []),
  ]);
  deleteBtn.addEventListener("click", async () => {
    if (!await showConfirm(`Excluir a unidade "${loc.name}"?`)) return;
    await api(`/clinic-locations/${loc.id}`, { method: "DELETE" });
    await loadClinicLocations();
  });

  const saveBtn = el("button", { type: "button", class: "btn-save" }, ["Salvar unidade"]);
  saveBtn.addEventListener("click", async () => {
    saveBtn.textContent = "Salvando...";
    await api(`/clinic-locations/${loc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameInput.value.trim(),
        googleMapsUrl: mapsInput.value.trim(),
        website: siteInput.value.trim(),
        timezone: tzInput.value.trim(),
        street: streetInput.value.trim(),
        number: numberInput.value.trim(),
        complement: complementInput.value.trim(),
        neighborhood: neighborhoodInput.value.trim(),
        city: cityInput.value.trim(),
        state: stateInput.value.trim(),
        zipCode: zipInput.value.trim(),
        country: countryInput.value.trim(),
        arrivalInstructions: arrivalInput.value.trim(),
        active: activeCheckbox.checked,
      }),
    });
    saveBtn.textContent = "Salvo!";
    setTimeout(() => (saveBtn.textContent = "Salvar unidade"), 1500);
  });

  return el("div", { class: "card location-card" }, [
    el("div", { class: "location-card-header" }, [
      nameInput,
      ...(index === 0 ? [el("span", { class: "badge-primary" }, ["PRINCIPAL"])] : []),
      el("span", { class: "spacer" }, []),
      upBtn,
      downBtn,
      el("label", { class: "active-toggle" }, [activeCheckbox, "Ativa"]),
      deleteBtn,
    ]),
    el("div", { class: "broadcast-form-row" }, [
      el("label", { style: "flex:1" }, ["Google Maps (opcional)", mapsInput]),
      el("label", { style: "flex:1" }, ["Website (opcional)", siteInput]),
    ]),
    el("div", { class: "broadcast-form-row" }, [el("label", { style: "flex:1" }, ["Fuso horário", tzInput])]),
    el("div", { class: "broadcast-form-row" }, [
      el("label", { style: "flex:3" }, ["Rua/Avenida", streetInput]),
      el("label", { style: "flex:1" }, ["Número", numberInput]),
    ]),
    el("div", { class: "broadcast-form-row" }, [
      el("label", { style: "flex:1" }, ["Complemento", complementInput]),
      el("label", { style: "flex:1" }, ["Bairro", neighborhoodInput]),
    ]),
    el("div", { class: "broadcast-form-row" }, [
      el("label", { style: "flex:1" }, ["Cidade", cityInput]),
      el("label", { style: "flex:1" }, ["Estado", stateInput]),
      el("label", { style: "flex:1" }, ["CEP", zipInput]),
      el("label", { style: "flex:1" }, ["País", countryInput]),
    ]),
    el("div", { class: "broadcast-form-row" }, [el("label", { style: "flex:1" }, ["Instruções de chegada (opcional)", arrivalInput])]),
    preview,
    el("div", { class: "broadcast-form-row", style: "margin-top:0.6rem" }, [saveBtn]),
  ]);
}

async function loadClinicLocations() {
  const locations = await api("/clinic-locations");
  const container = document.getElementById("clinic-locations-list");
  container.innerHTML = "";
  locations.forEach((loc, i) => container.appendChild(renderLocationCard(loc, i, locations.length)));
  paintIcons(container);
}

async function moveLocation(id, direction) {
  const locations = await api("/clinic-locations");
  const index = locations.findIndex((l) => l.id === id);
  const swapIndex = index + direction;
  if (swapIndex < 0 || swapIndex >= locations.length) return;

  const a = locations[index];
  const b = locations[swapIndex];
  await api(`/clinic-locations/${a.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: b.order }) });
  await api(`/clinic-locations/${b.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: a.order }) });
  await loadClinicLocations();
}

document.getElementById("btn-add-location").addEventListener("click", async () => {
  await api("/clinic-locations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nova unidade" }),
  });
  await loadClinicLocations();
});

// --- Canais (UAZAPI) ---
async function loadUazapiConfig() {
  const wrap = document.getElementById("channel-uazapi-config");
  const statusEl = document.getElementById("channel-uazapi-config-status");
  wrap.style.display = state.staff?.role === "admin" ? "block" : "none";
  if (state.staff?.role !== "admin") return;

  const config = await api("/whatsapp/config");
  document.getElementById("channel-uazapi-url").value = config.baseUrl || "";
  const tokenInput = document.getElementById("channel-uazapi-token");
  tokenInput.value = "";
  tokenInput.placeholder = config.configured && config.tokenHint
    ? `Token configurado (${config.tokenHint}); deixe vazio para manter`
    : "Cole o token da instância";
  statusEl.textContent = config.configured ? "Credenciais configuradas." : "Ainda não configurada.";
}

// Admin vê o erro real (pode citar o provedor, a URL ou o token); conta de
// clínica vê só uma orientação genérica.
function channelErrorText(error, fallback) {
  return state.staff?.role === "admin" && error.detail ? error.detail : fallback;
}

async function loadChannelStatus() {
  const status = await api("/whatsapp/status");
  const badge = document.getElementById("channel-status-badge");
  const qrWrap = document.getElementById("channel-qr-wrap");
  const qrImg = document.getElementById("channel-qr-img");
  const connectBtn = document.getElementById("btn-channel-connect");
  const disconnectBtn = document.getElementById("btn-channel-disconnect");
  const qrLoading = document.getElementById("channel-qr-loading");

  state.channelConnected = !!status.connected;

  if (!status.configured) {
    badge.textContent = "API não configurada";
    badge.className = "badge badge-red";
    qrWrap.style.display = "none";
    qrLoading.style.display = "none";
    connectBtn.style.display = "none";
    disconnectBtn.style.display = "none";
  } else if (status.connected) {
    badge.textContent = "Conectado";
    badge.className = "badge badge-green";
    qrWrap.style.display = "none";
    qrLoading.style.display = "none";
    connectBtn.style.display = "none";
    disconnectBtn.style.display = "inline-block";
  } else if (status.qr) {
    badge.textContent = "Aguardando leitura do QR Code";
    badge.className = "badge badge-neutral";
    qrImg.src = status.qr;
    qrWrap.style.display = "block";
    qrLoading.style.display = "none";
    connectBtn.textContent = "Gerar novo QR Code";
    connectBtn.style.display = "inline-block";
    disconnectBtn.style.display = "none";
  } else {
    badge.textContent = status.connecting ? "Conectando…" : status.lastError ? "Não foi possível conectar" : "Desconectado";
    badge.className = status.lastError && !status.connecting ? "badge badge-red" : "badge badge-neutral";
    qrWrap.style.display = "none";
    qrLoading.style.display = status.connecting ? "flex" : "none";
    connectBtn.textContent = "Gerar QR Code";
    connectBtn.style.display = "inline-block";
    disconnectBtn.style.display = "none";
  }

  // Contas de clínica não veem detalhes do provedor (URL/token/erros crus da
  // API): só uma orientação genérica. Admin vê a mensagem real pra diagnóstico.
  const errorEl = document.getElementById("channel-last-error");
  if (errorEl) {
    const isAdmin = state.staff?.role === "admin";
    if (!status.configured) {
      errorEl.textContent = isAdmin
        ? "Configure as credenciais da UAZAPI acima."
        : "Peça a um administrador para configurar.";
    } else if (!status.connecting && !status.connected && status.lastError) {
      errorEl.textContent = isAdmin
        ? status.lastError
        : "Não foi possível conectar. Um administrador precisa verificar a conexão.";
    } else {
      errorEl.textContent = "";
    }
  }

  await loadImportStatus();
}

const IMPORT_STAT_FIELDS = {
  found: "import-stat-found",
  created: "import-stat-created",
  merged: "import-stat-merged",
  ignored: "import-stat-ignored",
  conversations: "import-stat-conversations",
  partialHistory: "import-stat-partial",
  contactsInBase: "import-stat-total",
};

async function loadImportStatus() {
  const info = await api("/whatsapp/import-status");
  const statusEl = document.getElementById("channel-import-status");
  const statsWrap = document.getElementById("channel-import-stats");
  const updatedEl = document.getElementById("channel-import-updated");
  const importBtn = document.getElementById("btn-channel-import");

  if (info.stats) {
    statsWrap.style.display = "grid";
    for (const [key, elId] of Object.entries(IMPORT_STAT_FIELDS)) {
      document.getElementById(elId).textContent = info.stats[key] ?? 0;
    }
  } else {
    statsWrap.style.display = "none";
  }

  // Uma importação "running" parada há mais de 20 min é de um processo que
  // morreu (deploy/restart) — o servidor deixa disparar de novo, então o botão
  // também precisa voltar.
  const runningStale = info.status === "running" && info.updatedAt
    && Date.now() - new Date(info.updatedAt).getTime() > 20 * 60 * 1000;

  if (info.status === "running" && !runningStale) {
    statusEl.textContent = "Importando… isso pode levar alguns minutos.";
    importBtn.disabled = true;
  } else if (info.status === "failed" || runningStale) {
    importBtn.disabled = !state.channelConnected;
    statusEl.textContent = runningStale
      ? "A importação anterior não finalizou. Clique para tentar de novo."
      : "A importação falhou. Verifique a conexão e tente novamente.";
  } else {
    importBtn.disabled = !state.channelConnected;
    statusEl.textContent = info.status === "completed" ? "Importação concluída." : "";
  }

  updatedEl.textContent = info.updatedAt ? `Atualizado em ${new Date(info.updatedAt).toLocaleString("pt-BR")}` : "";
}

document.getElementById("btn-channel-import").addEventListener("click", async () => {
  const msg = "Importar os contatos e as conversas dos últimos 7 dias do WhatsApp? A conexão continuará ativa.";
  if (!(await showConfirm(msg))) return;
  const statusEl = document.getElementById("channel-import-status");
  try {
    await api("/whatsapp/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      silentStatuses: [400],
    });
    await loadChannelStatus();
  } catch (error) {
    if (error.status !== 400) throw error;
    statusEl.textContent = channelErrorText(error, "Não foi possível iniciar a importação.");
  }
});

function startChannelPolling() {
  stopChannelPolling();
  loadUazapiConfig();
  loadChannelStatus();
  state.channelPollHandle = setInterval(loadChannelStatus, 5000);
}

function stopChannelPolling() {
  if (state.channelPollHandle) {
    clearInterval(state.channelPollHandle);
    state.channelPollHandle = null;
  }
}

document.getElementById("btn-channel-connect").addEventListener("click", async () => {
  const btn = document.getElementById("btn-channel-connect");
  const errorEl = document.getElementById("channel-last-error");
  btn.disabled = true;
  errorEl.textContent = "";
  try {
    await api("/whatsapp/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      silentStatuses: [400],
    });
    await loadChannelStatus();
  } catch (error) {
    if (error.status !== 400) throw error;
    errorEl.textContent = channelErrorText(error, "Não foi possível gerar o QR Code. Um administrador precisa verificar a conexão.");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-channel-disconnect").addEventListener("click", async () => {
  if (!await showConfirm("Desconectar o WhatsApp dessa clínica? Vai precisar escanear o QR Code de novo pra reconectar.")) return;
  const errorEl = document.getElementById("channel-last-error");
  errorEl.textContent = "";
  try {
    await api("/whatsapp/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      silentStatuses: [400],
    });
    await loadChannelStatus();
  } catch (error) {
    if (error.status !== 400) throw error;
    errorEl.textContent = channelErrorText(error, "Não foi possível desconectar.");
  }
});

document.getElementById("btn-channel-uazapi-save").addEventListener("click", async () => {
  const button = document.getElementById("btn-channel-uazapi-save");
  const statusEl = document.getElementById("channel-uazapi-config-status");
  const baseUrl = document.getElementById("channel-uazapi-url").value.trim();
  const token = document.getElementById("channel-uazapi-token").value.trim();
  if (!baseUrl) return showError("Informe a URL da UAZAPI.");

  button.disabled = true;
  button.textContent = "Validando…";
  statusEl.textContent = "Consultando a instância…";
  try {
    const result = await api("/whatsapp/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, ...(token ? { token } : {}) }),
      silentStatuses: [400],
    });
    statusEl.textContent = result.webhookConfigured
      ? "Credenciais e webhook configurados."
      : "Credenciais salvas; falta configurar PUBLIC_BASE_URL/UAZAPI_WEBHOOK_SECRET no servidor.";
    await loadUazapiConfig();
    await loadChannelStatus();
  } catch (error) {
    if (error.status !== 400) throw error;
    statusEl.textContent = error.detail || "Não foi possível validar as credenciais da UAZAPI.";
  } finally {
    button.disabled = false;
    button.textContent = "Salvar e validar";
  }
});

// --- Bloqueios de agenda ---
async function loadScheduleBlocks() {
  const [blocks, professionals] = await Promise.all([api("/schedule-blocks"), api("/professionals")]);

  const profSelect = document.getElementById("bk-professional");
  profSelect.innerHTML = '<option value="">Clínica toda</option>';
  for (const p of professionals) profSelect.appendChild(el("option", { value: p.id }, [p.name]));

  const body = document.getElementById("blocks-body");
  body.innerHTML = "";
  const fmt = (d) => new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (const b of blocks) {
    const del = el("button", { type: "button", class: "btn-icon-danger", title: "Remover bloqueio" }, [
      el("span", { class: "nav-icon", "data-icon": "trash" }, []),
    ]);
    del.addEventListener("click", async () => {
      if (!await showConfirm("Remover esse bloqueio?")) return;
      await api(`/schedule-blocks/${b.id}`, { method: "DELETE" });
      loadScheduleBlocks();
    });
    body.appendChild(
      el("tr", {}, [
        el("td", {}, [`${fmt(b.startsAt)} — ${fmt(b.endsAt)}`]),
        el("td", {}, [b.professional?.name || "Clínica toda"]),
        el("td", {}, [b.reason || "—"]),
        el("td", {}, [del]),
      ])
    );
  }
  document.getElementById("blocks-empty").style.display = blocks.length ? "none" : "block";
}

document.getElementById("block-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const start = document.getElementById("bk-start").value;
  const end = document.getElementById("bk-end").value;
  if (!start || !end) return;
  if (new Date(end) <= new Date(start)) {
    showError("O fim do bloqueio precisa ser depois do início.");
    return;
  }
  await api("/schedule-blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      professionalId: document.getElementById("bk-professional").value || null,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      reason: document.getElementById("bk-reason").value.trim(),
    }),
  });
  e.target.reset();
  loadScheduleBlocks();
});

// --- Lista de espera ---
async function loadWaitlist() {
  const entries = await api("/waitlist");
  const body = document.getElementById("waitlist-body");
  body.innerHTML = "";
  const STATUS_LABEL = { waiting: "Aguardando", notified: "Vaga oferecida" };
  for (const w of entries) {
    const del = el("button", { type: "button", class: "btn-icon-danger", title: "Remover da lista" }, [
      el("span", { class: "nav-icon", "data-icon": "trash" }, []),
    ]);
    del.addEventListener("click", async () => {
      if (!await showConfirm("Tirar esse paciente da lista de espera?")) return;
      await api(`/waitlist/${w.id}`, { method: "DELETE" });
      loadWaitlist();
    });
    body.appendChild(
      el("tr", {}, [
        el("td", {}, [`${w.patient.name || w.patient.phone}`]),
        el("td", {}, [w.procedure?.name || "Qualquer"]),
        el("td", {}, [w.preferredNote || "—"]),
        el("td", {}, [STATUS_LABEL[w.status] || w.status]),
        el("td", {}, [new Date(w.createdAt).toLocaleDateString("pt-BR")]),
        el("td", {}, [del]),
      ])
    );
  }
  document.getElementById("waitlist-empty").style.display = entries.length ? "none" : "block";
}

// --- Navegacao das sub-abas de "Personalizar Alice" ---
const SETTINGS_SUB_LOADERS = {
  "clinic-data": () => {
    loadClinicDataForm();
    loadClinicLocations();
  },
  products: loadProducts,
  procedures: loadProcedures,
  staff: loadProfessionals,
  broadcasts: () => {
    loadBroadcastTargetOptions();
    loadBroadcasts();
  },
  "appt-reminder": loadReminderRules,
  "post-procedure": loadPostProcedureRules,
  renewal: loadRenewalRules,
  birthday: loadBirthdayRules,
  followup: loadFollowUpRules,
  blocks: loadScheduleBlocks,
  waitlist: loadWaitlist,
  history: () => loadActivityLog(true),
  funnel: loadStagesConfig,
  rules: loadPersonalize,
  clinics: loadClinicsList,
  channels: startChannelPolling,
  team: loadTeam,
};

function openSettingsSub(sub) {
  document.querySelectorAll("#settings-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  document.querySelectorAll(".settings-subpanel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`sub-${sub}`).classList.add("active");
  if (sub !== "channels") stopChannelPolling();
  SETTINGS_SUB_LOADERS[sub]?.();
}

document.getElementById("settings-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sub]");
  if (!btn) return;
  openSettingsSub(btn.dataset.sub);
});

function goToTab(tab) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`tab-${tab}`).classList.add("active");
}

document.getElementById("btn-goto-funnel-config").addEventListener("click", () => {
  goToTab("settings");
  openSettingsSub("funnel");
});

// --- Tour guiado ---
const TOUR_STEPS = [
  // ===== Visão geral =====
  { section: "Visão geral", tab: "dashboard", target: ".brand", title: "Bem-vindo(a) à Alice", desc: "Este guia percorre o painel inteiro, área por área, explicando o que cada função faz e como ela se conecta ao atendimento no WhatsApp. Leva uns 3 minutos. Use \"Anterior\" e \"Próximo\" para navegar e \"Encerrar tour\" para sair quando quiser — dá pra retomar depois clicando em \"Guia\", aqui embaixo na barra lateral." },
  { section: "Visão geral", tab: "dashboard", target: "#clinic-select", title: "Seletor de clínica", desc: "Se a sua conta tem mais de uma clínica, é aqui que você escolhe qual está gerenciando. Cada clínica tem WhatsApp, agenda, contatos, catálogo e regras próprios — nada é compartilhado. O nome da clínica ativa aparece logo acima, abaixo de \"Alice IA\"." },
  { section: "Visão geral", tab: "dashboard", target: ".side-nav", title: "Menu de navegação", desc: "O painel é dividido em quatro grupos: Início (a visão do dia), Clientes (Contatos, CRM e Chat), Operação (Agenda) e Conta (Personalizar Alice, onde fica toda a configuração). O menu fica sempre visível à esquerda — você vai voltar bastante a ele." },
  { section: "Visão geral", tab: "dashboard", target: "#btn-staff-session", title: "Quem está usando o painel", desc: "Marque aqui qual atendente está logado. Isso não substitui a senha do painel: serve para identificar quem assumiu cada conversa. Ao transferir um atendimento para uma pessoa no Chat, o nome que a equipe vê é o que estiver selecionado aqui. As contas da equipe são criadas em Personalizar Alice → Equipe." },
  { section: "Visão geral", tab: "dashboard", target: "#panel-ai-fab", title: "Ajuda da Alice", desc: "Dúvida sobre alguma função do painel? Clique em \"Precisa de ajuda?\" e pergunte com suas palavras. É uma assistente separada, só sobre como usar o painel — ela não responde pacientes nem altera a configuração." },
  { section: "Visão geral", tab: "dashboard", target: "#theme-toggle", title: "Tema claro e escuro", desc: "Alterna o painel entre o modo claro e o escuro. A preferência fica salva neste navegador." },

  // ===== Início =====
  { section: "Início", tab: "dashboard", target: "#dash-greeting", title: "Painel de Início", desc: "A primeira tela ao entrar: um resumo rápido de como o atendimento está indo. O selo \"Ativa\" à direita confirma que a Alice está no ar. Se aparecer outro status, verifique a conexão do WhatsApp em Personalizar Alice → Canais." },
  { section: "Início", tab: "dashboard", target: "#period-row", title: "Filtro de período", desc: "Escolha o intervalo — Hoje, Ontem, 7, 30 ou 90 dias. Os três indicadores e o gráfico logo abaixo se recalculam na hora para o período selecionado. O padrão é 30 dias." },
  { section: "Início", tab: "dashboard", target: ".stat-grid", title: "Indicadores do período", desc: "Três números lado a lado: contatos que a Alice atendeu, agendamentos que ela marcou e atendimentos concluídos. Dão a sensação de volume e de conversão sem precisar abrir relatório. \"Concluídos\" conta os agendamentos marcados como concluídos na Agenda." },
  { section: "Início", tab: "dashboard", target: ".dash-chart-card", title: "Atendimentos por dia", desc: "O volume de conversas dia a dia dentro do período escolhido. Picos e vales ajudam a enxergar os dias mais movimentados e planejar equipe e campanhas." },
  { section: "Início", tab: "dashboard", target: ".dash-calendar-card", title: "Calendário operacional", desc: "O mês em miniatura, com destaque nos dias que já têm agendamento. É só uma prévia — a agenda completa, com horários e edição, fica na aba Agenda." },

  // ===== Contatos =====
  { section: "Contatos", tab: "contacts", target: "#tab-contacts .page-header", title: "Base de contatos", desc: "Todo mundo que já falou com o WhatsApp da clínica entra aqui automaticamente, com nome, telefone, origem e data de entrada. É a lista mestre de pacientes e leads, e a fonte das campanhas e automações." },
  { section: "Contatos", tab: "contacts", target: "#btn-toggle-contact-form", title: "Adicionar contato manualmente", desc: "Para quem chegou por fora do WhatsApp — ligou, veio pelo balcão, indicação. Informe nome e telefone com DDI e DDD (ex: 5511999999999). A partir daí ele participa das campanhas e automações como qualquer outro contato." },
  { section: "Contatos", tab: "contacts", target: "#contacts-search", title: "Buscar contato", desc: "Filtra a lista por nome ou por telefone conforme você digita." },
  { section: "Contatos", tab: "contacts", target: "#tab-contacts .toolbar + .card", title: "Lista e ações", desc: "Cada linha é um contato. A coluna \"Origem\" mostra se ele veio do WhatsApp, de importação ou foi cadastrado à mão. O ícone de lixeira remove o contato — cuidado, isso apaga também o histórico dele." },

  // ===== CRM =====
  { section: "CRM", tab: "crm", target: "#crm-board", title: "Funil de vendas (kanban)", desc: "Cada card é um paciente; cada coluna é uma etapa da negociação. A Alice move os cards sozinha conforme a conversa evolui (por exemplo para \"Avaliação agendada\" quando marca um horário). Você também pode arrastar o card entre colunas ou trocar a etapa pelo seletor dentro dele." },
  { section: "CRM", tab: "crm", target: "#crm-search", title: "Buscar no funil", desc: "Encontra um card específico por nome ou telefone sem precisar varrer todas as colunas." },
  { section: "CRM", tab: "crm", target: "#btn-goto-funnel-config", title: "Configurar o funil", desc: "Atalho para a tela onde você cria, renomeia, recolore e reordena as colunas do funil. Vamos passar por ela mais adiante, em Personalizar Alice → Funil." },

  // ===== Chat =====
  { section: "Chat", tab: "chat", target: "#chat-filter-tabs", title: "Conversas por responsável", desc: "\"Alice\" mostra o que a IA está conduzindo sozinha; \"Humano\" mostra o que já foi assumido pela equipe; \"Todos\" junta tudo. Serve para ver rápido o que precisa de gente. Os números entre parênteses são a contagem de cada fila." },
  { section: "Chat", tab: "chat", target: ".chat-list-pane", title: "Lista de conversas", desc: "As conversas em andamento, mais recentes no topo. Clique em uma para abrir as mensagens ao lado." },
  { section: "Chat", tab: "chat", target: "#chat-window", title: "Assumir e devolver a conversa", desc: "Ao abrir uma conversa aparece o botão de assumir o atendimento: enquanto você está no controle, a Alice para de responder aquele paciente e você digita direto pelo campo de mensagem. Ao devolver, a Alice retoma de onde parou. Pelo cabeçalho da conversa também dá pra abrir o cadastro do contato e preencher dados como a data de nascimento (usada na automação de aniversário)." },

  // ===== Agenda =====
  { section: "Agenda", tab: "agenda", target: "#agenda-view-toggle", title: "Visões da agenda", desc: "Alterna entre Hoje, Semana e Mês. \"Hoje\" e \"Semana\" mostram a grade por horário; \"Mês\" mostra a lista de todos os agendamentos do período." },
  { section: "Agenda", tab: "agenda", target: "#btn-toggle-appt-form", title: "Agendar manualmente", desc: "Marque um horário na mão informando paciente, telefone, procedimento e data/hora — útil para encaixes feitos por telefone. Os agendamentos que a Alice fecha no WhatsApp aparecem aqui automaticamente." },
  { section: "Agenda", tab: "agenda", target: "#agenda-grid-wrap", title: "Grade de horários", desc: "Cada bloco é um atendimento. Clique num bloco para editar procedimento, profissional responsável, data/hora ou status. É o status \"Concluído\" que alimenta o indicador de atendimentos concluídos no Início e libera as automações de pós-procedimento e renovação; \"Cancelado\" tira o horário da agenda." },

  // ===== Personalizar Alice =====
  { section: "Personalizar Alice", tab: "settings", sub: "clinic-data", target: "#settings-tabs", title: "Central de configuração", desc: "Tudo o que a Alice sabe e faz é ajustado nessas abas. Vamos passar pelas principais em ordem. Não precisa preencher tudo de uma vez — o mínimo para começar é: Dados da clínica, Procedimentos e Canais. O resto pode vir depois." },

  { section: "Dados da clínica", tab: "settings", sub: "clinic-data", target: "#clinic-data-form", title: "Dados e horário de funcionamento", desc: "Nome, fuso horário, horário e dias de expediente. É a base de tudo: as automações só disparam dentro desse horário, e a Alice usa os dias de atendimento para não oferecer agendamento com a clínica fechada. O número do WhatsApp se preenche sozinho quando você conecta o aparelho em Canais." },
  { section: "Dados da clínica", tab: "settings", sub: "clinic-data", target: "#cd-persona", title: "Como a Alice se apresenta", desc: "A Alice nunca diz que é robô, IA ou atendimento automático. Aqui você escolhe a identidade dela: parte da equipe da clínica, secretária da clínica ou secretária de um profissional específico (nesse caso, informe o nome ao lado)." },
  { section: "Dados da clínica", tab: "settings", sub: "clinic-data", target: "#cd-notify-phone", title: "Avisos no seu WhatsApp", desc: "Informe um número para receber alertas de agendamento novo, remarcação, cancelamento e transferência para humano, e marque quais desses eventos quer receber. Os avisos saem pelo próprio WhatsApp conectado. Deixe em branco para desativar." },
  { section: "Dados da clínica", tab: "settings", sub: "clinic-data", target: "#clinic-locations-list", title: "Endereço e unidades", desc: "Preencha o endereço que a Alice envia ao paciente. Se a operação tem mais de um endereço, use \"Adicionar outra unidade\"." },

  { section: "Catálogo", tab: "settings", sub: "procedures", target: "#sub-procedures", title: "Procedimentos", desc: "O catálogo de serviços é o coração do atendimento: a Alice só oferece, explica e agenda o que está cadastrado aqui. Em cada procedimento você define valor, formas de pagamento, duração e — importante — objetivos/queixas atendidas e benefícios que podem ser afirmados, que ensinam a Alice a ligar frases como \"meu rosto parece cansado\" ao serviço certo sem inventar indicação." },
  { section: "Catálogo", tab: "settings", sub: "products", target: "#sub-products", title: "Produtos", desc: "Itens vendidos além dos procedimentos (dermocosméticos, pacotes): nome, valor, foto e descrição. A Alice usa para responder dúvidas de preço e indicação de produto." },
  { section: "Catálogo", tab: "settings", sub: "staff", target: "#sub-staff", title: "Profissionais", desc: "Quem atende, com foto, bio, Instagram, cor de identificação na agenda e a lista de procedimentos que cada um realiza. A Alice usa isso para encaixar o agendamento com o profissional certo." },

  { section: "Canais", tab: "settings", sub: "channels", target: ".channel-card", title: "Conexão do WhatsApp", desc: "É aqui que você conecta o número da clínica: clique em \"Gerar QR Code\" e escaneie pelo celular em WhatsApp → Aparelhos conectados → Conectar um aparelho. O selo mostra o status da conexão; se cair, é aqui que você reconecta. O pareamento expira em cerca de 2 minutos — gere um novo QR se precisar." },
  { section: "Canais", tab: "settings", sub: "channels", target: "#btn-channel-import", title: "Importar histórico do WhatsApp", desc: "Traz contatos e conversas dos últimos 7 dias do número conectado. As mensagens antigas entram como lidas e a Alice não responde a elas — serve só para você ter o contexto de quem já vinha conversando antes da conexão." },

  { section: "Automações", tab: "settings", sub: "broadcasts", target: "#sub-broadcasts", title: "Mensagens Programadas", desc: "Disparos pontuais para toda a base, para uma etapa do funil ou para contatos escolhidos a dedo. O envio é feito aos poucos e só dentro do horário comercial, para não queimar o número. Use variáveis como {primeiro_nome} para personalizar o texto." },
  { section: "Automações", tab: "settings", sub: "appt-reminder", target: "#sub-appt-reminder", title: "Lembrete de Consulta", desc: "Mensagens automáticas antes do horário marcado (1h, 24h, 48h antes...) para reduzir faltas. É possível manter vários lembretes ativos ao mesmo tempo, em janelas diferentes." },
  { section: "Automações", tab: "settings", sub: "post-procedure", target: "#sub-post-procedure", title: "Pós-procedimento", desc: "Contato de cuidados e acompanhamento até 30 dias depois do atendimento. Dá para restringir a procedimentos específicos e disparar somente quando o atendimento estiver marcado como concluído." },
  { section: "Automações", tab: "settings", sub: "renewal", target: "#sub-renewal", title: "Renovação", desc: "Retoma o contato meses ou anos depois (3 meses, 1 ano, 2 anos...) para reagendar procedimentos com validade, como toxina botulínica. É o que traz o paciente de volta sem você precisar lembrar de cada um." },
  { section: "Automações", tab: "settings", sub: "birthday", target: "#sub-birthday", title: "Aniversário", desc: "Mensagem de parabéns automática no dia, no horário que você escolher. Depende da data de nascimento preenchida no cadastro do contato (você preenche isso pelo cabeçalho da conversa, na aba Chat)." },
  { section: "Automações", tab: "settings", sub: "followup", target: "#sub-followup", title: "Recontato", desc: "Quando um lead some no meio da conversa, a Alice cutuca depois de um tempo sem resposta. Reinicia sozinho se ele voltar a falar e não incomoda quem já fechou, já foi dado como perdido ou já tem horário marcado. Você define o tempo de silêncio, a janela de horário e se repete a cada novo silêncio ou só uma vez." },
  { section: "Automações", tab: "settings", sub: "funnel", target: "#sub-funnel", title: "Funil", desc: "As colunas do CRM. Cada etapa tem nome, cor e um \"tipo\" (aberta, avaliação agendada, ganho, pós-procedimento, perdido) — é o tipo que diz à Alice e às automações o que aquela etapa significa. Adicione, renomeie, recolore, reordene ou remova etapas por aqui." },
  { section: "Agenda", tab: "settings", sub: "blocks", target: "#sub-blocks", title: "Bloqueios de agenda", desc: "Feriado, folga de um profissional, almoço, congresso, manutenção de equipamento. A Alice não oferece nem aceita agendamento nos períodos bloqueados. Pode bloquear a clínica inteira ou só um profissional." },
  { section: "Agenda", tab: "settings", sub: "waitlist", target: "#sub-waitlist", title: "Lista de espera", desc: "Quando o paciente pede um horário lotado e topa esperar, a Alice o coloca aqui. Se abrir vaga por cancelamento, ela avisa automaticamente o primeiro da fila compatível (mesmo procedimento e, quando faz sentido, mesmo profissional)." },

  { section: "Inteligência da Alice", tab: "settings", sub: "rules", rt: "home", target: "#rule-form", title: "Ensinar a Alice em uma frase", desc: "A forma mais rápida de ajustar o comportamento: escreva o que você quer (\"nunca passe preço de preenchimento antes da avaliação\"), a Alice entende, classifica e monta a regra, e você só revisa e aprova. As sugestões pendentes aparecem logo abaixo do campo." },
  { section: "Inteligência da Alice", tab: "settings", sub: "rules", rt: "global", target: "#rt-global", title: "Regras globais", desc: "O que a Alice deve respeitar em toda conversa: tom de voz, política de preço, quando chamar a equipe, o que nunca fazer. Já vêm algumas recomendadas prontas — o botão \"Restaurar recomendadas\" traz elas de volta caso você apague sem querer." },
  { section: "Inteligência da Alice", tab: "settings", sub: "rules", rt: "templates", target: "#rt-templates", title: "Mensagens prontas", desc: "Textos que a Alice reaproveita no atendimento (boas-vindas, confirmação, orientações). Você escolhe se ela pode adaptar o texto ao contexto ou se deve enviar exatamente como está. Aceita variáveis como {primeiro_nome}." },
  { section: "Inteligência da Alice", tab: "settings", sub: "rules", rt: "faq", target: "#rt-faq", title: "FAQ da clínica", desc: "Perguntas operacionais e suas respostas oficiais: estacionamento, acesso, documentos, políticas. Preço, agenda e catálogo continuam vindo das fontes oficiais — a FAQ cobre o resto." },
  { section: "Inteligência da Alice", tab: "settings", sub: "rules", rt: "settings", target: "#alice-settings-form", title: "Ajustes da Alice", desc: "Nome da secretária, área de atuação da clínica, a frase usada ao passar a conversa para uma pessoa, se ela divide respostas longas em várias bolhas e se exige comprovante do sinal antes de confirmar o horário." },
  { section: "Inteligência da Alice", tab: "settings", sub: "rules", rt: "playbooks", target: "#rt-playbooks", title: "Roteiros", desc: "Sequências passo a passo que a Alice segue em situações específicas (primeiro atendimento, objeções, remarcação...). Você define o gatilho, o objetivo e os passos, e ela conduz a conversa nessa ordem." },

  { section: "Conta", tab: "settings", sub: "history", target: "#sub-history", title: "Histórico de atividades", desc: "Registro do que mudou na clínica: o que aconteceu, quem fez e quando. Filtre por tipo de evento ou por área. Útil para auditar mudanças e entender um comportamento novo da Alice." },
  { section: "Conta", tab: "settings", sub: "clinics", target: "#sub-clinics", title: "Clínicas", desc: "Cadastre outras clínicas, cada uma com sua própria conexão de WhatsApp e configuração independente. O seletor no topo da barra lateral troca entre elas." },
  { section: "Conta", tab: "settings", sub: "team", target: "#sub-team", title: "Equipe", desc: "Contas individuais para os atendentes. Quando alguém está logado com a própria conta, as transferências no Chat mostram o nome certo. Não substitui a senha principal do painel." },

  // ===== Fim =====
  { section: "Fim", tab: "dashboard", target: "#btn-guide", title: "Pronto, você viu o painel inteiro", desc: "Um caminho sugerido para começar: 1) Dados da clínica e horário; 2) Procedimentos; 3) conectar o WhatsApp em Canais; 4) revisar as Regras globais; 5) ligar as automações que fizerem sentido. Clique em \"Guia\" quando quiser rever qualquer parte." },
];

let tourIndex = 0;

function positionTour(target) {
  const rect = target.getBoundingClientRect();
  const pad = 6;
  const spot = document.getElementById("tour-spotlight");
  spot.style.top = `${rect.top - pad}px`;
  spot.style.left = `${rect.left - pad}px`;
  spot.style.width = `${rect.width + pad * 2}px`;
  spot.style.height = `${rect.height + pad * 2}px`;

  const pop = document.getElementById("tour-popover");
  const pr = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 14;
  const margin = 12;

  let top;
  let left;
  if (vh - rect.bottom >= pr.height + gap + margin) {
    top = rect.bottom + gap;
    left = rect.left;
  } else if (rect.top >= pr.height + gap + margin) {
    top = rect.top - gap - pr.height;
    left = rect.left;
  } else if (vw - rect.right >= pr.width + gap + margin) {
    left = rect.right + gap;
    top = rect.top;
  } else {
    left = rect.left - gap - pr.width;
    top = (vh - pr.height) / 2;
  }

  left = Math.max(margin, Math.min(left, vw - pr.width - margin));
  top = Math.max(margin, Math.min(top, vh - pr.height - margin));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function showTourStep(i, dir = 1) {
  const step = TOUR_STEPS[i];
  if (!step) {
    endTour();
    return;
  }
  tourIndex = i;

  goToTab(step.tab);
  if (step.sub) openSettingsSub(step.sub);
  if (step.rt) {
    document.querySelector(`#rules-tabs button[data-rt="${step.rt}"]`)?.click();
  }

  const render = () => {
    const target = document.querySelector(step.target);
    if (!target) {
      const next = i + (dir < 0 ? -1 : 1);
      if (next >= 0 && next < TOUR_STEPS.length) showTourStep(next, dir);
      else endTour();
      return;
    }
    target.scrollIntoView({ block: "center" });

    document.getElementById("tour-step-label").textContent = `${step.section} · Passo ${i + 1}/${TOUR_STEPS.length}`;
    document.getElementById("tour-title").textContent = step.title;
    document.getElementById("tour-desc").textContent = step.desc;
    document.getElementById("tour-prev").style.visibility = i === 0 ? "hidden" : "visible";
    document.getElementById("tour-next").textContent = i === TOUR_STEPS.length - 1 ? "Concluir" : "Próximo";
    const bar = document.getElementById("tour-progress-bar");
    if (bar) bar.style.width = `${((i + 1) / TOUR_STEPS.length) * 100}%`;

    requestAnimationFrame(() => positionTour(target));
  };

  requestAnimationFrame(() => requestAnimationFrame(render));
}

function startTour() {
  tourIndex = 0;
  document.getElementById("tour-overlay").style.display = "block";
  showTourStep(0);
}

function endTour() {
  document.getElementById("tour-overlay").style.display = "none";
}

document.getElementById("btn-guide").addEventListener("click", startTour);
document.getElementById("tour-next").addEventListener("click", () => {
  if (tourIndex >= TOUR_STEPS.length - 1) {
    endTour();
    return;
  }
  showTourStep(tourIndex + 1, 1);
});
document.getElementById("tour-prev").addEventListener("click", () => {
  if (tourIndex <= 0) return;
  showTourStep(tourIndex - 1, -1);
});
document.getElementById("tour-end").addEventListener("click", endTour);
window.addEventListener("resize", () => {
  if (document.getElementById("tour-overlay").style.display === "block") {
    const step = TOUR_STEPS[tourIndex];
    const target = step && document.querySelector(step.target);
    if (target) positionTour(target);
  }
});

// --- Assistente de ajuda do painel (a rota exige a mesma sessao do usuario) ---
(function initPanelAssistant() {
  const fab = document.getElementById("panel-ai-fab");
  const windowEl = document.getElementById("panel-ai-window");
  const closeButton = document.getElementById("panel-ai-close");
  const messagesEl = document.getElementById("panel-ai-messages");
  const form = document.getElementById("panel-ai-form");
  const input = document.getElementById("panel-ai-text");
  const submitButton = form.querySelector('button[type="submit"]');
  const history = [];
  let greeted = false;
  let busy = false;

  function scrollMessages() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addAssistantMessage(role, text) {
    const message = document.createElement("div");
    message.className = `panel-ai-message panel-ai-message--${role}`;
    message.textContent = text;
    messagesEl.appendChild(message);
    scrollMessages();
    return message;
  }

  function setAssistantOpen(open) {
    windowEl.classList.toggle("is-open", open);
    fab.classList.toggle("is-open", open);
    fab.setAttribute("aria-expanded", open ? "true" : "false");
    windowEl.setAttribute("aria-hidden", open ? "false" : "true");
    if (!open) return;

    if (!greeted) {
      greeted = true;
      addAssistantMessage(
        "assistant",
        "Oi! Posso explicar qualquer parte do painel da Alice: conexao do WhatsApp, agenda, CRM, mensagens, automacoes e configuracoes. Como posso ajudar?"
      );
    }
    setTimeout(() => input.focus(), 50);
  }

  fab.addEventListener("click", () => setAssistantOpen(!windowEl.classList.contains("is-open")));
  closeButton.addEventListener("click", () => setAssistantOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && windowEl.classList.contains("is-open")) setAssistantOpen(false);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;

    input.value = "";
    addAssistantMessage("user", text);
    history.push({ role: "user", content: text });
    busy = true;
    input.disabled = true;
    submitButton.disabled = true;

    const typing = document.createElement("div");
    typing.className = "panel-ai-message panel-ai-message--assistant panel-ai-typing";
    typing.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(typing);
    scrollMessages();

    try {
      const result = await api("/assistant/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-10) }),
        silentStatuses: [429, 502],
      });
      typing.remove();
      const reply = result.reply || "Nao consegui responder agora. Tente novamente em instantes.";
      addAssistantMessage("assistant", reply);
      if (result.reply) history.push({ role: "assistant", content: result.reply });
    } catch {
      typing.remove();
      addAssistantMessage("assistant", "Nao consegui responder agora. Tente novamente em instantes.");
    } finally {
      busy = false;
      input.disabled = false;
      submitButton.disabled = false;
      input.focus();
    }
  });
})();

checkAuthAndBoot();
