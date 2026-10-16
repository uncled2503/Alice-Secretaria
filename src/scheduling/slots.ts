import { prisma } from "../db/client.js";
import { wallClockInZone, zonedWallClockToUtc, formatInZone, formatDayInZone, isoDateInZone } from "./time.js";
import { googleBusyIntervals } from "../google/calendar.js";
import { pushAppointmentInBackground } from "../integrations/calendarSync.js";
import { ceGateFor, type SlotGate } from "../clinicaexperts/availability.js";
import { nationalHolidayOn, parseHolidayOpen } from "./holidays.js";

export interface Slot {
  start: Date;
  end: Date;
  professionalId: string | null;
  professionalName: string | null;
}

// Intervalo ocupado, em epoch ms.
export interface BusyInterval {
  start: number;
  end: number;
  ce?: boolean; // agendamento que veio do / foi espelhado no Clinica Experts (o portao do CE ja o enxerga)
}

export interface ClinicHours {
  timezone: string;
  workStartMinutes: number; // minutos desde meia-noite (ex.: 8h30 = 510)
  workEndMinutes: number;
  lunchStartMinutes: number | null;
  lunchEndMinutes: number | null;
  workDays: Set<number>; // 0=domingo .. 6=sabado
  closedOnHolidays: boolean;
  holidayOpen?: Set<string>; // feriados nacionais em que a clinica ABRE (aba Feriados)
}

export type SlotReason = "past" | "closed_day" | "outside_hours" | "lunch_break" | "conflict" | "blocked" | "holiday";
export type SlotVerdict = { ok: true } | { ok: false; reason: SlotReason };

// Texto em portugues de cada motivo de recusa - fonte unica usada pela Alice,
// pelo painel e pela API externa, pra nunca ter tres traducoes divergentes do
// mesmo motivo.
export const SLOT_REASON_PT: Record<SlotReason | "procedure_not_found" | "invalid_datetime", string> = {
  past: "esse horário já passou",
  closed_day: "a clínica não atende nesse dia da semana",
  outside_hours: "esse horário está fora do expediente da clínica",
  lunch_break: "esse horário cai no intervalo (ex.: almoço) da clínica",
  conflict: "já tem outro paciente marcado nesse horário",
  blocked: "a agenda está bloqueada nesse horário (folga/feriado)",
  holiday: "esse dia é feriado nacional",
  procedure_not_found: "procedimento não encontrado",
  invalid_datetime: "o horário informado é inválido; use um valor 'iso' retornado pelas ferramentas de disponibilidade",
};

interface HoursSource {
  timezone: string;
  workStartHour: number;
  workStartMinute?: number;
  workEndHour: number;
  workEndMinute?: number;
  lunchStartHour?: number | null;
  lunchStartMinute?: number;
  lunchEndHour?: number | null;
  lunchEndMinute?: number;
  workDays: string;
  closedOnHolidays?: boolean;
  holidayOpen?: string;
}

function parseWorkDays(raw: string): Set<number> {
  return new Set(
    raw
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  );
}

export function clinicHoursOf(clinic: HoursSource): ClinicHours {
  return {
    timezone: clinic.timezone || "America/Sao_Paulo",
    workStartMinutes: clinic.workStartHour * 60 + (clinic.workStartMinute ?? 0),
    workEndMinutes: clinic.workEndHour * 60 + (clinic.workEndMinute ?? 0),
    lunchStartMinutes: clinic.lunchStartHour != null ? clinic.lunchStartHour * 60 + (clinic.lunchStartMinute ?? 0) : null,
    lunchEndMinutes: clinic.lunchEndHour != null ? clinic.lunchEndHour * 60 + (clinic.lunchEndMinute ?? 0) : null,
    workDays: parseWorkDays(clinic.workDays),
    closedOnHolidays: clinic.closedOnHolidays ?? false,
    holidayOpen: parseHolidayOpen(clinic.holidayOpen),
  };
}

// Expediente efetivo de um profissional: cada campo dele que estiver preenchido
// sobrescreve o da clinica; o resto herda. O minuto so entra junto da hora
// correspondente (nunca mistura minuto do profissional com hora da clinica ou
// vice-versa). Feriado e sempre decisao da clinica (nao existe "feriado so
// pra um profissional").
export function resolveHours(
  clinic: HoursSource,
  professional?: {
    workDays: string | null;
    workStartHour: number | null;
    workStartMinute?: number | null;
    workEndHour: number | null;
    workEndMinute?: number | null;
    lunchStartHour?: number | null;
    lunchStartMinute?: number | null;
    lunchEndHour?: number | null;
    lunchEndMinute?: number | null;
  } | null,
): ClinicHours {
  const base = clinicHoursOf(clinic);
  if (!professional) return base;
  return {
    timezone: base.timezone,
    workStartMinutes:
      professional.workStartHour != null
        ? professional.workStartHour * 60 + (professional.workStartMinute ?? 0)
        : base.workStartMinutes,
    workEndMinutes:
      professional.workEndHour != null
        ? professional.workEndHour * 60 + (professional.workEndMinute ?? 0)
        : base.workEndMinutes,
    lunchStartMinutes:
      professional.lunchStartHour != null
        ? professional.lunchStartHour * 60 + (professional.lunchStartMinute ?? 0)
        : base.lunchStartMinutes,
    lunchEndMinutes:
      professional.lunchEndHour != null
        ? professional.lunchEndHour * 60 + (professional.lunchEndMinute ?? 0)
        : base.lunchEndMinutes,
    workDays: professional.workDays ? parseWorkDays(professional.workDays) : base.workDays,
    closedOnHolidays: base.closedOnHolidays,
    holidayOpen: base.holidayOpen,
  };
}

// PURO: decide se um horario especifico pode receber um agendamento.
export function evaluateSlot(params: {
  startUtc: Date;
  durationMin: number;
  hours: ClinicHours;
  busy: BusyInterval[];
  blocks?: BusyInterval[];
  now?: Date;
  // Um agendamento manual (feito pela propria clinica no painel) pode ignorar
  // o padrao de horarios (expediente/dia da semana/feriado) - so a Alice, que
  // atende sozinha sem alguem pra decidir na hora, precisa respeitar esse
  // padrao a risca. Conflito com outro paciente e bloqueio manual continuam
  // valendo pros dois: isso nao e "horario de funcionamento", e um horario ja
  // comprometido de verdade.
  enforceHours?: boolean;
  // Disponibilidade confirmada pelo sistema de agenda da clinica (Clinica
  // Experts), quando integrado: o horario so passa se o profissional estiver
  // livre la pela duracao inteira do procedimento.
  gate?: SlotGate | null;
}): SlotVerdict {
  const { startUtc, durationMin, hours, busy } = params;
  const blocks = params.blocks ?? [];
  const now = params.now ?? new Date();
  const enforceHours = params.enforceHours ?? true;
  const endUtc = new Date(startUtc.getTime() + durationMin * 60_000);
  const s = startUtc.getTime();
  const e = endUtc.getTime();

  if (s <= now.getTime()) return { ok: false, reason: "past" };

  if (enforceHours) {
    const wc = wallClockInZone(startUtc, hours.timezone);
    if (!hours.workDays.has(wc.weekday)) return { ok: false, reason: "closed_day" };
    if (hours.closedOnHolidays) {
      const holiday = nationalHolidayOn(wc.year, wc.month, wc.day);
      if (holiday && !hours.holidayOpen?.has(holiday)) return { ok: false, reason: "holiday" };
    }

    const startMinutes = wc.hour * 60 + wc.minute;
    const endMinutes = startMinutes + durationMin;
    if (startMinutes < hours.workStartMinutes || endMinutes > hours.workEndMinutes) {
      return { ok: false, reason: "outside_hours" };
    }
    if (hours.lunchStartMinutes != null && hours.lunchEndMinutes != null) {
      if (startMinutes < hours.lunchEndMinutes && endMinutes > hours.lunchStartMinutes) {
        return { ok: false, reason: "lunch_break" };
      }
    }
  }

  for (const b of blocks) {
    if (s < b.end && e > b.start) return { ok: false, reason: "blocked" };
  }
  const ceCovered = params.gate?.covers?.(s) ?? false;
  for (const b of busy) {
    if (ceCovered && b.ce) continue; // o CE e a fonte da verdade desse dia
    if (s < b.end && e > b.start) return { ok: false, reason: "conflict" };
  }
  if (params.gate && !params.gate(s, durationMin)) return { ok: false, reason: "conflict" };
  return { ok: true };
}

// PURO: gera horarios livres varrendo os dias no fuso da clinica.
export function generateSlots(params: {
  hours: ClinicHours;
  durationMin: number;
  busy: BusyInterval[];
  blocks?: BusyInterval[];
  fromUtc?: Date;
  daysAhead?: number;
  limit?: number;
  now?: Date;
  professionalId?: string | null;
  professionalName?: string | null;
  gate?: SlotGate | null;
  stepMin?: number;
}): Slot[] {
  const { hours, durationMin, busy } = params;
  const blocks = params.blocks ?? [];
  const now = params.now ?? new Date();
  const from = params.fromUtc ?? now;
  const daysAhead = params.daysAhead ?? 7;
  const limit = params.limit ?? 10;
  const slots: Slot[] = [];

  const base = wallClockInZone(from, hours.timezone);
  const anchorNoonUtc = zonedWallClockToUtc(hours.timezone, base.year, base.month, base.day, 12, 0);

  for (let d = 0; d < daysAhead && slots.length < limit; d++) {
    const dayCursor = new Date(anchorNoonUtc.getTime() + d * 24 * 3_600_000);
    const wc = wallClockInZone(dayCursor, hours.timezone);
    if (!hours.workDays.has(wc.weekday)) continue;

    // Passo de 60min a partir do inicio real do expediente (pode ser 8h30,
    // 9h... nao precisa ser hora cheia) - preserva o mesmo espacamento de
    // antes, so desloca a largada quando o expediente nao comeca em hora cheia.
    for (
      let cursor = hours.workStartMinutes;
      cursor < hours.workEndMinutes && slots.length < limit;
      cursor += params.stepMin ?? 60
    ) {
      const startUtc = zonedWallClockToUtc(hours.timezone, wc.year, wc.month, wc.day, Math.floor(cursor / 60), cursor % 60);
      if (evaluateSlot({ startUtc, durationMin, hours, busy, blocks, now, gate: params.gate }).ok) {
        slots.push({
          start: startUtc,
          end: new Date(startUtc.getTime() + durationMin * 60_000),
          professionalId: params.professionalId ?? null,
          professionalName: params.professionalName ?? null,
        });
      }
    }
  }
  return slots;
}

// --- Wrappers que tocam o banco ---

interface BusyContext {
  busy: BusyInterval[];
  blocks: BusyInterval[];
}

// Carrega o que ocupa a agenda de um profissional (ou da clinica toda quando
// professionalId e null): agendamentos confirmados + bloqueios manuais.
// Agendamentos sem profissional atribuido bloqueiam todo mundo (conservador).
async function loadBusyContext(
  clinicId: string,
  opts: { professionalId?: string | null; ignoreAppointmentId?: string; excludeProcedureId?: string } = {},
): Promise<BusyContext> {
  const { professionalId } = opts;

  const appts = await prisma.appointment.findMany({
    where: {
      clinicId,
      status: "confirmed",
      ...(opts.ignoreAppointmentId ? { id: { not: opts.ignoreAppointmentId } } : {}),
      ...(professionalId ? { OR: [{ professionalId }, { professionalId: null }] } : {}),
      // excludeProcedureId: procedimento "por ordem de chegada" (ex.:
      // aplicação) - varios pacientes desse MESMO procedimento podem
      // ocupar o mesmo horario, entao esses agendamentos nao contam como
      // ocupado. Continuam contando pra qualquer outro procedimento.
      ...(opts.excludeProcedureId ? { procedureId: { not: opts.excludeProcedureId } } : {}),
    },
    select: { scheduledAt: true, ceBookingUuid: true, procedure: { select: { durationMin: true } } },
  });

  const scheduleBlocks = await prisma.scheduleBlock.findMany({
    where: {
      clinicId,
      ...(professionalId ? { OR: [{ professionalId }, { professionalId: null }] } : { professionalId: null }),
    },
    select: { startsAt: true, endsAt: true },
  });

  // Compromissos que ja estao no Google Agenda da clinica valem como bloqueio:
  // sem isso a Alice ofereceria um horario em que o profissional, na vida
  // real, ja tem outra coisa marcada. Vem vazio quando a integracao esta
  // desligada ou fora do ar.
  const googleBusy = await googleBusyIntervals(clinicId);

  return {
    busy: appts.map((a) => ({
      start: a.scheduledAt.getTime(),
      end: a.scheduledAt.getTime() + a.procedure.durationMin * 60_000,
      ce: !!a.ceBookingUuid,
    })),
    blocks: [...scheduleBlocks.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })), ...googleBusy],
  };
}

// Profissionais ativos que realizam um procedimento (para a Alice escolher).
export async function professionalsForProcedure(clinicId: string, procedureId: string) {
  return prisma.professional.findMany({
    where: { clinicId, active: true, procedures: { some: { id: procedureId } } },
    orderBy: { createdAt: "asc" },
  });
}

export interface AvailabilityResult {
  procedureName: string;
  slots: Slot[];
}

// Proximos horarios livres. Se professionalIds tiver mais de um, intercala os
// horarios dos profissionais; se estiver vazio, usa a agenda da clinica toda.
export async function findAvailableSlots(
  clinicId: string,
  procedureId: string,
  opts: { professionalIds?: string[]; daysAhead?: number; limit?: number } = {},
): Promise<Slot[]> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const procedure = await prisma.procedure.findFirst({ where: { id: procedureId, clinicId } });
  if (!procedure) return [];

  const limit = opts.limit ?? 8;
  const daysAhead = opts.daysAhead ?? 10;
  const ids = opts.professionalIds ?? [];

  const excludeProcedureId = procedure.allowConcurrentBooking ? procedure.id : undefined;

  if (ids.length === 0) {
    const ctx = await loadBusyContext(clinicId, { professionalId: null, excludeProcedureId });
    return generateSlots({
      hours: clinicHoursOf(clinic),
      durationMin: procedure.durationMin,
      busy: ctx.busy,
      blocks: ctx.blocks,
      daysAhead,
      limit,
    });
  }

  const perPro = await Promise.all(
    ids.map(async (id) => {
      const professional = await prisma.professional.findFirst({ where: { id, clinicId } });
      if (!professional) return [];
      const ctx = await loadBusyContext(clinicId, { professionalId: id, excludeProcedureId });
      const gate = await ceGateFor(clinicId, professional, new Date(), daysAhead, clinic.timezone || "America/Sao_Paulo");
      return generateSlots({
        hours: resolveHours(clinic, professional),
        durationMin: procedure.durationMin,
        busy: ctx.busy,
        blocks: ctx.blocks,
        daysAhead,
        limit,
        professionalId: id,
        professionalName: professional.name,
        gate,
        stepMin: gate ? 30 : 60,
      });
    }),
  );

  // Intercala (round-robin) e ordena por horario.
  return perPro
    .flat()
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, limit);
}

export interface AvailableDay {
  date: string; // AAAA-MM-DD no fuso da clinica (pra voltar na busca do dia)
  label: string; // "quarta-feira, 16/09"
  freeCount: number;
}

// Quais DIAS tem pelo menos um horario livre. E o primeiro passo do
// agendamento: oferecer o dia primeiro, e so depois os horarios daquele dia -
// senao a lista de horarios do mes inteiro vira um paredao de texto no
// WhatsApp.
export async function findAvailableDays(
  clinicId: string,
  procedureId: string,
  opts: { professionalIds?: string[]; daysAhead?: number; maxDays?: number } = {},
): Promise<AvailableDay[]> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const procedure = await prisma.procedure.findFirst({ where: { id: procedureId, clinicId } });
  if (!procedure) return [];

  const tz = clinic.timezone || "America/Sao_Paulo";
  const daysAhead = opts.daysAhead ?? 14;
  const maxDays = opts.maxDays ?? 5;

  // Limite alto de proposito: aqui a gente quer varrer os dias todos pra saber
  // quais tem vaga, nao parar nos primeiros horarios.
  const slots = await findAvailableSlotsFrom(
    clinicId,
    procedure.durationMin,
    opts.professionalIds ?? [],
    new Date(),
    daysAhead,
    500,
    procedure.allowConcurrentBooking ? procedure.id : undefined,
  );

  const byDay = new Map<string, AvailableDay>();
  for (const slot of slots) {
    const date = isoDateInZone(slot.start, tz);
    const current = byDay.get(date);
    if (current) current.freeCount += 1;
    else byDay.set(date, { date, label: formatDayInZone(slot.start, tz), freeCount: 1 });
  }
  return [...byDay.values()].slice(0, maxDays);
}

// Os horarios livres MAIS PROXIMOS a partir de agora (um por horario, mesmo com varios profissionais livres), em ordem. Hoje vem
// antes de amanha, que vem antes dos outros dias. Usado na avaliacao: oferecer o que esta mais perto, nao uma lista de dias.
export async function findNearestSlots(
  clinicId: string,
  procedureId: string,
  opts: { professionalIds?: string[]; limit?: number; daysAhead?: number; period?: Period | null; accept?: (slot: Slot) => boolean } = {},
): Promise<Slot[]> {
  const procedure = await prisma.procedure.findFirst({ where: { id: procedureId, clinicId } });
  if (!procedure) return [];
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const all = await findAvailableSlotsFrom(
    clinicId,
    procedure.durationMin,
    opts.professionalIds ?? [],
    new Date(),
    opts.daysAhead ?? 14,
    120,
    procedure.allowConcurrentBooking ? procedure.id : undefined,
  );
  const inPeriodSlots = filterByPeriod(dedupeByStart(all), clinic.timezone || "America/Sao_Paulo", opts.period);
  return (opts.accept ? inPeriodSlots.filter(opts.accept) : inPeriodSlots).slice(0, opts.limit ?? 3);
}

// Turno que a pessoa prefere (a Alice pergunta e oferece so os horarios desse turno).
export type Period = "manha" | "tarde" | "noite";

// PURO: o turno de uma hora cheia (manha ate 11h59, tarde 12h-17h59, noite 18h em diante).
export function periodOfHour(hour: number): Period {
  return hour < 12 ? "manha" : hour < 18 ? "tarde" : "noite";
}

// PURO: so os horarios do turno pedido (sem turno = todos).
export function filterByPeriod<T extends { start: Date }>(slots: T[], timeZone: string, period?: Period | null): T[] {
  if (!period) return slots;
  return slots.filter((x) => periodOfHour(wallClockInZone(x.start, timeZone).hour) === period);
}

// PURO: so os horarios que respeitam a janela que a pessoa pediu: comecam a partir de `from` ("HH:MM") e TERMINAM ate `until` ("HH:MM", ex.:
// "tenho aula as 18:40" = o atendimento tem que acabar antes). Sem janela = todos.
export function filterByTimeWindow<T extends { start: Date }>(slots: T[], timeZone: string, durationMin: number, from?: string | null, until?: string | null): T[] {
  const toMin = (t: string | null | undefined) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const f = toMin(from);
  const u = toMin(until);
  if (f === null && u === null) return slots;
  return slots.filter((x) => {
    const wc = wallClockInZone(x.start, timeZone);
    const start = wc.hour * 60 + wc.minute;
    if (f !== null && start < f) return false;
    if (u !== null && start + durationMin > u) return false;
    return true;
  });
}

// PURO: ate N horarios espalhados pelo dia (primeiro, do meio e ultimo) em vez dos N primeiros: a pessoa ve opcoes de verdade.
export function pickSpread<T>(slots: T[], max = 3): T[] {
  if (slots.length <= max) return slots;
  if (max === 1) return [slots[0]];
  const idx = new Set<number>();
  for (let i = 0; i < max; i++) idx.add(Math.round((i * (slots.length - 1)) / (max - 1)));
  return [...idx].sort((a, b) => a - b).map((i) => slots[i]);
}

// PURO: um slot por horario de inicio (mantem o primeiro).
export function dedupeByStart<T extends { start: Date }>(slots: T[]): T[] {
  const seen = new Set<number>();
  return slots.filter((x) => {
    const k = x.start.getTime();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Todos os horarios livres de UM dia especifico (no fuso da clinica). Usado
// quando o paciente pergunta "quais horarios voces tem na quarta?".
export async function findAvailableSlotsOnDay(
  clinicId: string,
  procedureId: string,
  day: { year: number; month: number; day: number },
  opts: { professionalIds?: string[]; limit?: number } = {},
): Promise<Slot[]> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const procedure = await prisma.procedure.findFirst({ where: { id: procedureId, clinicId } });
  if (!procedure) return [];

  const tz = clinic.timezone || "America/Sao_Paulo";
  // Meio-dia do dia pedido como ancora: generateSlots varre a partir do dia
  // desse instante, entao daysAhead=1 cobre exatamente esse dia.
  const anchor = zonedWallClockToUtc(tz, day.year, day.month, day.day, 12, 0);
  return findAvailableSlotsFrom(
    clinicId,
    procedure.durationMin,
    opts.professionalIds ?? [],
    anchor,
    1,
    opts.limit ?? 24,
    procedure.allowConcurrentBooking ? procedure.id : undefined,
  );
}

export interface SpecificTimeCheck {
  available: boolean;
  reason?: SlotReason;
  requestedIso: string;
  requestedLabel: string;
  availableProfessionals: { id: string | null; name: string | null }[];
  alternatives: { iso: string; label: string; professionalId: string | null; professionalName: string | null }[];
}

// Checa um dia/hora especifico. Retorna quais profissionais estao livres nele
// (ou, se ninguem estiver, alternativas).
export async function checkSpecificTime(
  clinicId: string,
  procedureId: string,
  requested: { year: number; month: number; day: number; hour: number; minute?: number },
  opts: { professionalIds?: string[]; ignoreAppointmentId?: string; enforceHours?: boolean } = {},
): Promise<SpecificTimeCheck> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const procedure = await prisma.procedure.findFirstOrThrow({ where: { id: procedureId, clinicId } });
  const tz = clinic.timezone || "America/Sao_Paulo";

  const startUtc = zonedWallClockToUtc(
    tz,
    requested.year,
    requested.month,
    requested.day,
    requested.hour,
    requested.minute ?? 0,
  );
  const label = formatInZone(startUtc, tz);
  const ids = opts.professionalIds ?? [];

  const candidates: { id: string | null; professional: Awaited<ReturnType<typeof prisma.professional.findFirst>> | null }[] =
    ids.length === 0
      ? [{ id: null, professional: null }]
      : await Promise.all(
          ids.map(async (id) => ({ id, professional: await prisma.professional.findFirst({ where: { id, clinicId } }) })),
        );

  const free: { id: string | null; name: string | null }[] = [];
  let lastReason: SlotReason = "conflict";

  for (const c of candidates) {
    const hours = resolveHours(clinic, c.professional);
    // ignoreAppointmentId exclui o proprio agendamento do que conta como
    // "ocupado" - sem isso, remarcar um agendamento pra um horario que toca no
    // horario ATUAL dele mesmo seria recusado por "conflito com ele mesmo".
    const ctx = await loadBusyContext(clinicId, {
      professionalId: c.id,
      ignoreAppointmentId: opts.ignoreAppointmentId,
      excludeProcedureId: procedure.allowConcurrentBooking ? procedure.id : undefined,
    });
    const gate = opts.enforceHours === false ? null : await ceGateFor(clinicId, c.professional, startUtc, 1, tz);
    const verdict = evaluateSlot({
      startUtc,
      durationMin: procedure.durationMin,
      hours,
      busy: ctx.busy,
      blocks: ctx.blocks,
      enforceHours: opts.enforceHours,
      gate,
    });
    if (verdict.ok) {
      free.push({ id: c.id, name: c.professional?.name ?? null });
    } else {
      lastReason = verdict.reason;
    }
  }

  if (free.length > 0) {
    return {
      available: true,
      requestedIso: startUtc.toISOString(),
      requestedLabel: label,
      availableProfessionals: free,
      alternatives: [],
    };
  }

  const altPro = ids.length ? ids : [];
  const excludeProcedureId = procedure.allowConcurrentBooking ? procedure.id : undefined;
  const sameDay = await findAvailableSlotsFrom(clinicId, procedure.durationMin, altPro, startUtc, 1, 3, excludeProcedureId);
  const laterDays = await findAvailableSlotsFrom(
    clinicId,
    procedure.durationMin,
    altPro,
    new Date(startUtc.getTime() + 24 * 3_600_000),
    6,
    3,
    excludeProcedureId,
  );
  const seen = new Set<string>();
  const alternatives = [...sameDay, ...laterDays]
    .filter((s) => {
      const key = `${s.start.getTime()}:${s.professionalId ?? ""}`;
      return !seen.has(key) && seen.add(key);
    })
    .slice(0, 3)
    .map((s) => ({
      iso: s.start.toISOString(),
      label: formatInZone(s.start, tz),
      professionalId: s.professionalId,
      professionalName: s.professionalName,
    }));

  return {
    available: false,
    reason: lastReason,
    requestedIso: startUtc.toISOString(),
    requestedLabel: label,
    availableProfessionals: [],
    alternatives,
  };
}

async function findAvailableSlotsFrom(
  clinicId: string,
  durationMin: number,
  professionalIds: string[],
  fromUtc: Date,
  daysAhead: number,
  limit: number,
  excludeProcedureId?: string,
): Promise<Slot[]> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const ids = professionalIds.length ? professionalIds : [null];
  const out: Slot[] = [];
  for (const id of ids) {
    const professional = id ? await prisma.professional.findFirst({ where: { id, clinicId } }) : null;
    const ctx = await loadBusyContext(clinicId, { professionalId: id, excludeProcedureId });
    const gate = await ceGateFor(clinicId, professional, fromUtc, daysAhead, clinic.timezone || "America/Sao_Paulo");
    out.push(
      ...generateSlots({
        hours: resolveHours(clinic, professional),
        durationMin,
        busy: ctx.busy,
        blocks: ctx.blocks,
        fromUtc,
        daysAhead,
        limit,
        professionalId: id,
        professionalName: professional?.name ?? null,
        gate,
        stepMin: gate ? 30 : 60,
      }),
    );
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export type BookingErrorCode = "procedure_not_found" | "invalid_datetime" | SlotReason;

export interface BookingSuccess {
  ok: true;
  appointmentId: string;
  scheduledAt: Date;
  procedureName: string;
  durationMin: number;
  professionalId: string | null;
  professionalName: string | null;
  label: string;
}

// Cria o agendamento revalidando disponibilidade DENTRO de uma transacao.
export async function createBooking(params: {
  clinicId: string;
  patientId: string;
  procedureId: string;
  startUtc: Date;
  professionalId?: string | null;
  source?: string | null;
  enforceHours?: boolean;
  // true = quem chamou espelha no Clinica Experts (e confere o resultado) antes de confirmar; aqui so nao dispara o espelho em segundo plano.
  deferMirror?: boolean;
}): Promise<BookingSuccess | { ok: false; error: BookingErrorCode }> {
  const { clinicId, patientId, procedureId, startUtc } = params;

  if (isNaN(startUtc.getTime())) return { ok: false, error: "invalid_datetime" };

  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const procedure = await prisma.procedure.findFirst({ where: { id: procedureId, clinicId } });
  if (!procedure) return { ok: false, error: "procedure_not_found" };

  const professional = params.professionalId
    ? await prisma.professional.findFirst({ where: { id: params.professionalId, clinicId } })
    : null;
  if (params.professionalId && !professional) return { ok: false, error: "procedure_not_found" };

  const hours = resolveHours(clinic, professional);
  const tz = clinic.timezone || "America/Sao_Paulo";

  // Fora da transacao de proposito: e uma chamada de rede (nao pode segurar a
  // transacao aberta) e ja vem de cache curto.
  const googleBusy = await googleBusyIntervals(clinicId);
  // Mesma razao: consulta o Clinica Experts antes de abrir a transacao.
  // Agendamento manual (enforceHours:false) e decisao da clinica, que usa o
  // proprio Clinica Experts: nao passa pelo portao de disponibilidade.
  const ceGate = params.enforceHours === false ? null : await ceGateFor(clinicId, professional, startUtc, 1, tz);

  const result = await prisma.$transaction(async (tx) => {
    const appts = await tx.appointment.findMany({
      where: {
        clinicId,
        status: "confirmed",
        ...(professional ? { OR: [{ professionalId: professional.id }, { professionalId: null }] } : {}),
        // Procedimento "por ordem de chegada" (allowConcurrentBooking): outros
        // agendamentos do MESMO procedimento nao contam como ocupado - varios
        // pacientes podem dividir o mesmo horario de proposito.
        ...(procedure.allowConcurrentBooking ? { procedureId: { not: procedure.id } } : {}),
      },
      select: { scheduledAt: true, ceBookingUuid: true, procedure: { select: { durationMin: true } } },
    });
    const blockRows = await tx.scheduleBlock.findMany({
      where: {
        clinicId,
        ...(professional ? { OR: [{ professionalId: professional.id }, { professionalId: null }] } : { professionalId: null }),
      },
      select: { startsAt: true, endsAt: true },
    });

    const busy: BusyInterval[] = appts.map((a) => ({
      start: a.scheduledAt.getTime(),
      end: a.scheduledAt.getTime() + a.procedure.durationMin * 60_000,
      ce: !!a.ceBookingUuid,
    }));
    const blocks: BusyInterval[] = [
      ...blockRows.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })),
      ...googleBusy,
    ];

    const verdict = evaluateSlot({ startUtc, durationMin: procedure.durationMin, hours, busy, blocks, enforceHours: params.enforceHours, gate: ceGate });
    if (!verdict.ok) return { ok: false as const, error: verdict.reason };

    const appointment = await tx.appointment.create({
      data: {
        clinicId,
        patientId,
        procedureId,
        professionalId: professional?.id ?? null,
        scheduledAt: startUtc,
        source: params.source ?? "whatsapp",
      },
    });

    return {
      ok: true as const,
      appointmentId: appointment.id,
      scheduledAt: appointment.scheduledAt,
      procedureName: procedure.name,
      durationMin: procedure.durationMin,
      professionalId: professional?.id ?? null,
      professionalName: professional?.name ?? null,
      label: formatInZone(startUtc, tz),
    };
  });

  // Espelha no Google Agenda depois do commit, sem segurar a resposta: o
  // paciente nao pode esperar o Google pra receber a confirmacao.
  if (result.ok && !params.deferMirror) pushAppointmentInBackground(result.appointmentId);
  return result;
}

// DIAGNOSTICO (somente leitura, admin): por que um horario aparece como indisponivel? Para cada profissional ATIVO da clinica diz se
// ele esta vinculado ao procedimento (so os vinculados entram na busca da Alice), o expediente dele, e o veredito do horario com e sem
// o portao do Clinica Experts. Serve pra achar "a equipe tem vaga e a Alice diz que nao": quase sempre e vinculo ou expediente.
export interface SlotDiagnosis {
  procedure: string;
  durationMin: number;
  when: string;
  clinicHours: string;
  professionals: {
    name: string;
    linked: boolean;
    hours: string;
    localVerdict: string;
    ceVerdict: string;
    free: boolean;
  }[];
}

const DOW_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const hoursText = (h: ClinicHours) =>
  `${[...h.workDays].sort().map((d) => DOW_PT[d]).join("/")} ${hhmm(h.workStartMinutes)}-${hhmm(h.workEndMinutes)}${h.lunchStartMinutes != null && h.lunchEndMinutes != null ? ` (almoço ${hhmm(h.lunchStartMinutes)}-${hhmm(h.lunchEndMinutes)})` : ""}`;

export async function diagnoseSlot(
  clinicId: string,
  procedureQuery: string,
  at: { year: number; month: number; day: number; hour: number; minute: number },
): Promise<SlotDiagnosis | { error: string }> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const q = procedureQuery.trim().toLowerCase();
  const procedures = await prisma.procedure.findMany({ where: { clinicId }, include: { professionals: { select: { id: true } } } });
  const procedure = procedures.find((p) => p.name.toLowerCase() === q) ?? procedures.find((p) => p.name.toLowerCase().includes(q));
  if (!procedure) return { error: `Procedimento "${procedureQuery}" não encontrado.` };

  const tz = clinic.timezone || "America/Sao_Paulo";
  const startUtc = zonedWallClockToUtc(tz, at.year, at.month, at.day, at.hour, at.minute);
  const linked = new Set(procedure.professionals.map((p) => p.id));
  const pros = await prisma.professional.findMany({ where: { clinicId, active: true }, orderBy: { createdAt: "asc" } });
  const out: SlotDiagnosis["professionals"] = [];
  for (const p of pros) {
    const hours = resolveHours(clinic, p);
    const ctx = await loadBusyContext(clinicId, { professionalId: p.id, excludeProcedureId: procedure.allowConcurrentBooking ? procedure.id : undefined });
    const local = evaluateSlot({ startUtc, durationMin: procedure.durationMin, hours, busy: ctx.busy, blocks: ctx.blocks });
    const gate = await ceGateFor(clinicId, p, startUtc, 1, tz);
    const withGate = evaluateSlot({ startUtc, durationMin: procedure.durationMin, hours, busy: ctx.busy, blocks: ctx.blocks, gate });
    out.push({
      name: p.name,
      linked: linked.has(p.id),
      hours: hoursText(hours),
      localVerdict: local.ok ? "livre" : SLOT_REASON_PT[local.reason],
      ceVerdict: !gate ? "sem integração com o Clínica Experts" : gate.covers?.(startUtc.getTime()) ? (withGate.ok ? "CE: livre" : "CE: ocupado") : "CE não respondeu esse dia",
      free: withGate.ok,
    });
  }
  return { procedure: procedure.name, durationMin: procedure.durationMin, when: formatInZone(startUtc, tz), clinicHours: hoursText(clinicHoursOf(clinic)), professionals: out };
}
