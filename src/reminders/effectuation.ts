import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// RESERVA EFETIVADA NO CLINICA EXPERTS? Numa clinica ligada ao CE, a reserva so e "agendamento" depois que o CE a aceitou. Enquanto a criacao La esta pendente, incerta, sem
// desfecho ou falhou (CeBookingAttempt), o horario ainda NAO e uma reserva firme: a confirmacao "Passando para confirmar o seu agendamento" nao pode apresentar como confirmado
// algo que o CE nao tem. A mensagem fica RETIDA (com o motivo visivel), nao descartada: sai se a reserva se efetivar dentro da janela.
// Reserva que veio do proprio CE (ceBookingUuid) esta efetivada por definicao. Clinica sem CE: nao se aplica (retorna vazio).
// ---------------------------------------------------------------------------

const OPEN_STATES = ["pending", "uncertain", "unresolved", "failed"];

// appointmentId -> motivo (em portugues, sem dado pessoal) para cada agendamento sem uuid cuja ULTIMA tentativa de criacao no CE nao foi concluida.
export async function notYetEffectuated(appts: { id: string; ceBookingUuid: string | null }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pendingIds = appts.filter((a) => !a.ceBookingUuid).map((a) => a.id);
  if (pendingIds.length === 0) return out;
  const attempts = await prisma.ceBookingAttempt.findMany({
    where: { appointmentId: { in: pendingIds }, kind: "create" },
    orderBy: { createdAt: "desc" },
    select: { appointmentId: true, state: true },
  });
  const latest = new Map<string, string>();
  for (const a of attempts) if (!latest.has(a.appointmentId)) latest.set(a.appointmentId, a.state);
  for (const [id, state] of latest) {
    if (OPEN_STATES.includes(state)) out.set(id, `a criação da reserva no Clínica Experts não foi concluída (${state})`);
  }
  return out;
}
