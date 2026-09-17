import { prisma } from "../db/client.js";

// Agendamento sem profissional atribuido bloqueia a agenda de TODO MUNDO na
// clinica (regra conservadora: ninguem sabe quem "e dono" daquele horario -
// ver loadBusyContext/createBooking em scheduling/slots.ts). Isso quebra
// agendamento simultaneo pra procedimentos que ganharam um profissional
// dedicado DEPOIS de ja existirem agendamentos antigos sem essa atribuicao
// (ex.: separar "Aplicação" pra um profissional proprio, ver
// seedDrSaulo.ts) - o agendamento antigo, sem dono, continua bloqueando o
// profissional novo mesmo nao tendo nenhuma relacao real com ele.
//
// Quando o procedimento de um agendamento sem profissional tem EXATAMENTE
// um profissional ativo ligado a ele, nao ha ambiguidade: so pode ser essa
// pessoa. Backfilla o professionalId nesses casos.
export async function backfillMissingProfessionalIds(clinicId: string): Promise<{ updated: number }> {
  const appts = await prisma.appointment.findMany({
    where: { clinicId, professionalId: null, status: "confirmed" },
    select: { id: true, procedureId: true },
  });
  if (appts.length === 0) return { updated: 0 };

  const resolvedByProcedure = new Map<string, string | null>();
  let updated = 0;
  for (const appt of appts) {
    let resolvedId = resolvedByProcedure.get(appt.procedureId);
    if (resolvedId === undefined) {
      const pros = await prisma.professional.findMany({
        where: { clinicId, active: true, procedures: { some: { id: appt.procedureId } } },
        select: { id: true },
      });
      resolvedId = pros.length === 1 ? pros[0].id : null;
      resolvedByProcedure.set(appt.procedureId, resolvedId);
    }
    if (resolvedId) {
      await prisma.appointment.update({ where: { id: appt.id }, data: { professionalId: resolvedId } });
      updated++;
    }
  }
  return { updated };
}
