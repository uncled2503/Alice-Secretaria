import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { FREE_PLAN } from "../crm/plan.js";
import { isWithinClinicHours } from "../crm/openHours.js";

const MAX_PER_TICK = 10; // por clinica a cada rodada (15 min)
export const NPS_AFTER_POST_MS = 4 * 3_600_000; // a pesquisa espera pelo menos 4h depois de uma mensagem de pos-procedimento

// PURO: o pos-procedimento desta regra AINDA vai sair (ou acabou de sair) para este atendimento? Entao a pesquisa espera. Avaliacao nao recebe pos.
export function postStillComing(
  appt: { scheduledAt: Date; procedureId: string; procedure: { name: string } },
  rules: { intervalValue: number; intervalUnit: string; procedureIds: string }[],
  sentCount: number,
  now: number,
): boolean {
  if (/avalia/i.test(appt.procedure.name) || sentCount > 0) return false;
  const elapsed = now - appt.scheduledAt.getTime();
  return rules.some((r) => {
    const filter = r.procedureIds.split(",").filter(Boolean);
    if (filter.length && !filter.includes(appt.procedureId)) return false;
    const at = r.intervalUnit === "hours" ? r.intervalValue * 3_600_000 : r.intervalValue * 86_400_000;
    return at <= elapsed + 3_600_000 && elapsed <= at + 3 * 86_400_000; // vence ate 1h daqui e ainda esta dentro da folga de envio do pos
  });
}

const DEFAULT_MESSAGE =
  "Oi {primeiro_nome}! Passando so pra saber como foi sua experiencia com a gente. Numa escala de 0 a 10, o quanto voce recomendaria a {unidade} pra um amigo?";

// Roda a cada 15 min. Para cada atendimento CONCLUIDO ha "npsHoursAfter" horas
// (e no maximo 5 dias atras), se a clinica tem NPS ligado e ainda nao pesquisou
// aquele agendamento, manda a pergunta e cria o registro. A nota chega pela
// conversa e a Alice grava com a ferramenta record_satisfaction.
export function startNpsJob(): void {
  scheduleLocked("pesquisa-satisfacao", "*/15 * * * *", async () => {
    const clinics = await prisma.clinic.findMany({
      where: { npsEnabled: true, plan: { not: FREE_PLAN } },
      select: { id: true, npsHoursAfter: true, npsMessage: true, npsEvaluationMessage: true, name: true, timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true },
    });

    for (const clinic of clinics) {
      // So pergunta dentro do expediente da clinica (antes mandava de madrugada).
      if (!isWithinClinicHours(clinic, new Date())) continue;
      const now = Date.now();
      const cutoff = new Date(now - clinic.npsHoursAfter * 3_600_000);
      const floor = new Date(now - 5 * 24 * 3_600_000);

      // Ja perguntados ficam de fora da consulta (senao o teto por rodada seria gasto com eles).
      const surveyed = await prisma.satisfactionSurvey.findMany({
        where: { clinicId: clinic.id, appointmentId: { not: null }, askedAt: { gte: floor } },
        select: { appointmentId: true },
      });
      const surveyedIds = surveyed.map((s) => s.appointmentId as string);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: clinic.id,
          ...(surveyedIds.length ? { id: { notIn: surveyedIds } } : {}),
          status: "completed",
          scheduledAt: { lte: cutoff, gte: floor },
          patient: { optedOut: false },
        },
        include: { patient: true, procedure: { select: { name: true } } },
        orderBy: { scheduledAt: "asc" },
        take: MAX_PER_TICK, // ligar o NPS pela 1a vez nao dispara os ultimos 5 dias de uma vez: o resto sai nas proximas rodadas
      });
      if (due.length === 0) continue;

      // Quem recebeu mensagem de pos-procedimento nas ultimas horas espera: pesquisa e acompanhamento no mesmo minuto parecem robo.
      const recentPost = await prisma.postProcedureSent.findMany({
        where: { sentAt: { gte: new Date(now - NPS_AFTER_POST_MS) }, appointment: { patientId: { in: due.map((d) => d.patientId) } } },
        select: { appointment: { select: { patientId: true } } },
      });
      const waitingPost = new Set(recentPost.map((r) => r.appointment.patientId));
      const postRules = await prisma.postProcedureRule.findMany({ where: { clinicId: clinic.id, active: true }, select: { intervalValue: true, intervalUnit: true, procedureIds: true } });
      const postSent = postRules.length
        ? await prisma.postProcedureSent.groupBy({ by: ["appointmentId"], where: { appointmentId: { in: due.map((d) => d.id) } }, _count: { _all: true } })
        : [];
      const postSentBy = new Map(postSent.map((s) => [s.appointmentId, s._count._all]));
      const ready = due.filter((d) => !waitingPost.has(d.patientId) && !postStillComing(d, postRules, postSentBy.get(d.id) ?? 0, now));
      if (ready.length === 0) continue;
      due.splice(0, due.length, ...ready);

      const info = await getClinicTemplateInfo(clinic.id);

      for (const appt of due) {
        const already = await prisma.satisfactionSurvey.findFirst({
          where: { clinicId: clinic.id, patientId: appt.patientId, appointmentId: appt.id },
        });
        if (already) continue;

        const firstName = appt.patient.name?.trim().split(" ")[0] || "";
        const isEvaluation = /avalia/i.test(appt.procedure.name);
        const text = ((isEvaluation && clinic.npsEvaluationMessage?.trim()) || clinic.npsMessage?.trim() || DEFAULT_MESSAGE)
          .replace(/\{primeiro_nome\}/gi, firstName)
          .replace(/\{nome\}/gi, firstName)
          .replace(/\{unidade\}/gi, info.primaryLocation?.name || info.name)
          .replace(/\{clinica\}/gi, info.name)
          .trim();

        try {
          const outcome = await sendText(clinic.id, appt.patient.phone, text, { kind: "pesquisa" });
          if (outcome !== "sent") continue;
        } catch (err) {
          console.error(`NPS: falha ao enviar para ${appt.patient.phone}:`, err);
          continue;
        }

        await prisma.satisfactionSurvey.create({
          data: { clinicId: clinic.id, patientId: appt.patientId, appointmentId: appt.id, askedAt: new Date() },
        });

        // Deixa a pergunta na conversa pra Alice ter contexto quando o paciente responder.
        let conv = await prisma.conversation.findFirst({
          where: { patientId: appt.patientId, status: { in: ["active", "qualified", "scheduled"] } },
          orderBy: { createdAt: "desc" },
        });
        if (!conv) conv = await prisma.conversation.create({ data: { patientId: appt.patientId } });
        await prisma.message.create({
          data: { conversationId: conv.id, role: "assistant", content: text, authorName: "Pesquisa de satisfação" },
        });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { status: "active", lastMessageAt: new Date(), lastFollowUpOrder: 0 },
        });
      }
    }
  });
}
