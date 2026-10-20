import { prisma } from "../db/client.js";
import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { ceRequest, getAccount, isoWithOffset, noteError } from "./client.js";
import { parseAvailableHours } from "./contract.js";

// O endpoint /available-hours do Clinica Experts devolve, pra um profissional
// num dia, os horarios de INICIO livres (ja descontando a escala dele,
// agendamentos e bloqueios). Ele NAO considera a duracao do procedimento, entao
// pedimos em passos de 15 min e exigimos que TODAS as celulas de 15 min do
// procedimento estejam livres.

export const CELL_MIN = 15;

// (inicio em epoch ms, duracao em min) -> cabe?
// `covers` diz se o CE foi consultado com sucesso pro DIA daquele horario: nesses dias o CE e a fonte da verdade
// (ja inclui agendamentos, remarcacoes e cancelamentos feitos la), entao os agendamentos que a Alice espelhou/importou
// do CE (ceBookingUuid) NAO contam de novo como ocupado - a copia local pode estar velha (cancelado/movido no CE) ou ter
// duracao diferente, e era isso que fazia a Alice dizer "ocupado" pra horario vago.
// `unverified`: o CE e a fonte da agenda e NAO foi consultado com sucesso pro DIA desse horario - nao da pra afirmar que esta livre.
export type SlotGate = ((startMs: number, durationMin: number) => boolean) & { covers?: (startMs: number) => boolean; unverified?: (startMs: number) => boolean };

// Escape de emergencia (variavel de ambiente): volta ao comportamento antigo, em que o dia que o CE nao respondeu NAO bloqueia a oferta.
const failOpen = () => (process.env.CE_GATE_FAIL_OPEN ?? "").trim().toLowerCase() === "on";

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
// dia): por padrao NAO oferece (`unverified` - a disponibilidade nao foi confirmada, e o CE e a fonte da agenda);
// com `failOpen` volta ao comportamento antigo (nao bloqueia).
export function buildGate(freeCells: Set<number>, loadedDays: Set<string>, timeZone: string, opts: { failOpen?: boolean } = {}): SlotGate {
  const failOpenMode = opts.failOpen ?? false;
  const gate: SlotGate = (startMs, durationMin) => {
    if (!loadedDays.has(isoDateInZone(new Date(startMs), timeZone))) return failOpenMode;
    const cells = Math.max(1, Math.ceil(durationMin / CELL_MIN));
    for (let i = 0; i < cells; i++) {
      if (!freeCells.has(startMs + i * CELL_MIN * 60_000)) return false;
    }
    return true;
  };
  gate.covers = (startMs) => loadedDays.has(isoDateInZone(new Date(startMs), timeZone));
  if (!failOpenMode) gate.unverified = (startMs) => !loadedDays.has(isoDateInZone(new Date(startMs), timeZone));
  return gate;
}

// Cache curto por (clinica, profissional, dia): a busca de horarios chama isso
// varias vezes seguidas e o Clinica Experts nao precisa ser consultado a cada
// uma. 45s e curto o bastante pra um agendamento recem-feito aparecer.
const dayCache = new Map<string, { at: number; hours: number[] | null }>(); // instantes (epoch ms) de inicio livres; null = nao verificado
const CACHE_MS = 45_000;
const FAILURE_CACHE_MS = 10_000; // falha do CE vale por pouco: nao martela um CE fora do ar, mas volta a oferecer logo que ele responde

export function invalidateCeCache(clinicId: string): void {
  for (const k of dayCache.keys()) if (k.startsWith(`${clinicId}|`)) dayCache.delete(k);
}

async function hoursForDay(
  clinicId: string,
  uuid: string,
  date: { year: number; month: number; day: number },
  timeZone: string,
): Promise<number[] | null> {
  const key = `${clinicId}|${uuid}|${date.year}-${date.month}-${date.day}`;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < (hit.hours ? CACHE_MS : FAILURE_CACHE_MS)) return hit.hours;

  const midnight = zonedWallClockToUtc(timeZone, date.year, date.month, date.day, 0, 0);
  const res = await ceRequest<{ data: unknown }>(clinicId, "/available-hours", {
    query: { professional_uuid: uuid, date: isoWithOffset(midnight, timeZone), interval: CELL_MIN },
  });
  // A documentacao define `data` como lista de OBJETOS sem campos; a implementacao sempre leu texto "HH:MM". Os dois formatos sao aceitos; uma forma NAO reconhecida NUNCA vira
  // "dia sem horarios livres" (isso fecharia a agenda da profissional sem ninguem saber): vira "disponibilidade nao verificada" e a causa aparece no painel.
  let hours: number[] | null = null;
  let why = res.ok ? "resposta inesperada" : res.error;
  if (res.ok) {
    const body = res.data as { data?: unknown } | null;
    if (body && Array.isArray(body.data)) {
      const parsed = parseAvailableHours(body.data, timeZone, date);
      if (parsed.unrecognized === 0) hours = parsed.starts;
      else why = `formato de horario nao reconhecido (${parsed.unrecognized} item(ns), ${parsed.shape}); a Alice nao presume que nao ha horarios`;
    } else why = "resposta sem a lista `data`";
  }
  // Falha aqui FECHA o portao pra esse dia (a disponibilidade nao foi confirmada) - entao a falha PRECISA aparecer, senao a Alice
  // some com os horarios dessa profissional sem ninguem saber por que. Aparece em Configuracoes > Clinica Experts.
  if (!hours) await noteError(clinicId, `Consulta de disponibilidade falhou (a Alice não oferece horários dessa profissional até o Clínica Experts responder): ${why}`);
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
      for (const ms of hours) free.add(ms);
    }),
  );
  if (loaded.size === 0) {
    // O CE nao respondeu nenhum dia: com ele como fonte da agenda, nao ha como afirmar disponibilidade (o portao fecha pros dias pedidos).
    if (failOpen()) return null;
    console.warn(`[agenda] Clinica Experts nao respondeu a disponibilidade (clinica=${clinicId} profissional=${professional.ceUuid}): horarios dessa profissional nao serao oferecidos ate ele responder`);
  }
  return buildGate(free, loaded, timeZone, { failOpen: failOpen() });
}

export async function professionalCeUuid(clinicId: string, professionalId: string | null | undefined): Promise<{ ceUuid: string | null } | null> {
  if (!professionalId) return null;
  return prisma.professional.findFirst({ where: { id: professionalId, clinicId }, select: { ceUuid: true } });
}
