import { scheduleLocked } from "../jobs/lock.js";
import { reservationEndMs } from "../scheduling/reservation.js";
import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError, isAmbiguousSendError, isSendDeferred, deferralInfo } from "../uazapi/client.js";
import { RunRecorder } from "../crm/automationRuns.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { notifyStaff } from "../crm/notify.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { wallClockInZone } from "../scheduling/time.js";
import { PLACEHOLDER_PROCEDURE_NAME } from "../clinicaexperts/placeholderProcedure.js";

function intervalMs(value: number, unit: string): number {
  const hourMs = 60 * 60_000;
  return unit === "hours" ? value * hourMs : value * 24 * hourMs;
}

// Nunca considera um agendamento "due" ha mais tempo que isso - protege contra
// disparo retroativo em massa quando uma regra e criada ou recriada do zero
// (sem isso, TODO agendamento ja feito no passado - meses de historico - vira
// "due" ao mesmo tempo na primeira checagem, porque nenhum tem PostProcedureSent
// pra esse ruleId novo). Incidente real: 30/09/2026, Clinica Dr. Saulo Silva -
// recriar a regra mandou a mensagem pra toda a base de pacientes de uma vez.
const MAX_OVERDUE_MS = 3 * 24 * 60 * 60_000; // 3 dias de folga alem do prazo da regra
const MAX_PER_TICK = 30; // teto de seguranca por regra a cada execucao (15min)
const POST_MAX_ATTEMPTS = 6; // tentativas (com falha antes da resposta do provedor) antes de fechar a etapa e avisar a equipe
const POST_STALE_MS = 10 * 60_000; // "reserved"/"sending" mais velho que isso: o processo caiu no meio

// Estados em que a etapa esta FECHADA (nunca reabre nem reenvia). "legacy" = registro anterior ao controle por estado: prova a reserva, nao a entrega; ambiguo, entao nao se reenvia.
export const POST_FINAL_STATES = ["legacy", "sent", "unconfirmed", "vetoed", "blocked", "duplicate", "failed_permanent"];

// Reserva/reivindica a etapa (atendimento x regra) de forma atomica. Devolve null quando a etapa nao e deste processo agora.
async function claimPostStep(appointmentId: string, ruleId: string, now: Date): Promise<{ id: string } | null> {
  const existing = await prisma.postProcedureSent.findUnique({ where: { appointmentId_ruleId: { appointmentId, ruleId } } });
  if (!existing) {
    try {
      const row = await prisma.postProcedureSent.create({ data: { appointmentId, ruleId, state: "reserved", reservedAt: now } });
      return { id: row.id };
    } catch {
      return null; // reserva atomica: outro processo ja pegou
    }
  }
  const stale = existing.reservedAt != null && now.getTime() - existing.reservedAt.getTime() > POST_STALE_MS;
  // "reserved" velho: o processo caiu ANTES de chamar o provedor (attemptedAt vazio) => seguro tentar de novo. "retry" => nova tentativa. O resto nao e nosso.
  const claimable = existing.state === "retry" || (existing.state === "reserved" && stale && existing.attemptedAt == null);
  if (!claimable) return null;
  // reivindica comparando o reservedAt lido: dois processos que leram a mesma linha velha nao ganham os dois
  const c = await prisma.postProcedureSent.updateMany({ where: { id: existing.id, state: existing.state, reservedAt: existing.reservedAt }, data: { state: "reserved", reservedAt: now } });
  return c.count === 1 ? { id: existing.id } : null;
}

async function finishPostStep(id: string, state: string, note: string, now: Date): Promise<void> {
  await prisma.postProcedureSent.updateMany({ where: { id, state: { in: ["reserved", "sending"] } }, data: { state, note: note.slice(0, 200), finalAt: now } });
}

// ---------------------------------------------------------------------------
// QUANDO O POS PODE SAIR, hora do dia. Padrao do fluxo (todas as clinicas): nada entre 21h e 7h (cuidados nao saem de noite/madrugada). Uma regra pode autorizar, POR CONFIGURACAO
// PROPRIA (PostProcedureRule.lateSendUntilHour, 21..24), o envio DEPOIS do fechamento - sempre para quem acabou de vencer (o pos de um atendimento que terminou as 20h30 sai as
// 21h30), nunca antes das 7h e nunca para uma mensagem antiga acumulada (essa espera a manha, como sempre). So este fluxo e so esta regra: recontatos, campanhas, lembretes,
// pesquisa e aniversario tem as proprias janelas e NAO sao tocados.
//
// O QUE INICIA O PRAZO: regra em HORAS conta do FIM da reserva (ends_at do CE; sem ele, inicio + soma dos procedimentos); regra em DIAS conta do INICIO. Em ambos os casos o
// atendimento precisa estar CONCLUIDO (onlyIfCompleted: status "completed", vindo do Clinica Experts ou da equipe): o horario ter passado NAO prova que o procedimento foi feito.
// ---------------------------------------------------------------------------
export const POST_FIRST_HOUR = 7;
export const POST_DEFAULT_LAST_HOUR = 21; // exclusivo
export const POST_LATE_FRESH_MS = 6 * 3_600_000; // depois do fechamento so sai o que venceu ha ate 6 h

// PURO: quando o pos deste atendimento vence (instante).
export function postDueAt(rule: { intervalValue: number; intervalUnit: string }, appt: { scheduledAt: Date; endsAt?: Date | null; procedure: { durationMin: number } }): Date {
  const interval = intervalMs(rule.intervalValue, rule.intervalUnit);
  const base = rule.intervalUnit === "hours" ? reservationEndMs(appt) : appt.scheduledAt.getTime();
  return new Date(base + interval);
}

export function validLateUntilHour(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= POST_DEFAULT_LAST_HOUR && v <= 24;
}

// PURO: neste horario local, a regra pode enviar? `afterHours` = so por causa da autorizacao propria da regra (aplica o filtro de "venceu ha pouco").
export function postHourGate(rule: { lateSendUntilHour?: number | null }, localHour: number): { allowed: boolean; afterHours: boolean } {
  if (localHour >= POST_FIRST_HOUR && localHour < POST_DEFAULT_LAST_HOUR) return { allowed: true, afterHours: false };
  if (localHour >= POST_DEFAULT_LAST_HOUR && validLateUntilHour(rule.lateSendUntilHour) && localHour < rule.lateSendUntilHour) return { allowed: true, afterHours: true };
  return { allowed: false, afterHours: false };
}

// PURO: depois do fechamento so passa o que venceu ha pouco (nada de lote antigo acumulado a noite).
export function postFreshEnough(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() <= now.getTime() && now.getTime() - dueAt.getTime() <= POST_LATE_FRESH_MS;
}

// PURO: o atendimento (inicio + duracao) ja terminou ate `limit`?
export function appointmentEndedBy(appt: { scheduledAt: Date; endsAt?: Date | null; procedure: { durationMin: number } }, limit: Date): boolean {
  return reservationEndMs(appt) <= limit.getTime(); // o fim da RESERVA (ends_at do CE / soma dos procedimentos), nao so a duracao do procedimento principal
}

// PURO: avaliacao nao recebe "pos-procedimento" (nao houve procedimento), a menos que a regra liste esse procedimento de
// proposito (procedureIds). Pedido da Lisboa (checklist 15/10): "nao enviar pos de avaliacao".
export function skipsPostForEvaluation(appt: { procedureId: string; procedure: { name: string }; procedures?: { procedureId: string | null; name: string }[] }, procedureFilter: string[]): boolean {
  // reserva com procedimento de verdade ALEM da avaliacao: nao e "so avaliacao" (o pos acompanha o procedimento)
  if ((appt.procedures ?? []).some((p) => !/avalia/i.test(p.name))) return false;
  return /avalia/i.test(appt.procedure.name) && !procedureFilter.includes(appt.procedureId);
}

// PURO: o procedimento que o pos acompanha: o que a regra lista (se a reserva tem varios) ou o principal.
export function postProcedureNameFor(appt: { procedureId: string; procedure: { name: string }; procedures?: { procedureId: string | null; name: string }[] }, procedureFilter: string[]): string {
  if (!procedureFilter.length || procedureFilter.includes(appt.procedureId)) return appt.procedure.name;
  return (appt.procedures ?? []).find((p) => p.procedureId != null && procedureFilter.includes(p.procedureId))?.name ?? appt.procedure.name;
}

// Roda a cada 15min. So dispara uma vez por agendamento por regra (marca em
// PostProcedureSent), respeitando "so apos concluido" e o filtro de
// procedimentos (procedureIds vazio = vale pra todos).
// Cada rodada deixa um resumo por clinica (AutomationRun "pos-procedimento") para provar se o job rodou, quantos atendimentos entraram, o que saiu e por que
// o restante nao saiu. O "pos" aqui e o ACOMPANHAMENTO PÓS-PROCEDIMENTO (regra PostProcedureRule, depois de um atendimento CONCLUIDO); nao e o preparo pre-procedimento
// (PreProcedureRule) nem a pesquisa de satisfacao (NPS), que sao fluxos separados.
export async function runPostProcedureCycle(clock: () => Date = () => new Date()): Promise<void> {
  {
    const recorders = new Map<string, RunRecorder>();
    const rec = (clinicId: string) => { let r = recorders.get(clinicId); if (!r) recorders.set(clinicId, (r = new RunRecorder("pos-procedimento", clinicId, clock()))); return r; };
    let failure: unknown = null;
    try {
    const rules = await prisma.postProcedureRule.findMany({
      where: { active: true, clinic: PAID_CLINIC_WHERE },
      include: { clinic: { select: { timezone: true } } },
    });
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    // Tentativa que ficou "sending" (o processo caiu depois de marcar a tentativa): o provedor PODE ter sido chamado => incerto, nunca reenvia as cegas.
    await prisma.postProcedureSent.updateMany({ where: { state: "sending", attemptedAt: { lt: new Date(clock().getTime() - POST_STALE_MS) } }, data: { state: "unconfirmed", finalAt: clock(), note: "o processo parou durante o envio: pode ter sido entregue, nao reenviado" } });
    for (const rule of rules) rec(rule.clinicId); // uma linha por clinica com regra ativa, mesmo sem candidatos: prova que o job rodou
    for (const rule of rules) {
      const now = clock();
      const r = rec(rule.clinicId);
      // Cuidados pos-procedimento nao saem de noite/madrugada: espera ate as 7h (o que ficou pendente sai no 1o ciclo da manha;
      // a folga de 3 dias da regra cobre a espera).
      const localHour = wallClockInZone(now, rule.clinic.timezone || "America/Sao_Paulo").hour;
      const gate = postHourGate(rule, localHour);
      if (!gate.allowed) { r.add("ignorado", "fora_do_horario_de_envio_7h_21h"); continue; }
      const cutoff = new Date(now.getTime() - intervalMs(rule.intervalValue, rule.intervalUnit));
      const floor = new Date(cutoff.getTime() - MAX_OVERDUE_MS);
      const procedureFilter = rule.procedureIds.split(",").filter(Boolean);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          // EVIDENCIA DE REALIZACAO (22/10): so atendimento com status "completed" (conclusao registrada no painel/pelo CE). "Nao cancelou nem faltou" NAO prova que o procedimento aconteceu, e o pos
          // diz/pressupoe que aconteceu ("como foi o seu procedimento?"). Regra com onlyIfCompleted=false nao abre excecao: os agendamentos que ela alcancaria sem conclusao sao CONTADOS no resumo da rodada
          // ("sem_evidencia_de_realizacao") para a equipe marcar o atendimento como concluido - nunca enviados por suposicao.
          status: "completed",
          scheduledAt: { lte: cutoff, gte: floor },
          // reserva com varios procedimentos: vale se QUALQUER um deles esta no filtro da regra
          ...(procedureFilter.length ? { OR: [{ procedureId: { in: procedureFilter } }, { procedures: { some: { procedureId: { in: procedureFilter } } } }] } : {}),
          procedure: { name: { not: PLACEHOLDER_PROCEDURE_NAME } }, // "horario sem procedimento" (reserva do CE sem procedimento) nao tem o que acompanhar
          postProcedureSent: { none: { ruleId: rule.id, state: { in: POST_FINAL_STATES } } }, // etapa FECHADA nao reabre; "retry"/"reserved" velho voltam a ser candidatos
          patient: {
            optedOut: false, // quem pediu pra parar nao recebe mensagem automatica
            // Relatou reacao ao procedimento (a Alice transferiu pra equipe como "REAÇÃO"): o fluxo automatico para.
            conversations: { none: { handoffReason: { startsWith: "REAÇÃO" }, lastMessageAt: { gte: new Date(now.getTime() - 7 * 24 * 3_600_000) } } },
          },
        },
        include: { patient: true, attendee: true, procedure: true, procedures: true, professional: true },
        take: MAX_PER_TICK * 4, // margem: as avaliacoes saem no filtro abaixo e nao podem esgotar o teto
      });
      if (!rule.onlyIfCompleted) {
        const noEvidence = await prisma.appointment.count({
          where: { clinicId: rule.clinicId, status: "confirmed", scheduledAt: { lte: cutoff, gte: floor }, ...(procedureFilter.length ? { OR: [{ procedureId: { in: procedureFilter } }, { procedures: { some: { procedureId: { in: procedureFilter } } } }] } : {}), postProcedureSent: { none: { ruleId: rule.id, state: { in: POST_FINAL_STATES } } } },
        });
        for (let i = 0; i < noEvidence; i++) r.add("ignorado", "sem_evidencia_de_realizacao");
      }
      for (let i = due.length - 1; i >= 0; i--) {
        if (skipsPostForEvaluation(due[i], procedureFilter)) due.splice(i, 1);
      }
      due.splice(MAX_PER_TICK);
      // Regra em HORAS conta a partir do FIM do atendimento (inicio + duracao): "1h depois" nao pode chegar com a
      // paciente ainda na cadeira (criolipolise e outros passam de 1h).
      if (rule.intervalUnit === "hours") {
        for (let i = due.length - 1; i >= 0; i--) {
          if (!appointmentEndedBy(due[i], cutoff)) due.splice(i, 1);
        }
      }

      // Depois do fechamento (autorizacao propria da regra): so quem venceu ha pouco. O que ja estava acumulado espera a manha, como sempre foi.
      if (gate.afterHours) {
        const before = due.length;
        for (let i = due.length - 1; i >= 0; i--) if (!postFreshEnough(postDueAt(rule, due[i]), now)) due.splice(i, 1);
        for (let i = before - due.length; i > 0; i--) r.add("ignorado", "apos_fechamento_so_o_que_venceu_ha_pouco");
      }

      if (due.length === 0) continue;
      r.candidates += due.length;
      r.eligible += due.length;

      if (!clinicInfoCache.has(rule.clinicId)) {
        clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
      }
      const clinicInfo = clinicInfoCache.get(rule.clinicId)!;

      for (const appt of due) {
        const text = renderMessageTemplate(rule.message, {
          patientName: appt.attendee?.name ?? appt.patient.name, // quem foi ATENDIDO
          patientPhone: appt.patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
          procedureName: postProcedureNameFor(appt, procedureFilter),
          professionalName: appt.professional?.name,
          when: appt.scheduledAt,
        });

        // RESERVA/REIVINDICACAO atomica, com estado: a linha so vira "sent" quando o provedor aceitou. Linha nova => reserva; "retry" ou "reserved" velha (o processo caiu ANTES de
        // chamar o provedor) => reivindica de novo; "sending" recente => outra rodada esta enviando; qualquer estado final => nao reabre.
        const claimed = await claimPostStep(appt.id, rule.id, now);
        if (!claimed) continue;
        let started = false;
        try {
          const outcome = await sendText(appt.clinicId, appt.patient.phone, text, {
            kind: "pos",
            // IMEDIATAMENTE antes de o provedor ser chamado: a tentativa passa a constar ("reserved" prova que o provedor nao foi chamado).
            beforeProvider: async () => {
              const c = await prisma.postProcedureSent.updateMany({ where: { id: claimed.id, state: "reserved" }, data: { state: "sending", attemptedAt: now, attempts: { increment: 1 } } });
              if (c.count !== 1) throw new Error("pos: outra rodada ja cuida desta etapa");
              started = true;
            },
          });
          if (outcome === "sent") { await finishPostStep(claimed.id, "sent", gate.afterHours ? "enviada depois do fechamento (autorizado pela regra)" : "enviada", now); await recordAutomatedMessage(appt.patientId, text, rule.name || "Pós-procedimento automático"); r.add("enviado", "pos"); }
          // barrado pela revisao / plano / identica: a decisao e definitiva para este atendimento (estado final) e o resumo da rodada registra, nao como envio
          else if (outcome === "vetoed") { await finishPostStep(claimed.id, "vetoed", "revisao por IA barrou a mensagem (motivo no Diario de atividades)", now); r.add("vetado", "revisao_de_envio_barrou"); }
          else if (outcome === "blocked") { await finishPostStep(claimed.id, "blocked", "envio automatico bloqueado para esta clinica (plano)", now); r.add("ignorado", "envio_bloqueado_pelo_plano"); }
          else { await finishPostStep(claimed.id, "duplicate", "mensagem identica ja enviada a esta pessoa", now); r.add("ignorado", "mensagem_identica_ja_enviada"); }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("pos: outra rodada")) { r.add("ignorado", "outra_rodada_cuida"); continue; }
          if (isAmbiguousSendError(err)) {
            // timeout depois de enviar: PODE ter chegado. A etapa fica "unconfirmed" e NUNCA reenvia as cegas (antes devolvia a reserva e podia mandar em dobro).
            await finishPostStep(claimed.id, "unconfirmed", "tempo esgotado no provedor: pode ter sido entregue, nao reenviado", now);
            r.add("incerto", "envio_nao_confirmado");
            continue;
          }
          if (isPermanentSendError(err)) {
            await finishPostStep(claimed.id, "failed_permanent", "numero sem WhatsApp", now);
            r.add("falha", "numero_sem_whatsapp");
            // Numero sem WhatsApp: etapa fechada (nao tenta de novo a cada 15 min) e avisa a equipe uma vez.
            console.error(`Pos-procedimento nao enviado: ${appt.patient.phone} nao tem WhatsApp.`);
            await notifyStaff(appt.clinicId, "automation_failed", `⚠️ O número de ${appt.patient.name ?? appt.patient.phone} (${appt.patient.phone}) não tem WhatsApp, então a mensagem de acompanhamento ("${rule.name}") não foi enviada. Confira o telefone no cadastro.`);
            continue;
          }
          if (isSendDeferred(err)) {
            // WhatsApp fora / revisao fora: nada saiu e nao e falha da pessoa. A etapa volta para "retry" SEM gastar tentativa; o aviso e unico (Diario + Canais).
            await prisma.postProcedureSent.updateMany({ where: { id: claimed.id, state: { in: ["reserved", "sending"] } }, data: { state: "retry", note: deferralInfo(err).tag, ...(started ? { attempts: { decrement: 1 } } : {}) } });
            r.add("adiado", deferralInfo(err).tag);
            console.warn(`[pos] adiado para ...${appt.patient.phone.slice(-4)} (${msg})`);
            continue;
          }
          // erro DEFINITIVO antes de sair (provedor recusou / rede caiu antes da resposta): volta para nova tentativa, com teto
          const cur = await prisma.postProcedureSent.findUnique({ where: { id: claimed.id }, select: { attempts: true } });
          const attempts = (cur?.attempts ?? 0) + (started ? 0 : 1);
          const exhausted = attempts >= POST_MAX_ATTEMPTS;
          await prisma.postProcedureSent.updateMany({ where: { id: claimed.id, state: { in: ["reserved", "sending"] } }, data: { state: exhausted ? "failed_permanent" : "retry", attempts, note: `falha no envio: ${msg.slice(0, 120)}`, finalAt: exhausted ? now : null } });
          r.add("falha", exhausted ? "envio_falhou_tentativas_esgotadas" : "envio_falhou_tentara_de_novo");
          console.error(`Falha ao enviar pos-procedimento (regra ${rule.id}) para ${appt.patient.phone}:`, err);
          // Sem isso a falha so aparecia no log do servidor. Avisa na primeira falha e quando as tentativas se esgotam (nao a cada ciclo de 15 min).
          if (attempts === 1 || exhausted) {
            await notifyStaff(
              appt.clinicId,
              "automation_failed",
              exhausted
                ? `⚠️ Não consegui enviar a mensagem automática de acompanhamento ("${rule.name}") para ${appt.patient.name ?? appt.patient.phone} (${appt.patient.phone}) depois de várias tentativas. Confira a conexão do WhatsApp e o contato.`
                : `⚠️ Falha ao enviar mensagem automática de acompanhamento ("${rule.name}") para ${appt.patient.name ?? appt.patient.phone} (${appt.patient.phone}). O sistema vai tentar novamente, mas convém checar a conexão do WhatsApp.`,
            );
          }
        }
      }
    }
    } catch (err) {
      failure = err;
      console.error("[pos-procedimento] a rodada falhou:", err instanceof Error ? err.message : err);
    } finally {
      for (const r of recorders.values()) await r.save(failure ? "erro" : "ok", failure ?? undefined);
    }
  }
}

export function startPostProcedureJob(): void {
  scheduleLocked("pos-procedimento", "*/15 * * * *", async () => { await runPostProcedureCycle(); });
}
