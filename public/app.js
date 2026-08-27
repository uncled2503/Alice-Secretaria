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
  if (!confirm(`Sair da conta de ${state.staff.name}?`)) return;
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
  if (!confirm(`Excluir o contato ${label}? Isso apaga o histórico de conversas e agendamentos dele. Não pode ser desfeito.`)) return;
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
      if (!confirm(`Remover a etapa "${stage.label}"? Pacientes nela vão pra primeira etapa restante.`)) return;
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
        el("div", { class: "t" }, [when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })]),
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
      el("td", {}, [a.status]),
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
  await api(`/appointments/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ procedureId, professionalId, scheduledAt: new Date(when).toISOString(), status }),
  });
  closeApptEditModal();
  await loadAgenda();
});

document.getElementById("appt-edit-delete").addEventListener("click", async () => {
  const id = state.editingAppointmentId;
  if (!id) return;
  if (!confirm("Excluir este agendamento? Não pode ser desfeito.")) return;
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

// --- Recontato ---
async function loadFollowUpRules() {
  const rules = await api("/followup-rules");
  const body = document.getElementById("followup-body");
  body.innerHTML = "";

  for (const rule of rules) {
    const daysInput = el("input", { type: "number", min: "1" });
    daysInput.value = rule.afterDays;

    const messageArea = el("textarea", {});
    messageArea.value = rule.message;

    const activeCheckbox = el("input", { type: "checkbox" });
    activeCheckbox.checked = rule.active;

    const saveBtn = el("button", { class: "btn-save" }, ["Salvar"]);
    saveBtn.addEventListener("click", async () => {
      saveBtn.textContent = "Salvando...";
      await api(`/followup-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          afterDays: Number(daysInput.value),
          message: messageArea.value,
          active: activeCheckbox.checked,
        }),
      });
      saveBtn.textContent = "Salvo!";
      setTimeout(() => (saveBtn.textContent = "Salvar"), 1500);
    });

    const deleteBtn = el("button", { type: "button", class: "btn-icon-danger", title: "Excluir etapa" }, [
      el("span", { class: "nav-icon", "data-icon": "trash" }, []),
    ]);
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Excluir a etapa de recontato ${rule.order}?`)) return;
      await api(`/followup-rules/${rule.id}`, { method: "DELETE" });
      await loadFollowUpRules();
    });

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [`Follow-up ${rule.order}`]),
        el("td", {}, [daysInput]),
        el("td", {}, [messageArea]),
        el("td", {}, [activeCheckbox]),
        el("td", { class: "actions" }, [saveBtn, deleteBtn]),
      ])
    );
  }
  paintIcons(body);
}

document.getElementById("followup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const afterDays = Number(document.getElementById("fu-days").value);
  const message = document.getElementById("fu-message").value.trim();
  if (!afterDays || !message) return;

  await api("/followup-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ afterDays, message }),
  });

  e.target.reset();
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

// --- Personalizar Alice (regras em linguagem natural) ---
let RULE_CATEGORY_LABELS = {};

async function loadRules() {
  if (Object.keys(RULE_CATEGORY_LABELS).length === 0) {
    const categories = await api("/rules/categories");
    RULE_CATEGORY_LABELS = Object.fromEntries(categories.map((c) => [c.id, c.label]));
  }

  const rules = await api("/rules");
  const pendingBox = document.getElementById("rules-pending");
  const activeBox = document.getElementById("rules-active");
  pendingBox.innerHTML = "";
  activeBox.innerHTML = "";

  for (const rule of rules) {
    if (rule.status === "active") {
      const discardBtn = el("button", { class: "btn-discard" }, ["Remover"]);
      discardBtn.addEventListener("click", async () => {
        await api(`/rules/${rule.id}`, { method: "DELETE" });
        await loadRules();
      });
      activeBox.appendChild(
        el("div", { class: "rule-card" }, [
          el("div", { class: "category" }, [RULE_CATEGORY_LABELS[rule.category] ?? rule.category]),
          el("div", { class: "instruction" }, [rule.instruction ?? ""]),
          el("div", { class: "actions" }, [discardBtn]),
        ])
      );
    } else {
      const isQuestion = rule.status === "needs_clarification";
      const discardBtn = el("button", { class: "btn-discard" }, ["Descartar"]);
      discardBtn.addEventListener("click", async () => {
        await api(`/rules/${rule.id}`, { method: "DELETE" });
        await loadRules();
      });

      const children = [
        el("div", { class: "category" }, [isQuestion ? "Precisa da sua atenção" : "Sugestão pendente"]),
        el("div", { class: "raw" }, [`Você disse: "${rule.rawInput}"`]),
      ];

      if (isQuestion) {
        children.push(el("div", { class: "question" }, [rule.clarifyingQuestion]));
        children.push(
          el("div", { class: "hint" }, ["Descreva de novo lá em cima, já respondendo essa pergunta."])
        );
      } else {
        const approveBtn = el("button", { class: "btn-approve" }, ["Aprovar"]);
        approveBtn.addEventListener("click", async () => {
          await api(`/rules/${rule.id}/approve`, { method: "POST" });
          await loadRules();
        });
        children.push(el("div", { class: "instruction" }, [`${RULE_CATEGORY_LABELS[rule.category] ?? rule.category}: ${rule.instruction}`]));
        children.push(el("div", { class: "actions" }, [approveBtn, discardBtn]));
      }
      if (isQuestion) children.push(el("div", { class: "actions" }, [discardBtn]));

      pendingBox.appendChild(el("div", { class: "rule-card pending" }, children));
    }
  }
}

document.getElementById("rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const textArea = document.getElementById("rule-text");
  const text = textArea.value.trim();
  if (!text) return;

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.textContent = "Pensando...";
  submitBtn.disabled = true;
  try {
    await api("/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    textArea.value = "";
    await loadRules();
  } finally {
    submitBtn.textContent = "Gerar sugestão";
    submitBtn.disabled = false;
  }
});


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
  if (!id || !confirm("Remover esse procedimento?")) return;
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
  if (!id || !confirm("Remover esse produto?")) return;
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
  if (!id || !confirm("Remover esse profissional?")) return;
  await api(`/professionals/${id}`, { method: "DELETE" });
  closeProfessionalModal();
  await loadProfessionals();
});

document.getElementById("professional-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("pf-id").value;
  const activeColor = document.querySelector("#pf-color-grid .color-swatch.active");
  const payload = {
    name: document.getElementById("pf-name").value.trim(),
    instagram: document.getElementById("pf-instagram").value.trim(),
    bio: document.getElementById("pf-bio").value.trim(),
    color: activeColor ? activeColor.dataset.color : "",
    photoUrl: pendingProfessionalPhoto,
    active: document.getElementById("pf-active").checked,
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
      if (!confirm(`Tem certeza que quer ${action} o acesso de "${c.name}"?`)) return;
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
      if (!confirm(`Excluir a clínica "${c.name}"? Só funciona se ela estiver vazia (sem contato nem conta de equipe).`)) return;
      await api(`/clinics/${c.id}`, { method: "DELETE" });
      await loadClinicsList();
    });

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [c.name]),
        el("td", {}, [c.whatsappPhone]),
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
        el("td", { class: "actions" }, [toggleBtn, deleteBtn]),
      ])
    );
  }
  paintIcons(body);
}

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
      if (!confirm(`Remover a conta de ${t.name}?`)) return;
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
}

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
  if (!id || !name || !whatsappPhone.replace(/\D/g, "")) return;

  await api(`/clinics/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, whatsappPhone, timezone, workStartHour, workEndHour, workDays, notifyPhone, notifyEvents }),
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
    if (!confirm(`Excluir a unidade "${loc.name}"?`)) return;
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

// --- Canais (conexao WhatsApp direta, sem gateway externo) ---
async function loadChannelStatus() {
  const status = await api("/whatsapp/status");
  const badge = document.getElementById("channel-status-badge");
  const qrWrap = document.getElementById("channel-qr-wrap");
  const qrImg = document.getElementById("channel-qr-img");
  const connectBtn = document.getElementById("btn-channel-connect");
  const disconnectBtn = document.getElementById("btn-channel-disconnect");
  const qrLoading = document.getElementById("channel-qr-loading");

  if (status.connected) {
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
    badge.textContent = status.connecting ? "Conectando…" : "Desconectado";
    badge.className = "badge badge-neutral";
    qrWrap.style.display = "none";
    qrLoading.style.display = status.connecting ? "flex" : "none";
    connectBtn.textContent = "Gerar QR Code";
    connectBtn.style.display = "inline-block";
    disconnectBtn.style.display = "none";
  }

  document.getElementById("btn-channel-import").disabled = !status.connected;
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

  if (info.status === "running") {
    statusEl.textContent = "Importando… isso pode levar alguns minutos.";
    importBtn.disabled = true;
  } else {
    if (!importBtn.disabled) importBtn.disabled = false;
    statusEl.textContent = info.status === "completed" ? "Importação concluída." : "";
  }

  updatedEl.textContent = info.updatedAt ? `Atualizado em ${new Date(info.updatedAt).toLocaleString("pt-BR")}` : "";
}

document.getElementById("btn-channel-import").addEventListener("click", async () => {
  if (!confirm("Isso vai reconectar o WhatsApp rapidamente (sem precisar de novo QR Code) pra buscar contatos e até 30 dias de conversas. Continuar?")) return;
  await api("/whatsapp/import", { method: "POST" });
  await loadImportStatus();
});

function startChannelPolling() {
  stopChannelPolling();
  loadChannelStatus();
  state.channelPollHandle = setInterval(loadChannelStatus, 2500);
}

function stopChannelPolling() {
  if (state.channelPollHandle) {
    clearInterval(state.channelPollHandle);
    state.channelPollHandle = null;
  }
}

document.getElementById("btn-channel-connect").addEventListener("click", async () => {
  await api("/whatsapp/connect", { method: "POST" });
  await loadChannelStatus();
});

document.getElementById("btn-channel-disconnect").addEventListener("click", async () => {
  if (!confirm("Desconectar o WhatsApp dessa clínica? Vai precisar escanear o QR Code de novo pra reconectar.")) return;
  await api("/whatsapp/disconnect", { method: "POST" });
  await loadChannelStatus();
});

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
  followup: loadFollowUpRules,
  funnel: loadStagesConfig,
  rules: loadRules,
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
  { tab: "dashboard", target: ".brand", title: "Bem-vindo(a) à Alice", desc: "Esse tour mostra rapidinho onde fica cada função do painel. Dá pra sair a qualquer momento em \"Encerrar tour\"." },
  { tab: "dashboard", target: "#period-row", title: "Filtro de período", desc: "Escolha o intervalo (hoje, 7 dias, 30 dias...) pra recalcular os indicadores abaixo." },
  { tab: "dashboard", target: ".stat-grid", title: "Métricas rápidas", desc: "Quantos contatos a Alice atendeu, quantos agendamentos e quantos atendimentos concluídos no período escolhido." },
  { tab: "dashboard", target: ".dash-columns", title: "Gráfico e calendário", desc: "Volume de atendimentos por dia, e um calendário do mês com os dias que têm agendamento marcado." },
  { tab: "contacts", target: "#tab-contacts .toolbar", title: "Contatos", desc: "Base de pacientes/leads. Busque por nome ou telefone, ou adicione um contato manualmente (ex: alguém que ligou)." },
  { tab: "crm", target: "#crm-board", title: "CRM", desc: "Funil kanban do paciente. Arraste o card entre as colunas pra mudar a etapa, ou use o dropdown dentro do card." },
  { tab: "chat", target: "#chat-window", title: "Chat", desc: "Veja as conversas em andamento. Dá pra assumir uma conversa manualmente e a Alice para de responder ali até você devolver o controle." },
  { tab: "agenda", target: "#agenda-grid-wrap", title: "Agenda", desc: "Calendário com os agendamentos por horário. Use Hoje/Semana/Mês pra mudar a visão, ou agende manualmente pelo botão no topo." },
  { tab: "settings", sub: "clinic-data", target: "#sub-clinic-data", title: "Personalizar Alice", desc: "Essa área reúne toda a configuração da clínica. Aqui em \"Dados da clínica\" ficam nome e horário de funcionamento — usado pelas mensagens automáticas." },
  { tab: "settings", sub: "procedures", target: "#sub-procedures", title: "Procedimentos", desc: "O catálogo que a Alice usa pra saber o que oferecer e agendar." },
  { tab: "settings", sub: "broadcasts", target: "#sub-broadcasts", title: "Mensagens Programadas", desc: "Campanhas avulsas pra base de contatos ou um estágio específico do funil, enviadas aos poucos dentro do horário comercial." },
  { tab: "settings", sub: "followup", target: "#sub-followup", title: "Recontato", desc: "Cascata de mensagens automáticas quando um lead fica dias sem responder — reinicia sozinha se ele voltar a falar." },
  { tab: "settings", sub: "funnel", target: "#sub-funnel", title: "Funil", desc: "Configure as etapas do CRM: adicione, renomeie, recolorir ou remova." },
  { tab: "settings", sub: "channels", target: "#sub-channels", title: "Canais", desc: "Status da conexão do WhatsApp dessa clínica. Gere o QR Code aqui mesmo e escaneie com o celular pra conectar." },
  { tab: "settings", sub: "clinics", target: "#sub-clinics", title: "Clínicas", desc: "Cadastre mais clínicas, cada uma com seu próprio WhatsApp — o seletor no topo da sidebar troca entre elas." },
  { tab: "dashboard", target: "#theme-toggle", title: "Tour concluído", desc: "É só isso! Clique em \"Guia\" a qualquer momento pra rever esse tour." },
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
  const popWidth = 300;
  let top = rect.bottom + 14;
  if (top + 160 > window.innerHeight) top = Math.max(12, rect.top - 174);
  let left = Math.min(rect.left, window.innerWidth - popWidth - 16);
  left = Math.max(12, left);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function showTourStep(i) {
  const step = TOUR_STEPS[i];
  if (!step) {
    endTour();
    return;
  }

  goToTab(step.tab);
  if (step.sub) openSettingsSub(step.sub);

  requestAnimationFrame(() => {
    const target = document.querySelector(step.target);
    if (!target) {
      tourIndex = i + 1;
      showTourStep(tourIndex);
      return;
    }
    target.scrollIntoView({ block: "center" });
    positionTour(target);

    document.getElementById("tour-step-label").textContent = `PASSO ${i + 1}/${TOUR_STEPS.length}`;
    document.getElementById("tour-title").textContent = step.title;
    document.getElementById("tour-desc").textContent = step.desc;
    document.getElementById("tour-prev").style.visibility = i === 0 ? "hidden" : "visible";
    document.getElementById("tour-next").textContent = i === TOUR_STEPS.length - 1 ? "Concluir" : "Próximo";
  });
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
  tourIndex++;
  showTourStep(tourIndex);
});
document.getElementById("tour-prev").addEventListener("click", () => {
  if (tourIndex <= 0) return;
  tourIndex--;
  showTourStep(tourIndex);
});
document.getElementById("tour-end").addEventListener("click", endTour);
window.addEventListener("resize", () => {
  if (document.getElementById("tour-overlay").style.display === "block") {
    const step = TOUR_STEPS[tourIndex];
    const target = step && document.querySelector(step.target);
    if (target) positionTour(target);
  }
});

checkAuthAndBoot();
