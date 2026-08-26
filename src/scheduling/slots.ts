import { prisma } from "../db/client.js";

export interface Slot {
  start: Date;
  end: Date;
}

// Gera horarios livres nos proximos `daysAhead` dias, dentro do expediente
// da clinica, checando conflito com agendamentos ja confirmados.
export async function findAvailableSlots(
  clinicId: string,
  durationMin: number,
  daysAhead = 7
): Promise<Slot[]> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });

  const existing = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed" },
    select: { scheduledAt: true, procedure: { select: { durationMin: true } } },
  });

  const workDays = new Set(clinic.workDays.split(",").map(Number));

  const slots: Slot[] = [];
  const now = new Date();

  for (let d = 0; d < daysAhead && slots.length < 10; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    if (!workDays.has(day.getDay())) continue; // clinica nao atende nesse dia da semana

    for (let hour = clinic.workStartHour; hour < clinic.workEndHour; hour++) {
      const start = new Date(day);
      start.setHours(hour, 0, 0, 0);
      if (start < now) continue;

      const end = new Date(start.getTime() + durationMin * 60_000);

      const conflict = existing.some((a) => {
        const aStart = a.scheduledAt.getTime();
        const aEnd = aStart + a.procedure.durationMin * 60_000;
        return start.getTime() < aEnd && end.getTime() > aStart;
      });

      if (!conflict) slots.push({ start, end });
      if (slots.length >= 10) break;
    }
  }

  return slots;
}
