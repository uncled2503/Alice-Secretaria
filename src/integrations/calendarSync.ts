import { pushAppointmentInBackground as pushToGoogle, removeAppointmentInBackground as removeFromGoogle } from "../google/calendar.js";
import { syncAppointmentInBackground as syncToClinicaExperts } from "../clinicaexperts/sync.js";

// Ponto unico por onde um agendamento da Alice e espelhado nos sistemas de
// agenda externos da clinica (Google Agenda e/ou Clinica Experts). Cada um
// decide sozinho se esta conectado; aqui so dispara os dois.
// Criar, remarcar e cancelar passam por aqui: o Clinica Experts le o status do
// agendamento (confirmed/cancelled) pra saber o que fazer.

export function pushAppointmentInBackground(appointmentId: string): void {
  pushToGoogle(appointmentId);
  syncToClinicaExperts(appointmentId);
}

// So o Google Agenda (o Clinica Experts ja foi espelhado, e conferido, antes: ver book_appointment em ai/alice.ts).
export function pushGoogleInBackground(appointmentId: string): void {
  pushToGoogle(appointmentId);
}

export function removeAppointmentInBackground(appointmentId: string): void {
  removeFromGoogle(appointmentId);
  syncToClinicaExperts(appointmentId);
}
