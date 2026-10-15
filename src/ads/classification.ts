import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { enqueueMessagingEvent } from "./messaging.js";
import { syncLeadTags } from "./tags.js";

// ---------------------------------------------------------------------------
// CLASSIFICACAO COMERCIAL DO LEAD (em qualificacao / qualificado / desqualificado) com HISTORICO (quem, quando, por que). Tres caminhos:
//   - manual: a equipe classifica (painel);
//   - etapa: a equipe move o card para a etapa mapeada como "qualificado" / "desqualificado" (Meta > mapeamento das etapas);
//   - ia: a Alice SUGERE (confirmed=false) com motivo comercial objetivo; so vira classificacao (tag + evento) depois da revisao humana, a menos que a
//     clinica tenha ligado a aprovacao automatica (explicita; fica registrada no historico).
// Nunca existe "qualificado" e "desqualificado" ao mesmo tempo: a nova classificacao confirmada substitui a anterior (que fica no historico).
// Feedback pra Meta: so QualifiedLead (evento oficial de mensagens comerciais) e so quando ha clique de anuncio + WABA + dataset. Desqualificado
// NAO tem evento oficial: fica no CRM e nos relatorios.
// ---------------------------------------------------------------------------

export type LeadStatus = "em_qualificacao" | "qualificado" | "desqualificado";
export const LEAD_STATUSES: LeadStatus[] = ["em_qualificacao", "qualificado", "desqualificado"];

export const STATUS_LABEL: Record<LeadStatus, string> = {
  em_qualificacao: "Em qualificação",
  qualificado: "Qualificado",
  desqualificado: "Desqualificado",
};

// Motivos comerciais objetivos (nunca dado de saude).
export const REASON_CODES = ["interesse_real", "pediu_agendamento", "pediu_orcamento", "quer_continuar", "sem_interesse", "fora_do_perfil", "teste_ou_spam", "vaga_emprego", "outro"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const DISQUALIFIED_NO_EVENT = "somente_crm: a Meta nao tem evento oficial de desqualificacao para mensagens comerciais";

export interface ClassifyParams {
  clinicId: string;
  patientId: string;
  status: LeadStatus;
  reason?: string | null;
  reasonCode?: string | null;
  source: "manual" | "etapa" | "ia";
  actorName?: string | null; // quem decidiu (null = sistema)
  confirmed?: boolean; // false = sugestao pendente de revisao
}

export interface ClassifyResult {
  id: string | null;
  changed: boolean;
  pending: boolean;
  metaStatus?: string | null;
}

const clean = (s: string | null | undefined, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) || null : null);

async function currentConfirmed(patientId: string) {
  return prisma.leadClassification.findFirst({ where: { patientId, confirmed: true, supersededAt: null }, orderBy: { createdAt: "desc" } });
}

// Aplica uma classificacao CONFIRMADA: substitui a atual, atualiza etiquetas e manda o feedback elegivel. Idempotente (mesmo status = nao muda nada).
async function applyConfirmed(p: ClassifyParams & { existingRowId?: string }): Promise<ClassifyResult> {
  const cur = await currentConfirmed(p.patientId);
  if (cur && cur.status === p.status && !p.existingRowId) return { id: cur.id, changed: false, pending: false, metaStatus: cur.metaStatus };
  const now = new Date();
  const attribution = await prisma.adAttribution.findFirst({ where: { patientId: p.patientId }, orderBy: { receivedAt: "desc" }, select: { id: true } });

  const row = await prisma.$transaction(async (tx) => {
    if (cur && cur.id !== p.existingRowId) await tx.leadClassification.update({ where: { id: cur.id }, data: { supersededAt: now } });
    const data = { confirmed: true, actorName: p.actorName ?? null, decidedAt: now, attributionId: attribution?.id ?? null };
    const saved = p.existingRowId
      ? await tx.leadClassification.update({ where: { id: p.existingRowId }, data })
      : await tx.leadClassification.create({ data: { clinicId: p.clinicId, patientId: p.patientId, status: p.status, reasonCode: clean(p.reasonCode, 40), reason: clean(p.reason, 300), source: p.source, ...data } });
    await tx.patient.update({ where: { id: p.patientId }, data: { leadClass: p.status, leadClassAt: now } });
    return saved;
  });

  // Feedback comercial pra Meta (so o evento oficial e elegivel); desqualificado fica no CRM.
  let metaStatus: string | null = null;
  if (p.status === "qualificado") {
    const out = await enqueueMessagingEvent({ clinicId: p.clinicId, patientId: p.patientId, eventName: "QualifiedLead", eventKey: `q:${p.patientId}:${attribution?.id ?? "sem-anuncio"}` });
    metaStatus = out.status === "enfileirado" ? "enfileirado" : out.status === "ja_enviado" ? "ja_enviado" : `nao_elegivel: ${out.reason ?? ""}`;
    await prisma.leadClassification.update({ where: { id: row.id }, data: { metaStatus, metaEventId: out.eventId } });
  } else if (p.status === "desqualificado") {
    metaStatus = DISQUALIFIED_NO_EVENT;
    await prisma.leadClassification.update({ where: { id: row.id }, data: { metaStatus } });
  }

  await syncLeadTags(p.clinicId, p.patientId);
  await logActivity({
    clinicId: p.clinicId,
    patientId: p.patientId,
    type: "crm_card_updated",
    area: "crm",
    title: `Lead classificado: ${STATUS_LABEL[p.status]}`,
    description: `${row.reason ?? "sem motivo informado"} (${p.source === "ia" ? "IA, revisão humana" : p.source === "etapa" ? "mudança de etapa" : "manual"}${p.actorName ? ` · ${p.actorName}` : ""}).`,
    actorName: p.actorName ?? null,
  });
  return { id: row.id, changed: true, pending: false, metaStatus };
}

// Ponto de entrada. Nunca lanca (CRM nao pode derrubar o atendimento).
export async function classifyLead(p: ClassifyParams): Promise<ClassifyResult> {
  try {
    if (!LEAD_STATUSES.includes(p.status)) return { id: null, changed: false, pending: false };
    const patient = await prisma.patient.findUnique({ where: { id: p.patientId }, select: { clinicId: true } });
    if (!patient || patient.clinicId !== p.clinicId) return { id: null, changed: false, pending: false };

    if (p.confirmed === false) {
      // Sugestao da IA: nao vira etiqueta nem evento. Uma sugestao pendente por lead.
      const pending = await prisma.leadClassification.findFirst({ where: { patientId: p.patientId, confirmed: false, decidedAt: null } });
      if (pending && pending.status === p.status) return { id: pending.id, changed: false, pending: true };
      if (pending) await prisma.leadClassification.update({ where: { id: pending.id }, data: { decidedAt: new Date(), actorName: "substituída por nova sugestão" } });
      const cur = await currentConfirmed(p.patientId);
      if (cur && cur.status === p.status) return { id: cur.id, changed: false, pending: false }; // a IA so repetiu o que ja vale
      const row = await prisma.leadClassification.create({ data: { clinicId: p.clinicId, patientId: p.patientId, status: p.status, reasonCode: clean(p.reasonCode, 40), reason: clean(p.reason, 300), source: p.source, confirmed: false } });
      const clinic = await prisma.clinic.findUnique({ where: { id: p.clinicId }, select: { qualificationAutoApprove: true } });
      if (clinic?.qualificationAutoApprove) {
        const r = await applyConfirmed({ ...p, existingRowId: row.id, actorName: "Alice (aprovação automática configurada)" });
        return { ...r, pending: false };
      }
      return { id: row.id, changed: false, pending: true };
    }
    return await applyConfirmed(p);
  } catch (err) {
    console.error("[classificacao] falha:", err);
    return { id: null, changed: false, pending: false };
  }
}

// Revisao humana de uma sugestao da IA.
export async function confirmClassification(id: string, actorName: string | null): Promise<ClassifyResult> {
  try {
    const row = await prisma.leadClassification.findUnique({ where: { id } });
    if (!row || row.confirmed || row.decidedAt) return { id: row?.id ?? null, changed: false, pending: false };
    return await applyConfirmed({ clinicId: row.clinicId, patientId: row.patientId, status: row.status as LeadStatus, reason: row.reason, reasonCode: row.reasonCode, source: "ia", actorName, existingRowId: row.id });
  } catch (err) {
    console.error("[classificacao] falha ao confirmar:", err);
    return { id: null, changed: false, pending: false };
  }
}

export async function rejectClassification(id: string, actorName: string | null): Promise<boolean> {
  const row = await prisma.leadClassification.findUnique({ where: { id } });
  if (!row || row.confirmed || row.decidedAt) return false;
  await prisma.leadClassification.update({ where: { id }, data: { decidedAt: new Date(), actorName: actorName ? `rejeitada por ${actorName}` : "rejeitada" } });
  return true;
}

export async function leadClassificationView(patientId: string) {
  const [rows, patient] = await Promise.all([
    prisma.leadClassification.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.patient.findUnique({ where: { id: patientId }, select: { leadClass: true, leadClassAt: true } }),
  ]);
  return {
    current: patient?.leadClass ?? null,
    currentAt: patient?.leadClassAt ?? null,
    pending: rows.find((r) => !r.confirmed && !r.decidedAt) ?? null,
    history: rows.filter((r) => r.confirmed || r.decidedAt).map((r) => ({
      id: r.id, status: r.status, reason: r.reason, reasonCode: r.reasonCode, source: r.source, confirmed: r.confirmed, actorName: r.actorName, createdAt: r.createdAt, decidedAt: r.decidedAt,
      current: r.confirmed && !r.supersededAt, metaStatus: r.metaStatus,
    })),
  };
}

// Gancho do funil (chamado em applyMove): a equipe moveu o card.
//  - etapa mapeada como "qualificado"/"desqualificado" -> classificacao (so se foi uma PESSOA: movimento da IA nao qualifica);
//  - etapa de venda ganha (movida por pessoa) -> evento Purchase de mensagens comerciais, quando elegivel;
//  - sempre atualiza as etiquetas (agendamento/venda).
export async function afterStageMove(p: { clinicId: string; patientId: string; newStageId: string; newStageName: string; transitionId: string | null; actorName: string | null; aiDriven?: boolean; saleValue?: number }): Promise<void> {
  try {
    const cfg = await prisma.metaConfig.findUnique({ where: { clinicId: p.clinicId }, select: { stageQualified: true, stageDisqualified: true, stageWon: true } });
    if (!p.aiDriven && cfg) {
      const reason = `Card movido para a etapa "${p.newStageName}"`;
      if (cfg.stageQualified && p.newStageId === cfg.stageQualified) await classifyLead({ clinicId: p.clinicId, patientId: p.patientId, status: "qualificado", reason, reasonCode: "interesse_real", source: "etapa", actorName: p.actorName });
      else if (cfg.stageDisqualified && p.newStageId === cfg.stageDisqualified) await classifyLead({ clinicId: p.clinicId, patientId: p.patientId, status: "desqualificado", reason, reasonCode: "outro", source: "etapa", actorName: p.actorName });
      if (cfg.stageWon && p.newStageId === cfg.stageWon && p.transitionId) {
        await enqueueMessagingEvent({ clinicId: p.clinicId, patientId: p.patientId, eventName: "Purchase", eventKey: `p:${p.patientId}:${p.transitionId}`, value: typeof p.saleValue === "number" && !isNaN(p.saleValue) ? p.saleValue : undefined });
      }
    }
    await syncLeadTags(p.clinicId, p.patientId);
  } catch (err) {
    console.error("[classificacao] afterStageMove:", err);
  }
}
