// ---------------------------------------------------------------------------
// O QUE A CLINICA JA ESCREVEU (equipe, do celular ou do painel, e lembretes automaticos). Caso Rita (15/10): a recepcao mandou "Data 20/10,
// Horario 09h30" e a Alice respondeu "08:00" porque a agenda dela estava desatualizada (a reserva foi movida no Clinica Experts). A fala da
// clinica vale tanto quanto a agenda: se divergirem, a Alice NAO afirma nenhum dos dois (confere no CE; se nao resolver, a equipe responde).
// Tudo aqui e PURO (testavel).
// ---------------------------------------------------------------------------

import { extractMentions } from "./slotGuard.js";
import { wallClockInZone } from "../scheduling/time.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export interface HistoryMessage {
  role: string; // user | assistant | human
  content: string;
  authorName?: string | null; // preenchido = automacao da clinica (lembrete, pos, NPS...)
  createdAt: Date;
}

export interface ClinicStatement {
  dd: number;
  mm: number;
  time: string; // HH:MM
  from: "equipe" | "automatica";
  at: Date;
  quote: string;
}

const APPT_CUE_RE = /\b(confirm\w*|agendamento|agendad\w*|marcad\w*|seu horario|horario|te receber|te esperamos|data)\b/;

// PURO: horarios de atendimento que a clinica afirmou (uma data e uma hora na mesma mensagem), do mais antigo ao mais novo.
export function clinicTimeStatements(history: HistoryMessage[], tz: string, now: Date, lookbackDays = 8): ClinicStatement[] {
  const out: ClinicStatement[] = [];
  const since = now.getTime() - lookbackDays * 86_400_000;
  for (const m of history) {
    const isStaff = m.role === "human";
    const isAuto = m.role === "assistant" && !!m.authorName;
    if (!isStaff && !isAuto) continue;
    if (m.createdAt.getTime() < since) continue;
    if (!APPT_CUE_RE.test(fold(m.content))) continue;
    const ment = extractMentions(m.content);
    if (ment.times.length !== 1) continue; // lista de horarios (oferta) nao e afirmacao de um horario marcado
    let dd: number | null = null;
    let mm: number | null = null;
    if (ment.dates.length === 1) [dd, mm] = ment.dates[0].split("/").map(Number);
    else if (ment.dates.length === 0 && ment.relative.length === 1 && (ment.relative[0] === "hoje" || ment.relative[0] === "amanha")) {
      const base = wallClockInZone(m.createdAt, tz);
      const day = new Date(Date.UTC(base.year, base.month - 1, base.day + (ment.relative[0] === "amanha" ? 1 : 0)));
      dd = day.getUTCDate();
      mm = day.getUTCMonth() + 1;
    }
    if (dd == null || mm == null) continue;
    out.push({ dd, mm, time: ment.times[0], from: isStaff ? "equipe" : "automatica", at: m.createdAt, quote: m.content.replace(/\s+/g, " ").slice(0, 80) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface LocalAppt {
  dd: number;
  mm: number;
  time: string;
}

export interface TimeConflict {
  dd: number;
  mm: number;
  clinicTime: string;
  localTimes: string[];
  from: "equipe" | "automatica";
  quote: string;
}

// PURO: a ULTIMA afirmacao da clinica sobre cada dia diverge da agenda da Alice nesse dia?
export function findTimeConflicts(appts: LocalAppt[], statements: ClinicStatement[]): TimeConflict[] {
  const lastByDate = new Map<string, ClinicStatement>();
  for (const s of statements) lastByDate.set(`${s.dd}/${s.mm}`, s); // o mais recente vale
  const out: TimeConflict[] = [];
  for (const s of lastByDate.values()) {
    const sameDay = appts.filter((a) => a.dd === s.dd && a.mm === s.mm);
    if (!sameDay.length || sameDay.some((a) => a.time === s.time)) continue;
    out.push({ dd: s.dd, mm: s.mm, clinicTime: s.time, localTimes: sameDay.map((a) => a.time), from: s.from, quote: s.quote });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function statementsNote(statements: ClinicStatement[]): string {
  if (!statements.length) return "";
  const last = new Map<string, ClinicStatement>();
  for (const s of statements) last.set(`${s.dd}/${s.mm}`, s);
  return `HORARIOS QUE A CLINICA JA ESCREVEU NESTA CONVERSA (equipe ou lembrete automatico): ${[...last.values()].map((s) => `${pad(s.dd)}/${pad(s.mm)} as ${s.time} (${s.from})`).join("; ")}. Isso vale tanto quanto a agenda: nunca diga um horario diferente do que a clinica ja informou; se houver duvida, nao afirme. `;
}
