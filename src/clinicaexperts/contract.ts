import { zonedWallClockToUtc } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// CONTRATO DO CLINICA EXPERTS (API v1, https://clinicaexperts.readme.io/reference). Funcoes PURAS: o que a Alice aceita como resposta valida e como interpreta cada campo.
// Conferido contra a documentacao em 21/10/2026. O que a documentacao NAO diz esta marcado como LIMITACAO e a Alice nao presume:
//  - a documentacao de /available-hours so diz que `data` e uma lista de OBJETOS sem campos definidos (additionalProperties); a implementacao sempre tratou itens como
//    texto "HH:MM". Aqui os dois formatos sao aceitos e uma forma NAO reconhecida vira "disponibilidade nao verificada" (nunca "dia sem horarios livres");
//  - o significado de `procedure_id` e `procedure_from_event` e de `interval` (unidade) nao esta documentado: a Alice NAO envia procedure_id/procedure_from_event e pede
//    celulas de 15 em 15 (interval=15), exigindo que TODAS as celulas da duracao estejam livres (nao presume que o CE considere a duracao);
//  - o POST /bookings devolve 200 (nao 201) e a documentacao nao define conflito (409): conflito vem como 422 com `errors`;
//  - PATCH /bookings/{uuid}/reschedule NAO tem corpo documentado (nao permite informar o novo horario): remarcar e PUT /bookings/{uuid} com starts_at/ends_at;
//  - a listagem documenta `per_page` (1..1000) e o envelope `meta` (valores como TEXTO), mas nao documenta o parametro `page`; ele e usado e a completude e CONFERIDA.
//  - limite de chamadas: a pagina "Status of returns" diz 100/min e a de "Request limits" diz 120/min: a Alice usa o menor (ver client.ts).
// ---------------------------------------------------------------------------

// ---------- estados ----------

export type CeMeaning = "active" | "completed" | "cancelled" | "no_show";
export interface CeStatusInfo {
  raw: string;
  known: boolean;
  meaning: CeMeaning | null; // null = estado desconhecido: NUNCA vira "confirmado" por padrao
}

const squash = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

// Estados documentados: scheduled, done, rescheduled, canceled, noshow, confirmed, waiting, progress, reserved. "rescheduled", "waiting", "progress" e "reserved" ainda sao
// reservas ATIVAS no calendario (a recepcao as reagenda/atende); so done, canceled e noshow encerram.
export function ceStatusInfo(raw: unknown): CeStatusInfo {
  const text = typeof raw === "string" ? raw.trim() : "";
  const s = squash(text);
  if (!s) return { raw: text, known: false, meaning: null };
  if (s.startsWith("cancel")) return { raw: text, known: true, meaning: "cancelled" };
  if (s === "noshow" || s.includes("missed") || s === "faltou" || s === "falta") return { raw: text, known: true, meaning: "no_show" };
  if (s === "done" || s.includes("complet") || s.includes("attended") || s.includes("finish") || s === "concluido" || s === "atendido") return { raw: text, known: true, meaning: "completed" };
  if (["scheduled", "confirmed", "waiting", "progress", "reserved", "rescheduled", "agendado", "confirmado", "aguardando", "ematendimento", "reservado", "remarcado"].includes(s)) return { raw: text, known: true, meaning: "active" };
  return { raw: text, known: false, meaning: null };
}

// Compatibilidade: estado do CE -> estado local. DESCONHECIDO nao vira "confirmed" (devolve null; quem chama preserva o estado local e registra o bruto).
export function mapCeStatus(raw: string | undefined): "confirmed" | "cancelled" | "no_show" | "completed" | null {
  const info = ceStatusInfo(raw);
  switch (info.meaning) {
    case "active": return "confirmed";
    case "cancelled": return "cancelled";
    case "no_show": return "no_show";
    case "completed": return "completed";
    default: return null;
  }
}

// ---------- instantes ----------

// Instante de uma reserva do CE. Com fuso explicito (Z ou +/-hh:mm) usa direto; SEM fuso le como horario de parede no fuso da clinica (nunca no do servidor).
export function parseCeInstant(raw: string, timeZone: string): Date {
  const text = raw.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return new Date(text);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!m) return new Date(NaN);
  return zonedWallClockToUtc(timeZone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}
export const hasExplicitOffset = (raw: string): boolean => /(Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim());

// ---------- envelope ----------

// {data: ...} ou o objeto direto.
export function unwrapData(json: unknown): unknown {
  if (json && typeof json === "object" && !Array.isArray(json) && "data" in (json as Record<string, unknown>)) return (json as { data: unknown }).data;
  return json;
}

export interface ListMeta { page: number; lastPage: number; of: number | null; perPage: number | null }
// `meta` vem com valores em TEXTO ("1", "3"): converte e valida. Sem meta utilizavel = null (quem chama decide se o resultado e completo).
export function listMeta(meta: unknown): ListMeta | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const n = (v: unknown): number | null => { const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(x) ? x : null; };
  const page = n(m.page), last = n(m.last_page);
  if (page == null || last == null || last < 1) return null;
  return { page, lastPage: last, of: n(m.of), perPage: n(m.per_page) };
}

// ---------- reserva ----------

export interface CeProcedureRef { id: number; name: string | null; duration: number | null }
export interface CeBookingParsed {
  uuid: string;
  startsAtRaw: string;
  startsAt: Date;
  endsAt: Date | null;
  hasOffset: boolean;
  status: CeStatusInfo;
  updatedAt: Date | null;
  patient: { uuid: string | null; name: string | null; phone: string | null; raw: Record<string, unknown> } | null;
  professionalUuid: string | null;
  procedures: CeProcedureRef[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Valida UMA reserva. Campos essenciais ausentes (uuid, inicio legivel, estado) => ok:false com os motivos; HTTP 200 com corpo estranho NAO e confirmacao.
export function parseBookingResource(raw: unknown, tz: string): { ok: true; booking: CeBookingParsed } | { ok: false; issues: string[] } {
  const b = unwrapData(raw);
  const issues: string[] = [];
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, issues: ["a resposta nao e uma reserva (objeto)"] };
  const r = b as Record<string, unknown>;
  const uuid = str(r.uuid);
  if (!uuid) issues.push("sem uuid da reserva");
  const startsRaw = str(r.starts_at);
  const startsAt = startsRaw ? parseCeInstant(startsRaw, tz) : new Date(NaN);
  if (!startsRaw) issues.push("sem horario de inicio");
  else if (Number.isNaN(startsAt.getTime())) issues.push("horario de inicio ilegivel");
  const status = ceStatusInfo(r.status);
  if (!status.raw) issues.push("sem estado da reserva");
  if (issues.length || !uuid || !startsRaw) return { ok: false, issues };
  const endsRaw = str(r.ends_at);
  const endsAt = endsRaw ? parseCeInstant(endsRaw, tz) : null;
  const upd = str(r.updated_at);
  const updatedAt = upd ? parseCeInstant(upd, tz) : null;
  const p = r.patient && typeof r.patient === "object" && !Array.isArray(r.patient) ? (r.patient as Record<string, unknown>) : null;
  const pro = r.professional && typeof r.professional === "object" ? (r.professional as Record<string, unknown>) : null;
  const procs: CeProcedureRef[] = [];
  if (Array.isArray(r.procedures)) {
    for (const x of r.procedures) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === "number" ? o.id : typeof o.id === "string" && /^\d+$/.test(o.id) ? Number(o.id) : null;
      if (id == null) continue;
      procs.push({ id, name: str(o.name), duration: typeof o.duration === "number" && o.duration > 0 ? o.duration : null });
    }
  }
  return {
    ok: true,
    booking: {
      uuid, startsAtRaw: startsRaw, startsAt, endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null, hasOffset: hasExplicitOffset(startsRaw),
      status, updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
      patient: p ? { uuid: str(p.uuid), name: str(p.name), phone: str(p.phone), raw: p } : null,
      professionalUuid: pro ? str(pro.uuid) : null,
      procedures: procs,
    },
  };
}

// ---------- disponibilidade ----------

const TIME_KEYS = ["starts_at", "start", "start_time", "time", "hour", "datetime", "date_time", "from", "begin", "available_at"];
export interface AvailableParse {
  starts: number[]; // instantes (epoch ms) de INICIO livres reconhecidos
  unrecognized: number; // itens que nao deu pra interpretar
  shape: "empty" | "strings" | "objects" | "mixed";
}

// Interpreta `data` de GET /available-hours. Itens: "HH:MM" / "HH:MM:SS" / ISO, ou objeto com algum dos campos conhecidos (com `available:false`/`busy:true` descartado).
export function parseAvailableHours(items: unknown, tz: string, day: { year: number; month: number; day: number }): AvailableParse {
  const out: AvailableParse = { starts: [], unrecognized: 0, shape: "empty" };
  if (!Array.isArray(items) || items.length === 0) return out;
  let strings = 0, objects = 0;
  const pushText = (t: string): boolean => {
    const hm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t.trim());
    if (hm) {
      out.starts.push(zonedWallClockToUtc(tz, day.year, day.month, day.day, Number(hm[1]), Number(hm[2])).getTime());
      return true;
    }
    const at = parseCeInstant(t, tz);
    if (!Number.isNaN(at.getTime())) { out.starts.push(at.getTime()); return true; }
    return false;
  };
  for (const it of items) {
    if (typeof it === "string") { strings++; if (!pushText(it)) out.unrecognized++; continue; }
    if (it && typeof it === "object" && !Array.isArray(it)) {
      objects++;
      const o = it as Record<string, unknown>;
      if (o.available === false || o.busy === true || o.free === false) continue; // marcado como ocupado: nao e horario livre
      const key = TIME_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
      if (!key || !pushText(o[key] as string)) out.unrecognized++;
      continue;
    }
    out.unrecognized++;
  }
  out.shape = strings && objects ? "mixed" : objects ? "objects" : "strings";
  return out;
}
