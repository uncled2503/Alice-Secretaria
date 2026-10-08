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

// PURO: nome de procedimento que e so a avaliacao (nao o servico em si).
export function isEvaluationName(name: string): boolean {
  return /^\s*avalia/i.test(name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
}

// Uma reserva pode ter varios procedimentos (ex.: "Avaliacao" + o procedimento
// de verdade). A confirmacao tem que citar o PROCEDIMENTO, nao a avaliacao:
// prefere o primeiro que nao seja avaliacao e que exista na Alice.
async function pickProcedure(clinicId: string, b: CeBookingLite) {
  const ceIds = (b.procedures ?? []).map((p) => p.id);
  const candidates = ceIds.length ? await prisma.procedure.findMany({ where: { clinicId, ceId: { in: ceIds } } }) : [];
  const byCeId = new Map(candidates.map((p) => [p.ceId, p]));
  const ordered = ceIds.map((id) => byCeId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  return ordered.find((p) => !isEvaluationName(p.name)) ?? ordered[0] ?? null;
}

export interface PullResult {
  created: number;
  updated: number;
  skipped: number;
  skippedNote: string[];
  error?: string;
}

export async function pullClinicBookings(clinicId: string): Promise<PullResult> {
  const result: PullResult = { created: 0, updated: 0, skipped: 0, skippedNote: [] };
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

    const picked = await pickProcedure(clinicId, b);
    const existing = await prisma.appointment.findFirst({ where: { clinicId, ceBookingUuid: b.uuid }, include: { procedure: true } });
    if (existing) {
      const data: { scheduledAt?: Date; status?: string; professionalId?: string | null; procedureId?: string } = {};
      // Importado antes como "Avaliacao" mas a reserva tem o procedimento de verdade: corrige.
      if (picked && picked.id !== existing.procedureId && isEvaluationName(existing.procedure.name) && !isEvaluationName(picked.name)) data.procedureId = picked.id;
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

    const procedure = picked;
    const phone = normalizeCePhone(b.patient?.phone);
    if (!procedure || !phone) { result.skipped++; result.skippedNote.push(!phone ? "sem telefone" : "procedimento sem vínculo"); continue; } // sem procedimento vinculado ou sem telefone: nada a lembrar

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
          else {
            // Reservas sem telefone ou com procedimento nao vinculado NAO recebem lembrete: avisa na tela.
            const notes = r.skippedNote.length
              ? `Aviso: ${r.skippedNote.length} agendamento(s) dos próximos dias não entram nos lembretes (${[...new Set(r.skippedNote)].join(", ")}). Confira o telefone no Clínica Experts ou rode "Importar do Clínica Experts".`
              : null;
            await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: a.clinicId }, data: { lastSyncAt: new Date(), lastError: notes } });
          }
        } catch (err) {
          console.error("[clinicaexperts] pull:", err);
        }
      }
    } finally {
      running = false;
    }
  });
}
