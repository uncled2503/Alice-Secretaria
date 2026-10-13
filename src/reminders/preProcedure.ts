import { prisma } from "../db/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";

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
