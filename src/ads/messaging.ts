import { prisma } from "../db/client.js";
import type { CapiEvent } from "../meta/capi.js";

// ---------------------------------------------------------------------------
// API DE CONVERSOES PARA MENSAGENS COMERCIAIS (WhatsApp / Click-to-WhatsApp). Segue a documentacao oficial da Meta:
//   POST /{DATASET_ID}/events com action_source "business_messaging", messaging_channel "whatsapp",
//   user_data { whatsapp_business_account_id, ctwa_clid } e, quando ha valor, custom_data { currency, value }.
// Eventos aceitos (lista oficial): Purchase, LeadSubmitted, InitiateCheckout, AddToCart, ViewContent, OrderCreated, OrderShipped, OrderDelivered,
// OrderCanceled, OrderReturned, CartAbandoned, QualifiedLead, RatingProvided, ReviewProvided. NAO existe evento de desqualificacao nem de agendamento:
// esses ficam so no CRM (nada e "emprestado" de outro evento com significado errado). A Meta NAO deduplica: a deduplicacao e nossa (event_id unico).
// Pre-requisitos que dependem da conta: WhatsApp Business Platform (WABA), dataset ligado ao WABA, token com whatsapp_business_manage_events.
// O envio atual ("website") continua separado e intacto.
// ---------------------------------------------------------------------------

export const MESSAGING_EVENTS = [
  "Purchase", "LeadSubmitted", "InitiateCheckout", "AddToCart", "ViewContent", "OrderCreated", "OrderShipped", "OrderDelivered",
  "OrderCanceled", "OrderReturned", "CartAbandoned", "QualifiedLead", "RatingProvided", "ReviewProvided",
] as const;

export type MessagingEventName = (typeof MESSAGING_EVENTS)[number];

export interface MessagingConfigLite {
  messagingEnabled: boolean;
  wabaId: string | null;
  messagingDatasetId: string | null;
  accessTokenEnc: string | null;
}

// PURO: pode mandar este evento deste lead? Devolve o motivo quando nao pode.
export function messagingEligibility(
  cfg: MessagingConfigLite | null,
  attribution: { ctwaClid: string | null } | null,
  eventName: string,
): { ok: true } | { ok: false; reason: string } {
  if (!(MESSAGING_EVENTS as readonly string[]).includes(eventName)) return { ok: false, reason: `a Meta nao aceita o evento "${eventName}" na API de mensagens comerciais` };
  if (!cfg || !cfg.messagingEnabled) return { ok: false, reason: "envio para mensagens comerciais desligado nesta clinica" };
  if (!cfg.accessTokenEnc) return { ok: false, reason: "falta o token da Meta" };
  if (!cfg.wabaId) return { ok: false, reason: "falta o WhatsApp Business Account ID (WABA): o numero precisa estar na API oficial do WhatsApp" };
  if (!cfg.messagingDatasetId) return { ok: false, reason: "falta o dataset do WABA" };
  if (!attribution?.ctwaClid) return { ok: false, reason: "o lead nao tem o ctwa_clid do clique no anuncio (so vem na API oficial do WhatsApp)" };
  return { ok: true };
}

// PURO: o evento exatamente como a documentacao manda. Sem dado pessoal: so o ID do WABA e o ID do clique.
export function buildMessagingEvent(p: { eventName: MessagingEventName; eventId: string; wabaId: string; ctwaClid: string; eventTime?: number; value?: number; currency?: string }): CapiEvent {
  return {
    event_name: p.eventName,
    event_time: p.eventTime ?? Math.floor(Date.now() / 1000),
    event_id: p.eventId,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: { whatsapp_business_account_id: p.wabaId, ctwa_clid: p.ctwaClid },
    ...(typeof p.value === "number" && Number.isFinite(p.value) ? { custom_data: { currency: p.currency ?? "BRL", value: p.value } } : {}),
  };
}

export interface EnqueueOutcome {
  status: "enfileirado" | "nao_elegivel" | "ja_enviado";
  eventId: string;
  reason?: string;
}

// Enfileira (ou registra como nao elegivel) UM evento de mensagens comerciais. `eventKey` define a identidade (ex.: "q:<lead>:<entrada>"): o mesmo
// evento nunca e enviado duas vezes, mesmo se a pagina for recarregada, o webhook reprocessado ou a classificacao repetida. NUNCA lanca.
export async function enqueueMessagingEvent(p: {
  clinicId: string;
  patientId: string;
  eventName: MessagingEventName;
  eventKey: string;
  value?: number;
}): Promise<EnqueueOutcome> {
  const eventId = `msg:${p.eventName}:${p.eventKey}`;
  try {
    const [cfg, patient, attribution] = await Promise.all([
      prisma.metaConfig.findUnique({ where: { clinicId: p.clinicId } }),
      prisma.patient.findUnique({ where: { id: p.patientId }, select: { optedOut: true, clinicId: true } }),
      // o clique da conversa atual: a entrada mais recente que tem ctwa_clid
      prisma.adAttribution.findFirst({ where: { patientId: p.patientId, ctwaClid: { not: null } }, orderBy: { receivedAt: "desc" } }),
    ]);
    if (!patient || patient.clinicId !== p.clinicId) return { status: "nao_elegivel", eventId, reason: "lead nao encontrado" };
    if (patient.optedOut) return { status: "nao_elegivel", eventId, reason: "o lead pediu para nao receber contato (LGPD)" };

    const ok = messagingEligibility(cfg, attribution, p.eventName);
    const base = { clinicId: p.clinicId, eventId, eventName: p.eventName, source: "server", channel: "business_messaging", leadId: p.patientId, testEventCode: cfg?.testEventCode || null };
    try {
      if (!ok.ok) {
        await prisma.metaEvent.create({ data: { ...base, payload: JSON.stringify({ event_name: p.eventName, skipped: true }), status: "skipped", lastError: `nao elegivel: ${ok.reason}` } });
        return { status: "nao_elegivel", eventId, reason: ok.reason };
      }
      const event = buildMessagingEvent({ eventName: p.eventName, eventId, wabaId: cfg!.wabaId!, ctwaClid: attribution!.ctwaClid!, value: p.value });
      await prisma.metaEvent.create({ data: { ...base, payload: JSON.stringify(event), status: "pending", nextAttemptAt: new Date() } });
      return { status: "enfileirado", eventId };
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return { status: "ja_enviado", eventId, reason: "este evento ja foi registrado" };
      throw err;
    }
  } catch (err) {
    console.error(`[meta-mensagens] falha ao enfileirar ${p.eventName}:`, err);
    return { status: "nao_elegivel", eventId, reason: "erro interno ao enfileirar" };
  }
}

// Reavalia eventos que ficaram "skipped" (ex.: o WABA foi configurado depois): os que agora sao elegiveis voltam pra fila.
export async function requeueSkippedMessagingEvents(clinicId: string): Promise<{ checked: number; requeued: number }> {
  const [cfg, rows] = await Promise.all([
    prisma.metaConfig.findUnique({ where: { clinicId } }),
    prisma.metaEvent.findMany({ where: { clinicId, channel: "business_messaging", status: "skipped" }, take: 200 }),
  ]);
  let requeued = 0;
  for (const r of rows) {
    if (!r.leadId) continue;
    const attribution = await prisma.adAttribution.findFirst({ where: { patientId: r.leadId, ctwaClid: { not: null } }, orderBy: { receivedAt: "desc" } });
    if (!messagingEligibility(cfg, attribution, r.eventName).ok) continue;
    // o payload do "skipped" e so um marcador: reconstroi o evento real (valor, se houve, nao se perde porque nao era elegivel: vai sem valor)
    const event = buildMessagingEvent({ eventName: r.eventName as MessagingEventName, eventId: r.eventId, wabaId: cfg!.wabaId!, ctwaClid: attribution!.ctwaClid! });
    await prisma.metaEvent.update({ where: { id: r.id }, data: { payload: JSON.stringify(event), status: "pending", nextAttemptAt: new Date(), lastError: null } });
    requeued++;
  }
  return { checked: rows.length, requeued };
}
