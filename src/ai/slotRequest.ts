// ---------------------------------------------------------------------------
// O QUE A PESSOA PEDIU DE DIA E HORARIO. Casos reais de 16/10/2026: ela disse "so aos sabados", "sabado dia 24, umas 10 ou 10:30",
// "tenho aula as 18:40", "terca as 12:30" e a Alice respondeu com os horarios mais proximos (hoje, amanha) como se nada tivesse sido
// dito. Aqui as mensagens da pessoa viram um PEDIDO estruturado (dias, dias da semana, horas, limites, turno) que vai na ficha e na
// ordem "JOGADA AGORA": a Alice so oferece o que respeita o pedido. Tudo PURO (testavel, sem banco).
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const pad = (n: number) => String(n).padStart(2, "0");

export interface SlotRequest {
  dates: string[]; // AAAA-MM-DD citados (dia/mes, "dia 24", hoje, amanha, dia da semana -> proxima ocorrencia)
  weekdays: number[]; // 0=domingo..6=sabado que ela citou
  onlyWeekdays: boolean; // "so aos sabados", "somente terca"
  times: string[]; // HH:MM que ela citou como preferencia (nao inclui o limite abaixo)
  notBefore: string | null; // "depois das 17h"
  notAfter: string | null; // "antes das 18h", "tenho aula as 18:40"
  period: "manha" | "tarde" | "noite" | null;
}

export function emptyRequest(): SlotRequest {
  return { dates: [], weekdays: [], onlyWeekdays: false, times: [], notBefore: null, notAfter: null, period: null };
}

export function isEmptyRequest(r: SlotRequest): boolean {
  return !r.dates.length && !r.weekdays.length && !r.times.length && !r.notBefore && !r.notAfter && !r.period;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekdayOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Proxima ocorrencia (a partir de amanha) do dia da semana.
function nextWeekday(todayIso: string, wd: number): string {
  for (let i = 1; i <= 7; i++) {
    const iso = addDays(todayIso, i);
    if (weekdayOfIso(iso) === wd) return iso;
  }
  return addDays(todayIso, 1);
}

// "24/10" -> ano certo (a proxima ocorrencia a partir de hoje).
function isoForDayMonth(todayIso: string, day: number, month: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const [y, m, d] = todayIso.split("-").map(Number);
  const year = month < m || (month === m && day < d - 1) ? y + 1 : y;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// "dia 24" (sem mes): o proximo dia 24 a partir de hoje.
function isoForDayOfMonth(todayIso: string, day: number): string | null {
  if (day < 1 || day > 31) return null;
  for (let i = 0; i <= 62; i++) {
    const iso = addDays(todayIso, i);
    if (Number(iso.slice(8, 10)) === day) return iso;
  }
  return null;
}

function hhmm(h: string, m?: string): string | null {
  const hh = Number(h);
  const mm = m ? Number(m) : 0;
  if (!Number.isFinite(hh) || hh > 23 || mm > 59) return null;
  return `${pad(hh)}:${pad(mm)}`;
}

// "18h40", "18:40", "18h", "18 horas" -> "18:40"
const T = "(\\d{1,2})(?:\\s*(?:h|:|horas?)\\s*(\\d{2})?)";

const WD_RE = /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)s?(?:-feiras?| feiras?)?\b/g;
const ONLY_RE = /\b(somente|so|apenas|unicamente)\b[^.!?\n]{0,18}$/;

// PURO: junta o pedido de varias mensagens (as ultimas pesam mais: a data/limite mais recente vence quando ha conflito de limite).
export function parseSlotRequest(texts: string[], todayIso: string): SlotRequest {
  const req = emptyRequest();
  const dates = new Set<string>();
  const weekdayDates = new Set<string>(); // proxima ocorrencia de um dia da semana citado (so vale se ela nao deu data explicita)
  const wds = new Set<number>();
  const times = new Set<string>();

  for (const raw of texts) {
    // "aula as 1840" / "as 930" -> "as 18:40" / "as 9:30" (hora escrita sem separador)
    const f = fold(raw).replace(/\b(as|a)\s+(?:([01]\d|2[0-3])([0-5]\d)|([6-9])([0-5]\d))\b/g, (_m, p: string, h1?: string, m1?: string, h2?: string, m2?: string) => `${p} ${h1 ?? h2}:${m1 ?? m2}`);
    if (!f.trim()) continue;

    // datas "24/10"
    for (const m of f.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) {
      const iso = isoForDayMonth(todayIso, Number(m[1]), Number(m[2]));
      if (iso) dates.add(iso);
    }
    // "dia 24" (nao "dia 24/10", ja tratado)
    for (const m of f.matchAll(/\bdia (\d{1,2})\b(?!\s*\/)/g)) {
      const iso = isoForDayOfMonth(todayIso, Number(m[1]));
      if (iso) dates.add(iso);
    }
    // "hoje"/"amanha" so valem como dia pedido junto de um horario ("amanha as 12h30"); "estou trabalhando hoje" nao e pedido de dia
    const hasClock = /\b\d{1,2}\s*(?:h|:)\s*\d{0,2}|\b(?:as|a)\s+\d{1,2}\b/.test(f);
    if (hasClock) {
      if (/\bdepois de amanha\b/.test(f)) dates.add(addDays(todayIso, 2));
      if (/\bamanha\b/.test(f.replace(/\bdepois de amanha\b/g, " "))) dates.add(addDays(todayIso, 1));
      if (/\bhoje\b/.test(f)) dates.add(todayIso);
    }

    // dias da semana
    for (const m of f.matchAll(WD_RE)) {
      const wd = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"].indexOf(m[1]);
      if (wd < 0) continue;
      wds.add(wd);
      const before = f.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
      if (ONLY_RE.test(before)) req.onlyWeekdays = true;
      // "terca" aponta a proxima terca; "so aos sabados" e restricao (nao pede uma data), e data explicita sempre manda
      if (!ONLY_RE.test(before) && !/\d{1,2}\/\d{1,2}|\bdia \d{1,2}\b/.test(f)) weekdayDates.add(nextWeekday(todayIso, wd));
    }

    // limites de horario
    for (const m of f.matchAll(new RegExp(`\\b(?:depois d[aeo]s?|a partir d[aeo]s?|apos as?)\\s*${T}`, "g"))) {
      const t = hhmm(m[1], m[2]);
      if (t) req.notBefore = t;
    }
    for (const m of f.matchAll(new RegExp(`\\b(?:antes d[aeo]s?|ate (?:as?|o))\\s*${T}`, "g"))) {
      const t = hhmm(m[1], m[2]);
      if (t) req.notAfter = t;
    }
    // "tenho aula as 18:40", "saio do trabalho as 17h": a partir dai ela nao consegue
    for (const m of f.matchAll(new RegExp(`\\b(?:tenho|tem)\\s+(?:uma?\\s+)?(?:aula|curso|reuniao|compromisso|trabalho|medico|consulta|faculdade|prova)\\w*\\s+(?:as?|a partir d[aeo]s?)\\s*${T}`, "g"))) {
      const t = hhmm(m[1], m[2]);
      if (t) req.notAfter = t;
    }

    // "saio do trabalho as 18h30", "so consigo depois das 18:30", "so posso a partir das 19h": ela so esta livre a PARTIR dai (caso Nathalia: ofereceram 13h30 a quem sai as 18h30)
    for (const m of f.matchAll(new RegExp(`\\bsaio\\b[^.!?\\n]{0,40}?\\b(?:as?|a partir d[aeo]s?)\\s*${T}`, "g"))) {
      const t = hhmm(m[1], m[2]);
      if (t) req.notBefore = t;
    }
    for (const m of f.matchAll(new RegExp(`\\b(?:so|somente|apenas)\\s+(?:consigo|posso|da pra|tenho como|estou livre)\\b[^.!?\\n]{0,25}?\\b(?:as?|depois d[aeo]s?|a partir d[aeo]s?|apos as?)\\s*${T}`, "g"))) {
      const t = hhmm(m[1], m[2]);
      if (t) req.notBefore = t;
    }

    // turno
    if (/\b(de manha|pela manha|manha|cedo)\b/.test(f)) req.period = "manha";
    else if (/\b(a tarde|de tarde|pela tarde|tarde)\b/.test(f) && !/\bboa tarde\b/.test(f)) req.period = "tarde";
    else if (/\b(a noite|de noite|pela noite|noitinha)\b/.test(f) && !/\bboa noite\b/.test(f)) req.period = "noite";

    // horas citadas como preferencia ("10 ou 10:30", "umas 10", "12h30"): so as que NAO foram lidas como limite
    for (const m of f.matchAll(/\b(\d{1,2})(?:\s*(?:h|:)\s*(\d{2})?)?\b/g)) {
      const t = hhmm(m[1], m[2]);
      if (!t) continue;
      const hour = Number(m[1]);
      // numero solto so conta com marca de hora ("10h", "10:30") ou junto de "umas/as/ou"
      const marked = /[h:]/.test(m[0]) || new RegExp(`\\b(?:umas?|as|a|ou)\\s+${m[1]}\\b`).test(f);
      if (!marked || hour < 6 || hour > 22) continue;
      // nao e a data ("24/10") nem o numero do dia ("dia 24")
      if (new RegExp(`\\b${m[1]}\\s*/`).test(f) && !/[h:]/.test(m[0])) continue;
      if (new RegExp(`\\bdia ${m[1]}\\b`).test(f) && !/[h:]/.test(m[0])) continue;
      times.add(t);
    }
  }

  req.dates = [...(dates.size ? dates : weekdayDates)].sort();
  req.weekdays = [...wds].sort();
  // limites nao entram como "horario preferido"
  req.times = [...times].filter((t) => t !== req.notAfter && t !== req.notBefore).sort();
  return req;
}

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// PURO: o pedido em texto curto para a ficha ("sabado 24/10; so consegue aos sabados; citou 10:00, 10:30; nao pode depois das 18:40").
export function describeSlotRequest(r: SlotRequest): string {
  const parts: string[] = [];
  if (r.dates.length) parts.push(`dia(s) que ela citou: ${r.dates.slice(0, 4).map((d) => `${WEEKDAY_NAMES[weekdayOfIso(d)]} ${dm(d)}`).join(", ")}`);
  if (r.weekdays.length) parts.push(`${r.onlyWeekdays ? "SO consegue" : "citou"} ${r.weekdays.map((w) => WEEKDAY_NAMES[w]).join(", ")}`);
  if (r.times.length) parts.push(`horario(s) que ela citou: ${r.times.slice(0, 4).join(", ")}`);
  if (r.period) parts.push(`turno: ${r.period === "manha" ? "manha" : r.period}`);
  if (r.notBefore) parts.push(`so depois das ${r.notBefore}`);
  if (r.notAfter) parts.push(`NAO pode a partir das ${r.notAfter} (o atendimento tem que terminar antes)`);
  return parts.join("; ");
}

// PURO: um horario (data ISO + HH:MM de inicio) respeita o pedido? Usado pra conferir a oferta antes de enviar.
export function slotRespects(r: SlotRequest, iso: string, time: string, durationMin = 30): boolean {
  if (r.onlyWeekdays && r.weekdays.length && !r.weekdays.includes(weekdayOfIso(iso))) return false;
  if (r.notBefore && time < r.notBefore) return false;
  if (r.notAfter) {
    const [h, m] = time.split(":").map(Number);
    const end = h * 60 + m + durationMin;
    const [lh, lm] = r.notAfter.split(":").map(Number);
    if (end > lh * 60 + lm) return false;
  }
  if (r.period) {
    const h = Number(time.slice(0, 2));
    if (r.period === "manha" && h >= 12) return false;
    if (r.period === "tarde" && (h < 12 || h >= 18)) return false;
    if (r.period === "noite" && h < 18) return false;
  }
  return true;
}

// PURO: a oferta da Alice (lista de horarios que a agenda devolveu) respeita o pedido da pessoa? Devolve o motivo (texto pra mandar o modelo
// refazer) ou null. So conta restricao DURA: "so aos sabados", "antes das 18:40", "depois das 17h", turno, e dia explicito que nem foi consultado.
export function requestViolation(
  req: SlotRequest,
  offer: { date: string; time: string }[],
  datesQueried: string[],
  todayIso: string,
  durationMin = 30,
): string | null {
  if (offer.length && (req.onlyWeekdays || req.notBefore || req.notAfter || req.period)) {
    const ok = offer.filter((o) => slotRespects(req, o.date, o.time, durationMin));
    if (!ok.length) return `os horarios que voce ofereceu NAO respeitam o pedido dela (${describeSlotRequest(req)}). Consulte de novo (check_availability com date do dia que ela pode e from_time/until_time) e ofereca so horarios que respeitem esse pedido.`;
  }
  const wanted = req.dates.filter((d) => d >= todayIso);
  if (wanted.length && !wanted.some((d) => datesQueried.includes(d)) && offer.length && !offer.some((o) => wanted.includes(o.date))) {
    return `ela pediu ${wanted.slice(0, 2).map((d) => `${WEEKDAY_NAMES[weekdayOfIso(d)]} ${dm(d)}`).join(" ou ")} e voce nao consultou esse dia. Consulte ESSE dia primeiro (check_availability com date=${wanted[0]}); so ofereca outro dia se nao houver horario nele, e diga isso com clareza.`;
  }
  return null;
}
