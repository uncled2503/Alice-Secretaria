import { prisma } from "../db/client.js";
import { buildUserData } from "./userData.js";
import type { CapiEvent } from "./capi.js";

// ---------------------------------------------------------------------------
// event_id estavel (deduplicacao). Navegador e servidor, se algum dia os dois
// enviarem a mesma conversao, precisam usar EXATAMENTE estes ids.
// ---------------------------------------------------------------------------
export const metaEventId = {
  lead: (leadId: string) => `lead:${leadId}`,
  schedule: (appointmentId: string) => `schedule:${appointmentId}`,
  crmStage: (leadId: string, transitionId: string) => `crmstage:${leadId}:${transitionId}`,
  disqualified: (leadId: string, transitionId: string) => `disqualified:${leadId}:${transitionId}`,
  qualified: (leadId: string, transitionId: string) => `qualified:${leadId}:${transitionId}`,
};

const RETRYABLE_STATUSES = ["pending", "error"];
export const META_MAX_ATTEMPTS = 8;

// Backoff exponencial com teto de 6h.
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, 6 * 60 * 60_000);
}

type PatientLite = {
  id: string;
  phone: string;
  email: string | null;
  optedOut: boolean;
  metaFbc: string | null;
  metaFbp: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  adCampaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  sourceUrl: string | null;
};

const PATIENT_META_SELECT = {
  id: true,
  phone: true,
  email: true,
  optedOut: true,
  metaFbc: true,
  metaFbp: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  utmContent: true,
  utmTerm: true,
  adCampaignName: true,
  adsetName: true,
  adName: true,
  sourceUrl: true,
} as const;

// custom_data com a atribuicao do lead (NUNCA PII aqui).
function attributionCustomData(p: PatientLite): Record<string, unknown> {
  const cd: Record<string, unknown> = {};
  if (p.utmSource) cd.utm_source = p.utmSource;
  if (p.utmMedium) cd.utm_medium = p.utmMedium;
  if (p.utmCampaign) cd.utm_campaign = p.utmCampaign;
  if (p.utmContent) cd.utm_content = p.utmContent;
  if (p.utmTerm) cd.utm_term = p.utmTerm;
  if (p.adCampaignName) cd.campaign_name = p.adCampaignName;
  if (p.adsetName) cd.adset_name = p.adsetName;
  if (p.adName) cd.ad_name = p.adName;
  return cd;
}

function eventSourceUrl(config: { siteUrl: string | null }, patient: PatientLite): string {
  return patient.sourceUrl || config.siteUrl || process.env.PUBLIC_BASE_URL?.trim() || "https://alice";
}

// Monta o objeto do evento e grava na fila (idempotente pelo par
// clinicId+eventId). NUNCA lanca. Chamar SEMPRE depois da transacao principal.
async function enqueue(params: {
  clinicId: string;
  eventName: string;
  eventId: string;
  leadId: string | null;
  patient: PatientLite | null;
  customData?: Record<string, unknown>;
}): Promise<void> {
  try {
    const config = await prisma.metaConfig.findUnique({ where: { clinicId: params.clinicId } });
    if (!config || !config.capiEnabled || !config.pixelId || !config.accessTokenEnc) return;

    const patient =
      params.patient ??
      (params.leadId
        ? await prisma.patient.findUnique({ where: { id: params.leadId }, select: PATIENT_META_SELECT })
        : null);

    // LGPD: lead que pediu pra sair nao tem dado enviado pra Meta.
    if (patient?.optedOut) return;

    const userData = patient
      ? buildUserData(patient)
      : { external_id: [] as string[] }; // sem lead: evento de teste

    const customData = { ...(patient ? attributionCustomData(patient) : {}), ...(params.customData ?? {}) };

    const event: CapiEvent = {
      event_name: params.eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: params.eventId,
      action_source: "website",
      event_source_url: eventSourceUrl(config, patient ?? ({ sourceUrl: null } as PatientLite)),
      user_data: userData as Record<string, unknown>,
      ...(Object.keys(customData).length ? { custom_data: customData } : {}),
    };

    await prisma.metaEvent.create({
      data: {
        clinicId: params.clinicId,
        eventId: params.eventId,
        eventName: params.eventName,
        source: "server",
        leadId: params.leadId,
        payload: JSON.stringify(event), // ja sanitizado: user_data com hash, sem token
        status: "pending",
        nextAttemptAt: new Date(),
        testEventCode: config.testEventCode || null,
      },
    });
  } catch (err: unknown) {
    // P2002 = par (clinicId, eventId) ja existe -> deduplicado, tudo certo.
    if ((err as { code?: string })?.code === "P2002") return;
    console.error(`[meta] falha ao enfileirar ${params.eventName} (${params.eventId}):`, err);
  }
}

// ---- Pontos de entrada ----------------------------------------------------

export async function enqueueLead(clinicId: string, patientId: string): Promise<void> {
  await enqueue({ clinicId, eventName: "Lead", eventId: metaEventId.lead(patientId), leadId: patientId, patient: null });
}

export async function enqueueSchedule(clinicId: string, appointmentId: string): Promise<void> {
  try {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { patientId: true, clinicId: true, procedure: { select: { name: true } } },
    });
    if (!appt || appt.clinicId !== clinicId) return;
    await enqueue({
      clinicId,
      eventName: "Schedule",
      eventId: metaEventId.schedule(appointmentId),
      leadId: appt.patientId,
      patient: null,
      customData: appt.procedure?.name ? { content_name: appt.procedure.name } : undefined,
    });
  } catch (err) {
    console.error("[meta] enqueueSchedule falhou:", err);
  }
}

// Chamado no choke point de mudanca de etapa do CRM (applyMove). Decide entre
// CRMStageChanged / DisqualifiedLead / QualifiedLead conforme o mapeamento.
export async function enqueueStageChange(params: {
  clinicId: string;
  patientId: string;
  transitionId: string; // id do ActivityLog da transicao
  prevStageId: string | null;
  prevStageName: string | null;
  newStageId: string;
  newStageName: string;
  pipelineId?: string;
  pipelineName?: string;
  changedAt?: Date;
  actorName?: string | null;
}): Promise<void> {
  try {
    const config = await prisma.metaConfig.findUnique({ where: { clinicId: params.clinicId } });
    if (!config || !config.capiEnabled) return;

    const ignored = config.stagesIgnored.split(",").map((s) => s.trim()).filter(Boolean);
    if (ignored.includes(params.newStageId)) return; // coluna que nao envia evento

    const patient = await prisma.patient.findUnique({
      where: { id: params.patientId },
      select: { ...PATIENT_META_SELECT, clinicId: true, funnelStage: true, name: true },
    });
    if (!patient || patient.clinicId !== params.clinicId || patient.optedOut) return;

    const form = { form_id: params.clinicId, form_name: config.name || "Alice" };
    const base: Record<string, unknown> = {
      lead_id: params.patientId,
      pipeline_id: params.pipelineId ?? params.clinicId,
      pipeline_name: params.pipelineName ?? "CRM",
      previous_stage_id: params.prevStageId ?? "",
      previous_stage_name: params.prevStageName ?? "",
      new_stage_id: params.newStageId,
      new_stage_name: params.newStageName,
      changed_at: (params.changedAt ?? new Date()).toISOString(),
      ...form,
      ...(patient.adCampaignName ? { campaign_name: patient.adCampaignName } : {}),
      ...(patient.adsetName ? { adset_name: patient.adsetName } : {}),
      ...(patient.adName ? { ad_name: patient.adName } : {}),
      ...(patient.utmSource ? { utm_source: patient.utmSource } : {}),
      ...(patient.utmCampaign ? { utm_campaign: patient.utmCampaign } : {}),
    };

    // CRMStageChanged: toda movimentacao valida
    await enqueue({
      clinicId: params.clinicId,
      eventName: "CRMStageChanged",
      eventId: metaEventId.crmStage(params.patientId, params.transitionId),
      leadId: params.patientId,
      patient,
      customData: base,
    });

    // DisqualifiedLead: SO na coluna de desqualificado. NUNCA na de "perdido".
    if (config.stageDisqualified && params.newStageId === config.stageDisqualified && params.newStageId !== config.stageLost) {
      await enqueue({
        clinicId: params.clinicId,
        eventName: "DisqualifiedLead",
        eventId: metaEventId.disqualified(params.patientId, params.transitionId),
        leadId: params.patientId,
        patient,
        customData: base,
      });
    }

    // QualifiedLead: so quando a coluna de qualificado estiver mapeada.
    if (config.stageQualified && params.newStageId === config.stageQualified) {
      await enqueue({
        clinicId: params.clinicId,
        eventName: "QualifiedLead",
        eventId: metaEventId.qualified(params.patientId, params.transitionId),
        leadId: params.patientId,
        patient,
        customData: base,
      });
    }
  } catch (err) {
    console.error("[meta] enqueueStageChange falhou:", err);
  }
}

// Evento de teste manual (botao "Enviar evento de teste").
export async function enqueueTestLead(clinicId: string): Promise<{ ok: boolean; detail: string }> {
  const config = await prisma.metaConfig.findUnique({ where: { clinicId } });
  if (!config) return { ok: false, detail: "Configure a Meta primeiro." };
  if (!config.pixelId || !config.accessTokenEnc) return { ok: false, detail: "Falta pixel ou token." };
  const eventId = `test:${clinicId}:${Date.now()}`;
  const event: CapiEvent = {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: config.siteUrl || process.env.PUBLIC_BASE_URL?.trim() || "https://alice",
    user_data: { external_id: [`test-${clinicId}`] },
    custom_data: { test: true },
  };
  await prisma.metaEvent.create({
    data: {
      clinicId,
      eventId,
      eventName: "Lead",
      source: "server",
      payload: JSON.stringify(event),
      status: "pending",
      nextAttemptAt: new Date(),
      testEventCode: config.testEventCode || "TEST_MANUAL",
    },
  });
  return { ok: true, detail: "Evento de teste enfileirado. Veja em Eventos de teste no Gerenciador da Meta em alguns segundos." };
}

export function dueEventsFilter() {
  return { status: { in: RETRYABLE_STATUSES }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] };
}
