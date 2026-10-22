import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isSendDeferred, deferralInfo, isPermanentSendError, isAmbiguousSendError, type SendReport } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { wallClockInZone } from "../scheduling/time.js";
import { PLACEHOLDER_PROCEDURE_NAME } from "../clinicaexperts/placeholderProcedure.js";
import { renewalDueAt, intervalMonths } from "./calendarInterval.js";

const DAY_MS = 24 * 60 * 60_000;

// Mesma protecao do postProcedure.ts: nunca manda pra algo que ficou "due" ha mais tempo que isso, senao criar/recriar uma regra reenvia pra anos de historico de uma vez.
export const RENEWAL_MAX_OVERDUE_MS = 30 * DAY_MS;
const MAX_PER_TICK = 30;
export const RENEWAL_MAX_ATTEMPTS = 3;
export const RENEWAL_RETRY_GAP_MS = 6 * 3_600_000; // o job roda de 6 em 6 h
export const RENEWAL_STALE_RESERVED_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// RENOVACAO com CONTROLE PERSISTENTE (22/10/2026). Antes: o registro de "enviada" era criado DEPOIS de sendText, qualquer que fosse o resultado - veto da revisao por IA, bloqueio do plano ou
// mensagem duplicada CONSUMIAM a renovacao (a pessoa nunca mais receberia), e uma queda entre o envio e o registro reenviava. Agora:
//  - a linha de RenewalSent e RESERVADA (unica por atendimento+regra) ANTES de chamar o provedor; a tentativa so conta como iniciada com \`attemptedAt\` (gravado imediatamente antes da chamada);
//  - so \`sent\` (aceito pelo provedor) consome a renovacao. Veto, bloqueio, adiamento e falha comum ficam VISIVEIS e tentam de novo (intervalo e teto), nunca consumindo;
//  - reserva abandonada: SEM attemptedAt = o provedor nao foi chamado (libera); COM attemptedAt = resultado INCERTO (nunca reenvia sozinho);
//  - timeout/queda no meio = incerto, sem reenvio automatico; numero invalido/sem WhatsApp = falha definitiva;
//  - o intervalo e de CALENDARIO (meses/anos no fuso da clinica, fim de mes e bissexto explicitos - ver calendarInterval.ts) contado do FIM do atendimento CONCLUIDO.
// "Fez o procedimento" = atendimento com status \`completed\`: "agendado que ja passou" NAO prova realizacao (a mensagem diz "ja faz 4 meses desde o seu Botox").
// ---------------------------------------------------------------------------
export const RENEWAL_FINAL = ["legacy", "sent", "unconfirmed", "failed_permanent", "exhausted", "duplicate", "reserved"];
const RETRYABLE = ["deferred", "failed", "vetoed", "blocked"];

export interface RenewalCycleResult { sent: number; retried: number; skipped: Record<string, number> }

async function settleStale(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RENEWAL_STALE_RESERVED_MS);
  // reserva abandonada ANTES de chamar o provedor: nada foi enviado, volta para nova tentativa
  await prisma.renewalSent.updateMany({ where: { state: "reserved", attemptedAt: null, updatedAt: { lt: cutoff } }, data: { state: "deferred", detail: "reserva abandonada antes de chamar o provedor: liberada", nextAttemptAt: null, updatedAt: now } });
  // chamada iniciada e sem desfecho: pode ter saido
  await prisma.renewalSent.updateMany({ where: { state: "reserved", attemptedAt: { not: null }, updatedAt: { lt: cutoff } }, data: { state: "unconfirmed", detail: "o processo parou durante o envio: pode ter sido entregue; NAO reenviado", updatedAt: now } });
}

export async function runRenewalCycle(clock: () => Date = () => new Date()): Promise<RenewalCycleResult> {
  const out: RenewalCycleResult = { sent: 0, retried: 0, skipped: {} };
  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };
  await settleStale(clock());
  const rules = await prisma.renewalRule.findMany({ where: { active: true, clinic: PAID_CLINIC_WHERE }, include: { clinic: { select: { timezone: true } } } });
  const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

  for (const rule of rules) {
    const tz = rule.clinic.timezone || "America/Sao_Paulo";
    // O job roda de 6 em 6h em UTC: convite de renovacao so entre 8h e 20h na clinica.
    const localHour = wallClockInZone(clock(), tz).hour;
    if (localHour < 8 || localHour >= 20) { skip("fora_do_horario_8h_20h"); continue; }
    const months = intervalMonths(rule.intervalValue, rule.intervalUnit);
    if (months === null) {
      console.error(`[renovacao] regra ${rule.id} com intervalUnit/valor invalido ("${rule.intervalValue} ${rule.intervalUnit}"; esperado months/years > 0) - pulando`);
      skip("regra_invalida");
      continue;
    }
    const now0 = clock();
    // janela larga (em dias) so para buscar; o vencimento EXATO e conferido por calendario abaixo
    const upper = new Date(now0.getTime() - Math.max(1, months - 1) * 28 * DAY_MS);
    const lower = new Date(now0.getTime() - months * 31 * DAY_MS - RENEWAL_MAX_OVERDUE_MS - 31 * DAY_MS);
    const procedureFilter = rule.procedureIds.split(",").filter(Boolean);

    const candidates = await prisma.appointment.findMany({
      where: {
        clinicId: rule.clinicId,
        status: "completed", // evidencia de que o procedimento foi REALIZADO (nao basta "nao cancelou")
        scheduledAt: { lte: upper, gte: lower },
        ...(procedureFilter.length ? { procedureId: { in: procedureFilter } } : {}),
        procedure: { name: { not: PLACEHOLDER_PROCEDURE_NAME } }, // reserva sem procedimento nao tem o que renovar
        renewalSent: { none: { ruleId: rule.id, state: { in: RENEWAL_FINAL } } },
        patient: { optedOut: false, contactKind: "paciente", promoOptOut: false }, // opt-out total, nao-paciente e "sem promocoes" nunca recebem
      },
      include: { patient: true, procedure: true, professional: true, renewalSent: { where: { ruleId: rule.id } } },
      orderBy: { scheduledAt: "asc" },
      take: MAX_PER_TICK * 4,
    });
    if (candidates.length === 0) continue;
    if (!clinicInfoCache.has(rule.clinicId)) clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
    const clinicInfo = clinicInfoCache.get(rule.clinicId)!;
    let handled = 0;

    for (const appt of candidates) {
      if (handled >= MAX_PER_TICK) break;
      const now = clock();
      const due = renewalDueAt(appt.scheduledAt, appt.endsAt, rule.intervalValue, rule.intervalUnit, tz);
      if (!due || due.getTime() > now.getTime()) { skip("ainda_nao_venceu"); continue; }
      if (now.getTime() - due.getTime() > RENEWAL_MAX_OVERDUE_MS) { skip("vencida_ha_mais_de_30_dias"); continue; }
      // Ja voltou (ou tem novo horario) para o mesmo procedimento/grupo: nao manda a renovacao.
      const groupIds = procedureFilter.length ? procedureFilter : [appt.procedureId];
      const later = await prisma.appointment.count({ where: { patientId: appt.patientId, status: { in: ["confirmed", "completed"] }, scheduledAt: { gt: appt.scheduledAt }, procedureId: { in: groupIds } } });
      if (later > 0) { skip("ja_voltou_ou_tem_horario"); continue; }

      // ---- reserva atomica (ANTES da tentativa)
      const existing = appt.renewalSent[0] ?? null;
      let rowId: string;
      let attempt = 1;
      if (!existing) {
        try {
          rowId = (await prisma.renewalSent.create({ data: { appointmentId: appt.id, ruleId: rule.id, state: "reserved", attempts: 1, updatedAt: now } })).id;
        } catch (e) {
          if ((e as { code?: string })?.code === "P2002") { skip("outra_execucao_reservou"); continue; }
          throw e;
        }
      } else {
        if (!RETRYABLE.includes(existing.state)) { skip(`controle_${existing.state}`); continue; }
        if (existing.attempts >= RENEWAL_MAX_ATTEMPTS) {
          await prisma.renewalSent.updateMany({ where: { id: existing.id, state: existing.state }, data: { state: "exhausted", detail: `tentativas esgotadas (${existing.attempts}); ultimo motivo: ${existing.detail ?? existing.state}`.slice(0, 300), updatedAt: now } });
          skip("tentativas_esgotadas");
          continue;
        }
        if (existing.nextAttemptAt && existing.nextAttemptAt.getTime() > now.getTime()) { skip("aguardando_intervalo"); continue; }
        const claimed = await prisma.renewalSent.updateMany({ where: { id: existing.id, state: existing.state, updatedAt: existing.updatedAt }, data: { state: "reserved", attempts: { increment: 1 }, attemptedAt: null, updatedAt: now } });
        if (claimed.count !== 1) { skip("outra_execucao_reservou"); continue; }
        rowId = existing.id;
        attempt = existing.attempts + 1;
        out.retried++;
      }
      handled++;

      // ---- reavalia com o banco de AGORA (opt-out/classificacao mudaram entre a selecao e o envio)
      const fresh = await prisma.patient.findUnique({ where: { id: appt.patientId }, select: { optedOut: true, contactKind: true, promoOptOut: true } });
      const release = (data: Record<string, unknown>) => prisma.renewalSent.updateMany({ where: { id: rowId, state: "reserved" }, data: { ...data, updatedAt: new Date() } });
      if (!fresh || fresh.optedOut || fresh.promoOptOut || fresh.contactKind !== "paciente") { await release({ state: "blocked", detail: "pessoa pediu para nao receber ou foi classificada como nao-paciente", nextAttemptAt: null, attempts: { decrement: 1 } }); skip("opt_out_ou_nao_paciente"); continue; }

      const text = renderMessageTemplate(rule.message, {
        patientName: appt.patient.name, patientPhone: appt.patient.phone, clinicName: clinicInfo.name, locationName: clinicInfo.primaryLocation?.name,
        locationAddress: clinicInfo.primaryLocation?.fullAddress, procedureName: appt.procedure.name, professionalName: appt.professional?.name, when: appt.scheduledAt, birthDate: appt.patient.birthDate,
      });
      await prisma.renewalSent.update({ where: { id: rowId }, data: { messageText: text } }); // texto desta tentativa fica visivel mesmo se a revisao vetar antes do provedor
      const retryAt = new Date(now.getTime() + RENEWAL_RETRY_GAP_MS);
      const exhaust = attempt >= RENEWAL_MAX_ATTEMPTS;
      let report: SendReport | null = null;
      try {
        const outcome = await sendText(appt.clinicId, appt.patient.phone, text, {
          kind: "renovacao",
          beforeProvider: async () => { await prisma.renewalSent.update({ where: { id: rowId }, data: { attemptedAt: new Date(), messageText: text } }); },
          report: (r) => { report = r; },
        });
        const rep = report as SendReport | null;
        if (outcome === "sent") {
          await release({ state: "sent", acceptedAt: new Date(), detail: "aceito pelo provedor", destination: rep?.destination ?? null, providerId: rep?.providerId ?? null, nextAttemptAt: null });
          out.sent++;
          await recordAutomatedMessage(appt.patientId, text, rule.name || "Renovação automática").catch((err) => console.error("[renovacao] aceita, mas o registro no chat falhou (NAO reenvia):", err instanceof Error ? err.message : err));
        } else if (outcome === "duplicate") {
          await release({ state: "duplicate", detail: "mensagem identica ja registrada para esta pessoa", nextAttemptAt: null });
        } else if (outcome === "vetoed") {
          await release({ state: exhaust ? "exhausted" : "vetoed", detail: "a revisao por IA barrou a mensagem (motivo no Diario); a renovacao NAO foi consumida", nextAttemptAt: exhaust ? null : retryAt });
        } else {
          await release({ state: exhaust ? "exhausted" : "blocked", detail: "envio automatico bloqueado (plano/politica); a renovacao NAO foi consumida", nextAttemptAt: exhaust ? null : retryAt });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const started = await prisma.renewalSent.findUnique({ where: { id: rowId }, select: { attemptedAt: true } });
        if (isSendDeferred(err)) await release({ state: "deferred", detail: deferralInfo(err).reason, nextAttemptAt: null, ...(started?.attemptedAt ? {} : { attempts: { decrement: 1 } }) });
        else if (isPermanentSendError(err)) await release({ state: "failed_permanent", detail: `numero invalido/sem WhatsApp: ${msg.slice(0, 120)}`, nextAttemptAt: null });
        else if (isAmbiguousSendError(err)) await release({ state: "unconfirmed", detail: "tempo esgotado no provedor: pode ter chegado; NAO reenviado" });
        else await release({ state: exhaust ? "exhausted" : "failed", detail: `falha do provedor antes de aceitar: ${msg.slice(0, 120)}`, nextAttemptAt: exhaust ? null : retryAt });
        console.error(`[renovacao] falha (regra ${rule.id}) para ...${appt.patient.phone.slice(-4)}:`, msg);
      }
    }
  }
  return out;
}

// Roda de 6 em 6h.
export function startRenewalJob(): void {
  scheduleLocked("renovacao", "0 */6 * * *", async () => { await runRenewalCycle(); });
}
