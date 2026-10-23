// Aba DISPAROS: o que a Alice devia enviar x o que foi tentado/aceito/entregue, com o motivo de cada pendencia e a recuperacao segura (fila persistida no servidor).
// Tudo que vem do servidor entra na tela por textContent (nunca innerHTML): nomes e detalhes sao dados de pessoas.
(function () {
  "use strict";

  const KIND_LABEL = { confirmacao: "Confirmação", cobranca: "Cobrança", lembrete: "Lembrete", aniversario: "Aniversário", pos: "Pós-procedimento", pre: "Pré-procedimento", renovacao: "Renovação", recontato: "Recontato", retorno_combinado: "Retorno combinado", retomada: "Retomada", campanha: "Campanha", pesquisa: "Pesquisa", indicacao: "Indicação", aviso_agendamento: "Aviso de agendamento" };
  const VIEWS = [
    { id: "hoje", label: "Hoje" },
    { id: "proximos", label: "Próximos" },
    { id: "atencao", label: "Precisam de atenção" },
    { id: "historico", label: "Histórico" },
  ];
  const STATUS_TONE = {
    lido: "ok", entregue: "ok", aceito: "ok", coberto: "ok", confirmado_equipe: "info", programado: "neutral", cancelado: "neutral", encaminhado: "info",
    entrega_falhou: "bad", falhou: "bad", incerto: "warn", adiado: "warn", barrado: "warn", bloqueado: "neutral", expirado: "bad",
    nao_tentado: "warn", excluido: "neutral", em_andamento: "info",
  };
  const COUNTERS = [
    { key: "programados", label: "Programados", hint: "Ainda não é a hora de enviar.", status: "programado" },
    { key: "cancelados", label: "Cancelados", hint: "Cancelados pela equipe ou não mais devidos.", status: "cancelado" },
    { key: "encaminhados", label: "Encaminhados à equipe", hint: "A equipe foi avisada; não é mensagem enviada.", status: "encaminhado" },
    { key: "esperados", label: "Esperados", hint: "Tudo o que a Alice devia enviar neste período (inclui os que saem por motivo legítimo)." },
    { key: "excluidos", label: "Fora (motivo legítimo)", hint: "Cancelou, confirmou, pediu para não receber…", status: "excluido" },
    { key: "aceitos", label: "Aceitos pelo WhatsApp", hint: "O provedor aceitou o envio. Ainda sem confirmação de entrega.", status: "aceito" },
    { key: "confirmados_equipe", label: "Confirmados pela equipe", hint: "A equipe atestou que chegou; não há evidência do provedor. Nunca somado a aceitos/entregues.", status: "confirmado_equipe" },
    { key: "entregues", label: "Entregues", hint: "O provedor informou entrega no aparelho.", status: "entregue" },
    { key: "lidos", label: "Lidos", hint: "O provedor informou leitura.", status: "lido" },
    { key: "adiados", label: "Adiados", hint: "Retidos (WhatsApp, Clínica Experts, equipe conversando…). Tentam de novo.", status: "adiado" },
    { key: "falhos", label: "Falharam", hint: "O envio falhou. Veja o motivo.", status: "falhou" },
    { key: "incertos", label: "Resultado incerto", hint: "Pode ter saído: concilie antes de tentar de novo.", status: "incerto" },
    { key: "expirados", label: "Expirados", hint: "O prazo passou sem envio.", status: "expirado" },
    { key: "nao_tentados", label: "Não tentados", hint: "Elegíveis ainda sem tentativa registrada.", status: "nao_tentado" },
    { key: "recuperaveis_hoje", label: "Recuperáveis hoje", hint: "Podem ser tentados de novo hoje (cada um é revalidado no envio).", recoverable: true },
  ];

  const S = {
    view: "hoje", from: "", to: "", kinds: "", status: "", reason: "", ruleId: "", campaignId: "", professionalId: "", q: "", recoverableToday: false, extended: false,
    page: 1, pageSize: 50, data: null, selected: new Set(), allFiltered: false, timer: null, loading: false, detailId: null,
  };

  const root = () => document.getElementById("dp-root");

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else if (k === "checked") n.checked = !!v;
      else if (k === "disabled") n.disabled = !!v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    return n;
  }

  function fmtDay(iso) { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}/${m}/${y}`; }
  function fmtDT(iso, tz) {
    if (!iso) return "—";
    try { return new Intl.DateTimeFormat("pt-BR", { timeZone: tz || undefined, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; }
  }
  function fmtTime(iso, tz) {
    if (!iso) return "—";
    try { return new Intl.DateTimeFormat("pt-BR", { timeZone: tz || undefined, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; }
  }

  function query(extra) {
    const p = new URLSearchParams();
    p.set("view", S.view);
    if (S.view === "historico" || S.from) { if (S.from) p.set("from", S.from); if (S.to) p.set("to", S.to); }
    if (S.kinds) p.set("kinds", S.kinds);
    if (S.status) p.set("status", S.status);
    if (S.reason) p.set("reason", S.reason);
    if (S.ruleId) p.set("ruleId", S.ruleId);
    if (S.campaignId) p.set("campaignId", S.campaignId);
    if (S.professionalId) p.set("professionalId", S.professionalId);
    if (S.q) p.set("q", S.q);
    if (S.recoverableToday) p.set("recoverableToday", "1");
    if (S.extended) p.set("extended", "1");
    for (const [k, v] of Object.entries(extra || {})) p.set(k, String(v));
    return p.toString();
  }
  function filtersObj() {
    const o = { view: S.view };
    if (S.from) o.from = S.from;
    if (S.to) o.to = S.to;
    for (const k of ["kinds", "status", "reason", "ruleId", "campaignId", "professionalId", "q"]) if (S[k]) o[k] = S[k];
    if (S.recoverableToday) o.recoverableToday = true;
    if (S.extended) o.extended = true;
    return o;
  }

  function toast(msg, bad) {
    const t = h("div", { class: `dp-toast${bad ? " dp-toast-bad" : ""}`, role: "status", text: msg });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  async function post(path, body) {
    const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), silentStatuses: [404, 409, 429] };
    try { return { ok: true, json: await api(path, opts) }; }
    catch (e) {
      let msg = e.detail || "";
      return { ok: false, json: { message: msg || "Não foi possível concluir.", ok: false }, status: e.status };
    }
  }

  // ----------------------------------------------------------------- carregamento
  async function load(keepSelection) {
    if (S.loading) return;
    S.loading = true;
    try {
      S.data = await api(`/dispatches/?${query({ page: S.page, pageSize: S.pageSize })}`);
      if (!keepSelection) { S.selected.clear(); S.allFiltered = false; }
    } catch (e) {
      const r = root();
      if (r) r.replaceChildren(h("div", { class: "card" }, h("p", { text: "Não consegui carregar os disparos agora. Tente atualizar a página." })));
      S.loading = false;
      return;
    }
    S.loading = false;
    render();
    schedulePolling();
  }

  function schedulePolling() {
    clearTimeout(S.timer);
    const active = (S.data?.runs || []).some((r) => ["queued", "running", "paused"].includes(r.state));
    if (!document.getElementById("tab-dispatches")?.classList.contains("active")) return;
    S.timer = setTimeout(() => load(true), active ? 5000 : 60000);
  }

  // ----------------------------------------------------------------- render
  function badge(text, tone) { return h("span", { class: `dp-badge dp-${tone || "neutral"}`, text }); }

  function render() {
    const d = S.data;
    const r = root();
    if (!r || !d) return;
    const frag = [];
    frag.push(renderHeader(d));
    for (const a of d.avisos || []) frag.push(h("div", { class: "dp-aviso", role: "note", text: a }));
    frag.push(renderRuns(d));
    frag.push(renderCounters(d));
    frag.push(renderCoverage(d));
    frag.push(renderFilters(d));
    frag.push(renderList(d));
    frag.push(renderJobs(d));
    r.replaceChildren(...frag);
    if (S.detailId) openDetail(S.detailId, true);
  }

  function renderHeader(d) {
    const tabs = h("div", { class: "dp-tabs", role: "tablist" }, VIEWS.map((v) => h("button", {
      type: "button", role: "tab", class: `period-btn${S.view === v.id ? " active" : ""}`, "aria-selected": S.view === v.id ? "true" : "false",
      onclick: () => { S.view = v.id; S.from = ""; S.to = ""; S.page = 1; S.status = ""; S.reason = ""; S.recoverableToday = false; load(); },
      text: v.label,
    })));
    const range = h("div", { class: "dp-range" },
      h("label", {}, "De ", h("input", { type: "date", value: S.from || d.periodo.from, onchange: (e) => { S.from = e.target.value; S.view = "historico"; S.page = 1; load(); } })),
      h("label", {}, "até ", h("input", { type: "date", value: S.to || d.periodo.to, onchange: (e) => { S.to = e.target.value; S.view = "historico"; S.page = 1; load(); } })),
    );
    return h("div", { class: "dp-head" },
      h("div", {},
        h("p", { class: "dp-sub" }, `Período: ${fmtDay(d.periodo.from)}${d.periodo.from !== d.periodo.to ? ` a ${fmtDay(d.periodo.to)}` : ""} · fuso ${d.fuso} · atualizado ${fmtTime(d.geradoEm, d.fuso)}`),
        tabs, range),
      h("div", { class: "dp-head-actions" },
        h("button", { type: "button", class: "dp-btn", onclick: () => load(true), text: "Atualizar" }),
        h("button", { type: "button", class: "dp-btn", onclick: openPolicy, text: "Janela e ampliação" }),
      ));
  }

  function renderCounters(d) {
    const c = d.counters;
    return h("div", { class: "dp-counters", role: "group", "aria-label": "Contadores" }, COUNTERS.map((k) => {
      const clickable = !!(k.status || k.recoverable);
      return h(clickable ? "button" : "div", {
        type: clickable ? "button" : false, class: `dp-counter${clickable ? " dp-clickable" : ""}`, title: k.hint,
        onclick: clickable ? () => { if (k.recoverable) { S.recoverableToday = !S.recoverableToday; S.status = ""; } else { S.status = S.status === k.status ? "" : k.status; S.recoverableToday = false; } S.page = 1; load(); } : false,
      }, h("span", { class: "dp-counter-n", text: String(c[k.key] ?? 0) }), h("span", { class: "dp-counter-l", text: k.label }));
    }));
  }

  function renderCoverage(d) {
    const rows = d.cobertura.filter((k) => k.counters.esperados > 0 || k.kind !== "cobranca");
    const th = (t) => h("th", { text: t });
    const topReasons = (k) => Object.entries(k.porMotivo).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, n]) => `${d.motivos[code] || code} (${n})`).join(" · ") || "—";
    return h("details", { class: "card dp-cov", open: S.view !== "historico" ? "" : false },
      h("summary", {}, "Cobertura por tipo (esperado × tentado × aceito × entregue)"),
      h("div", { class: "dp-scroll" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Tipo", "Esperados", "Elegíveis", "Aceitos", "Entregues", "Lidos", "Adiados", "Falharam", "Incertos", "Expirados", "Fora", "Cobertura", "Principais motivos"].map(th))),
        h("tbody", {}, rows.map((k) => h("tr", {},
          h("td", { text: KIND_LABEL[k.kind] }),
          ...[k.counters.esperados, k.counters.elegiveis, k.counters.aceitos, k.counters.entregues, k.counters.lidos, k.counters.adiados, k.counters.falhos, k.counters.incertos, k.counters.expirados, k.counters.excluidos].map((n) => h("td", { text: String(n) })),
          h("td", { title: k.fonteNota }, k.cobertura == null ? badge("não calculável", "warn") : badge(`${k.cobertura}%`, k.cobertura >= 99 ? "ok" : "warn")),
          h("td", { class: "dp-reasons", text: topReasons(k) }),
        ))),
      )),
      h("p", { class: "hint", text: "Cobertura = elegíveis cujo envio foi ao menos aceito pelo WhatsApp. Aceito não é entregue: veja as colunas separadas. Quando a fonte é incompleta (agenda externa, aniversários só dos cadastrados), o percentual não é calculado." }),
      ...rows.filter((k) => !k.fonteCompleta).map((k) => h("p", { class: "hint", text: `${KIND_LABEL[k.kind]}: ${k.fonteNota}` })),
    );
  }

  function select(label, value, options, onchange) {
    return h("label", { class: "dp-field" }, h("span", { text: label }), h("select", { onchange: (e) => onchange(e.target.value) },
      options.map(([v, t]) => h("option", { value: v, selected: v === value ? "" : false, text: t }))));
  }

  function renderFilters(d) {
    const statuses = [["", "Todos os estados"], ...Object.entries(d.statusLabels).map(([k, v]) => [k, v])];
    const reasons = [["", "Todos os motivos"], ...Object.entries(d.motivos).map(([k, v]) => [k, v])];
    const kinds = [["", "Todos os tipos"], ...Object.entries(KIND_LABEL)];
    const rules = [["", "Todas as regras"], ...(d.regras || []).map((r) => [r.id, `${r.rotulo}${r.ativa ? "" : " (desligada)"}`])];
    const camps = [["", "Todas as campanhas"], ...(d.campanhas || []).map((c) => [c.id, c.title])];
    const pros = [["", "Todos os profissionais"], ...(d.profissionais || []).map((p) => [p.id, p.name])];
    const apply = (k) => (v) => { S[k] = v; S.page = 1; load(); };
    let t;
    const search = h("input", { type: "search", class: "search-input", placeholder: "Buscar por nome ou final do telefone", value: S.q, "aria-label": "Buscar", oninput: (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); S.page = 1; load(); }, 450); } });
    return h("div", { class: "dp-filters" },
      search,
      select("Tipo", S.kinds, kinds, apply("kinds")),
      select("Estado", S.status, statuses, apply("status")),
      select("Motivo", S.reason, reasons, apply("reason")),
      select("Regra", S.ruleId, rules, apply("ruleId")),
      select("Campanha", S.campaignId, camps, apply("campaignId")),
      select("Profissional", S.professionalId, pros, apply("professionalId")),
      h("label", { class: "dp-check" }, h("input", { type: "checkbox", checked: S.recoverableToday, onchange: (e) => { S.recoverableToday = e.target.checked; S.page = 1; load(); } }), " Recuperável hoje"),
      h("label", { class: "dp-check" }, h("input", { type: "checkbox", checked: S.extended, onchange: (e) => { S.extended = e.target.checked; S.page = 1; load(); } }), " Janela ampliada"),
      h("a", { class: "dp-btn dp-link", href: `/api/dispatches/export.csv?${query()}&clinicId=${encodeURIComponent((typeof state !== "undefined" && state.clinicId) || "")}`, download: "" , text: "Exportar CSV" }),
    );
  }

  function selectionBar(d) {
    const n = S.allFiltered ? d.total : S.selected.size;
    if (!n && !d.items.some((i) => i.recoverable)) return h("div", { class: "dp-selbar dp-selbar-empty" });
    const pageIds = d.items.map((i) => i.id);
    const allPage = pageIds.length > 0 && pageIds.every((id) => S.selected.has(id));
    const kids = [];
    if (n) kids.push(h("strong", { text: S.allFiltered ? `Todos os ${d.total} resultados do filtro selecionados` : `${n} selecionado(s) nesta página` }));
    if (!S.allFiltered && allPage && d.total > pageIds.length) kids.push(h("button", { type: "button", class: "dp-linkbtn", onclick: () => { S.allFiltered = true; render(); }, text: `Selecionar todos os ${d.total} resultados do filtro` }));
    if (S.allFiltered || n) kids.push(h("button", { type: "button", class: "dp-linkbtn", onclick: () => { S.selected.clear(); S.allFiltered = false; render(); }, text: "Limpar seleção" }));
    kids.push(h("button", { type: "button", class: "dp-btn dp-btn-primary", disabled: !n && !d.counters.recuperaveis_hoje, onclick: () => (n ? previewRecovery(false) : previewRecovery(true)), text: n ? "Recuperar selecionados…" : "Recuperar os elegíveis de hoje…" }));
    return h("div", { class: "dp-selbar" }, kids);
  }

  function renderList(d) {
    const head = ["", "Pessoa", "Tipo", "Referência", "Estado", "Motivo", "Tent.", "Última", "Próxima", "Entrega"];
    const allBox = h("input", { type: "checkbox", "aria-label": "Selecionar a página", checked: d.items.length > 0 && d.items.every((i) => S.selected.has(i.id)), onchange: (e) => { for (const i of d.items) e.target.checked ? S.selected.add(i.id) : S.selected.delete(i.id); S.allFiltered = false; render(); } });
    const rows = d.items.map((i) => {
      const box = h("input", { type: "checkbox", "aria-label": `Selecionar ${i.patientName}`, checked: S.allFiltered || S.selected.has(i.id), disabled: S.allFiltered, onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? S.selected.add(i.id) : S.selected.delete(i.id); render(); } });
      return h("tr", { class: `dp-row${S.detailId === i.id ? " dp-row-active" : ""}`, tabindex: "0", onclick: () => openDetail(i.id), onkeydown: (e) => { if (e.key === "Enter") openDetail(i.id); } },
        h("td", {}, box),
        h("td", {}, h("div", { class: "dp-person", text: i.patientName }), h("div", { class: "dp-muted", text: i.phone })),
        h("td", { text: KIND_LABEL[i.kind] }),
        h("td", {}, i.kind === "aniversario" ? fmtDay(i.sendDay) : fmtDT(i.referenceAt, d.fuso), i.professional ? h("div", { class: "dp-muted", text: i.professional }) : null),
        h("td", {}, badge(i.statusLabel, STATUS_TONE[i.status]), i.extended ? badge("ampliada", "info") : null, i.recoverable ? badge("recuperável hoje", "info") : null),
        h("td", { text: i.reasonLabel }),
        h("td", { text: String(i.attempts) }),
        h("td", { text: fmtDT(i.attemptedAt, d.fuso) }),
        h("td", { text: i.nextAttemptAt ? fmtDT(i.nextAttemptAt, d.fuso) : "—" }),
        h("td", { text: i.deliveryState ? ({ accepted: "aceito", delivered: "entregue", read: "lido", failed: "falhou" }[i.deliveryState] || i.deliveryState) : "—" }),
      );
    });
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const pager = h("div", { class: "dp-pager" },
      h("button", { type: "button", class: "dp-btn", disabled: d.page <= 1, onclick: () => { S.page = d.page - 1; load(true); }, text: "Anterior" }),
      h("span", { text: `Página ${d.page} de ${pages} · ${d.total} item(ns)` }),
      h("button", { type: "button", class: "dp-btn", disabled: d.page >= pages, onclick: () => { S.page = d.page + 1; load(true); }, text: "Próxima" }),
    );
    const table = h("div", { class: "dp-scroll" }, h("table", { class: "dp-table" },
      h("thead", {}, h("tr", {}, head.map((t, idx) => h("th", {}, idx === 0 ? allBox : t)))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: String(head.length), class: "dp-empty", text: "Nada neste filtro." }))),
    ));
    return h("div", { class: "card dp-list" }, selectionBar(d), table, pager);
  }

  function renderRuns(d) {
    const runs = (d.runs || []).filter((r) => ["queued", "running", "paused"].includes(r.state) || Date.now() - new Date(r.createdAt).getTime() < 6 * 3600_000);
    if (!runs.length) return h("div", { hidden: "" });
    const label = { queued: "Na fila", running: "Enviando", paused: "Pausada", completed: "Concluída", cancelled: "Cancelada" };
    return h("div", { class: "card dp-runs" }, h("h3", { text: "Recuperações" }), runs.map((r) => {
      const done = (r.itens.done || 0) + (r.itens.failed || 0) + (r.itens.cancelled || 0);
      const act = [];
      if (["queued", "running"].includes(r.state)) act.push(h("button", { type: "button", class: "dp-btn", onclick: () => runAct(r.id, "pause"), text: "Pausar" }));
      if (r.state === "paused") act.push(h("button", { type: "button", class: "dp-btn", onclick: () => runAct(r.id, "resume"), text: "Retomar" }));
      if (["queued", "running", "paused"].includes(r.state)) act.push(h("button", { type: "button", class: "dp-btn", onclick: () => runAct(r.id, "cancel"), text: "Cancelar o que falta" }));
      const res = Object.entries(r.resultados).map(([k, v]) => `${v} ${({ sent: "enviado(s)", skipped: "dispensado(s)", failed: "falhou", deferred: "adiado(s)", vetoed: "barrado(s)", unconfirmed: "incerto(s)" })[k] || k}`).join(" · ");
      return h("div", { class: "dp-run" },
        h("div", {}, badge(label[r.state] || r.state, r.state === "completed" ? "ok" : r.state === "cancelled" ? "neutral" : "info"), ` ${done}/${r.total} · ${fmtDT(r.createdAt, d.fuso)} · por ${r.createdBy || "—"}`),
        h("div", { class: "dp-muted", text: res || (r.total ? "aguardando" : "") }),
        h("progress", { max: String(Math.max(r.total, 1)), value: String(done), "aria-label": "Progresso" }),
        h("div", { class: "dp-actions" }, act));
    }));
  }

  function renderJobs(d) {
    if (!d.jobs?.length) return h("div", { hidden: "" });
    return h("details", { class: "card dp-jobs" }, h("summary", {}, "Saúde dos envios automáticos"),
      d.jobs.map((j) => h("p", {}, h("strong", { text: `${j.label}: ` }), j.ultimaRodada ? `última rodada ${fmtDT(j.ultimaRodada, d.fuso)} (${Math.round((j.duracaoMs || 0) / 1000)} s, ${j.resultado})${j.proximaEsperada ? `, próxima esperada ${fmtTime(j.proximaEsperada, d.fuso)}` : ""}` : "nenhuma rodada registrada",
        j.atrasado ? badge("atrasado", "bad") : badge("em dia", "ok"), j.erro ? ` — ${j.erro}` : "")));
  }

  // ----------------------------------------------------------------- acoes
  async function runAct(id, action) {
    const r = await post(`/dispatches/runs/${id}/${action}`, {});
    toast(r.json.message || (r.ok ? "Feito." : "Não foi possível."), !r.ok);
    load(true);
  }

  function modal(title, body, actions) {
    const prev = document.getElementById("dp-modal");
    if (prev) prev.remove();
    const close = () => m.remove();
    const m = h("div", { id: "dp-modal", class: "dp-modal", role: "dialog", "aria-modal": "true", "aria-label": title, onclick: (e) => { if (e.target === m) close(); }, onkeydown: (e) => { if (e.key === "Escape") close(); } },
      h("div", { class: "dp-modal-box" }, h("h3", { text: title }), body, h("div", { class: "dp-actions" }, actions(close))));
    document.body.appendChild(m);
    m.querySelector("button, input, select")?.focus();
    return close;
  }

  async function previewRecovery(allEligible) {
    const body = allEligible
      ? { allFiltered: true, filters: { ...filtersObj(), recoverableToday: true } }
      : S.allFiltered ? { allFiltered: true, filters: filtersObj() } : { ids: [...S.selected] };
    const r = await post("/dispatches/recovery/preview", body);
    if (!r.ok) { toast(r.json.message, true); return; }
    const p = r.json;
    const list = h("div", {},
      h("p", {}, h("strong", { text: `${p.elegiveis.length} item(ns) serão colocados na fila` }), ` de ${p.total} selecionado(s).`),
      p.elegiveis.length ? h("ul", { class: "dp-ul" }, p.elegiveis.slice(0, 12).map((e) => h("li", { text: `${e.paciente} (${e.telefone}) — ${KIND_LABEL[e.tipo] || e.tipo}: ${e.motivo}` })), p.elegiveis.length > 12 ? h("li", { text: `… e mais ${p.elegiveis.length - 12}` }) : null) : null,
      p.excluidos.length ? h("details", {}, h("summary", { text: `${p.excluidos.length} fora da fila (e por quê)` }), h("ul", { class: "dp-ul" }, p.excluidos.slice(0, 40).map((e) => h("li", { text: `${e.paciente}: ${e.motivo}` })))) : null,
      p.avisos.map((a) => h("p", { class: "hint", text: a })),
    );
    modal("Recuperar disparos", list, (close) => [
      h("button", { type: "button", class: "dp-btn", onclick: close, text: "Voltar" }),
      h("button", { type: "button", class: "dp-btn dp-btn-primary", disabled: p.elegiveis.length === 0, onclick: async (e) => {
        e.target.disabled = true; // duplo clique nao cria duas filas
        const rr = await post("/dispatches/recovery", body);
        close();
        if (rr.ok) { toast(rr.json.queued ? `Fila criada com ${rr.json.queued} item(ns). O envio acontece em segundo plano e você acompanha aqui.` : "Nenhum item entrou na fila.", !rr.json.queued); S.selected.clear(); S.allFiltered = false; }
        else toast(rr.json.message, true);
        load(true);
      }, text: "Confirmar e enfileirar" }),
    ]);
  }

  async function openDetail(id, silent) {
    S.detailId = id;
    let det;
    try { det = await api(`/dispatches/item?id=${encodeURIComponent(id)}`, { silentStatuses: [404] }); }
    catch { S.detailId = null; if (!silent) toast("Item não encontrado.", true); return; }
    const old = document.getElementById("dp-drawer");
    if (old) old.remove();
    const it = det.item;
    const close = () => { S.detailId = null; document.getElementById("dp-drawer")?.remove(); render(); };
    const act = (label, fn, cls) => h("button", { type: "button", class: cls || "dp-btn", onclick: fn, text: label });
    const run = async (action, extra) => { const r = await post("/dispatches/action", { id, action, ...(extra || {}) }); toast(r.json.message || "Feito.", !(r.ok && r.json.ok !== false)); await load(true); };
    const can = (a) => it.actions.includes(a);
    const buttons = [];
    if (can("recuperar")) buttons.push(act("Tentar de novo agora", () => run("recuperar"), "dp-btn dp-btn-primary"));
    if (can("agendar_depois")) buttons.push(act("Tentar mais tarde hoje", () => { const m = Number(prompt("Daqui a quantos minutos? (até 21h de hoje)", "60")); if (m) run("agendar_depois", { minutes: m }); }));
    if (can("conciliar")) { buttons.push(act("Conferi: chegou", () => run("conciliar", { decision: "enviado" }))); buttons.push(act("Conferi: NÃO saiu", () => run("conciliar", { decision: "nao_enviado" }))); }
    if (can("corrigir_cadastro")) buttons.push(act("Corrigir telefone", () => { const p = prompt("Novo telefone (com DDD):"); if (p) run("corrigir_cadastro", { phone: p }); }));
    if (can("resolver_telefone") && det.telefone?.alternativaEstrutural) buttons.push(act("Usar a outra forma do número", () => run("resolver_telefone")));
    if (can("encaminhar_humano")) buttons.push(act("Avisar a equipe", () => run("encaminhar_humano", { note: prompt("Observação (opcional):") || "" })));
    if (can("cancelar_pendente")) buttons.push(act("Cancelar este envio", () => { if (confirm("A Alice não vai enviar esta mensagem. Confirmar?")) run("cancelar_pendente"); }));
    const tel = det.telefone;
    const drawer = h("aside", { id: "dp-drawer", class: "dp-drawer", role: "dialog", "aria-label": "Detalhe do disparo" },
      h("div", { class: "dp-drawer-head" }, h("h3", { text: it.patientName }), h("button", { type: "button", class: "dp-btn", onclick: close, "aria-label": "Fechar", text: "Fechar" })),
      h("p", {}, badge(it.statusLabel, STATUS_TONE[it.status]), " ", it.reasonLabel),
      it.detail ? h("p", { class: "dp-muted", text: it.detail }) : null,
      h("dl", { class: "dp-dl" },
        h("dt", { text: "Tipo / regra" }), h("dd", { text: `${KIND_LABEL[it.kind]}${it.ruleName ? ` · ${it.ruleName}` : ""}` }),
        h("dt", { text: "Referência" }), h("dd", { text: it.kind === "aniversario" ? fmtDay(it.sendDay) : `${fmtDT(it.referenceAt, S.data.fuso)}${it.procedure ? ` · ${it.procedure}` : ""}${it.professional ? ` · ${it.professional}` : ""}` }),
        h("dt", { text: "Origem" }), h("dd", { text: det.who || "—" }),
        h("dt", { text: "Tentativas" }), h("dd", { text: `${it.attempts}${it.attemptedAt ? ` (última ${fmtDT(it.attemptedAt, S.data.fuso)})` : ""}` }),
        h("dt", { text: "Telefone cadastrado" }), h("dd", { text: it.phone }),
        h("dt", { text: "Destino usado" }), h("dd", { text: it.destination || "—" }),
        h("dt", { text: "Id da mensagem (provedor)" }), h("dd", { text: det.providerMessageId || "— (sem id: entrega não rastreável)" }),
        h("dt", { text: "Entrega" }), h("dd", { text: it.deliveryState ? ({ accepted: "aceito pelo WhatsApp (sem confirmação de entrega)", delivered: "entregue", read: "lido", failed: "o provedor informou falha" }[it.deliveryState] || it.deliveryState) : "—" }),
        it.extendedReason ? [h("dt", { text: "Janela ampliada" }), h("dd", { text: `${it.extendedReason}${it.deadlineAt ? ` · prazo final ${fmtDT(it.deadlineAt, S.data.fuso)}` : ""}` })] : null,
      ),
      tel ? h("p", { class: "dp-muted", text: `Telefone: ${tel.valido ? "válido" : "inválido"} (${tel.tipo})${tel.alternativaEstrutural ? " · existe uma forma alternativa (com/sem o 9), usada só se o WhatsApp recusar explicitamente" : ""}` }) : null,
      det.text ? h("div", {}, h("h4", { text: "Texto exato desta tentativa" }), h("pre", { class: "dp-pre", text: det.text })) : null,
      det.textNote && !det.text ? h("p", { class: "hint", text: det.textNote }) : null,
      h("h4", { text: "Linha do tempo" }),
      h("ul", { class: "dp-ul" }, det.timeline.map((t) => h("li", { text: `${fmtDT(t.at, S.data.fuso)} — ${t.what}` }))),
      it.recoverableWhy ? h("p", { class: "hint", text: it.recoverableWhy }) : null,
      h("div", { class: "dp-actions" }, buttons),
    );
    document.body.appendChild(drawer);
    if (!silent) drawer.querySelector("button")?.focus();
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { document.removeEventListener("keydown", esc); if (document.getElementById("dp-drawer")) close(); } });
  }

  async function openPolicy() {
    let pol;
    try { pol = await api("/dispatches/policy"); } catch { return; }
    const names = { confirmacao: "Confirmações", cobranca: "Cobranças", lembrete: "Lembretes", aniversario: "Aniversários" };
    const fields = {};
    const body = h("div", { class: "dp-policy" },
      h("p", { class: "hint", text: "A janela normal de cada envio continua valendo. A ampliação só entra quando há causa operacional comprovada (rodada que não aconteceu, WhatsApp ou Clínica Experts fora, falha recuperável, fila maior que a capacidade), sempre no mesmo dia, até o limite abaixo e nunca depois das 21h. Depois do limite o envio expira e a equipe é avisada." }),
      Object.keys(names).map((k) => {
        const p = pol.politica[k];
        const f = fields[k] = {
          on: h("input", { type: "checkbox", checked: p.extendEnabled }),
          until: h("input", { type: "time", value: p.extendUntil }),
          max: h("input", { type: "number", min: "0", max: "720", value: String(p.maxExtendMin) }),
          lead: h("input", { type: "number", min: "0", max: "1440", value: String(p.minLeadMin) }),
          att: h("input", { type: "number", min: "1", max: "10", value: String(p.maxAttempts) }),
          gap: h("input", { type: "number", min: "5", max: "120", value: String(p.retryGapMin) }),
          per: h("input", { type: "number", min: "1", max: "30", value: String(p.maxPerRun) }),
        };
        return h("fieldset", { class: "dp-fs" }, h("legend", { text: names[k] }),
          h("label", { class: "dp-check" }, f.on, " Ampliar a janela automaticamente"),
          h("label", { class: "dp-field" }, h("span", { text: "Limite final (hora local)" }), f.until),
          h("label", { class: "dp-field" }, h("span", { text: "Ampliar no máximo (min)" }), f.max),
          h("label", { class: "dp-field" }, h("span", { text: "Antecedência mínima do atendimento (min)" }), f.lead),
          h("label", { class: "dp-field" }, h("span", { text: "Tentativas" }), f.att),
          h("label", { class: "dp-field" }, h("span", { text: "Intervalo entre tentativas (min)" }), f.gap),
          h("label", { class: "dp-field" }, h("span", { text: "Envios por rodada" }), f.per));
      }),
    );
    modal("Janela e ampliação automática", body, (close) => [
      h("button", { type: "button", class: "dp-btn", onclick: close, text: "Fechar" }),
      h("button", { type: "button", class: "dp-btn dp-btn-primary", onclick: async () => {
        for (const k of Object.keys(names)) {
          const f = fields[k];
          try { await api(`/dispatches/policy/${k}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extendEnabled: f.on.checked, extendUntil: f.until.value, maxExtendMin: Number(f.max.value), minLeadMin: Number(f.lead.value), maxAttempts: Number(f.att.value), retryGapMin: Number(f.gap.value), maxPerRun: Number(f.per.value) }) }); }
          catch { toast(`Não salvei ${names[k]}.`, true); return; }
        }
        toast("Política salva.");
        close();
        load(true);
      }, text: "Salvar" }),
    ]);
  }

  window.loadDispatches = function () { S.page = 1; load(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && document.getElementById("tab-dispatches")?.classList.contains("active")) load(true); });
})();
