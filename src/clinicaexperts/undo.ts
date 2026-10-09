import { prisma } from "../db/client.js";
import { ceRequest, disconnectAccount } from "./client.js";
import { invalidateCeCache } from "./availability.js";

// ---------------------------------------------------------------------------
// "Desfazer importacao": limpa o que a conexao com o Clinica Experts trouxe
// quando ela foi feita na clinica ERRADA. Tudo que foi CRIADO depois da conexao
// (createdAt >= since) por importacao some; o que a clinica ja tinha antes so
// perde o vinculo (ceId/ceUuid). No fim, desconecta.
//
// Nunca apaga: paciente com conversa, agendamento da Alice (so cancela o
// espelho no Clinica Experts), procedimento/profissional que ja existia.
// ---------------------------------------------------------------------------

export interface UndoResult {
  dryRun: boolean;
  since: string;
  appointmentsDeleted: number;
  patientsDeleted: number;
  proceduresDeleted: number;
  professionalsDeleted: number;
  unlinked: { procedures: number; professionals: number; patients: number };
  cancelledInCe: number; // agendamentos da propria Alice que tinham sido espelhados na agenda ERRADA e foram cancelados la
  failures: string[];
  sample: { procedures: string[]; professionals: string[] }; // nomes (ate 15) pra conferir antes de apagar
}

// Sem a conexao (ja desconectada) a data de inicio some. Deduz pelo que a importacao deixou:
// pacientes com vinculo do Clinica Experts E sem NENHUMA conversa (so a importacao cria
// assim). O mais antigo marca o comeco; recua 6h pra pegar profissionais/catalogo
// importados logo antes do primeiro agendamento.
export async function inferImportSince(clinicId: string): Promise<Date | null> {
  // 1) Pacientes que so a importacao da agenda cria (vinculo do CE e nenhuma conversa).
  const first = await prisma.patient.findFirst({
    where: { clinicId, ceUuid: { not: null }, conversations: { none: {} } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (first) return new Date(first.createdAt.getTime() - 6 * 3_600_000);

  // 2) So o CATALOGO foi importado ("Importar do Clinica Experts"): profissionais criados em lote.
  //    Agrupa por proximidade (lacuna < 30 min) e pega o maior grupo (>= 2). Profissional que a
  //    clinica ja tinha e foi so vinculado tem data bem anterior e fica fora do lote.
  const pros = await prisma.professional.findMany({
    where: { clinicId, ceUuid: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  let best: Date[] = [];
  let current: Date[] = [];
  for (const p of pros) {
    if (current.length && p.createdAt.getTime() - current[current.length - 1].getTime() > 30 * 60_000) current = [];
    current.push(p.createdAt);
    if (current.length > best.length) best = [...current];
  }
  if (best.length >= 2) return new Date(best[0].getTime() - 3_600_000);

  // 3) Sobraram so procedimentos "crus" vinculados (procedimento nao tem data de criacao): nao ha
  //    como datar. Devolve "agora": pacientes e profissionais NAO sao tocados, so os procedimentos
  //    que nunca foram personalizados.
  const rawProcs = await prisma.procedure.count({ where: { clinicId, ceId: { not: null } } });
  return rawProcs > 0 ? new Date() : null;
}

export async function undoCeImport(clinicId: string, opts: { dryRun: boolean; since?: Date }): Promise<UndoResult> {
  const account = await prisma.clinicaExpertsAccount.findUnique({ where: { clinicId }, select: { createdAt: true } });
  const since = opts.since ?? account?.createdAt ?? (await inferImportSince(clinicId));
  if (!since) throw new Error("Nao encontrei nada importado do Clinica Experts nesta clinica (sem pacientes, profissionais nem procedimentos vinculados). Nada a desfazer.");

  const result: UndoResult = {
    dryRun: opts.dryRun,
    since: since.toISOString(),
    appointmentsDeleted: 0,
    patientsDeleted: 0,
    proceduresDeleted: 0,
    professionalsDeleted: 0,
    unlinked: { procedures: 0, professionals: 0, patients: 0 },
    cancelledInCe: 0,
    failures: [],
    sample: { procedures: [], professionals: [] },
  };

  // 1. Agendamentos importados (origem "presencial" criados pela importacao).
  const candidates = await prisma.appointment.findMany({
    where: { clinicId, createdAt: { gte: since }, source: "presencial" },
    include: { patient: { select: { ceUuid: true, _count: { select: { conversations: true } } } } },
  });
  const junkAppointments = candidates.filter((a) => a.ceBookingUuid != null || (a.patient.ceUuid != null && a.patient._count.conversations === 0));
  const junkIds = junkAppointments.map((a) => a.id);

  // 2. Agendamentos da PROPRIA Alice que foram espelhados no Clinica Experts
  //    errado: cancela la (a agenda dessa clinica nao e a nossa) e solta o vinculo.
  const mirrored = await prisma.appointment.findMany({
    where: { clinicId, ceBookingUuid: { not: null }, id: { notIn: junkIds } },
    select: { id: true, ceBookingUuid: true },
  });

  // 3. Pacientes criados pela importacao: sem nenhuma conversa e sem outro agendamento.
  const patientCandidates = await prisma.patient.findMany({
    where: { clinicId, createdAt: { gte: since }, ceUuid: { not: null }, conversations: { none: {} } },
    select: { id: true, appointments: { select: { id: true } } },
  });
  const junkSet = new Set(junkIds);
  const junkPatients = patientCandidates.filter((p) => p.appointments.every((a) => junkSet.has(a.id)));

  // 4. Procedimentos e profissionais criados pela importacao (sem agendamento que sobre).
  // Procedimento nao tem data de criacao: o que a importacao cria vem "cru"
  // (sem descricao, beneficios, fotos nem pagamento). Procedimento ja
  // personalizado pela clinica NUNCA e apagado, so perde o vinculo.
  const procs = await prisma.procedure.findMany({
    where: { clinicId, ceId: { not: null } },
    include: { appointments: { select: { id: true } }, photos: { select: { id: true } } },
  });
  const isRaw = (p: (typeof procs)[number]) =>
    p.photos.length === 0 && !p.goals && !p.benefits && !p.resultTimeline && !p.paymentLink && !p.pixKey && p.paymentMethods === "" &&
    !p.allowConcurrentBooking && !p.offerInstallments && (!p.description || /^Avalia/i.test(p.description));
  const pros = await prisma.professional.findMany({
    where: { clinicId, ceUuid: { not: null } },
    select: { id: true, name: true, createdAt: true, appointments: { select: { id: true } } },
  });
  const created = (d: Date) => d.getTime() >= since.getTime();
  const junkProcs = procs.filter((p) => isRaw(p) && p.appointments.every((a) => junkSet.has(a.id)));
  const junkPros = pros.filter((p) => created(p.createdAt) && p.appointments.every((a) => junkSet.has(a.id)));

  result.appointmentsDeleted = junkIds.length;
  result.patientsDeleted = junkPatients.length;
  result.proceduresDeleted = junkProcs.length;
  result.professionalsDeleted = junkPros.length;
  result.cancelledInCe = mirrored.length;
  result.sample.procedures = junkProcs.slice(0, 15).map((p) => p.name);
  result.sample.professionals = junkPros.slice(0, 15).map((p) => p.name);
  const junkProcSet = new Set(junkProcs.map((p) => p.id));
  const junkProSet = new Set(junkPros.map((p) => p.id));
  result.unlinked.procedures = procs.filter((p) => !junkProcSet.has(p.id)).length;
  result.unlinked.professionals = pros.filter((p) => !junkProSet.has(p.id)).length;
  result.unlinked.patients = await prisma.patient.count({ where: { clinicId, ceUuid: { not: null }, id: { notIn: junkPatients.map((p) => p.id) } } });

  if (opts.dryRun) return result;

  // ---- execucao ----
  for (const m of account ? mirrored : []) {
    const res = await ceRequest(clinicId, `/bookings/${m.ceBookingUuid}/cancel`, { method: "PATCH" });
    if (!res.ok) result.failures.push(`cancelar espelho ${m.ceBookingUuid} no Clinica Experts: ${res.error}`);
  }
  if (junkIds.length) {
    await prisma.reminderSent.deleteMany({ where: { appointmentId: { in: junkIds } } });
    await prisma.postProcedureSent.deleteMany({ where: { appointmentId: { in: junkIds } } });
    await prisma.renewalSent.deleteMany({ where: { appointmentId: { in: junkIds } } });
    await prisma.appointment.deleteMany({ where: { id: { in: junkIds } } });
  }
  for (const p of junkPatients) {
    try {
      await prisma.patient.delete({ where: { id: p.id } });
    } catch (err) {
      result.patientsDeleted--;
      result.failures.push(`paciente ${p.id}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  for (const p of junkProcs) {
    try {
      await prisma.procedure.delete({ where: { id: p.id } });
    } catch (err) {
      result.proceduresDeleted--;
      result.failures.push(`procedimento ${p.id}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  for (const p of junkPros) {
    try {
      await prisma.professional.delete({ where: { id: p.id } });
    } catch (err) {
      result.professionalsDeleted--;
      result.failures.push(`profissional ${p.id}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  // O que sobrou so perde o vinculo com o Clinica Experts.
  await prisma.procedure.updateMany({ where: { clinicId, ceId: { not: null } }, data: { ceId: null } });
  await prisma.professional.updateMany({ where: { clinicId, ceUuid: { not: null } }, data: { ceUuid: null } });
  await prisma.patient.updateMany({ where: { clinicId, ceUuid: { not: null } }, data: { ceUuid: null } });
  await prisma.appointment.updateMany({ where: { clinicId, ceBookingUuid: { not: null } }, data: { ceBookingUuid: null } });

  await disconnectAccount(clinicId);
  invalidateCeCache(clinicId);
  return result;
}
