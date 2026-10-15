import { prisma } from "../db/client.js";
import { getFunnelStages } from "../crm/stages.js";

// ---------------------------------------------------------------------------
// ETIQUETAS AUTOMATICAS do lead (origem + situacao comercial), derivadas do ESTADO REAL: anuncio, classificacao confirmada, agendamento, venda. Sao
// etiquetas de sistema (Tag.system) com cor propria; as etiquetas que a equipe criou nunca sao tocadas. Sempre uma so de origem (mais a plataforma quando
// identificada) e uma so de classificacao: "Lead Qualificado" e "Lead Desqualificado" nunca ficam juntas.
// ---------------------------------------------------------------------------

export const TAG = {
  metaAds: "Meta Ads",
  facebookAds: "Facebook Ads",
  instagramAds: "Instagram Ads",
  organic: "WhatsApp Orgânico",
  unknown: "Origem Não Identificada",
  novo: "Lead Novo",
  qualificando: "Em Qualificação",
  qualificado: "Lead Qualificado",
  desqualificado: "Lead Desqualificado",
  agendado: "Agendamento Realizado",
  venda: "Venda Realizada",
} as const;

export const TAG_COLORS: Record<string, string> = {
  [TAG.metaAds]: "#1877f2",
  [TAG.facebookAds]: "#1e3a8a",
  [TAG.instagramAds]: "#db2777",
  [TAG.organic]: "#65a30d",
  [TAG.unknown]: "#64748b",
  [TAG.novo]: "#0ea5e9",
  [TAG.qualificando]: "#f59e0b",
  [TAG.qualificado]: "#15803d",
  [TAG.desqualificado]: "#dc2626",
  [TAG.agendado]: "#7c3aed",
  [TAG.venda]: "#0f766e",
};

export const SYSTEM_LABELS: string[] = Object.values(TAG);
export const CLASS_LABELS: string[] = [TAG.novo, TAG.qualificando, TAG.qualificado, TAG.desqualificado];

export interface LeadState {
  hasAd: boolean;
  firstPlatform: "facebook" | "instagram" | null; // plataforma da PRIMEIRA entrada (so quando identificavel)
  organicReliable: boolean; // a clinica recebe o referral de forma confiavel (API oficial): sem referral = organico
  leadClass: string | null; // em_qualificacao | qualificado | desqualificado
  userMessages: number;
  hasAppointment: boolean; // agendamento confirmado ou concluido
  sold: boolean; // etapa de venda ganha
}

// PURO: quais etiquetas de sistema o lead deve ter agora.
export function desiredLabels(s: LeadState): string[] {
  const out: string[] = [];
  if (s.hasAd) {
    out.push(TAG.metaAds);
    if (s.firstPlatform === "facebook") out.push(TAG.facebookAds);
    if (s.firstPlatform === "instagram") out.push(TAG.instagramAds);
  } else out.push(s.organicReliable ? TAG.organic : TAG.unknown);

  if (s.leadClass === "qualificado") out.push(TAG.qualificado);
  else if (s.leadClass === "desqualificado") out.push(TAG.desqualificado);
  else if (s.leadClass === "em_qualificacao" || s.userMessages >= 2) out.push(TAG.qualificando);
  else out.push(TAG.novo);

  if (s.hasAppointment) out.push(TAG.agendado);
  if (s.sold) out.push(TAG.venda);
  return out;
}

async function ensureTag(clinicId: string, label: string): Promise<string> {
  const color = TAG_COLORS[label] ?? "#64748b";
  // Dois leads novos ao mesmo tempo criam a mesma etiqueta: o upsert do Prisma pode perder a corrida (P2002). Nesse caso a outra gravacao ja criou: so le.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tag = await prisma.tag.upsert({ where: { clinicId_label: { clinicId, label } }, update: { system: true, color }, create: { clinicId, label, color, system: true }, select: { id: true } });
      return tag.id;
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err;
      const found = await prisma.tag.findUnique({ where: { clinicId_label: { clinicId, label } }, select: { id: true } });
      if (found) return found.id;
    }
  }
  throw new Error(`nao consegui criar a etiqueta ${label}`);
}

const running = new Set<string>();

// Recalcula as etiquetas de sistema de UM lead. Idempotente; nunca lanca.
export async function syncLeadTags(clinicId: string, patientId: string): Promise<string[] | null> {
  if (running.has(patientId)) return null;
  running.add(patientId);
  try {
    const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true, clinicId: true, leadClass: true, funnelStage: true } });
    if (!patient || patient.clinicId !== clinicId) return null;
    const [attrs, cfg, userMessages, appts, stages] = await Promise.all([
      prisma.adAttribution.findMany({ where: { patientId }, orderBy: { receivedAt: "asc" }, select: { platform: true } }),
      prisma.metaConfig.findUnique({ where: { clinicId }, select: { wabaId: true } }),
      prisma.message.count({ where: { role: "user", conversation: { patientId } } }),
      prisma.appointment.count({ where: { patientId, status: { in: ["confirmed", "completed"] } } }),
      getFunnelStages(clinicId),
    ]);
    const wonIds = new Set(stages.filter((s) => s.kind === "ganho").map((s) => s.stageId));
    const state: LeadState = {
      hasAd: attrs.length > 0,
      firstPlatform: (attrs[0]?.platform as "facebook" | "instagram" | null) ?? null,
      organicReliable: !!cfg?.wabaId,
      leadClass: patient.leadClass,
      userMessages,
      hasAppointment: appts > 0,
      sold: wonIds.has(patient.funnelStage),
    };
    const want = desiredLabels(state);

    const current = await prisma.patientTag.findMany({ where: { patientId, tag: { system: true, label: { in: SYSTEM_LABELS } } }, select: { tagId: true, tag: { select: { label: true } } } });
    const haveLabels = new Set(current.map((c) => c.tag.label));
    for (const c of current) if (!want.includes(c.tag.label)) await prisma.patientTag.delete({ where: { patientId_tagId: { patientId, tagId: c.tagId } } });
    for (const label of want) {
      if (haveLabels.has(label)) continue;
      const tagId = await ensureTag(clinicId, label);
      await prisma.patientTag.upsert({ where: { patientId_tagId: { patientId, tagId } }, update: {}, create: { patientId, tagId } });
    }
    return want;
  } catch (err) {
    console.error("[etiquetas] falha ao sincronizar:", err);
    return null;
  } finally {
    running.delete(patientId);
  }
}

export function syncLeadTagsInBackground(clinicId: string, patientId: string): void {
  void syncLeadTags(clinicId, patientId).catch(() => {});
}

// Aplica as etiquetas a todos os leads da clinica (botao do admin; em lotes, idempotente).
export async function backfillLeadTags(clinicId: string, opts: { limit?: number; after?: string } = {}): Promise<{ processed: number; last: string | null; done: boolean }> {
  const batch = await prisma.patient.findMany({ where: { clinicId, ...(opts.after ? { id: { gt: opts.after } } : {}) }, orderBy: { id: "asc" }, take: opts.limit ?? 200, select: { id: true } });
  for (const p of batch) await syncLeadTags(clinicId, p.id);
  return { processed: batch.length, last: batch.at(-1)?.id ?? null, done: batch.length < (opts.limit ?? 200) };
}
