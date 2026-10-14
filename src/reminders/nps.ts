import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { FREE_PLAN } from "../crm/plan.js";
import { isWithinClinicHours } from "../crm/openHours.js";

const MAX_PER_TICK = 10; // por clinica a cada rodada (15 min)

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
          const outcome = await sendText(clinic.id, appt.patient.phone, text);
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
