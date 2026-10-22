import { wallClockInZone } from "./time.js";

// ---------------------------------------------------------------------------
// COMPATIBILIDADE REAL DA LISTA DE ESPERA (22/10). Antes a vaga ia para o primeiro da fila com o mesmo procedimento, sem olhar dia, turno, antecedencia nem validade. Agora a entrada so e
// elegivel quando TODOS os criterios que ela registrou batem com a vaga (criterio nao preenchido = qualquer). Ordem: prioridade (maior primeiro) e depois a mais antiga.
// Oferecer a vaga NAO reserva a vaga: a mensagem pergunta se a pessoa quer e a reserva so existe depois do aceite e do CE (ver offerFreedSlotToWaitlist).
// ---------------------------------------------------------------------------
export interface WaitEntry {
  id: string; procedureId: string | null; professionalId: string | null; days: string | null; shifts: string | null; minLeadHours: number; priority: number; validUntil: Date | null; createdAt: Date; status: string;
}
export interface FreedSlot { procedureId: string; professionalId: string | null; start: Date }

export type Shift = "manha" | "tarde" | "noite";
export function shiftOf(hour: number): Shift { return hour < 12 ? "manha" : hour < 18 ? "tarde" : "noite"; }

const parseList = (v: string | null | undefined): string[] | null => { const l = (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean); return l.length ? l : null; };

export function waitEntryProblem(e: WaitEntry, slot: FreedSlot, now: Date, tz: string): string | null {
  if (e.status !== "waiting") return "entrada nao esta aguardando";
  if (e.validUntil && e.validUntil.getTime() < now.getTime()) return "entrada vencida";
  if (e.procedureId && e.procedureId !== slot.procedureId) return "outro procedimento";
  if (e.professionalId && slot.professionalId && e.professionalId !== slot.professionalId) return "outro profissional";
  if (slot.start.getTime() <= now.getTime()) return "a vaga ja passou";
  if (e.minLeadHours > 0 && slot.start.getTime() - now.getTime() < e.minLeadHours * 3_600_000) return `antecedencia menor que ${e.minLeadHours}h`;
  const w = wallClockInZone(slot.start, tz);
  const wd = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  const days = parseList(e.days);
  if (days && !days.includes(String(wd))) return "dia da semana fora do pedido";
  const shifts = parseList(e.shifts);
  if (shifts && !shifts.includes(shiftOf(w.hour))) return "turno fora do pedido";
  return null;
}

// PURO: entradas compativeis com a vaga, na ordem de oferta.
export function rankWaitlist(entries: WaitEntry[], slot: FreedSlot, now: Date, tz: string): WaitEntry[] {
  return entries.filter((e) => waitEntryProblem(e, slot, now, tz) === null).sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
}
