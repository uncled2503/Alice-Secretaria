import cron from "node-cron";
import { prisma } from "../db/client.js";
import { ceRequest, dayBoundIso, noteError } from "./client.js";

// ---------------------------------------------------------------------------
// Clinica Experts -> Alice: agendamentos feitos DIRETO no Clinica Experts
// (recepcao, telefone, presencial) viram Appointment aqui, pra os lembretes de
// confirmacao enxergarem a agenda real. So grava no banco: NAO manda mensagem,
// NAO avisa a equipe e NAO espelha de volta (nao passa por createBooking).
// ---------------------------------------------------------------------------

const DAYS_AHEAD = 3; // hoje + proximos dias
const PULL_EVERY = "*/10 * * * *";

export interface CeBookingLite {
  uuid?: string;
  status?: string;
  starts_at?: string;
  professional?: { uuid?: string } | null;
  patient?: { uuid?: string; name?: string | null; phone?: string | null } | null;
  procedures?: { id: number }[];
}

// PURO: status do Clinica Experts -> status da Alice. "scheduled"/confirmado
// vira confirmed; cancelado e falta sao espelhados; concluido vira completed.
export function mapCeStatus(raw: string | undefined): "confirmed" | "cancelled" | "no_show" | "completed" {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.startsWith("cancel")) return "cancelled";
  if (s.includes("noshow") || s.includes("missed") || s === "faltou") return "no_show";
  if (s.includes("complet") || s.includes("done") || s.includes("attended") || s.includes("finish")) return "completed";
  return "confirmed";
}

// PURO: telefone do CE ("+55 11 94949-4707", "11949494707"...) -> digitos com DDI 55.
export function normalizeCePhone(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 10) return null;
  if (d.startsWith("55") && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

export interface PullResult {
  created: number;
  updated: number;
  skipped: number;
  error?: string;
}

export async function pullClinicBookings(clinicId: string): Promise<PullResult> {
  const result: PullResult = { created: 0, updated: 0, skipped: 0 };
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";

  const bookings: CeBookingLite[] = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const day = new Date(Date.now() + i * 24 * 3_600_000);
    // /bookings so e confiavel com janela de DIA INTEIRO (ver memoria da integracao).
    const res = await ceRequest<{ data: CeBookingLite[] }>(clinicId, "/bookings", {
      query: { starts_at: dayBoundIso(day, tz, "start"), ends_at: dayBoundIso(day, tz, "end"), per_page: 1000 },
    });
    if (!res.ok) return { ...result, error: res.error };
    bookings.push(...(res.data.data ?? []));
  }

  const seen = new Set<string>();
  for (const b of bookings) {
    if (!b.uuid || seen.has(b.uuid) || !b.starts_at) continue;
    seen.add(b.uuid);
    const when = new Date(b.starts_at);
    if (Number.isNaN(when.getTime())) { result.skipped++; continue; }
    const status = mapCeStatus(b.status);

    const existing = await prisma.appointment.findFirst({ where: { clinicId, ceBookingUuid: b.uuid } });
    if (existing) {
      const data: { scheduledAt?: Date; status?: string; professionalId?: string | null } = {};
      if (existing.scheduledAt.getTime() !== when.getTime()) data.scheduledAt = when;
      // "confirmed" nunca rebaixa um atendimento que ja foi concluido/faltou aqui.
      if (status !== "confirmed" && existing.status !== status) data.status = status;
      if (status === "confirmed" && existing.status === "cancelled") data.status = "confirmed"; // reativado la
      if (Object.keys(data).length) {
        await prisma.appointment.update({ where: { id: existing.id }, data });
        result.updated++;
      }
      continue;
    }

    if (status === "cancelled" || status === "no_show") { result.skipped++; continue; }

    const ceProcId = b.procedures?.[0]?.id;
    const procedure = ceProcId != null ? await prisma.procedure.findFirst({ where: { clinicId, ceId: ceProcId } }) : null;
    const phone = normalizeCePhone(b.patient?.phone);
    if (!procedure || !phone) { result.skipped++; continue; } // sem procedimento vinculado ou sem telefone: nada a lembrar

    const professional = b.professional?.uuid ? await prisma.professional.findFirst({ where: { clinicId, ceUuid: b.professional.uuid } }) : null;

    // Agendamento da propria Alice cujo uuid ainda nao tinha sido gravado (corrida
    // com o espelhamento): so anexa o uuid, nao duplica.
    const patientForMatch = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
    if (patientForMatch) {
      const own = await prisma.appointment.findFirst({
        where: { clinicId, patientId: patientForMatch.id, scheduledAt: when, ceBookingUuid: null, status: "confirmed" },
      });
      if (own) {
        await prisma.appointment.update({ where: { id: own.id }, data: { ceBookingUuid: b.uuid } });
        result.updated++;
        continue;
      }
    }

    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId, phone } },
      update: { ceUuid: b.patient?.uuid ?? undefined },
      create: { clinicId, phone, name: b.patient?.name?.trim() || null, ceUuid: b.patient?.uuid ?? null },
    });
    await prisma.appointment.create({
      data: {
        clinicId, patientId: patient.id, procedureId: procedure.id, professionalId: professional?.id ?? null,
        scheduledAt: when, status, source: "presencial", ceBookingUuid: b.uuid,
      },
    });
    result.created++;
  }
  return result;
}

let running = false;

export function startCeBookingPullJob(): void {
  cron.schedule(PULL_EVERY, async () => {
    if (running) return;
    running = true;
    try {
      const accounts = await prisma.clinicaExpertsAccount.findMany({ select: { clinicId: true } });
      for (const a of accounts) {
        try {
          const r = await pullClinicBookings(a.clinicId);
          if (r.error) await noteError(a.clinicId, `Importação da agenda: ${r.error}`);
          else await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: a.clinicId }, data: { lastSyncAt: new Date(), lastError: null } });
        } catch (err) {
          console.error("[clinicaexperts] pull:", err);
        }
      }
    } finally {
      running = false;
    }
  });
}
