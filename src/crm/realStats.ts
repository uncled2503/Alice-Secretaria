import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// Numeros "reais" do painel: so o que a Alice de fato fez, nunca o que veio de
// importacao de historico, agenda lancada pela recepcao ou integracao.
//
// - Resposta da Alice: Message role "assistant" com authorName NULL. Mensagens
//   automaticas (recontato, lembrete, NPS, lista de espera) e da equipe tem
//   authorName preenchido; historico importado do WhatsApp so cria "user"/"human".
// - Mensagem ao vivo do contato: role "user" cujo createdAt e >= criacao do
//   paciente. O historico importado carrega a data ORIGINAL (anterior ao
//   cadastro do paciente), entao fica de fora sem precisar de marcador.
// - Agendamento da Alice: origem whatsapp/instagram (a Alice grava assim; a
//   recepcao e o Clinica Experts entram como presencial/telefone).
// ---------------------------------------------------------------------------

export const ALICE_BOOKING_SOURCES = ["whatsapp", "instagram"] as const;

export interface RealActivity {
  aliceRepliedPatients: Set<string>; // pacientes a quem a Alice respondeu no periodo
  liveContactPatients: Set<string>; // pacientes que escreveram ao vivo no periodo
  activeConversations: Set<string>; // conversas com resposta da Alice ou mensagem ao vivo do contato
}

export async function realActivity(clinicId: string, start: Date, end: Date): Promise<RealActivity> {
  const [aliceRows, inboundRows] = await Promise.all([
    prisma.message.findMany({
      where: { role: "assistant", authorName: null, createdAt: { gte: start, lte: end }, conversation: { patient: { clinicId } } },
      select: { conversationId: true, conversation: { select: { patientId: true } } },
      distinct: ["conversationId"],
    }),
    prisma.message.findMany({
      where: { role: "user", createdAt: { gte: start, lte: end }, conversation: { patient: { clinicId } } },
      select: { conversationId: true, createdAt: true, conversation: { select: { patientId: true, patient: { select: { createdAt: true } } } } },
    }),
  ]);

  const aliceRepliedPatients = new Set(aliceRows.map((r) => r.conversation.patientId));
  const live = inboundRows.filter((r) => r.createdAt.getTime() >= r.conversation.patient.createdAt.getTime());
  const liveContactPatients = new Set(live.map((r) => r.conversation.patientId));
  const activeConversations = new Set([...aliceRows.map((r) => r.conversationId), ...live.map((r) => r.conversationId)]);
  return { aliceRepliedPatients, liveContactPatients, activeConversations };
}

// Contatos NOVOS de verdade: cadastrados no periodo E que de fato conversaram
// (escreveram ao vivo ou receberam resposta da Alice). Exclui o que a
// importacao de historico, o Clinica Experts ou a recepcao cadastraram.
export async function realNewContacts(clinicId: string, start: Date, end: Date): Promise<number> {
  const created = await prisma.patient.findMany({
    where: { clinicId, createdAt: { gte: start, lte: end } },
    select: { id: true, createdAt: true },
    take: 5000,
  });
  if (!created.length) return 0;
  const real = new Set<string>();
  const createdAtById = new Map(created.map((p) => [p.id, p.createdAt.getTime()]));
  const ids = created.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    const [inbound, replies] = await Promise.all([
      prisma.message.findMany({
        where: { role: "user", conversation: { patientId: { in: chunk } } },
        select: { createdAt: true, conversation: { select: { patientId: true } } },
      }),
      prisma.message.findMany({
        where: { role: "assistant", authorName: null, conversation: { patientId: { in: chunk } } },
        select: { conversation: { select: { patientId: true } } },
        distinct: ["conversationId"],
      }),
    ]);
    for (const m of inbound) {
      const pid = m.conversation.patientId;
      if (m.createdAt.getTime() >= (createdAtById.get(pid) ?? Infinity)) real.add(pid);
    }
    for (const r of replies) real.add(r.conversation.patientId);
  }
  return real.size;
}

// Agendamentos feitos PELA ALICE no periodo (quando foram marcados, nao a data
// da consulta). A agenda da recepcao nao entra.
export async function aliceBookings(clinicId: string, start: Date, end: Date) {
  return prisma.appointment.findMany({
    where: { clinicId, source: { in: [...ALICE_BOOKING_SOURCES] }, createdAt: { gte: start, lte: end } },
    select: { createdAt: true, scheduledAt: true, status: true },
  });
}
