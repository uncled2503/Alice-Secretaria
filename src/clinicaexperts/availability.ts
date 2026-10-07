import { prisma } from "../db/client.js";
import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { ceRequest, getAccount, isoWithOffset, noteError } from "./client.js";

// O endpoint /available-hours do Clinica Experts devolve, pra um profissional
// num dia, os horarios de INICIO livres (ja descontando a escala dele,
// agendamentos e bloqueios). Ele NAO considera a duracao do procedimento, entao
// pedimos em passos de 15 min e exigimos que TODAS as celulas de 15 min do
// procedimento estejam livres.

export const CELL_MIN = 15;

// (inicio em epoch ms, duracao em min) -> cabe?
export type SlotGate = (startMs: number, durationMin: number) => boolean;

// PURO: "08:30" no dia (fuso da clinica) -> epoch ms.
export function cellStarts(timeZone: string, date: { year: number; month: number; day: number }, hhmm: string[]): number[] {
  const out: number[] = [];
  for (const h of hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(h);
    if (!m) continue;
    out.push(zonedWallClockToUtc(timeZone, date.year, date.month, date.day, Number(m[1]), Number(m[2])).getTime());
  }
  return out;
}

// PURO: monta o portao a partir das celulas livres conhecidas e dos dias
// efetivamente carregados. Dia que nao foi carregado (CE fora do ar naquele
// dia) nao bloqueia: nunca derrubamos a agenda por falha de integracao.
export function buildGate(freeCells: Set<number>, loadedDays: Set<string>, timeZone: string): SlotGate {
  return (startMs, durationMin) => {
    if (!loadedDays.has(isoDateInZone(new Date(startMs), timeZone))) return true;
    const cells = Math.max(1, Math.ceil(durationMin / CELL_MIN));
    for (let i = 0; i < cells; i++) {
      if (!freeCells.has(startMs + i * CELL_MIN * 60_000)) return false;
    }
    return true;
  };
}

// Cache curto por (clinica, profissional, dia): a busca de horarios chama isso
// varias vezes seguidas e o Clinica Experts nao precisa ser consultado a cada
// uma. 45s e curto o bastante pra um agendamento recem-feito aparecer.
const dayCache = new Map<string, { at: number; hours: string[] | null }>();
const CACHE_MS = 45_000;

export function invalidateCeCache(clinicId: string): void {
  for (const k of dayCache.keys()) if (k.startsWith(`${clinicId}|`)) dayCache.delete(k);
}

async function hoursForDay(
  clinicId: string,
  uuid: string,
  date: { year: number; month: number; day: number },
  timeZone: string,
): Promise<string[] | null> {
  const key = `${clinicId}|${uuid}|${date.year}-${date.month}-${date.day}`;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.hours;

  const midnight = zonedWallClockToUtc(timeZone, date.year, date.month, date.day, 0, 0);
  const res = await ceRequest<{ data: string[] }>(clinicId, "/available-hours", {
    query: { professional_uuid: uuid, date: isoWithOffset(midnight, timeZone), interval: CELL_MIN },
  });
  const hours = res.ok && Array.isArray(res.data?.data) ? res.data.data : null;
  // Falha aqui faz o portao "abrir" (nunca derrubamos a agenda por falha de
  // integracao) - entao a falha PRECISA aparecer, senao a Alice oferece horario
  // ocupado sem ninguem saber por que. Aparece em Configuracoes > Clinica Experts.
  if (!hours) await noteError(clinicId, `Consulta de disponibilidade falhou (a Alice pode oferecer horário já ocupado): ${res.ok ? "resposta inesperada" : res.error}`);
  dayCache.set(key, { at: Date.now(), hours });
  return hours;
}

// Portao de disponibilidade do Clinica Experts pra um profissional, cobrindo
// `daysAhead` dias a partir de `fromUtc`. Devolve null quando nao se aplica
// (clinica sem integracao, "respeitar o CE" desligado, profissional sem
// vinculo) - ai a agenda funciona so com as regras proprias da Alice.
export async function ceGateFor(
  clinicId: string,
  professional: { ceUuid: string | null } | null | undefined,
  fromUtc: Date,
  daysAhead: number,
  timeZone: string,
): Promise<SlotGate | null> {
  if (!professional?.ceUuid) return null;
  const account = await getAccount(clinicId);
  if (!account || !account.blockBusy) return null;

  const days: { year: number; month: number; day: number; key: string }[] = [];
  const anchor = new Date(fromUtc.getTime());
  for (let d = 0; d < Math.max(1, daysAhead) + 1; d++) {
    const when = new Date(anchor.getTime() + d * 24 * 3_600_000);
    const key = isoDateInZone(when, timeZone);
    const [y, m, dd] = key.split("-").map(Number);
    if (!days.some((x) => x.key === key)) days.push({ year: y, month: m, day: dd, key });
  }

  const loaded = new Set<string>();
  const free = new Set<number>();
  await Promise.all(
    days.map(async (day) => {
      const hours = await hoursForDay(clinicId, professional.ceUuid!, day, timeZone);
      if (!hours) return;
      loaded.add(day.key);
      for (const ms of cellStarts(timeZone, day, hours)) free.add(ms);
    }),
  );
  if (loaded.size === 0) return null;
  return buildGate(free, loaded, timeZone);
}

export async function professionalCeUuid(clinicId: string, professionalId: string | null | undefined): Promise<{ ceUuid: string | null } | null> {
  if (!professionalId) return null;
  return prisma.professional.findFirst({ where: { id: professionalId, clinicId }, select: { ceUuid: true } });
}
