import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError, isAmbiguousSendError, isSendDeferred, deferralInfo } from "../uazapi/client.js";
import { formatInZone } from "../scheduling/time.js";
import { notifyStaff } from "./notify.js";
import { usableFirstName } from "./greeting.js";
import { recordAutomatedMessage } from "./conversationLog.js";
import { scheduleLocked } from "../jobs/lock.js";
import { PLACEHOLDER_PROCEDURE_NAME } from "../clinicaexperts/placeholderProcedure.js";

// Quando a Alice agenda dentro de uma conversa, a propria resposta dela JA e
// a confirmacao que o paciente ve. Mas um agendamento criado FORA de uma
// conversa (painel manual, API externa) nao tem ninguem escrevendo pro
// paciente - so a equipe ficava sabendo (notifyStaff), o paciente nunca
// recebia nada. Pedido explicito do cliente (17/09/2026): mesmo fora da
// Alice, o paciente tem que ser avisado sobre o agendamento.
//
// Nao reaproveita o template "Confirmação de horário" que a clinica cadastra
// pra Alice usar como referencia: aquele texto costuma ser escrito pra UM
// cenario especifico (ex.: primeira consulta presencial - "seja bem-vindo",
// bioimpedancia, endereco) e a Alice so o usa quando o contexto bate, porque
// ela entende a diferenca. Mandar esse texto verbatim (sem uma IA lendo o
// contexto) pra QUALQUER procedimento - incluindo retorno/aplicação - sairia
// errado. Em vez disso, monta uma confirmacao minima e neutra, so com fatos
// verdadeiros pra qualquer agendamento: procedimento, profissional e horario.
//
// CONTROLE PERSISTENTE (19/10/2026): antes havia UMA tentativa solta; se o provedor/WhatsApp estivesse fora naquele instante, o paciente nunca sabia (e a equipe so via o aviso).
// Agora cada (agendamento, horario) tem uma linha AppointmentConfirmation:
//  - falha TEMPORARIA (WhatsApp fora, revisao fora, provedor 5xx): a etapa fica "retry" e a recuperacao (a cada 5 min) tenta de novo, so dentro da janela e com teto de tentativas;
//  - resultado INCERTO (tempo esgotado): "unconfirmed", NUNCA reenvia as cegas, a equipe e avisada uma vez;
//  - antes de cada envio REVALIDA: o agendamento ainda existe, continua confirmado, no MESMO horario e ainda no futuro; cancelou/remarcou => "superseded" (o texto antigo nunca sai);
//  - nao varre o historico: so existe linha para o que o gatilho (criacao pelo painel/API) registrou, e linha velha demais expira.
export const CONFIRM_WINDOW_MS = 6 * 3_600_000; // depois disso a confirmacao perde a utilidade: nao se envia mais
export const CONFIRM_MAX_ATTEMPTS = 5;
export const CONFIRM_STALE_MS = 10 * 60_000;

type Clock = () => Date;

function buildText(appt: { patient: { name: string | null }; procedure: { name: string }; professional: { name: string } | null; scheduledAt: Date; clinic: { timezone: string | null } }): string {
  const firstName = usableFirstName(appt.patient.name);
  const tz = appt.clinic.timezone || "America/Sao_Paulo";
  const when = formatInZone(appt.scheduledAt, tz);
  // Alguns procedimentos ja tem o nome do profissional no proprio nome (ex.:
  // "Experiência Clínica Presencial com Dr. Saulo Silva") - so repete o
  // "com {profissional}" quando esse nome ainda nao aparece no procedimento.
  const professionalName = appt.professional?.name ?? null;
  const withWho = professionalName && !appt.procedure.name.includes(professionalName) ? `, com ${professionalName},` : "";
  return `Oi${firstName ? `, ${firstName}` : ""}! Confirmando seu horário: ${appt.procedure.name}${withWho} em ${when}.`;
}

// Gatilho (painel manual / API externa): registra o controle do horario e faz a primeira tentativa. Nunca lanca (quem chama dispara e segue).
export async function sendAppointmentConfirmationToPatient(appointmentId: string, clock: Clock = () => new Date()): Promise<void> {
  try {
    const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { id: true, clinicId: true, patientId: true, scheduledAt: true } });
    if (!appt) return;
    const now = clock();
    let row = await prisma.appointmentConfirmation.findUnique({ where: { appointmentId_startsAt: { appointmentId: appt.id, startsAt: appt.scheduledAt } } });
    if (!row) {
      try {
        row = await prisma.appointmentConfirmation.create({ data: { clinicId: appt.clinicId, appointmentId: appt.id, patientId: appt.patientId, startsAt: appt.scheduledAt, state: "reserved", reservedAt: now, createdAt: now } });
      } catch {
        return; // outra chamada registrou o mesmo horario ao mesmo tempo: ela cuida
      }
    } else {
      // Este horario ja tem controle: o gatilho repetido (duplo clique, API reenviada) NAO envia de novo; a recuperacao cuida do que falhou. Unica excecao: o agendamento passou
      // por OUTRO horario depois deste e VOLTOU (A -> B -> A): a confirmacao anterior de A ficou velha, entao o retorno a A reabre o controle.
      const movedAway = await prisma.appointmentConfirmation.count({ where: { appointmentId: appt.id, startsAt: { not: appt.scheduledAt }, createdAt: { gt: row.createdAt } } });
      if (!movedAway || !["sent", "superseded", "expired", "unconfirmed", "failed_permanent", "vetoed", "duplicate", "blocked"].includes(row.state)) return;
      const reopened = await prisma.appointmentConfirmation.updateMany({ where: { id: row.id, state: row.state, updatedAt: row.updatedAt }, data: { state: "reserved", reservedAt: now, attemptedAt: null, finalAt: null, attempts: 0, createdAt: now, note: "horario retomado depois de uma remarcacao" } });
      if (reopened.count !== 1) return;
    }
    await attemptConfirmation(row.id, clock);
  } catch (err) {
    console.error("[confirmacao-agendamento] falha ao registrar/enviar:", err instanceof Error ? err.message : err);
  }
}

async function finish(id: string, state: string, note: string, now: Date): Promise<void> {
  await prisma.appointmentConfirmation.updateMany({ where: { id, state: { in: ["reserved", "sending", "retry"] } }, data: { state, note: note.slice(0, 200), finalAt: now } });
}

// Uma tentativa: reivindica, REVALIDA, envia e classifica o resultado.
export async function attemptConfirmation(id: string, clock: Clock = () => new Date()): Promise<string> {
  const now = clock();
  const row = await prisma.appointmentConfirmation.findUnique({ where: { id } });
  if (!row) return "inexistente";
  // "reserved" sem tentativa marcada prova que o provedor NAO foi chamado (recem criada pelo gatilho, ou o processo caiu antes de enviar): pode tentar. "retry" tambem.
  // "sending" (tentativa marcada) nunca volta a ser tentada: e incerta.
  const claimable = row.state === "retry" || (row.state === "reserved" && row.attemptedAt == null);
  if (!claimable) return row.state;
  if (now.getTime() - row.createdAt.getTime() > CONFIRM_WINDOW_MS) { await finish(id, "expired", "janela de confirmacao vencida: nao enviada", now); return "expired"; }

  const appt = await prisma.appointment.findUnique({ where: { id: row.appointmentId }, include: { patient: true, procedure: true, professional: true, clinic: true } });
  if (!appt) { await finish(id, "superseded", "agendamento removido", now); return "superseded"; }
  if (appt.status !== "confirmed") { await finish(id, "superseded", `agendamento ${appt.status}: a confirmacao nao vale mais`, now); return "superseded"; }
  if (appt.scheduledAt.getTime() !== row.startsAt.getTime()) { await finish(id, "superseded", "horario remarcado: o texto antigo nao vale mais", now); return "superseded"; }
  if (appt.scheduledAt.getTime() <= now.getTime()) { await finish(id, "superseded", "o horario ja passou", now); return "superseded"; }
  if (appt.patient.optedOut) { await finish(id, "superseded", "a pessoa pediu para nao receber mensagens", now); return "superseded"; }
  if (appt.procedure.name === PLACEHOLDER_PROCEDURE_NAME) { await finish(id, "superseded", "reserva sem procedimento: nada a confirmar", now); return "superseded"; }

  const claim = await prisma.appointmentConfirmation.updateMany({ where: { id, state: row.state, reservedAt: row.reservedAt }, data: { state: "reserved", reservedAt: now } });
  if (claim.count !== 1) return "outra_rodada";

  const text = buildText(appt);
  let started = false;
  try {
    const outcome = await sendText(appt.clinicId, appt.patient.phone, text, {
      kind: "agendamento",
      // IMEDIATAMENTE antes de o provedor ser chamado: a tentativa passa a constar. "reserved" prova que o provedor NAO foi chamado.
      beforeProvider: async () => {
        const c = await prisma.appointmentConfirmation.updateMany({ where: { id, state: "reserved" }, data: { state: "sending", attemptedAt: now, attempts: { increment: 1 } } });
        if (c.count !== 1) throw new Error("confirmacao: outra rodada ja cuida");
        started = true;
      },
    });
    // "blocked" (plano gratis), "vetoed" (revisao) ou "duplicate": nada saiu, entao nao grava no chat como se tivesse saido.
    if (outcome === "sent") {
      await finish(id, "sent", "enviada", now);
      await recordAutomatedMessage(appt.patientId, text, "Confirmação de agendamento");
      return "sent";
    }
    await finish(id, outcome, outcome === "vetoed" ? "revisao por IA barrou a mensagem" : outcome === "blocked" ? "envio automatico bloqueado para esta clinica" : "mensagem identica ja enviada", now);
    return outcome;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("confirmacao: outra rodada")) return "outra_rodada";
    const who = `${appt.patient.name ?? appt.patient.phone} (${appt.patient.phone})`;
    if (isAmbiguousSendError(err)) {
      await finish(id, "unconfirmed", "tempo esgotado no provedor: pode ter sido entregue, nao reenviado", now);
      await notifyStaff(appt.clinicId, "automation_failed", `⚠️ Não consegui confirmar se a confirmação de agendamento chegou para ${who}. Não reenviei para não duplicar: confira com o paciente.`);
      return "unconfirmed";
    }
    if (isPermanentSendError(err)) {
      await finish(id, "failed_permanent", "numero sem WhatsApp", now);
      await notifyStaff(appt.clinicId, "automation_failed", `⚠️ O número de ${who} não tem WhatsApp, então a confirmação de agendamento não foi enviada. Confirme com o paciente por outro meio.`);
      return "failed_permanent";
    }
    if (isSendDeferred(err)) {
      // WhatsApp/revisao fora: nada saiu e nao e falha da pessoa. Volta para "retry" sem gastar tentativa; a recuperacao tenta de novo dentro da janela (aviso unico: Diario + Canais).
      await prisma.appointmentConfirmation.updateMany({ where: { id, state: { in: ["reserved", "sending"] } }, data: { state: "retry", note: deferralInfo(err).tag, ...(started ? { attempts: { decrement: 1 } } : {}) } });
      return "retry";
    }
    console.error(`Falha ao enviar confirmação de agendamento para ${appt.patient.phone}:`, err);
    const cur = await prisma.appointmentConfirmation.findUnique({ where: { id }, select: { attempts: true } });
    const attempts = (cur?.attempts ?? 0) + (started ? 0 : 1);
    const exhausted = attempts >= CONFIRM_MAX_ATTEMPTS;
    await prisma.appointmentConfirmation.updateMany({ where: { id, state: { in: ["reserved", "sending"] } }, data: { state: exhausted ? "failed_permanent" : "retry", attempts, note: `falha no envio: ${msg.slice(0, 120)}`, finalAt: exhausted ? now : null } });
    if (exhausted) await notifyStaff(appt.clinicId, "automation_failed", `⚠️ Falha ao enviar a confirmação de agendamento para ${who} depois de várias tentativas. Confirme com o paciente manualmente.`);
    return exhausted ? "failed_permanent" : "retry";
  }
}

// RECUPERACAO: roda a cada 5 min. (1) tentativa que ficou "sending" (o processo caiu depois de marcar a tentativa) => incerta, nunca reenvia; (2) "retry" e "reserved" velho
// (caiu antes do provedor) => nova tentativa, SO de linhas dentro da janela. Linhas fora da janela expiram. Nunca olha agendamentos antigos: so o que o gatilho registrou.
export async function runConfirmationRecovery(clock: Clock = () => new Date()): Promise<{ attempted: number; expired: number; interrupted: number }> {
  const now = clock();
  const out = { attempted: 0, expired: 0, interrupted: 0 };
  const stuck = await prisma.appointmentConfirmation.findMany({ where: { state: "sending", attemptedAt: { lt: new Date(now.getTime() - CONFIRM_STALE_MS) } }, select: { id: true, clinicId: true, patientId: true } });
  for (const s of stuck) {
    const c = await prisma.appointmentConfirmation.updateMany({ where: { id: s.id, state: "sending" }, data: { state: "unconfirmed", finalAt: now, note: "o processo parou durante o envio: pode ter sido entregue, nao reenviado" } });
    if (c.count === 1) {
      out.interrupted++;
      const p = await prisma.patient.findUnique({ where: { id: s.patientId }, select: { name: true, phone: true } });
      await notifyStaff(s.clinicId, "automation_failed", `⚠️ Não consegui confirmar se a confirmação de agendamento chegou para ${p?.name ?? p?.phone ?? "um paciente"}. Não reenviei para não duplicar: confira com o paciente.`).catch(() => undefined);
    }
  }
  const old = await prisma.appointmentConfirmation.updateMany({ where: { state: { in: ["retry", "reserved"] }, createdAt: { lt: new Date(now.getTime() - CONFIRM_WINDOW_MS) } }, data: { state: "expired", finalAt: now, note: "janela de confirmacao vencida: nao enviada" } });
  out.expired = old.count;
  const rows = await prisma.appointmentConfirmation.findMany({
    where: { OR: [{ state: "retry" }, { state: "reserved", attemptedAt: null, reservedAt: { lt: new Date(now.getTime() - CONFIRM_STALE_MS) } }], createdAt: { gte: new Date(now.getTime() - CONFIRM_WINDOW_MS) } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const r of rows) {
    out.attempted++;
    await attemptConfirmation(r.id, clock);
  }
  return out;
}

export function startConfirmationRecoveryJob(): void {
  scheduleLocked("confirmacao-agendamento", "*/5 * * * *", async () => { await runConfirmationRecovery(); });
}
