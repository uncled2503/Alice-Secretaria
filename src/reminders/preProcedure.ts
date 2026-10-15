import { prisma } from "../db/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { scheduleLocked } from "../jobs/lock.js";
import { sendText, isPermanentSendError } from "../uazapi/client.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { notifyStaff } from "../crm/notify.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { isoDateInZone, wallClockInZone } from "../scheduling/time.js";

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
  return text.replace(/,\s*([!.?])/g, "$1");
}

// PURO: a regra vale pra esse procedimento? (procedureIds vazio = todos)
export function ruleCoversProcedure(procedureIds: string, procedureId: string): boolean {
  const ids = procedureIds.split(",").filter(Boolean);
  return ids.length === 0 || ids.includes(procedureId);
}

interface ConfirmedAppointment {
  id: string;
  clinicId: string;
  scheduledAt: Date;
  procedureId: string;
  procedure: { name: string };
  professional?: { name: string } | null;
  patient: { name: string | null; phone: string };
}

// Texto de preparo dos agendamentos que a cliente acabou de confirmar (ordem do dia). Reserva cada envio (agendamento+regra)
// antes de devolver o texto: confirmar de novo nao reenvia. null = nenhuma regra se aplica (ou ja foi enviada).
export async function buildPreProcedureText(appts: ConfirmedAppointment[]): Promise<string | null> {
  if (!appts.length) return null;
  const clinicId = appts[0].clinicId;
  const rules = await prisma.preProcedureRule.findMany({ where: { clinicId, active: true }, orderBy: { createdAt: "asc" } });
  if (!rules.length) return null;
  const already = await prisma.preProcedureSent.findMany({
    where: { appointmentId: { in: appts.map((a) => a.id) } },
    select: { appointmentId: true, ruleId: true },
  });
  const sentKeys = new Set(already.map((s) => `${s.appointmentId}|${s.ruleId}`));
  const alreadyRule = new Set(already.map((s) => s.ruleId)); // a mesma regra ja enviada pra outro horario do dia nao repete
  const info = await getClinicTemplateInfo(clinicId);

  const texts: string[] = [];
  const usedRules = new Set<string>();
  for (const appt of [...appts].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())) {
    for (const rule of rules) {
      if (usedRules.has(rule.id) || alreadyRule.has(rule.id) || sentKeys.has(`${appt.id}|${rule.id}`)) continue;
      if (!ruleCoversProcedure(rule.procedureIds, appt.procedureId)) continue;
      try {
        await prisma.preProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } }); // reserva atomica
      } catch {
        continue; // outra confirmacao simultanea ja pegou
      }
      usedRules.add(rule.id);
      texts.push(
        tidyGreeting(
          renderMessageTemplate(rule.message, {
            patientName: appt.patient.name,
            patientPhone: appt.patient.phone,
            clinicName: info.name,
            locationName: info.primaryLocation?.name,
            locationAddress: info.primaryLocation?.fullAddress,
            procedureName: appt.procedure.name,
            professionalName: appt.professional?.name,
            when: appt.scheduledAt,
          }),
        ),
      );
    }
  }
  return texts.length ? combinePreProcedureTexts(texts) : null;
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

export async function sendAdvancePreProcedure(now: Date = new Date()): Promise<number> {
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
    const hour = wallClockInZone(now, tz).hour;
    if (hour < PRE_SEND_FROM_HOUR || hour >= PRE_SEND_UNTIL_HOUR) continue;
    const widest = Math.max(...clinicRules.map((r) => r.sendHoursBefore ?? 0));
    const candidates = await prisma.appointment.findMany({
      where: {
        clinicId,
        status: "confirmed",
        scheduledAt: { gte: new Date(now.getTime() + PRE_MIN_LEAD_MS), lte: new Date(now.getTime() + widest * 3_600_000) },
        patient: { optedOut: false },
      },
      include: { patient: true, procedure: true, professional: true },
      orderBy: { scheduledAt: "asc" },
      take: 400,
    });
    if (!candidates.length) continue;
    const sentRows = await prisma.preProcedureSent.findMany({ where: { appointmentId: { in: candidates.map((a) => a.id) } }, select: { appointmentId: true, ruleId: true } });
    const sentKeys = new Set(sentRows.map((s) => `${s.appointmentId}|${s.ruleId}`));
    const info = await getClinicTemplateInfo(clinicId);

    // Um texto por paciente e por dia (varios procedimentos no mesmo dia viram uma mensagem so).
    const groups = new Map<string, typeof candidates>();
    for (const a of candidates) {
      const key = `${a.patientId}|${isoDateInZone(a.scheduledAt, tz)}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }

    for (const appts of groups.values()) {
      if (sentPatients >= PRE_MAX_PATIENTS_PER_TICK) return sentPatients;
      const patient = appts[0].patient;
      const reserved: { appointmentId: string; ruleId: string }[] = [];
      const texts: string[] = [];
      const usedRules = new Set<string>();
      for (const appt of appts) {
        for (const rule of clinicRules) {
          if (usedRules.has(rule.id) || sentKeys.has(`${appt.id}|${rule.id}`)) continue;
          if (!isPreProcedureDue(appt.scheduledAt, now, rule.sendHoursBefore ?? 0)) continue;
          if (!ruleCoversProcedure(rule.procedureIds, appt.procedureId)) continue;
          try {
            await prisma.preProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } }); // reserva atomica
          } catch {
            continue;
          }
          reserved.push({ appointmentId: appt.id, ruleId: rule.id });
          usedRules.add(rule.id);
          texts.push(
            renderMessageTemplate(texts.length === 0 ? toAdvanceIntro(rule.message) : rule.message, {
              patientName: patient.name,
              patientPhone: patient.phone,
              clinicName: info.name,
              locationName: info.primaryLocation?.name,
              locationAddress: info.primaryLocation?.fullAddress,
              procedureName: appt.procedure.name,
              professionalName: appt.professional?.name,
              when: appt.scheduledAt,
            }),
          );
        }
      }
      if (!texts.length) continue;
      const text = tidyGreeting(combinePreProcedureTexts(texts));
      try {
        const outcome = await sendText(clinicId, patient.phone, text);
        if (outcome === "sent") await recordAutomatedMessage(patient.id, text, "Preparo da visita (48h antes)");
        sentPatients++;
      } catch (err) {
        if (isPermanentSendError(err)) {
          // Numero sem WhatsApp: mantem a reserva (nao tenta de novo a cada 15 min) e avisa a equipe uma vez.
          await notifyStaff(clinicId, "automation_failed", `⚠️ O número de ${patient.name ?? patient.phone} (${patient.phone}) não tem WhatsApp, então as orientações de preparo não foram enviadas.`);
          continue;
        }
        for (const r of reserved) await prisma.preProcedureSent.deleteMany({ where: r }); // devolve a reserva: tenta no proximo ciclo
        console.error(`[pre-procedimento] falha ao enviar para ${patient.phone}:`, err);
      }
    }
  }
  return sentPatients;
}

export function startPreProcedureJob(): void {
  scheduleLocked("pre-procedimento", "*/15 * * * *", async () => {
    await sendAdvancePreProcedure();
  });
}
