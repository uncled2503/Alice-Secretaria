import { prisma } from "../db/client.js";
import { wallClockInZone, zonedWallClockToUtc, formatInZone } from "./time.js";

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
}

export interface ClinicHours {
  timezone: string;
  workStartHour: number;
  workEndHour: number;
  workDays: Set<number>; // 0=domingo .. 6=sabado
}

export type SlotReason = "past" | "closed_day" | "outside_hours" | "conflict" | "blocked";
export type SlotVerdict = { ok: true } | { ok: false; reason: SlotReason };

interface HoursSource {
  timezone: string;
  workStartHour: number;
  workEndHour: number;
  workDays: string;
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
    workStartHour: clinic.workStartHour,
    workEndHour: clinic.workEndHour,
    workDays: parseWorkDays(clinic.workDays),
  };
}

// Expediente efetivo de um profissional: cada campo dele que estiver preenchido
// sobrescreve o da clinica; o resto herda.
export function resolveHours(
  clinic: HoursSource,
  professional?: { workDays: string | null; workStartHour: number | null; workEndHour: number | null } | null,
): ClinicHours {
  const base = clinicHoursOf(clinic);
  if (!professional) return base;
  return {
    timezone: base.timezone,
    workStartHour: professional.workStartHour ?? base.workStartHour,
    workEndHour: professional.workEndHour ?? base.workEndHour,
    workDays: professional.workDays ? parseWorkDays(professional.workDays) : base.workDays,
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
}): SlotVerdict {
  const { startUtc, durationMin, hours, busy } = params;
  const blocks = params.blocks ?? [];
  const now = params.now ?? new Date();
  const endUtc = new Date(startUtc.getTime() + durationMin * 60_000);
  const s = startUtc.getTime();
  const e = endUtc.getTime();

  if (s <= now.getTime()) return { ok: false, reason: "past" };

  const wc = wallClockInZone(startUtc, hours.timezone);
  if (!hours.workDays.has(wc.weekday)) return { ok: false, reason: "closed_day" };

  const startMinutes = wc.hour * 60 + wc.minute;
  if (startMinutes < hours.workStartHour * 60 || startMinutes + durationMin > hours.workEndHour * 60) {
    return { ok: false, reason: "outside_hours" };
  }

  for (const b of blocks) {
    if (s < b.end && e > b.start) return { ok: false, reason: "blocked" };
  }
  for (const b of busy) {
    if (s < b.end && e > b.start) return { ok: false, reason: "conflict" };
  }
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

    for (let hour = hours.workStartHour; hour < hours.workEndHour && slots.length < limit; hour++) {
      const startUtc = zonedWallClockToUtc(hours.timezone, wc.year, wc.month, wc.day, hour, 0);
      if (evaluateSlot({ startUtc, durationMin, hours, busy, blocks, now }).ok) {
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
  opts: { professionalId?: string | null; ignoreAppointmentId?: string } = {},
): Promise<BusyContext> {
  const { professionalId } = opts;

  const appts = await prisma.appointment.findMany({
    where: {
      clinicId,
      status: "confirmed",
      ...(opts.ignoreAppointmentId ? { id: { not: opts.ignoreAppointmentId } } : {}),
      ...(professionalId ? { OR: [{ professionalId }, { professionalId: null }] } : {}),
    },
    select: { scheduledAt: true, procedure: { select: { durationMin: true } } },
  });

  const scheduleBlocks = await prisma.scheduleBlock.findMany({
    where: {
      clinicId,
      ...(professionalId ? { OR: [{ professionalId }, { professionalId: null }] } : { professionalId: null }),
    },
    select: { startsAt: true, endsAt: true },
  });

  return {
    busy: appts.map((a) => ({
      start: a.scheduledAt.getTime(),
      end: a.scheduledAt.getTime() + a.procedure.durationMin * 60_000,
    })),
    blocks: scheduleBlocks.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })),
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

  if (ids.length === 0) {
    const ctx = await loadBusyContext(clinicId, { professionalId: null });
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
      const ctx = await loadBusyContext(clinicId, { professionalId: id });
      return generateSlots({
        hours: resolveHours(clinic, professional),
        durationMin: procedure.durationMin,
        busy: ctx.busy,
        blocks: ctx.blocks,
        daysAhead,
        limit,
        professionalId: id,
        professionalName: professional.name,
      });
    }),
  );

  // Intercala (round-robin) e ordena por horario.
  return perPro
    .flat()
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, limit);
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
  opts: { professionalIds?: string[] } = {},
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
    const ctx = await loadBusyContext(clinicId, { professionalId: c.id });
    const verdict = evaluateSlot({ startUtc, durationMin: procedure.durationMin, hours, busy: ctx.busy, blocks: ctx.blocks });
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
  const sameDay = await findAvailableSlotsFrom(clinicId, procedure.durationMin, altPro, startUtc, 1, 3);
  const laterDays = await findAvailableSlotsFrom(
    clinicId,
    procedure.durationMin,
    altPro,
    new Date(startUtc.getTime() + 24 * 3_600_000),
    6,
    3,
  );
  const seen = new Set<string>();
  const alternatives = [...sameDay, ...laterDays]
    .filter((s) => {
      const key = `${s.start.getTime()}:${s.professionalId ?? ""}`;
      return !seen.has(key) && seen.add(key);
    })
    .slice(0, 4)
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
): Promise<Slot[]> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const ids = professionalIds.length ? professionalIds : [null];
  const out: Slot[] = [];
  for (const id of ids) {
    const professional = id ? await prisma.professional.findFirst({ where: { id, clinicId } }) : null;
    const ctx = await loadBusyContext(clinicId, { professionalId: id });
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

  return prisma.$transaction(async (tx) => {
    const appts = await tx.appointment.findMany({
      where: {
        clinicId,
        status: "confirmed",
        ...(professional ? { OR: [{ professionalId: professional.id }, { professionalId: null }] } : {}),
      },
      select: { scheduledAt: true, procedure: { select: { durationMin: true } } },
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
    }));
    const blocks: BusyInterval[] = blockRows.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() }));

    const verdict = evaluateSlot({ startUtc, durationMin: procedure.durationMin, hours, busy, blocks });
    if (!verdict.ok) return { ok: false as const, error: verdict.reason };

    const appointment = await tx.appointment.create({
      data: {
        clinicId,
        patientId,
        procedureId,
        professionalId: professional?.id ?? null,
        scheduledAt: startUtc,
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
}
