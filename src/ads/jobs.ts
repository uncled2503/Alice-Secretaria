import { prisma } from "../db/client.js";
import { scheduleLocked } from "../jobs/lock.js";
import { resolvePendingAdNames } from "./attribution.js";
import { syncLeadTags } from "./tags.js";
import { startSuggestionJob } from "./suggest.js";

// Politica de retencao dos dados de atribuicao (LGPD): por padrao 2 anos; ajustavel por AD_ATTRIBUTION_RETENTION_DAYS. Apagar o contato apaga as entradas
// (cascata); aqui so se aposenta o que passou do prazo.
export const RETENTION_DAYS = Math.max(30, Number(process.env.AD_ATTRIBUTION_RETENTION_DAYS) || 730);

export async function purgeOldAttributions(now: Date = new Date()): Promise<number> {
  const r = await prisma.adAttribution.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - RETENTION_DAYS * 86_400_000) } } });
  return r.count;
}

// Rede de seguranca das etiquetas: agendamentos feitos por importacao do Clinica Experts, API ou telefone nao passam pelo ponto unico de agenda.
export async function reconcileAppointmentTags(limit = 400): Promise<number> {
  const since = new Date(Date.now() - 2 * 86_400_000);
  const appts = await prisma.appointment.findMany({
    where: { OR: [{ scheduledAt: { gte: since } }, { createdAt: { gte: since } }] },
    distinct: ["patientId"],
    take: limit,
    select: { clinicId: true, patientId: true },
  });
  for (const a of appts) await syncLeadTags(a.clinicId, a.patientId);
  return appts.length;
}

export function startAdsJobs(): void {
  scheduleLocked("anuncios-nomes", "7 * * * *", async () => {
    await resolvePendingAdNames(null, { limit: 40 });
  });
  scheduleLocked("etiquetas-agenda", "*/30 * * * *", async () => {
    await reconcileAppointmentTags();
  });
  scheduleLocked("anuncios-retencao", "30 4 * * *", async () => {
    const n = await purgeOldAttributions();
    if (n) console.log(`[anuncios] ${n} entrada(s) de atribuicao apagada(s) pela politica de retencao (${RETENTION_DAYS} dias)`);
  });
  startSuggestionJob();
}
