import { prisma } from "../db/client.js";
import { normName } from "../maintenance/applyLisboaServicos.js";
import { disconnectAccount } from "./client.js";
import { invalidateCeCache } from "./availability.js";

// ---------------------------------------------------------------------------
// A conexao com o Clinica Experts foi feita na clinica ERRADA (Dra. Tatiana) e trouxe o
// catalogo e a agenda da Lisboa. Esta acao COMPARA as duas clinicas e remove da clinica de
// origem o que e COPIA do que a clinica de referencia tem:
//   - procedimento: mesmo nome (ou mesmo codigo do Clinica Experts) E mesmo preco E mesma
//     duracao, sem nenhuma personalizacao e sem agendamentos proprios;
//   - profissional: mesmo codigo do Clinica Experts (ou mesmo nome) e sem agendamentos proprios;
//   - paciente: sem nenhuma conversa e com o mesmo codigo do Clinica Experts (ou mesmo telefone
//     de um paciente importado) da referencia;
//   - agendamento: mesmo codigo de agendamento da referencia, ou de paciente copiado.
// O que tem o mesmo nome mas e diferente (preco, duracao, descricao...) FICA, e e listado.
// ---------------------------------------------------------------------------

export interface CopyItem { name: string; reason?: string }
export interface RemoveCopiesResult {
  dryRun: boolean;
  fromClinic: string;
  referenceClinic: string;
  procedures: { delete: CopyItem[]; keep: CopyItem[] };
  professionals: { delete: CopyItem[]; keep: CopyItem[] };
  patientsDeleted: number;
  appointmentsDeleted: number;
  unlinked: number;
  failures: string[];
}

const sameNumber = (a: number | null, b: number | null) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);

export async function removeCopiesOfClinic(fromId: string, referenceId: string, opts: { dryRun: boolean }): Promise<RemoveCopiesResult> {
  if (fromId === referenceId) throw new Error("A clinica de origem e a de referencia sao a mesma.");
  const [from, ref] = await Promise.all([
    prisma.clinic.findUniqueOrThrow({ where: { id: fromId }, select: { name: true } }),
    prisma.clinic.findUniqueOrThrow({ where: { id: referenceId }, select: { name: true } }),
  ]);
  const result: RemoveCopiesResult = {
    dryRun: opts.dryRun,
    fromClinic: from.name,
    referenceClinic: ref.name,
    procedures: { delete: [], keep: [] },
    professionals: { delete: [], keep: [] },
    patientsDeleted: 0,
    appointmentsDeleted: 0,
    unlinked: 0,
    failures: [],
  };

  const [refProcs, refPros, refPatients, refBookings, procs, pros, patients, appts] = await Promise.all([
    prisma.procedure.findMany({ where: { clinicId: referenceId } }),
    prisma.professional.findMany({ where: { clinicId: referenceId }, select: { name: true, ceUuid: true } }),
    prisma.patient.findMany({ where: { clinicId: referenceId }, select: { phone: true, ceUuid: true } }),
    prisma.appointment.findMany({ where: { clinicId: referenceId, ceBookingUuid: { not: null } }, select: { ceBookingUuid: true } }),
    prisma.procedure.findMany({ where: { clinicId: fromId }, include: { appointments: { select: { id: true } }, photos: { select: { id: true } } } }),
    prisma.professional.findMany({ where: { clinicId: fromId }, include: { appointments: { select: { id: true } } } }),
    prisma.patient.findMany({ where: { clinicId: fromId }, select: { id: true, phone: true, ceUuid: true, _count: { select: { conversations: true } } } }),
    prisma.appointment.findMany({ where: { clinicId: fromId }, select: { id: true, patientId: true, ceBookingUuid: true } }),
  ]);

  // ---- pacientes e agendamentos copiados ----
  const refPatientUuids = new Set(refPatients.map((p) => p.ceUuid).filter((x): x is string => !!x));
  const refPatientPhones = new Set(refPatients.filter((p) => p.ceUuid).map((p) => p.phone));
  const refBookingUuids = new Set(refBookings.map((b) => b.ceBookingUuid as string));
  const junkPatients = patients.filter(
    (p) => p._count.conversations === 0 && ((p.ceUuid != null && refPatientUuids.has(p.ceUuid)) || (p.ceUuid != null && refPatientPhones.has(p.phone))),
  );
  const junkPatientSet = new Set(junkPatients.map((p) => p.id));
  const junkAppts = appts.filter((a) => (a.ceBookingUuid != null && refBookingUuids.has(a.ceBookingUuid)) || junkPatientSet.has(a.patientId));
  const junkApptSet = new Set(junkAppts.map((a) => a.id));
  // Paciente copiado que tem agendamento "de verdade" (nao copiado) fica.
  const keptPatients = new Set(appts.filter((a) => !junkApptSet.has(a.id)).map((a) => a.patientId));
  const patientIdsToDelete = junkPatients.filter((p) => !keptPatients.has(p.id)).map((p) => p.id);
  const deletePatientSet = new Set(patientIdsToDelete);
  const apptIdsToDelete = junkAppts.filter((a) => deletePatientSet.has(a.patientId) || (a.ceBookingUuid != null && refBookingUuids.has(a.ceBookingUuid))).map((a) => a.id);
  const apptDeleteSet = new Set(apptIdsToDelete);
  result.patientsDeleted = patientIdsToDelete.length;
  result.appointmentsDeleted = apptIdsToDelete.length;

  // ---- procedimentos ----
  const procIdsToDelete: string[] = [];
  for (const p of procs) {
    const candidates = refProcs.filter((r) => (p.ceId != null && r.ceId === p.ceId) || normName(r.name) === normName(p.name));
    if (!candidates.length) continue; // nao existe na referencia: e da propria clinica
    const equal = candidates.some((r) => sameNumber(r.price, p.price) && r.durationMin === p.durationMin && r.priceVariable === p.priceVariable);
    const raw =
      p.photos.length === 0 && !p.goals && !p.benefits && !p.resultTimeline && !p.paymentLink && !p.pixKey && p.paymentMethods === "" &&
      !p.allowConcurrentBooking && !p.offerInstallments && (!p.description || /^Avalia/i.test(p.description));
    if (p.appointments.some((a) => !apptDeleteSet.has(a.id))) result.procedures.keep.push({ name: p.name, reason: "tem agendamentos próprios" });
    else if (!equal) result.procedures.keep.push({ name: p.name, reason: "mesmo nome, mas preço ou duração diferentes" });
    else if (!raw) result.procedures.keep.push({ name: p.name, reason: "já foi personalizado" });
    else {
      result.procedures.delete.push({ name: p.name });
      procIdsToDelete.push(p.id);
    }
  }

  // ---- profissionais ----
  const refUuids = new Set(refPros.map((r) => r.ceUuid).filter((x): x is string => !!x));
  const refProNames = new Set(refPros.map((r) => normName(r.name)));
  const proIdsToDelete: string[] = [];
  for (const p of pros) {
    const matches = (p.ceUuid != null && refUuids.has(p.ceUuid)) || refProNames.has(normName(p.name));
    if (!matches) continue;
    if (p.appointments.some((a) => !apptDeleteSet.has(a.id))) result.professionals.keep.push({ name: p.name, reason: "tem agendamentos próprios" });
    else {
      result.professionals.delete.push({ name: p.name });
      proIdsToDelete.push(p.id);
    }
  }

  if (opts.dryRun) return result;

  if (apptIdsToDelete.length) {
    await prisma.reminderSent.deleteMany({ where: { appointmentId: { in: apptIdsToDelete } } });
    await prisma.postProcedureSent.deleteMany({ where: { appointmentId: { in: apptIdsToDelete } } });
    await prisma.renewalSent.deleteMany({ where: { appointmentId: { in: apptIdsToDelete } } });
    await prisma.appointment.deleteMany({ where: { id: { in: apptIdsToDelete } } });
  }
  for (const id of patientIdsToDelete) {
    try { await prisma.patient.delete({ where: { id } }); } catch (err) { result.patientsDeleted--; result.failures.push(`paciente ${id}: ${(err as Error).message.slice(0, 100)}`); }
  }
  for (const id of procIdsToDelete) {
    try { await prisma.procedure.delete({ where: { id } }); } catch (err) { result.failures.push(`procedimento ${id}: ${(err as Error).message.slice(0, 100)}`); }
  }
  for (const id of proIdsToDelete) {
    try { await prisma.professional.delete({ where: { id } }); } catch (err) { result.failures.push(`profissional ${id}: ${(err as Error).message.slice(0, 100)}`); }
  }
  // O que sobrou nao usa o Clinica Experts: solta os vinculos.
  const a = await prisma.procedure.updateMany({ where: { clinicId: fromId, ceId: { not: null } }, data: { ceId: null } });
  const b = await prisma.professional.updateMany({ where: { clinicId: fromId, ceUuid: { not: null } }, data: { ceUuid: null } });
  await prisma.patient.updateMany({ where: { clinicId: fromId, ceUuid: { not: null } }, data: { ceUuid: null } });
  await prisma.appointment.updateMany({ where: { clinicId: fromId, ceBookingUuid: { not: null } }, data: { ceBookingUuid: null } });
  result.unlinked = a.count + b.count;
  // A conexao estava na clinica errada: desconecta pra a importacao nao trazer tudo de novo.
  await disconnectAccount(fromId);
  invalidateCeCache(fromId);
  return result;
}
