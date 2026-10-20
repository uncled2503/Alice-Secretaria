import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { ceRequest, dayBoundIso, getAccount } from "../clinicaexperts/client.js";
import { invalidateCeCache } from "../clinicaexperts/availability.js";
import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { clinicTimeStatements, findTimeConflicts, type ClinicStatement, type HistoryMessage, type TimeConflict } from "./clinicStatements.js";

const pad = (n: number) => String(n).padStart(2, "0");
const foldName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export interface ConflictCheck {
  statements: ClinicStatement[];
  remaining: TimeConflict[]; // divergencias que nao deu pra resolver
  healed: number; // horarios da Alice corrigidos pelo Clinica Experts
}

// A fala da clinica (equipe/lembrete) diverge do horario que a Alice tem? Confere no Clinica Experts (a verdade da agenda):
//  - o CE tem a reserva no horario que a clinica escreveu -> a agenda da Alice estava velha: corrige;
//  - senao -> sobra a divergencia (a Alice nao afirma nada e a equipe responde).
export async function checkClinicTimeConflicts(
  clinicId: string,
  patient: { id: string; name: string | null; ceUuid: string | null },
  history: HistoryMessage[],
  tz: string,
  now: Date = new Date(), // injetavel: o relogio de teste nao pode depender do dia em que a suite roda
): Promise<ConflictCheck> {
  const statements = clinicTimeStatements(history, tz, now);
  const load = () =>
    prisma.appointment.findMany({
      where: { patientId: patient.id, status: "confirmed", scheduledAt: { gte: new Date(now.getTime() - 3_600_000) } },
      select: { id: true, scheduledAt: true, ceBookingUuid: true },
    });
  const toLocal = (a: { scheduledAt: Date }) => {
    const wc = wallClockInZone(a.scheduledAt, tz);
    return { dd: wc.day, mm: wc.month, time: `${pad(wc.hour)}:${pad(wc.minute)}` };
  };
  let appts = await load();
  let conflicts = findTimeConflicts(appts.map(toLocal), statements);
  if (!conflicts.length || !(await getAccount(clinicId))) return { statements, remaining: conflicts, healed: 0 };

  let healed = 0;
  for (const c of conflicts) {
    const sameDay = appts.filter((a) => {
      const l = toLocal(a);
      return l.dd === c.dd && l.mm === c.mm;
    });
    if (sameDay.length !== 1) continue; // varios no mesmo dia: nao adivinha qual e
    const base = wallClockInZone(now, tz);
    const year = c.mm < base.month || (c.mm === base.month && c.dd < base.day - 1) ? base.year + 1 : base.year;
    const dayStart = zonedWallClockToUtc(tz, year, c.mm, c.dd, 12, 0);
    const res = await ceRequest<{ data: { uuid: string; starts_at: string; status: string; patient: { uuid: string; name: string } | null }[] }>(clinicId, "/bookings", {
      query: { starts_at: dayBoundIso(dayStart, tz, "start"), ends_at: dayBoundIso(dayStart, tz, "end"), per_page: 1000 },
    });
    if (!res.ok) continue;
    const mine = (res.data.data ?? []).filter(
      (b) => b.status !== "canceled" && ((patient.ceUuid && b.patient?.uuid === patient.ceUuid) || (patient.name && b.patient?.name && foldName(b.patient.name) === foldName(patient.name))),
    );
    const match = mine.find((b) => {
      const wc = wallClockInZone(new Date(b.starts_at), tz);
      return `${pad(wc.hour)}:${pad(wc.minute)}` === c.clinicTime;
    });
    if (!match) continue; // o CE tambem nao tem esse horario: nao da pra concluir
    const target = sameDay[0];
    await prisma.appointment.update({ where: { id: target.id }, data: { scheduledAt: new Date(match.starts_at), ...(target.ceBookingUuid ? {} : { ceBookingUuid: match.uuid }) } });
    invalidateCeCache(clinicId);
    await logActivity({
      clinicId,
      patientId: patient.id,
      type: "appointment_rescheduled",
      area: "agenda",
      title: "Horário corrigido pelo Clínica Experts",
      description: `A agenda da Alice tinha ${c.localTimes.join("/")} e o Clínica Experts (e a mensagem da clínica) tem ${c.clinicTime} em ${pad(c.dd)}/${pad(c.mm)}.`,
      actorName: null,
    });
    healed++;
  }
  if (healed) {
    appts = await load();
    conflicts = findTimeConflicts(appts.map(toLocal), statements);
  }
  return { statements, remaining: conflicts, healed };
}
