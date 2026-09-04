import { prisma } from "../db/client.js";
import { wallClockInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// Números que a clínica do plano grátis vê no painel pra entender o que está
// perdendo sem a Alice. Tudo sai do dado REAL dela - nada de estimativa
// inventada. É o argumento de venda mais forte que existe: o próprio histórico.
//
// Só é calculado para clínicas no plano grátis (ver /dashboard/stats).
// ---------------------------------------------------------------------------

export interface UpsellStats {
  leads: number; // leads novos no período
  foraDoHorario: number; // chegaram fora do expediente (a Alice teria respondido)
  semResposta: number; // conversas em que o lead falou por último e ninguém voltou
  respostasNaMao: number; // mensagens que a equipe digitou
  minutosNoChat: number; // tempo estimado digitando (2 min por resposta)
  tempoRespostaMin: number | null; // mediana de espera do lead pela 1ª resposta humana
  demoraramMaisDeUmaHora: number; // leads que esperaram > 60 min pela resposta
}

const MIN_PER_REPLY = 2; // estimativa conservadora de quanto custa digitar uma resposta

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function upsellStats(clinicId: string, startDate: Date, endDate: Date): Promise<UpsellStats> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { timezone: true, workStartHour: true, workEndHour: true, workDays: true },
  });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const workDays = new Set(clinic.workDays.split(",").map((d) => Number(d.trim())).filter((n) => !Number.isNaN(n)));

  const inBusinessHours = (at: Date): boolean => {
    const w = wallClockInZone(at, tz);
    if (!workDays.has(w.weekday)) return false;
    return w.hour >= clinic.workStartHour && w.hour < clinic.workEndHour;
  };

  // Todas as mensagens do período, em ordem, pra derivar leads/espera/respostas.
  const messages = await prisma.message.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate },
      role: { in: ["user", "human", "assistant"] },
      conversation: { patient: { clinicId } },
    },
    orderBy: { createdAt: "asc" },
    select: { conversationId: true, role: true, createdAt: true },
    take: 20000,
  });

  const leads = await prisma.patient.count({
    where: { clinicId, createdAt: { gte: startDate, lte: endDate } },
  });

  let foraDoHorario = 0;
  let respostasNaMao = 0;
  const waits: number[] = [];
  let demoraramMaisDeUmaHora = 0;

  // Por conversa: fila de mensagens do lead esperando resposta da equipe.
  const pending = new Map<string, Date | null>(); // 1ª mensagem do lead ainda sem resposta
  const lastRole = new Map<string, string>();
  const countedOutOfHours = new Set<string>();

  for (const m of messages) {
    lastRole.set(m.conversationId, m.role);

    if (m.role === "user") {
      // Conta uma vez por conversa: o lead chegou fora do expediente?
      if (!countedOutOfHours.has(m.conversationId) && !inBusinessHours(m.createdAt)) {
        countedOutOfHours.add(m.conversationId);
        foraDoHorario++;
      }
      if (!pending.has(m.conversationId) || pending.get(m.conversationId) == null) {
        pending.set(m.conversationId, m.createdAt);
      }
      continue;
    }

    if (m.role === "human") respostasNaMao++;

    const waitingSince = pending.get(m.conversationId);
    if (waitingSince) {
      const min = Math.round((m.createdAt.getTime() - waitingSince.getTime()) / 60_000);
      if (min >= 0) {
        waits.push(min);
        if (min > 60) demoraramMaisDeUmaHora++;
      }
      pending.set(m.conversationId, null);
    }
  }

  // Conversas em que o lead falou por último: ninguém voltou.
  let semResposta = 0;
  for (const role of lastRole.values()) if (role === "user") semResposta++;

  return {
    leads,
    foraDoHorario,
    semResposta,
    respostasNaMao,
    minutosNoChat: respostasNaMao * MIN_PER_REPLY,
    tempoRespostaMin: median(waits),
    demoraramMaisDeUmaHora,
  };
}
