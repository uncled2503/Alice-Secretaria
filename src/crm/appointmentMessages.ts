import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { formatInZone } from "../scheduling/time.js";

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
export async function sendAppointmentConfirmationToPatient(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, procedure: true, professional: true, clinic: true },
  });
  if (!appt) return;

  const firstName = appt.patient.name?.trim().split(" ")[0] || "";
  const tz = appt.clinic.timezone || "America/Sao_Paulo";
  const when = formatInZone(appt.scheduledAt, tz);
  // Alguns procedimentos ja tem o nome do profissional no proprio nome (ex.:
  // "Experiência Clínica Presencial com Dr. Saulo Silva") - so repete o
  // "com {profissional}" quando esse nome ainda nao aparece no procedimento.
  const professionalName = appt.professional?.name ?? null;
  const withWho = professionalName && !appt.procedure.name.includes(professionalName) ? `, com ${professionalName},` : "";

  const text = `Oi${firstName ? `, ${firstName}` : ""}! Confirmando seu horário: ${appt.procedure.name}${withWho} em ${when}.`;

  try {
    await sendText(appt.clinicId, appt.patient.phone, text);
  } catch (err) {
    console.error(`Falha ao enviar confirmação de agendamento para ${appt.patient.phone}:`, err);
  }
}
