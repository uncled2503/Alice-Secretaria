import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// UMA CONFIRMACAO POR PESSOA POR DIA (pedido da Lisboa, 14/10/2026): quem tem 3 agendamentos no mesmo dia (3 procedimentos
// na mesma visita) recebia 3 confirmacoes. Agora so o PRIMEIRO horario do dia dispara os lembretes/confirmacoes; os demais
// ficam "cobertos" por ele. Estas funcoes sao usadas pelo envio (cron), pela auditoria de cobertura e pelo resumo diario.
// ---------------------------------------------------------------------------

interface DayAppt {
  id: string;
  patientId: string;
  attendeeId?: string | null; // acompanhante que divide o telefone: e outra PESSOA
  scheduledAt: Date;
}

// PURO: ids dos agendamentos que sao o PRIMEIRO do dia (dia local da clinica) de cada pessoa.
export function firstOfDayIds(appts: DayAppt[], timeZone: string): Set<string> {
  const sorted = [...appts].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const first = new Set<string>();
  for (const a of sorted) {
    const key = `${a.patientId}|${a.attendeeId ?? ""}|${isoDateInZone(a.scheduledAt, timeZone)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    first.add(a.id);
  }
  return first;
}

// Limites [inicio, fim) do dia local em que cai o instante.
export function localDayBounds(instant: Date, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = isoDateInZone(instant, timeZone).split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: zonedWallClockToUtc(timeZone, y, m, d, 0, 0),
    end: zonedWallClockToUtc(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0),
  };
}
