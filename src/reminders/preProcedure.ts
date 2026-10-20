import { prisma } from "../db/client.js";
import { tidyGreetingText } from "../crm/greeting.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { scheduleLocked } from "../jobs/lock.js";
import { sendText, isPermanentSendError, isAmbiguousSendError, isConnectionDownError } from "../uazapi/client.js";
import { STALE_PENDING_MS } from "../ai/delivery.js";
import { FAIL_GAP_MS, MAX_SEND_ATTEMPTS, MAX_VETOES, VETO_RETRY_MS } from "../crm/followupLedger.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { notifyStaff } from "../crm/notify.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { isoDateInZone, wallClockInZone } from "../scheduling/time.js";
import { PLACEHOLDER_PROCEDURE_NAME } from "../clinicaexperts/placeholderProcedure.js";

// ---------------------------------------------------------------------------
// PRE-PROCEDIMENTO (pedido da Lisboa, 14/10/2026): logo depois que a cliente CONFIRMA o horario na conversa com a Alice, sai a
// orientacao de preparo do procedimento. A mensagem comeca agradecendo a confirmacao ("Obrigada pela confirmacao, Fulana!") e
// segue com as recomendacoes, entao ela SUBSTITUI a resposta de confirmacao da Alice (ver pendingPreProcedure em ai/alice.ts).
// Uma vez por agendamento por regra (PreProcedureSent); procedimento sem regra nao recebe nada.
// ---------------------------------------------------------------------------

const THANKS_LINE_RE = /^\s*obrigad[ao]s? pela confirma[cç][aã]o[^\n]*\n*/i;

// PURO: junta as mensagens de varios procedimentos do mesmo dia. So a primeira leva o "Obrigada pela confirmacao".
export function combinePreProcedureTexts(texts: string[]): string {
  return texts
    .map((t, i) => (i === 0 ? t.trim() : t.replace(THANKS_LINE_RE, "").trim()))
    .filter(Boolean)
    .join("\n\n");
}

// PURO: sem nome cadastrado o modelo vira "Obrigada pela confirmacao, !" -> "Obrigada pela confirmacao!".
export function tidyGreeting(text: string): string {
  return tidyGreetingText(text);
}

// PURO: a regra vale pra esse procedimento? (procedureIds vazio = todos)
export function ruleCoversProcedure(procedureIds: string, procedureId: string): boolean {
  const ids = procedureIds.split(",").filter(Boolean);
  return ids.length === 0 || ids.includes(procedureId);
}

// PURO: a regra vale para ALGUM procedimento da RESERVA? (uma reserva do CE pode ter varios: o principal e os demais). procedureIds vazio = todos.
export function ruleCoversReservation(procedureIds: string, a: { procedureId: string; procedures?: { procedureId: string | null }[] }): boolean {
  const ids = procedureIds.split(",").filter(Boolean);
  if (ids.length === 0) return true;
  return ids.includes(a.procedureId) || (a.procedures ?? []).some((p) => p.procedureId != null && ids.includes(p.procedureId));
}

// PURO: o procedimento que a regra orienta (o da regra que a reserva tem), para o texto citar o certo e nao so o principal.
export function procedureNameForRule(rule: { procedureIds: string }, a: { procedureId: string; procedure: { name: string }; procedures?: { procedureId: string | null; name: string }[] }): string {
  const ids = rule.procedureIds.split(",").filter(Boolean);
  if (ids.length === 0 || ids.includes(a.procedureId)) return a.procedure.name;
  return (a.procedures ?? []).find((p) => p.procedureId != null && ids.includes(p.procedureId))?.name ?? a.procedure.name;
}

interface ConfirmedAppointment {
  id: string;
  clinicId: string;
  scheduledAt: Date;
  procedureId: string;
  procedure: { name: string };
  procedures?: { procedureId: string | null; name: string }[];
  professional?: { name: string } | null;
  patient: { name: string | null; phone: string };
  attendee?: { name: string } | null; // quem sera ATENDIDO quando nao e a pessoa do telefone
}

// ---------------------------------------------------------------------------
// ESTADOS DA ETAPA DE PREPARO (PreProcedureSent.state) - 20/10/2026. Antes a linha era criada ("reserva") e tratada como MENSAGEM ENVIADA: se o processo caia entre a reserva e o envio,
// o preparo nunca saia e nada percebia. Agora a reserva e so uma reserva:
//   reserved      reservada; o provedor NAO foi chamado (evidencia de que o envio nao comecou => pode ser recuperada, depois de revalidar)
//   queued        virou a resposta da conversa (canal "resposta"); a entrega dessa mensagem diz o resto (reconciliada a cada ciclo)
//   sending       tentativa INICIADA: gravado imediatamente ANTES de chamar o provedor (o provedor pode ter sido chamado)
//   sent          enviada (confirmada pelo provedor ou pelo registro no chat)
//   unconfirmed   resultado incerto (timeout, queda durante/depois da chamada): NUNCA reenvia as cegas
//   failed        o provedor recusou, nada saiu: tenta de novo (com intervalo e teto)
//   failed_permanent / blocked / vetoed / superseded / expired   desfechos finais (vetoed ainda e reavaliado ate MAX_VETOES)
// Linhas antigas (anteriores a esta versao) ficam "sent": era assim que eram tratadas.
// ---------------------------------------------------------------------------

export interface PreReservation {
  appointmentId: string;
  ruleId: string;
}

export const PRE_AUTHOR = "Preparo da visita";
export const PRE_AUTHOR_ADVANCE = "Preparo da visita (48h antes)";
const RECOVERABLE = ["reserved", "failed", "vetoed"] as const;

// Texto de preparo dos agendamentos que a cliente acabou de confirmar (ordem do dia). Reserva cada envio (agendamento+regra) ANTES de devolver o texto: confirmar de novo
// nao reenvia. A reserva fica "reserved" ate a resposta existir (linkPreProcedureToMessage). null = nenhuma regra se aplica (ou ja foi tratada).
export async function buildPreProcedureText(appts: ConfirmedAppointment[]): Promise<{ text: string; reservations: PreReservation[] } | null> {
  if (!appts.length) return null;
  const clinicId = appts[0].clinicId;
  const rules = await prisma.preProcedureRule.findMany({ where: { clinicId, active: true }, orderBy: { createdAt: "asc" } });
  if (!rules.length) return null;
  const already = await prisma.preProcedureSent.findMany({
    where: { appointmentId: { in: appts.map((a) => a.id) } },
    select: { appointmentId: true, ruleId: true },
  });
  const sentKeys = new Set(already.map((s) => `${s.appointmentId}|${s.ruleId}`));
  const alreadyRule = new Set(already.map((s) => s.ruleId)); // a mesma regra ja tratada pra outro horario do dia nao repete
  const info = await getClinicTemplateInfo(clinicId);

  const texts: string[] = [];
  const reservations: PreReservation[] = [];
  const usedRules = new Set<string>();
  for (const appt of [...appts].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())) {
    for (const rule of rules) {
      if (usedRules.has(rule.id) || alreadyRule.has(rule.id) || sentKeys.has(`${appt.id}|${rule.id}`)) continue;
      if (!ruleCoversReservation(rule.procedureIds, appt)) continue;
      if (appt.procedure.name === PLACEHOLDER_PROCEDURE_NAME) continue; // reserva sem procedimento: nao ha preparo a orientar
      try {
        await prisma.preProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id, state: "reserved", channel: "resposta", reservedAt: new Date() } }); // reserva atomica (NAO e envio)
      } catch {
        continue; // outra confirmacao simultanea ja pegou
      }
      usedRules.add(rule.id);
      reservations.push({ appointmentId: appt.id, ruleId: rule.id });
      texts.push(
        tidyGreeting(
          renderMessageTemplate(rule.message, {
            patientName: appt.attendee?.name ?? appt.patient.name,
            patientPhone: appt.patient.phone,
            clinicName: info.name,
            locationName: info.primaryLocation?.name,
            locationAddress: info.primaryLocation?.fullAddress,
            procedureName: procedureNameForRule(rule, appt),
            professionalName: appt.professional?.name,
            when: appt.scheduledAt,
          }),
        ),
      );
    }
  }
  return texts.length ? { text: combinePreProcedureTexts(texts), reservations } : null;
}

// A resposta que carrega o preparo JA existe (gravada, pendente de entrega): a etapa passa a "queued" e a entrega da mensagem diz o desfecho.
export async function linkPreProcedureToMessage(reservations: PreReservation[], messageId: string): Promise<void> {
  if (!reservations.length) return;
  await prisma.preProcedureSent.updateMany({
    where: { state: "reserved", OR: reservations.map((r) => ({ appointmentId: r.appointmentId, ruleId: r.ruleId })) },
    data: { state: "queued", messageId },
  });
}

// ---------------------------------------------------------------------------
// ENVIO ANTECIPADO (Lisboa, 15/10/2026): "sempre 48 horas antes". Regra com sendHoursBefore preenchido sai sozinha quando faltam essas
// horas (ou menos) para o atendimento, de 8h as 20h no fuso da clinica; atendimento marcado de ultima hora recebe assim que possivel,
// desde que falte pelo menos 1h. Mesma reserva de antes (PreProcedureSent): quem ja recebeu nao recebe de novo ao confirmar.
// ---------------------------------------------------------------------------

export const PRE_SEND_FROM_HOUR = 8;
export const PRE_SEND_UNTIL_HOUR = 20;
export const PRE_MIN_LEAD_MS = 60 * 60_000;
const PRE_MAX_PATIENTS_PER_TICK = 30;
export const PRE_MAX_ATTEMPTS = MAX_SEND_ATTEMPTS;

// PURO: ja esta na hora de mandar o preparo deste atendimento?
export function isPreProcedureDue(scheduledAt: Date, now: Date, hoursBefore: number): boolean {
  const lead = scheduledAt.getTime() - now.getTime();
  return lead >= PRE_MIN_LEAD_MS && lead <= hoursBefore * 3_600_000;
}

// PURO: o texto da regra comeca agradecendo a confirmacao ("Obrigada pela confirmacao, Fulana!"), que so faz sentido logo apos confirmar.
// No envio antecipado troca por uma abertura que cita o dia e a hora.
export function toAdvanceIntro(text: string): string {
  const intro = "Oi, {primeiro_nome}! 💗\nPassando para enviar as orientações de preparo do seu atendimento em {data} às {hora}:\n";
  return THANKS_LINE_RE.test(text) ? text.replace(THANKS_LINE_RE, intro) : intro + text.trim();
}

// PURO: pode enviar agora? (janela de comunicacao 8h-20h no fuso da clinica)
export function inPreSendHours(now: Date, tz: string): boolean {
  const h = wallClockInZone(now, tz).hour;
  return h >= PRE_SEND_FROM_HOUR && h < PRE_SEND_UNTIL_HOUR;
}

export type PreDispatchResult = { sent: number; deferred: number; final: Record<string, number> };

const keyWhere = (keys: PreReservation[]) => ({ OR: keys.map((k) => ({ appointmentId: k.appointmentId, ruleId: k.ruleId })) });

// REVALIDA e ENVIA o preparo de UM paciente/dia a partir de etapas ja reservadas (canal antecipado ou recuperacao). Nada e enviado sem passar por aqui:
//  - o agendamento precisa continuar confirmado, ainda faltar pelo menos 1h, a regra continuar ativa e cobrir o procedimento ATUAL, a pessoa nao ter pedido para sair;
//  - envio equivalente ja registrado no chat desde a reserva => a etapa vira "sent" sem reenviar;
//  - fora de 8h-20h nada muda (aguarda);
//  - a etapa vira "sending" (tentativa iniciada) IMEDIATAMENTE antes de o provedor ser chamado (beforeProvider): "reserved" prova que o provedor nao foi chamado.
async function dispatchPreProcedure(clinicId: string, keys: PreReservation[], now: Date, channel: "antecipado" | "recuperacao"): Promise<PreDispatchResult> {
  const out: PreDispatchResult = { sent: 0, deferred: 0, final: {} };
  const setFinal = async (k: PreReservation, state: string, note: string, extra: Record<string, unknown> = {}) => {
    await prisma.preProcedureSent.updateMany({ where: { appointmentId: k.appointmentId, ruleId: k.ruleId, state: { in: [...RECOVERABLE, "sending"] } }, data: { state, note: note.slice(0, 200), finalAt: now, ...extra } });
    out.final[state] = (out.final[state] ?? 0) + 1;
  };
  const rows = await prisma.preProcedureSent.findMany({
    where: { ...keyWhere(keys), state: { in: [...RECOVERABLE] } },
    include: { rule: true, appointment: { include: { patient: true, attendee: true, procedure: true, procedures: true, professional: true } } },
  });
  if (!rows.length) return out;
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";

  const valid: typeof rows = [];
  for (const r of rows) {
    const k = { appointmentId: r.appointmentId, ruleId: r.ruleId };
    const a = r.appointment;
    if (a.status !== "confirmed") { await setFinal(k, "superseded", `agendamento ${a.status}: a orientacao nao se aplica mais`); continue; }
    if (a.scheduledAt.getTime() - now.getTime() < PRE_MIN_LEAD_MS) { await setFinal(k, "expired", "faltam menos de 1h (ou o horario ja passou): a orientacao perdeu a pertinencia"); continue; }
    if (a.patient.optedOut) { await setFinal(k, "superseded", "a pessoa pediu para nao receber mensagens"); continue; }
    if (!r.rule.active || !ruleCoversReservation(r.rule.procedureIds, a) || a.procedure.name === PLACEHOLDER_PROCEDURE_NAME) { await setFinal(k, "superseded", "a regra nao cobre mais o(s) procedimento(s) atual(is)"); continue; }
    valid.push(r);
  }
  if (!valid.length) return out;

  if (!inPreSendHours(now, tz)) { out.deferred += valid.length; return out; } // fora do horario de comunicacao: a etapa continua como esta

  const info = await getClinicTemplateInfo(clinicId);
  const patient = valid[0].appointment.patient;
  const personName = valid[0].appointment.attendee?.name ?? patient.name; // o grupo e de UMA pessoa: quem sera atendido
  const ordered = [...valid].sort((a, b) => a.appointment.scheduledAt.getTime() - b.appointment.scheduledAt.getTime());
  const text = tidyGreeting(
    combinePreProcedureTexts(
      ordered.map((r, i) =>
        renderMessageTemplate(i === 0 ? toAdvanceIntro(r.rule.message) : r.rule.message, {
          patientName: personName, patientPhone: patient.phone, clinicName: info.name,
          locationName: info.primaryLocation?.name, locationAddress: info.primaryLocation?.fullAddress,
          procedureName: procedureNameForRule(r.rule, r.appointment), professionalName: r.appointment.professional?.name, when: r.appointment.scheduledAt,
        }),
      ),
    ),
  );
  const myKeys = ordered.map((r) => ({ appointmentId: r.appointmentId, ruleId: r.ruleId }));
  // um envio EQUIVALENTE (mesmo texto, mesma pessoa) ja registrado no chat desde a reserva, por outro caminho/rodada/instancia: a etapa so e fechada, nao reenvia.
  // (Compara o CONTEUDO: o texto leva a data e a hora, entao outro dia/procedimento da mesma pessoa nunca conta como equivalente.)
  const since = new Date(Math.min(...ordered.map((r) => (r.reservedAt ?? r.sentAt).getTime())) - 60_000);
  const equivalent = await prisma.message.findFirst({ where: { role: "assistant", content: text, createdAt: { gte: since }, conversation: { patientId: patient.id } }, select: { id: true } });
  if (equivalent) {
    for (const k of myKeys) await setFinal(k, "sent", "envio equivalente ja registrado no chat");
    return out;
  }
  const author = channel === "antecipado" ? PRE_AUTHOR_ADVANCE : PRE_AUTHOR;

  try {
    const outcome = await sendText(clinicId, patient.phone, text, {
      kind: "preparo",
      // IMEDIATAMENTE antes de o provedor ser chamado: a tentativa passa a constar. Se outra rodada ja pegou alguma etapa, nao chama o provedor.
      beforeProvider: async () => {
        const claimed = await prisma.preProcedureSent.updateMany({
          where: { ...keyWhere(myKeys), state: { in: [...RECOVERABLE] } },
          data: { state: "sending", attemptedAt: now, attempts: { increment: 1 }, channel },
        });
        if (claimed.count !== myKeys.length) {
          // desfaz o que esta rodada marcou e desiste: nada foi enviado
          await prisma.preProcedureSent.updateMany({ where: { ...keyWhere(myKeys), state: "sending", attemptedAt: now }, data: { state: "reserved", attemptedAt: null } });
          throw new Error("preparo: outra rodada ja cuida desta etapa");
        }
      },
    });
    if (outcome === "duplicate") {
      // "duplicate" tambem acontece quando OUTRA rodada reservou o mesmo texto e ainda NAO enviou (a reivindicacao da etapa so ocorre depois, imediatamente antes do provedor).
      // Se esta rodada nao reivindicou nada e as etapas seguem recuperaveis, NAO as fecha como enviadas: quem estiver enviando conclui, e a proxima reconciliacao fecha pelo
      // registro no chat (ou reenvia, se a outra rodada falhou). Fechar aqui perdia a mensagem: a rodada que ia enviar desistia ao ver a etapa ja "enviada".
      const pendentes = await prisma.preProcedureSent.count({ where: { ...keyWhere(myKeys), state: { in: [...RECOVERABLE] } } });
      if (pendentes === myKeys.length) { out.deferred += myKeys.length; return out; }
    }
    if (outcome === "sent" || outcome === "duplicate") {
      if (outcome === "sent") await recordAutomatedMessage(patient.id, text, author).catch(() => undefined);
      for (const k of myKeys) await setFinal(k, "sent", outcome === "sent" ? "enviada" : "mensagem identica ja enviada a esta pessoa");
      out.sent += 1;
    } else if (outcome === "blocked") {
      for (const k of myKeys) await setFinal(k, "blocked", "envio automatico bloqueado para esta clinica (plano)");
    } else {
      // vetoed: a revisao por IA barrou. Temporario: reavalia depois; no maximo MAX_VETOES vezes
      for (const r of ordered) {
        const attempts = r.attempts + 1;
        await prisma.preProcedureSent.updateMany({
          where: { appointmentId: r.appointmentId, ruleId: r.ruleId, state: { in: ["sending", ...RECOVERABLE] } },
          data: { state: "vetoed", attempts, note: "revisao por IA barrou a mensagem (motivo no Diario de atividades)", reevaluateAt: attempts >= MAX_VETOES ? null : new Date(now.getTime() + VETO_RETRY_MS), finalAt: attempts >= MAX_VETOES ? now : null },
        });
      }
      out.final.vetoed = (out.final.vetoed ?? 0) + myKeys.length;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("preparo: outra rodada")) { out.deferred += myKeys.length; return out; }
    const now2 = await prisma.preProcedureSent.findMany({ where: { ...keyWhere(myKeys) }, select: { appointmentId: true, ruleId: true, state: true, attempts: true } });
    const started = now2.some((r) => r.state === "sending"); // a tentativa chegou a ser marcada antes do erro
    if (isConnectionDownError(err)) {
      // WhatsApp desta clinica fora: o provedor NAO foi chamado e nao e falha da pessoa. A etapa continua reservada, sem gastar tentativa; a recuperacao revalida e envia quando voltar.
      out.deferred += myKeys.length;
      return out;
    }
    if (isPermanentSendError(err)) {
      for (const k of myKeys) await setFinal(k, "failed_permanent", "numero sem WhatsApp"); // mantem a etapa fechada: nao tenta de novo a cada ciclo
      await notifyStaff(clinicId, "automation_failed", `⚠️ O número de ${patient.name ?? patient.phone} (${patient.phone}) não tem WhatsApp, então as orientações de preparo não foram enviadas.`).catch(() => undefined);
    } else if (isAmbiguousSendError(err)) {
      // pode ter chegado: NUNCA reenvia as cegas
      for (const k of myKeys) await setFinal(k, "unconfirmed", "tempo esgotado no provedor: pode ter sido entregue, nao reenviado");
    } else {
      // erro DEFINITIVO antes de sair (provedor recusou / falha de rede antes da resposta): volta para nova tentativa, com intervalo e teto
      console.error(`[pre-procedimento] falha ao enviar para ${patient.phone}:`, msg);
      for (const r of now2) {
        const exhausted = r.attempts >= PRE_MAX_ATTEMPTS;
        await prisma.preProcedureSent.updateMany({
          where: { appointmentId: r.appointmentId, ruleId: r.ruleId, state: { in: ["sending", ...RECOVERABLE] } },
          data: { state: exhausted ? "failed_permanent" : "failed", note: `falha no envio: ${msg.slice(0, 120)}`, reevaluateAt: exhausted ? null : new Date(now.getTime() + FAIL_GAP_MS), finalAt: exhausted ? now : null },
        });
      }
      if (started && now2.some((r) => r.attempts >= PRE_MAX_ATTEMPTS)) await notifyStaff(clinicId, "automation_failed", `⚠️ Não consegui enviar as orientações de preparo para ${patient.name ?? patient.phone} depois de várias tentativas.`).catch(() => undefined);
    }
  }
  return out;
}

// RECONCILIA e RECUPERA (a cada ciclo do job). Nunca reenvia quando o resultado e ambiguo.
//  1. "queued": le o desfecho da mensagem da conversa (enviada / sem confirmacao / falha definitiva / bloqueada). Vetada, expirada ou superada = NAO foi entregue: volta para recuperacao.
//  2. "sending" parada ha mais de STALE_PENDING_MS: procura o registro no chat; achou => "sent"; nao achou => "unconfirmed" (o provedor pode ter aceitado; nao reenvia).
//  3. "reserved" parada (ha mais de STALE_PENDING_MS), "failed" e "vetoed" no prazo: o provedor NAO foi chamado (ou recusou) => revalida e envia (dispatchPreProcedure).
export async function reconcilePreProcedure(now: Date = new Date()): Promise<{ reconciled: number; recovered: number; unconfirmed: number }> {
  const out = { reconciled: 0, recovered: 0, unconfirmed: 0 };
  const stale = new Date(now.getTime() - STALE_PENDING_MS);

  const queued = await prisma.preProcedureSent.findMany({ where: { state: "queued" }, take: 100 });
  for (const q of queued) {
    const m = q.messageId ? await prisma.message.findUnique({ where: { id: q.messageId }, select: { deliveryStatus: true, createdAt: true } }) : null;
    const st = m?.deliveryStatus ?? null;
    const set = async (state: string, note: string, extra: Record<string, unknown> = {}) => { await prisma.preProcedureSent.updateMany({ where: { id: q.id, state: "queued" }, data: { state, note, finalAt: now, ...extra } }); out.reconciled++; };
    if (st === "sent") await set("sent", "resposta entregue");
    else if (st === "unconfirmed") { await set("unconfirmed", "a resposta saiu sem confirmacao do provedor: nao reenviada"); out.unconfirmed++; }
    else if (st === "failed_permanent") await set("failed_permanent", "numero sem WhatsApp");
    else if (st === "blocked") await set("blocked", "envio automatico bloqueado");
    else if (st === "pending" || st === "sending" || st === "failed") continue; // a entrega da mensagem ainda cuida
    else await set("failed", `a resposta nao foi entregue (${st ?? "superada/ausente"}): sera reavaliada`, { finalAt: null, reevaluateAt: now }); // vetoed / expired / null / mensagem sumiu
  }

  const sending = await prisma.preProcedureSent.findMany({ where: { state: "sending", attemptedAt: { lt: stale } }, include: { appointment: { select: { patientId: true } } }, take: 100 });
  for (const s of sending) {
    const evidence = await prisma.message.findFirst({ where: { role: "assistant", authorName: { startsWith: PRE_AUTHOR }, createdAt: { gte: s.attemptedAt ?? stale }, conversation: { patientId: s.appointment.patientId } }, select: { id: true } });
    if (evidence) await prisma.preProcedureSent.updateMany({ where: { id: s.id, state: "sending" }, data: { state: "sent", note: "confirmada pelo registro no chat", finalAt: now } });
    else { await prisma.preProcedureSent.updateMany({ where: { id: s.id, state: "sending" }, data: { state: "unconfirmed", note: "tentativa sem desfecho (processo caiu durante/depois da chamada ao provedor): pode ter sido entregue, nao reenviada", finalAt: now } }); out.unconfirmed++; }
    out.reconciled++;
  }

  // recuperaveis: agrupa por clinica + paciente + dia
  const cand = await prisma.preProcedureSent.findMany({
    where: {
      OR: [
        { state: "reserved", reservedAt: { lt: stale } },
        { state: "failed", attempts: { lt: PRE_MAX_ATTEMPTS }, OR: [{ reevaluateAt: null }, { reevaluateAt: { lte: now } }] },
        { state: "vetoed", attempts: { lt: MAX_VETOES }, reevaluateAt: { lte: now } },
      ],
    },
    include: { appointment: { select: { clinicId: true, patientId: true, attendeeId: true, scheduledAt: true, clinic: { select: { timezone: true } } } } },
    orderBy: { reservedAt: "asc" },
    take: 100,
  });
  const groups = new Map<string, { clinicId: string; keys: PreReservation[] }>();
  for (const c of cand) {
    const tz = c.appointment.clinic.timezone || "America/Sao_Paulo";
    const key = `${c.appointment.patientId}|${c.appointment.attendeeId ?? ""}|${isoDateInZone(c.appointment.scheduledAt, tz)}`;
    const g = groups.get(key) ?? { clinicId: c.appointment.clinicId, keys: [] };
    g.keys.push({ appointmentId: c.appointmentId, ruleId: c.ruleId });
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const r = await dispatchPreProcedure(g.clinicId, g.keys, now, "recuperacao");
    out.recovered += r.sent;
  }
  return out;
}

export async function sendAdvancePreProcedure(now: Date = new Date()): Promise<number> {
  await reconcilePreProcedure(now).catch((err) => console.error("[pre-procedimento] reconciliacao falhou:", err instanceof Error ? err.message : err));
  const rules = await prisma.preProcedureRule.findMany({
    where: { active: true, sendHoursBefore: { not: null }, clinic: PAID_CLINIC_WHERE },
    include: { clinic: { select: { timezone: true } } },
    orderBy: { createdAt: "asc" },
  });
  let sentPatients = 0;
  const byClinic = new Map<string, typeof rules>();
  for (const r of rules) byClinic.set(r.clinicId, [...(byClinic.get(r.clinicId) ?? []), r]);

  for (const [clinicId, clinicRules] of byClinic) {
    const tz = clinicRules[0].clinic.timezone || "America/Sao_Paulo";
    if (!inPreSendHours(now, tz)) continue;
    const widest = Math.max(...clinicRules.map((r) => r.sendHoursBefore ?? 0));
    const candidates = await prisma.appointment.findMany({
      where: {
        clinicId,
        status: "confirmed",
        scheduledAt: { gte: new Date(now.getTime() + PRE_MIN_LEAD_MS), lte: new Date(now.getTime() + widest * 3_600_000) },
        patient: { optedOut: false },
      },
      include: { patient: true, attendee: true, procedure: true, procedures: true, professional: true },
      orderBy: { scheduledAt: "asc" },
      take: 400,
    });
    if (!candidates.length) continue;
    const sentRows = await prisma.preProcedureSent.findMany({ where: { appointmentId: { in: candidates.map((a) => a.id) } }, select: { appointmentId: true, ruleId: true } });
    const sentKeys = new Set(sentRows.map((s) => `${s.appointmentId}|${s.ruleId}`)); // (qualquer estado: as nao concluidas sao do reconciliador acima)

    // Um texto por paciente e por dia (varios procedimentos no mesmo dia viram uma mensagem so).
    const groups = new Map<string, typeof candidates>();
    for (const a of candidates) {
      const key = `${a.patientId}|${a.attendeeId ?? ""}|${isoDateInZone(a.scheduledAt, tz)}`; // uma pessoa (nao um telefone) por mensagem
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }

    for (const appts of groups.values()) {
      if (sentPatients >= PRE_MAX_PATIENTS_PER_TICK) return sentPatients;
      const reserved: PreReservation[] = [];
      const usedRules = new Set<string>();
      for (const appt of appts) {
        for (const rule of clinicRules) {
          if (usedRules.has(rule.id) || sentKeys.has(`${appt.id}|${rule.id}`)) continue;
          if (!isPreProcedureDue(appt.scheduledAt, now, rule.sendHoursBefore ?? 0)) continue;
          if (!ruleCoversReservation(rule.procedureIds, appt)) continue;
          if (appt.procedure.name === PLACEHOLDER_PROCEDURE_NAME) continue; // reserva sem procedimento: nao ha preparo a orientar
          try {
            await prisma.preProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id, state: "reserved", channel: "antecipado", reservedAt: now } }); // reserva atomica (NAO e envio)
          } catch {
            continue;
          }
          reserved.push({ appointmentId: appt.id, ruleId: rule.id });
          usedRules.add(rule.id);
        }
      }
      if (!reserved.length) continue;
      const r = await dispatchPreProcedure(clinicId, reserved, now, "antecipado");
      sentPatients += r.sent;
    }
  }
  return sentPatients;
}

export function startPreProcedureJob(): void {
  scheduleLocked("pre-procedimento", "*/15 * * * *", async () => {
    await sendAdvancePreProcedure();
  });
}
