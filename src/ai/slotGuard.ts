// ---------------------------------------------------------------------------
// TRAVA DE DIA E HORA (pedido da Lisboa, 14/10/2026: "ela manda dia e hora errados"). O modelo pequeno reescreve datas de cabeca
// ("Amanha, dia 20/10", "conseguimos agendar para amanha" com a lista em 16/10). Corrigir rotulo a rotulo nao bastou. Regra agora:
// a resposta so pode citar datas e horarios que uma ferramenta de agenda DEVOLVEU nesta rodada (ou que a propria pessoa citou, ou que ja
// estao no agendamento dela). Se citar outro, o codigo manda o modelo refazer uma vez; se errar de novo, monta a resposta direto dos dados
// da agenda. Tudo aqui e PURO (sem banco) para ser testado.
// ---------------------------------------------------------------------------

import { formatInZone, wallClockInZone } from "../scheduling/time.js";

const pad = (n: number) => String(n).padStart(2, "0");

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export interface SlotState {
  times: Set<string>; // "HH:MM" (fuso da clinica) devolvidos pelas ferramentas
  dates: Set<string>; // "DD/MM"
  instants: number[]; // instantes devolvidos (para conferir hoje/amanha)
  offer: { iso: string; professional: string | null }[]; // ultima lista oferecida (ate montar a resposta)
  offerProcedure: string | null; // procedimento a que essa lista se refere (campo "procedimento" do resultado da ferramenta), para nao reaproveitar a de outro
  booked: { label: string; professional: string | null } | null; // book_appointment deu certo
}

export function newSlotState(): SlotState {
  return { times: new Set(), dates: new Set(), instants: [], offer: [], offerProcedure: null, booked: null };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function addInstant(state: SlotState, iso: string, tz: string): void {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return;
  const wc = wallClockInZone(d, tz);
  state.times.add(`${pad(wc.hour)}:${pad(wc.minute)}`);
  state.dates.add(`${pad(wc.day)}/${pad(wc.month)}`);
  state.instants.push(d.getTime());
}

// Rotulo ja formatado pela ferramenta ("quarta-feira, 21/10 às 16:00"): extrai dia/mes e hora.
function addLabel(state: SlotState, label: string): void {
  const f = fold(label);
  for (const m of f.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) state.dates.add(`${pad(Number(m[1]))}/${pad(Number(m[2]))}`);
  for (const m of f.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) state.times.add(`${pad(Number(m[1]))}:${m[2]}`);
}

// Le o resultado (JSON) de uma ferramenta de agenda e guarda o que ela devolveu.
export function absorbToolResult(state: SlotState, toolName: string, resultJson: string, tz: string): void {
  let data: unknown;
  try {
    data = JSON.parse(resultJson);
  } catch {
    return;
  }
  const walk = (node: unknown, key = ""): void => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, key));
    if (node && typeof node === "object") return Object.entries(node as Record<string, unknown>).forEach(([k, v]) => walk(v, k));
    if (typeof node !== "string") return;
    if (key === "iso" && ISO_RE.test(node)) addInstant(state, node, tz);
    else if (key === "quando" || key === "horario_pedido" || key === "confirmado") addLabel(state, node);
  };
  walk(data);
  const r = data as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return;
  const list = (r.horarios_mais_proximos ?? r.horarios ?? r.alternativas) as unknown;
  if (Array.isArray(list) && list.length) {
    state.offer = list
      .map((x) => x as Record<string, unknown>)
      .filter((x) => typeof x.iso === "string")
      .map((x) => ({ iso: x.iso as string, professional: typeof x.profissional === "string" ? x.profissional : null }));
    state.offerProcedure = typeof r.procedimento === "string" ? r.procedimento : null;
  }
  if (toolName === "book_appointment" && r.agendado === true && typeof r.quando === "string") {
    state.booked = { label: r.quando, professional: typeof r.profissional === "string" ? r.profissional : null };
  }
}

// ---------- o que a resposta cita ----------

export interface Mentions {
  times: string[]; // "HH:MM"
  dates: string[]; // "DD/MM"
  relative: ("hoje" | "amanha" | "depois")[];
}

function stripNoise(f: string): string {
  return f
    // faixa de expediente: "das 8h as 21h", "de 8h a 15h", "entre 9:00 e 12:00"
    .replace(/\b(?:das?|de|entre|ate)\s+\d{1,2}(?::\d{2}|h\d{0,2})?\s*(?:horas)?\s*(?:as|a|ate|e)\s+\d{1,2}(?::\d{2}|h\d{0,2})?/g, " ")
    // duracao e tolerancia: "dura 1h30", "tem duracao de 1h30", "tolerancia de 10 minutos"
    .replace(/\b(?:dura\w*|duracao|leva\w*|cerca de|aproximadamente|tolerancia|atraso)\s+(?:de\s+)?\d{1,2}(?::\d{2}|h\d{0,2})?/g, " ")
    // "24h de antecedencia"
    .replace(/\b\d{1,2}\s*h(?:oras)?\s+de\s+anteced\w+/g, " ");
}

export function extractMentions(text: string): Mentions {
  const f = stripNoise(fold(text));
  const times = new Set<string>();
  for (const m of f.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const h = Number(m[1]);
    if (h <= 23 && Number(m[2]) <= 59) times.add(`${pad(h)}:${m[2]}`);
  }
  for (const m of f.matchAll(/\b(\d{1,2})h(\d{2})?\b/g)) {
    const h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    if (h <= 23 && mi <= 59) times.add(`${pad(h)}:${pad(mi)}`);
  }
  const dates = new Set<string>();
  for (const m of f.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) dates.add(`${pad(d)}/${pad(mo)}`);
  }
  const relative: Mentions["relative"] = [];
  if (/\bdepois de amanha\b/.test(f)) relative.push("depois");
  if (/\bamanha\b/.test(f.replace(/\bdepois de amanha\b/g, " "))) relative.push("amanha");
  if (/\bhoje\b/.test(f)) relative.push("hoje");
  return { times: [...times], dates: [...dates], relative };
}

// "DD/MM" de hoje, amanha e depois de amanha no fuso da clinica.
export function relativeDateKeys(now: Date, tz: string): { hoje: string; amanha: string; depois: string } {
  const key = (offsetDays: number) => {
    const wc = wallClockInZone(new Date(now.getTime() + offsetDays * 86_400_000), tz);
    return `${pad(wc.day)}/${pad(wc.month)}`;
  };
  return { hoje: key(0), amanha: key(1), depois: key(2) };
}

export interface GuardResult {
  ok: boolean;
  problems: string[];
}

// `known` = o que e legitimo citar alem do que a ferramenta devolveu: o que a pessoa escreveu, agendamentos dela, ofertas anteriores
// (so no caso sem ferramenta). `toolUsed` = uma ferramenta de agenda rodou nesta rodada (regra estrita).
export function checkSlotMentions(params: {
  text: string;
  state: SlotState;
  known: { times: Set<string>; dates: Set<string> };
  toolUsed: boolean;
  now: Date;
  tz: string;
}): GuardResult {
  const { text, state, known, toolUsed, now, tz } = params;
  const m = extractMentions(text);
  const problems: string[] = [];
  if (m.times.length === 0 && m.dates.length === 0) return { ok: true, problems };

  const okTime = (t: string) => state.times.has(t) || known.times.has(t);
  const okDate = (d: string) => state.dates.has(d) || known.dates.has(d);

  // Sem ferramenta nesta rodada: so e "oferta" (e so confere) se cita dia E hora; "expediente" ou "duracao" soltos nao contam.
  if (!toolUsed && !(m.dates.length > 0 && m.times.length > 0)) return { ok: true, problems };

  for (const t of m.times) if (!okTime(t)) problems.push(`horario ${t} nao devolvido pela agenda`);
  for (const d of m.dates) if (!okDate(d)) problems.push(`data ${d} nao devolvida pela agenda`);

  // "hoje"/"amanha" junto de uma lista de horarios: algum horario oferecido tem que cair nesse dia.
  if (m.times.length > 0 && m.relative.length > 0) {
    const rel = relativeDateKeys(now, tz);
    const offered = new Set<string>([...state.dates, ...known.dates, ...m.dates]);
    for (const r of m.relative) if (!offered.has(rel[r])) problems.push(`"${r === "depois" ? "depois de amanha" : r}" mas nenhum horario cai em ${rel[r]}`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------- resposta montada direto dos dados da agenda ----------

export const SLOT_NUDGE =
  "ATENCAO: sua resposta cita dia ou horario que NENHUMA ferramenta de agenda devolveu (ou usa 'hoje'/'amanha' com a data errada). Refaca: chame check_availability / check_specific_time se faltar dado e cite SOMENTE os horarios devolvidos, copiando o campo 'quando' exatamente como veio (sem reescrever dia da semana nem data), no maximo 3 horarios, e NUNCA diga que ja agendou antes de book_appointment dar certo.";

export const SLOT_FALLBACK_ASK = "Deixa eu confirmar os horários certinhos pra você. Prefere manhã ou tarde?";

export function renderOffer(offer: { iso: string; professional: string | null }[], tz: string): string {
  const lines = offer.slice(0, 3).map((o) => `• ${formatInZone(new Date(o.iso), tz)}${o.professional ? ` com ${o.professional}` : ""}`);
  return `Tenho estes horários:\n\n${lines.join("\n")}\n\nQual deles fica melhor pra você? 😊`;
}

export function renderBooked(b: { label: string; professional: string | null }): string {
  return `Pronto! Está agendado para ${b.label}${b.professional ? ` com ${b.professional}` : ""}. Se precisar alterar algo ou tiver algum imprevisto, é só avisar. 💗`;
}

// Os conjuntos "legitimos" a partir de textos (o que a pessoa escreveu, ofertas anteriores) e de horarios de agendamentos (instantes).
export function knownFrom(texts: string[], appointmentInstants: Date[], tz: string): { times: Set<string>; dates: Set<string> } {
  const times = new Set<string>();
  const dates = new Set<string>();
  for (const t of texts) {
    const m = extractMentions(t);
    m.times.forEach((x) => times.add(x));
    m.dates.forEach((x) => dates.add(x));
  }
  for (const d of appointmentInstants) {
    const wc = wallClockInZone(d, tz);
    times.add(`${pad(wc.hour)}:${pad(wc.minute)}`);
    dates.add(`${pad(wc.day)}/${pad(wc.month)}`);
  }
  return { times, dates };
}
