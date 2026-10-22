import { prisma } from "../db/client.js";
import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { maskPhone } from "../crm/leadPhones.js";
import { maskDigits } from "../uazapi/phone.js";
import type { DispatchItem, DispatchStatus, ItemKind } from "./model.js";
import { STATUS_LABEL, REASONS, reasonFromDetail } from "./model.js";

// ---------------------------------------------------------------------------
// ADAPTADORES da Central de Disparos (22/10/2026): cada fluxo continua com o SEU controle persistente (nenhuma segunda fonte de verdade, nenhuma fila duplicada); aqui so se TRADUZ o
// registro existente para a linha da Central. Somente leitura. O que o controle nao guarda (ex.: texto/id do provedor do pos e do pre) aparece como "nao registrado", nunca inventado.
//   renovacao (RenewalSent) · retorno combinado (CallbackDispatch) · campanha (BroadcastRecipient) · pos (PostProcedureSent) · pre (PreProcedureSent) · recontato e retomadas (FollowUpDispatch)
// "Entregue"/"lido" so com deliveryState vindo do provedor (webhook); "confirmado pela equipe" e outra coisa.
// ---------------------------------------------------------------------------
type Period = { from: string; to: string };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const shortId = (s: string | null | undefined) => (s ? (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s) : null);
const mask = (s: string | null | undefined): string | null => (s ? s.replace(/\d{8,}/g, (d) => maskDigits(d)) : null);

function range(p: Period, tz: string): { gte: Date; lt: Date } {
  const [y1, m1, d1] = p.from.split("-").map(Number);
  const [y2, m2, d2] = p.to.split("-").map(Number);
  const next = new Date(Date.UTC(y2, m2 - 1, d2 + 1));
  return { gte: zonedWallClockToUtc(tz, y1, m1, d1, 0, 0), lt: zonedWallClockToUtc(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0) };
}

// Estado do provedor -> status da Central. `delivery` so conta com evidencia do provedor (aceito != entregue != lido); "staff_confirmed" e confirmacao humana.
function sentStatus(delivery: string | null | undefined): { status: DispatchStatus; reason: string } {
  if (delivery === "read") return { status: "lido", reason: "ja_enviado" };
  if (delivery === "delivered") return { status: "entregue", reason: "ja_enviado" };
  if (delivery === "failed") return { status: "entrega_falhou", reason: "falha_provedor" };
  if (delivery === "staff_confirmed") return { status: "confirmado_equipe", reason: "ja_enviado" };
  return { status: "aceito", reason: "ja_enviado" };
}

interface Row {
  id: string; kind: ItemKind; ruleName: string | null; patientId: string; referenceAt: Date | null; sendDay: string; state: string; detail: string | null;
  attempts: number; attemptedAt: Date | null; nextAttemptAt: Date | null; providerId: string | null; destination: string | null; deliveryState: string | null; messageText: string | null;
  professional?: string | null; procedure?: string | null; campaignId?: string | null; campaignTitle?: string | null; note?: string | null; future?: boolean;
}

// traducao generica de estados (todos os controles usam o mesmo vocabulario, com pequenas variacoes)
function translate(r: Row): { status: DispatchStatus; reason: string } {
  const base = reasonFromDetail(r.detail);
  switch (r.state) {
    case "sent": return sentStatus(r.deliveryState);
    case "reserved": case "sending": case "running": case "queued": return { status: "em_andamento", reason: "trava_ocupada" };
    case "pending": return { status: r.future ? "programado" : "nao_tentado", reason: r.future ? "ainda_nao_e_hora" : "sem_evidencia" };
    case "deferred": case "retry": return { status: "adiado", reason: base === "outro" ? "aguardando_intervalo" : base };
    case "failed": return { status: "falhou", reason: base === "outro" ? "falha_provedor" : base };
    case "failed_permanent": return { status: "falhou", reason: base === "outro" ? "numero_sem_whatsapp" : base };
    case "vetoed": return { status: "barrado", reason: "revisao_barrou" };
    case "blocked": return /cancelado pela equipe/i.test(r.detail ?? "") ? { status: "cancelado", reason: "cancelado_pela_equipe" } : { status: "bloqueado", reason: base === "outro" ? "plano_ou_opt_out" : base };
    case "exhausted": case "expired": return { status: "expirado", reason: "tentativas_esgotadas" };
    case "unconfirmed": return { status: "incerto", reason: "incerto" };
    case "duplicate": return { status: "coberto", reason: "ja_enviado" };
    case "skipped": return { status: "excluido", reason: base === "outro" ? "plano_ou_opt_out" : base };
    case "forwarded": return { status: "encaminhado", reason: "equipe_conversando" };
    case "closed": return { status: "cancelado", reason: "cancelado_pela_equipe" };
    case "legacy": return { status: "incerto", reason: "sem_evidencia" }; // registro anterior ao controle: so prova a reserva, nao o envio
    default: return { status: "incerto", reason: "sem_evidencia" };
  }
}

function toItem(r: Row, names: Map<string, { name: string | null; phone: string }>, tzNow: Date): DispatchItem {
  const { status, reason } = translate(r);
  const pat = names.get(r.patientId);
  const retryable = ["adiado", "falhou"].includes(status) && !["failed_permanent"].includes(r.state);
  const why = status === "incerto" ? "resultado incerto: concilie antes (pode ter saído)" : retryable ? "este fluxo tenta de novo sozinho no próximo ciclo, dentro do teto de tentativas (a Central não reenvia por fora)" : "este tipo de disparo é recuperado pelo próprio fluxo; a Central mostra o estado e permite avisar a equipe";
  void tzNow;
  return {
    id: r.id, source: "adapter", kind: r.kind, ruleId: null, ruleName: r.ruleName, patientId: r.patientId, patientName: (pat?.name ?? "").trim() || "(sem nome)", phone: maskPhone(pat?.phone),
    professional: r.professional ?? null, procedure: r.procedure ?? null, referenceAt: (r.referenceAt ?? new Date()).toISOString(), sendDay: r.sendDay,
    status, statusLabel: STATUS_LABEL[status], reason, reasonLabel: REASONS[reason] ?? reason, detail: mask(r.detail),
    attempts: r.attempts, attemptedAt: iso(r.attemptedAt), nextAttemptAt: iso(r.nextAttemptAt), deadlineAt: null, extendedReason: null, extended: false,
    destination: r.destination ? maskDigits(r.destination) : null, providerId: shortId(r.providerId), providerIdFull: r.providerId ?? null, messageText: r.messageText ?? null, deliveryState: r.deliveryState,
    recoverable: false, recoverableWhy: why, actions: ["detalhe", "atualizar", ...(["falhou", "adiado", "incerto", "barrado", "expirado", "nao_tentado"].includes(status) ? ["encaminhar_humano"] : [])],
    campaignId: r.campaignId ?? null, campaignTitle: r.campaignTitle ?? null, origin: r.note ?? null,
  };
}

export async function adapterItems(clinicId: string, period: Period, tz: string, now: Date): Promise<DispatchItem[]> {
  const win = range(period, tz);
  const rows: Row[] = [];
  const day = (d: Date) => isoDateInZone(d, tz);
  const mkDay = (primary: Date | null | undefined, fallback: Date) => day(primary ?? fallback);

  // ---- renovacao
  for (const r of await prisma.renewalSent.findMany({
    where: { appointment: { clinicId }, OR: [{ updatedAt: win }, { AND: [{ updatedAt: null }, { sentAt: win }] }] },
    include: { appointment: { include: { procedure: { select: { name: true } }, professional: { select: { name: true } } } }, rule: { select: { name: true } } },
    take: 500,
  })) rows.push({ id: `rn:${r.id}`, kind: "renovacao", ruleName: r.rule.name, patientId: r.appointment.patientId, referenceAt: r.appointment.scheduledAt, sendDay: mkDay(r.updatedAt, r.sentAt), state: r.state, detail: r.detail, attempts: r.attempts, attemptedAt: r.attemptedAt, nextAttemptAt: r.nextAttemptAt, providerId: r.providerId, destination: r.destination, deliveryState: r.state === "sent" ? (r.deliveryState ?? "accepted") : null, messageText: r.messageText, procedure: r.appointment.procedure.name, professional: r.appointment.professional?.name ?? null });

  // ---- retorno combinado
  for (const r of await prisma.callbackDispatch.findMany({ where: { clinicId, OR: [{ updatedAt: win }, { AND: [{ updatedAt: null }, { createdAt: win }] }] }, take: 500 })) {
    rows.push({ id: `cb:${r.id}`, kind: "retorno_combinado", ruleName: "Retorno combinado", patientId: r.patientId, referenceAt: r.dueAt, sendDay: mkDay(r.updatedAt, r.createdAt), state: r.state, detail: r.detail, attempts: r.attempts, attemptedAt: r.attemptedAt, nextAttemptAt: r.nextAttemptAt, providerId: r.providerId, destination: r.destination, deliveryState: r.state === "sent" ? (r.deliveryState ?? "accepted") : null, messageText: r.messageText, note: r.note, future: r.dueAt.getTime() > now.getTime() });
  }

  // ---- campanha (por destinatario)
  for (const r of await prisma.broadcastRecipient.findMany({
    where: { campaign: { clinicId }, OR: [{ updatedAt: win }, { sentAt: win }, { attemptedAt: win }, { AND: [{ status: "pending" }, { campaign: { scheduledFor: win } }] }] },
    include: { campaign: { select: { id: true, title: true, scheduledFor: true } } },
    take: 800,
  })) rows.push({ id: `bc:${r.id}`, kind: "campanha", ruleName: r.campaign.title, patientId: r.patientId, referenceAt: r.campaign.scheduledFor, sendDay: mkDay(r.sentAt ?? r.attemptedAt ?? r.updatedAt, r.campaign.scheduledFor), state: r.status, detail: r.detail, attempts: r.attempts, attemptedAt: r.attemptedAt, nextAttemptAt: r.nextAttemptAt, providerId: r.providerId, destination: r.destination, deliveryState: r.status === "sent" ? (r.deliveryState ?? "accepted") : null, messageText: r.messageText, campaignId: r.campaign.id, campaignTitle: r.campaign.title, future: r.campaign.scheduledFor.getTime() > now.getTime() });

  // ---- pos-procedimento (o controle nao guarda texto/id do provedor: aparece como nao registrado)
  for (const r of await prisma.postProcedureSent.findMany({
    where: { appointment: { clinicId }, OR: [{ finalAt: win }, { reservedAt: win }, { AND: [{ finalAt: null }, { reservedAt: null }, { sentAt: win }] }] },
    include: { appointment: { include: { procedure: { select: { name: true } }, professional: { select: { name: true } } } }, rule: { select: { name: true } } },
    take: 500,
  })) rows.push({ id: `ps:${r.id}`, kind: "pos", ruleName: r.rule.name, patientId: r.appointment.patientId, referenceAt: r.appointment.scheduledAt, sendDay: mkDay(r.finalAt ?? r.reservedAt, r.sentAt), state: r.state, detail: r.note, attempts: r.attempts, attemptedAt: r.attemptedAt, nextAttemptAt: null, providerId: null, destination: null, deliveryState: r.state === "sent" ? "accepted" : null, messageText: null, procedure: r.appointment.procedure.name, professional: r.appointment.professional?.name ?? null });

  // ---- pre-procedimento
  for (const r of await prisma.preProcedureSent.findMany({
    where: { appointment: { clinicId }, OR: [{ finalAt: win }, { reservedAt: win }, { AND: [{ finalAt: null }, { reservedAt: null }, { sentAt: win }] }] },
    include: { appointment: { include: { procedure: { select: { name: true } }, professional: { select: { name: true } } } }, rule: { select: { name: true } } },
    take: 500,
  })) rows.push({ id: `pr:${r.id}`, kind: "pre", ruleName: r.rule.name, patientId: r.appointment.patientId, referenceAt: r.appointment.scheduledAt, sendDay: mkDay(r.finalAt ?? r.reservedAt, r.sentAt), state: r.state, detail: (r as { note?: string | null }).note ?? null, attempts: r.attempts, attemptedAt: r.attemptedAt, nextAttemptAt: r.reevaluateAt ?? null, providerId: null, destination: null, deliveryState: r.state === "sent" ? "accepted" : null, messageText: null, procedure: r.appointment.procedure.name, professional: r.appointment.professional?.name ?? null, note: r.channel ? `canal: ${r.channel}` : null });

  // ---- recontato e retomadas (FollowUpDispatch)
  for (const r of await prisma.followUpDispatch.findMany({ where: { clinicId, OR: [{ decidedAt: win }, { updatedAt: win }] }, take: 800 })) {
    const retomada = r.flow !== "recontato";
    rows.push({ id: `fu:${r.id}`, kind: retomada ? "retomada" : "recontato", ruleName: retomada ? (r.flow === "avaliacao_cancelada" ? "Retomada: avaliação cancelada" : "Retomada: avaliação sem fechamento") : `Recontato (etapa ${r.step})`, patientId: r.patientId, referenceAt: r.dueAt, sendDay: day(r.decidedAt), state: r.state, detail: [r.layer, r.reason].filter(Boolean).join(": ") || null, attempts: r.attempt, attemptedAt: null, nextAttemptAt: r.reevaluateAt, providerId: null, destination: null, deliveryState: r.state === "sent" ? "accepted" : null, messageText: null });
  }

  const ids = [...new Set(rows.map((r) => r.patientId))];
  const pats = ids.length ? await prisma.patient.findMany({ where: { id: { in: ids }, clinicId }, select: { id: true, name: true, phone: true } }) : [];
  const names = new Map(pats.map((p) => [p.id, { name: p.name, phone: p.phone }]));
  return rows.filter((r) => names.has(r.patientId) && r.sendDay >= period.from && r.sendDay <= period.to).map((r) => toItem(r, names, now));
}

export const ADAPTER_PREFIXES = ["rn", "cb", "bc", "ps", "pr", "fu"] as const;

// Dia (fuso da clinica) em que a linha do adaptador aparece: o MESMO calculo de adapterItems, para localizar um item pela identidade sem listar nada.
export async function adapterRowDay(clinicId: string, id: string, tz: string): Promise<string | null> {
  const [prefix, raw] = id.split(":");
  if (!raw) return null;
  const day = (d: Date) => isoDateInZone(d, tz);
  if (prefix === "rn") { const r = await prisma.renewalSent.findFirst({ where: { id: raw, appointment: { clinicId } }, select: { updatedAt: true, sentAt: true } }); return r ? day(r.updatedAt ?? r.sentAt) : null; }
  if (prefix === "cb") { const r = await prisma.callbackDispatch.findFirst({ where: { id: raw, clinicId }, select: { updatedAt: true, createdAt: true } }); return r ? day(r.updatedAt ?? r.createdAt) : null; }
  if (prefix === "bc") { const r = await prisma.broadcastRecipient.findFirst({ where: { id: raw, campaign: { clinicId } }, select: { sentAt: true, attemptedAt: true, updatedAt: true, campaign: { select: { scheduledFor: true } } } }); return r ? day(r.sentAt ?? r.attemptedAt ?? r.updatedAt ?? r.campaign.scheduledFor) : null; }
  if (prefix === "ps") { const r = await prisma.postProcedureSent.findFirst({ where: { id: raw, appointment: { clinicId } }, select: { finalAt: true, reservedAt: true, sentAt: true } }); return r ? day(r.finalAt ?? r.reservedAt ?? r.sentAt) : null; }
  if (prefix === "pr") { const r = await prisma.preProcedureSent.findFirst({ where: { id: raw, appointment: { clinicId } }, select: { finalAt: true, reservedAt: true, sentAt: true } }); return r ? day(r.finalAt ?? r.reservedAt ?? r.sentAt) : null; }
  if (prefix === "fu") { const r = await prisma.followUpDispatch.findFirst({ where: { id: raw, clinicId }, select: { decidedAt: true } }); return r ? day(r.decidedAt) : null; }
  return null;
}
