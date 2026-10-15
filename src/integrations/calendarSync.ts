import { pushAppointmentInBackground as pushToGoogle, removeAppointmentInBackground as removeFromGoogle } from "../google/calendar.js";
import { syncAppointmentInBackground as syncToClinicaExperts } from "../clinicaexperts/sync.js";
import { prisma } from "../db/client.js";
import { syncLeadTagsInBackground } from "../ads/tags.js";

// A etiqueta "Agendamento Realizado" acompanha o agendamento, de quem for (Alice, painel, API, importacao).
function refreshLeadTags(appointmentId: string): void {
  void prisma.appointment
    .findUnique({ where: { id: appointmentId }, select: { clinicId: true, patientId: true } })
    .then((a) => { if (a) syncLeadTagsInBackground(a.clinicId, a.patientId); })
    .catch(() => {});
}

// Ponto unico por onde um agendamento da Alice e espelhado nos sistemas de
// agenda externos da clinica (Google Agenda e/ou Clinica Experts). Cada um
// decide sozinho se esta conectado; aqui so dispara os dois.
// Criar, remarcar e cancelar passam por aqui: o Clinica Experts le o status do
// agendamento (confirmed/cancelled) pra saber o que fazer.

export function pushAppointmentInBackground(appointmentId: string): void {
  pushToGoogle(appointmentId);
  syncToClinicaExperts(appointmentId);
  refreshLeadTags(appointmentId);
}

// So o Google Agenda (o Clinica Experts ja foi espelhado, e conferido, antes: ver book_appointment em ai/alice.ts).
export function pushGoogleInBackground(appointmentId: string): void {
  pushToGoogle(appointmentId);
  refreshLeadTags(appointmentId);
}

export function removeAppointmentInBackground(appointmentId: string): void {
  removeFromGoogle(appointmentId);
  syncToClinicaExperts(appointmentId);
  refreshLeadTags(appointmentId);
}
