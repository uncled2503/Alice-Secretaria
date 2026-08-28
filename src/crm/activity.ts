import { prisma } from "../db/client.js";

// Areas do historico (o "Em qual area?" do painel).
export const ACTIVITY_AREAS: Record<string, string> = {
  atendimento: "Atendimento e conversas",
  agenda: "Agenda e agendamentos",
  automacoes: "Automações de mensagem",
  catalogo: "Serviços, produtos e profissionais",
  crm: "Funil e etapas",
  equipe: "Equipe e acessos",
  clinica: "Dados da clínica",
};

// Tipos de evento (o "O que aconteceu?" do painel).
export const ACTIVITY_TYPES: Record<string, string> = {
  human_takeover: "Atendimento assumido por uma pessoa",
  human_resume: "Atendimento devolvido para a Alice",
  appointment_booked: "Agendamento criado",
  appointment_rescheduled: "Agendamento remarcado",
  appointment_cancelled: "Agendamento cancelado",
  clinic_updated: "Dados da clínica alterados",
  catalog_added: "Item de catálogo adicionado",
  catalog_removed: "Item de catálogo removido",
  automation_created: "Automação criada",
  automation_removed: "Automação removida",
  rule_activated: "Regra de atendimento ativada",
  staff_added: "Conta de equipe criada",
  staff_removed: "Conta de equipe removida",
  stage_created: "Etapa do funil criada",
  stage_removed: "Etapa do funil removida",
  broadcast_scheduled: "Mensagem programada agendada",
};

export interface ActivityEntry {
  clinicId: string;
  type: keyof typeof ACTIVITY_TYPES | string;
  area: keyof typeof ACTIVITY_AREAS | string;
  title: string;
  description?: string | null;
  actorName?: string | null; // null/ausente = ação automática do sistema
}

// Registra uma atividade. NUNCA lanca - o historico e secundario, uma falha
// aqui nao pode derrubar a operacao que estava sendo registrada.
export async function logActivity(entry: ActivityEntry): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        clinicId: entry.clinicId,
        type: String(entry.type),
        area: String(entry.area),
        title: entry.title,
        description: entry.description ?? null,
        actorName: entry.actorName ?? null,
      },
    });
  } catch (err) {
    console.error("Falha ao registrar atividade no historico:", err);
  }
}
