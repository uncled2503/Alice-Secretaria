import { prisma } from "../db/client.js";
import { getFunnelStages } from "./stages.js";
import { ALICE_BOOKING_SOURCES } from "./realStats.js";

// ---------------------------------------------------------------------------
// Relatorios de gestao (fase 2 da Lisboa): conversao por anuncio/campanha e desempenho da Alice (agendamentos feitos por
// ela, transferencias, falhas). Tudo calculado do que ja esta gravado - sem IA.
// ---------------------------------------------------------------------------

export interface CampaignRow {
  origin: string; // campanha/anuncio ou "Orgânico (sem anúncio)"
  leads: number;
  scheduled: number; // viraram agendamento (qualquer status, exceto cancelado)
  attended: number; // compareceram (atendimento concluido)
  won: number; // estao numa etapa de venda ganha
  scheduledRate: number; // % dos leads
  attendedRate: number;
  wonRate: number;
  lowConversion: boolean; // muitos contatos e quase nenhum agendamento: revisar oferta/abordagem
}

export const LOW_CONVERSION_MIN_LEADS = 20;
export const LOW_CONVERSION_MAX_RATE = 10; // % de agendamento abaixo disso, com leads suficientes

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

export function originOf(p: { adCampaignName: string | null; adName: string | null }): string {
  return (p.adCampaignName || p.adName || "").trim() || "Orgânico (sem anúncio)";
}

export async function marketingReport(clinicId: string, start: Date, end: Date): Promise<{ campaigns: CampaignRow[]; totals: { leads: number; scheduled: number; attended: number; won: number } }> {
  const [stages, patients] = await Promise.all([
    getFunnelStages(clinicId),
    prisma.patient.findMany({
      where: { clinicId, createdAt: { gte: start, lte: end } },
      select: {
        id: true, adCampaignName: true, adName: true, funnelStage: true,
        appointments: { select: { status: true } },
      },
      take: 20000,
    }),
  ]);
  const wonStages = new Set(stages.filter((s) => s.kind === "ganho").map((s) => s.stageId));

  const byOrigin = new Map<string, { leads: number; scheduled: number; attended: number; won: number }>();
  for (const p of patients) {
    const key = originOf(p);
    const row = byOrigin.get(key) ?? { leads: 0, scheduled: 0, attended: 0, won: 0 };
    row.leads++;
    if (p.appointments.some((a) => a.status !== "cancelled")) row.scheduled++;
    if (p.appointments.some((a) => a.status === "completed")) row.attended++;
    if (wonStages.has(p.funnelStage)) row.won++;
    byOrigin.set(key, row);
  }

  const campaigns: CampaignRow[] = [...byOrigin.entries()]
    .map(([origin, r]) => ({
      origin,
      ...r,
      scheduledRate: pct(r.scheduled, r.leads),
      attendedRate: pct(r.attended, r.leads),
      wonRate: pct(r.won, r.leads),
      lowConversion: r.leads >= LOW_CONVERSION_MIN_LEADS && pct(r.scheduled, r.leads) < LOW_CONVERSION_MAX_RATE && !origin.startsWith("Orgânico"),
    }))
    .sort((a, b) => b.leads - a.leads);

  const totals = campaigns.reduce((t, c) => ({ leads: t.leads + c.leads, scheduled: t.scheduled + c.scheduled, attended: t.attended + c.attended, won: t.won + c.won }), { leads: 0, scheduled: 0, attended: 0, won: 0 });
  return { campaigns, totals };
}

export interface AliceReport {
  bookings: { total: number; confirmedByPatient: number; completed: number; noShow: number; cancelled: number; won: number };
  handoffs: { total: number; byReason: { reason: string; count: number }[] };
  deliveryFailures: number;
  repeatingLoops: number; // vezes que a trava anti-repeticao transferiu pra equipe
}

export async function aliceReport(clinicId: string, start: Date, end: Date): Promise<AliceReport> {
  const [stages, appts, handoffLogs, failures] = await Promise.all([
    getFunnelStages(clinicId),
    prisma.appointment.findMany({
      where: { clinicId, source: { in: [...ALICE_BOOKING_SOURCES] }, createdAt: { gte: start, lte: end } },
      select: { status: true, patientConfirmed: true, patient: { select: { funnelStage: true } } },
    }),
    prisma.activityLog.findMany({
      where: { clinicId, type: "human_takeover", actorName: null, createdAt: { gte: start, lte: end } },
      select: { description: true },
      take: 5000,
    }),
    prisma.message.count({
      where: { role: "assistant", deliveryStatus: { in: ["failed", "failed_permanent"] }, createdAt: { gte: start, lte: end }, conversation: { patient: { clinicId } } },
    }),
  ]);
  const wonStages = new Set(stages.filter((s) => s.kind === "ganho").map((s) => s.stageId));

  const reasons = new Map<string, number>();
  for (const l of handoffLogs) {
    // "Fulana — pedido de desconto."  ->  "pedido de desconto"
    const reason = (l.description ?? "").split(" — ").slice(1).join(" — ").replace(/\.$/, "").trim() || "sem motivo informado";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const byReason = [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 15);

  return {
    bookings: {
      total: appts.length,
      confirmedByPatient: appts.filter((a) => a.patientConfirmed).length,
      completed: appts.filter((a) => a.status === "completed").length,
      noShow: appts.filter((a) => a.status === "no_show").length,
      cancelled: appts.filter((a) => a.status === "cancelled").length,
      won: appts.filter((a) => wonStages.has(a.patient.funnelStage)).length,
    },
    handoffs: { total: handoffLogs.length, byReason },
    deliveryFailures: failures,
    repeatingLoops: byReason.filter((r) => /repetindo/i.test(r.reason)).reduce((n, r) => n + r.count, 0),
  };
}
