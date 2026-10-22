import { prisma } from "../db/client.js";
import { zonedWallClockToUtc, isoDateInZone } from "../scheduling/time.js";
import { reasonReport } from "./lossReasons.js";
import { openProposalsReport } from "./proposals.js";
import { clinicPackageAlerts } from "./packages.js";

// ---------------------------------------------------------------------------
// RELATORIOS DE GESTAO (diario / semanal / mensal), com DENOMINADORES CLAROS (checklist mestre). Toda taxa e { n, d, pct }: pct = null quando d = 0 (nunca 0% inventado). So usa o que o sistema
// REALMENTE registra: nao ha "venda" nem faturamento aqui alem de atendimento CONCLUIDO; a conversao e de FUNIL (contato -> agendamento -> avaliacao -> procedimento concluido). Proposta
// aberta soma so valor informado. O "score" de prioridade comercial nao e probabilidade estatistica: ver commercialPriority().
// ---------------------------------------------------------------------------
export interface Rate { n: number; d: number; pct: number | null; definicao: string }
const rate = (n: number, d: number, definicao: string): Rate => ({ n, d, pct: d > 0 ? Math.round((n / d) * 1000) / 10 : null, definicao });

export function periodOf(preset: "diario" | "semanal" | "mensal", now: Date, tz: string): { from: Date; to: Date; label: string } {
  const today = isoDateInZone(now, tz).split("-").map(Number);
  const startOfDay = (y: number, m: number, d: number) => zonedWallClockToUtc(tz, y, m, d, 0, 0);
  if (preset === "diario") { const n = new Date(Date.UTC(today[0], today[1] - 1, today[2] + 1)); return { from: startOfDay(today[0], today[1], today[2]), to: startOfDay(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()), label: "hoje" }; }
  if (preset === "semanal") { const s = new Date(Date.UTC(today[0], today[1] - 1, today[2] - 6)); const n = new Date(Date.UTC(today[0], today[1] - 1, today[2] + 1)); return { from: startOfDay(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate()), to: startOfDay(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()), label: "últimos 7 dias" }; }
  const n = new Date(Date.UTC(today[0], today[1], 1)); // mes corrente
  return { from: startOfDay(today[0], today[1], 1), to: startOfDay(n.getUTCFullYear(), n.getUTCMonth() + 1, 1), label: "mês corrente" };
}

// Segmentacao recorrente/VIP BASEADA EM DADOS: nº de atendimentos CONCLUIDOS nos ultimos 12 meses (limites explicitos, ajustaveis no futuro). Uso INTERNO: nunca aparece para a pessoa.
export const SEGMENT_LIMITS = { recorrente: 3, vip: 6 };
export function segmentOf(completedLast12m: number): "novo" | "ocasional" | "recorrente" | "vip" {
  if (completedLast12m >= SEGMENT_LIMITS.vip) return "vip";
  if (completedLast12m >= SEGMENT_LIMITS.recorrente) return "recorrente";
  return completedLast12m >= 1 ? "ocasional" : "novo";
}

// PRIORIDADE COMERCIAL EXPLICAVEL (heuristica, NAO probabilidade): soma de sinais registrados, cada um com o seu motivo. O resultado e uma ORDEM de atencao para a equipe, nunca "x% de chance de fechar".
export function commercialPriority(p: { temperature?: string | null; askedPrice?: boolean; askedSchedule?: boolean; askedInstallments?: boolean; hasOpenProposal?: boolean; daysSilent?: number | null; hasFutureBooking?: boolean }): { pontos: number; motivos: string[]; aviso: string } {
  const motivos: string[] = [];
  let pontos = 0;
  const add = (n: number, why: string) => { pontos += n; motivos.push(`+${n} ${why}`); };
  if (p.hasFutureBooking) return { pontos: 0, motivos: ["já tem horário marcado: fora da fila comercial"], aviso: "Ordem de atenção, não probabilidade." };
  if (p.temperature === "quente") add(3, "temperatura quente (marcada)"); else if (p.temperature === "morno") add(1, "temperatura morna (marcada)");
  if (p.askedSchedule) add(3, "pediu horário"); if (p.askedPrice) add(2, "perguntou valor"); if (p.askedInstallments) add(2, "perguntou parcelamento");
  if (p.hasOpenProposal) add(2, "tem proposta aberta");
  if ((p.daysSilent ?? 0) > 14) { pontos -= 2; motivos.push("-2 sem resposta há mais de 14 dias"); }
  return { pontos, motivos, aviso: "Ordem de atenção para a equipe: soma de sinais registrados, NÃO é probabilidade estatística de fechamento." };
}

export async function managementReport(clinicId: string, preset: "diario" | "semanal" | "mensal", now = new Date()) {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const { from, to, label } = periodOf(preset, now, tz);
  const inP = { gte: from, lt: to };

  // ---- funil (denominadores explicitos)
  const newLeads = await prisma.patient.findMany({ where: { clinicId, createdAt: inP, contactKind: "paciente" }, select: { id: true } });
  const leadIds = newLeads.map((l) => l.id);
  const booked = leadIds.length ? await prisma.appointment.findMany({ where: { patientId: { in: leadIds }, status: { not: "cancelled" } }, select: { patientId: true } }) : [];
  const leadsAgendaram = new Set(booked.map((b) => b.patientId)).size;
  const appts = await prisma.appointment.findMany({ where: { clinicId, scheduledAt: inP }, include: { procedure: { select: { name: true } }, professional: { select: { name: true } } } });
  const isEval = (a: { procedure: { name: string } }) => /avalia/i.test(a.procedure.name);
  const evalDone = appts.filter((a) => a.status === "completed" && isEval(a));
  const completed = appts.filter((a) => a.status === "completed");
  const noShow = appts.filter((a) => a.status === "no_show");
  const cancelled = appts.filter((a) => a.status === "cancelled");
  // avaliacao -> procedimento concluido (qualquer nao-avaliacao) no periodo ou ate 30 dias depois
  let evalToProc = 0;
  for (const e of evalDone) {
    const later = await prisma.appointment.count({ where: { patientId: e.patientId, status: "completed", scheduledAt: { gt: e.scheduledAt, lt: new Date(e.scheduledAt.getTime() + 30 * 86_400_000) }, procedure: { name: { not: { contains: "valia" } } } } });
    if (later > 0) evalToProc++;
  }
  const by = (key: (a: (typeof appts)[number]) => string | null) => {
    const m = new Map<string, { concluidos: number; faltas: number; cancelados: number; total: number }>();
    for (const a of appts) {
      const k = key(a) ?? "(sem informação)";
      const r = m.get(k) ?? { concluidos: 0, faltas: 0, cancelados: 0, total: 0 };
      r.total++; if (a.status === "completed") r.concluidos++; if (a.status === "no_show") r.faltas++; if (a.status === "cancelled") r.cancelados++;
      m.set(k, r);
    }
    return [...m.entries()].map(([nome, r]) => ({ nome, ...r, taxaFalta: rate(r.faltas, r.concluidos + r.faltas, "faltas / (concluídos + faltas)"), taxaCancelamento: rate(r.cancelados, r.total, "cancelados / agendamentos do período") })).sort((a, b) => b.total - a.total);
  };

  // ---- conversas: resolucao pela Alice (criterio definido) e motivos de transferencia
  const convs = await prisma.conversation.findMany({ where: { patient: { clinicId }, lastMessageAt: inP }, select: { humanTakeover: true, handoffReason: true, messages: { where: { role: "user" }, take: 1, select: { id: true } } } });
  const withUser = convs.filter((c) => c.messages.length > 0);
  const resolvidas = withUser.filter((c) => !c.humanTakeover);
  const transfer = new Map<string, number>();
  for (const c of withUser) if (c.humanTakeover) { const k = (c.handoffReason ?? "sem motivo registrado").replace(/"[^"]*"/g, "").slice(0, 60).trim() || "sem motivo registrado"; transfer.set(k, (transfer.get(k) ?? 0) + 1); }

  // ---- base por segmento (dados)
  const since = new Date(now.getTime() - 365 * 86_400_000);
  const done12 = await prisma.appointment.groupBy({ by: ["patientId"], where: { clinicId, status: "completed", scheduledAt: { gte: since, lte: now } }, _count: { _all: true } });
  const seg = { novo: 0, ocasional: 0, recorrente: 0, vip: 0 };
  for (const g of done12) seg[segmentOf(g._count._all)]++;

  return {
    periodo: { preset, rotulo: label, de: from.toISOString(), ate: to.toISOString(), fuso: tz },
    funil: {
      contatosNovos: newLeads.length,
      contatoParaAgendamento: rate(leadsAgendaram, newLeads.length, "contatos novos do período com ao menos um agendamento não cancelado / contatos novos do período"),
      avaliacoesConcluidas: evalDone.length,
      avaliacaoParaProcedimento: rate(evalToProc, evalDone.length, "avaliações concluídas com procedimento concluído em até 30 dias / avaliações concluídas"),
      agendamentosNoPeriodo: appts.length, concluidos: completed.length, faltas: noShow.length, cancelados: cancelled.length,
      taxaFalta: rate(noShow.length, completed.length + noShow.length, "faltas / (concluídos + faltas)"),
    },
    porProcedimento: by((a) => a.procedure.name),
    porProfissional: by((a) => a.professional?.name ?? null),
    motivos: await reasonReport(clinicId, from, to),
    resolucaoDaAlice: { ...rate(resolvidas.length, withUser.length, "conversas com mensagem da pessoa no período que NÃO passaram para a equipe / conversas com mensagem da pessoa no período"), criterio: "conversa 'resolvida' = sem transferência para a equipe; não mede satisfação.", transferenciasPorMotivo: [...transfer.entries()].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n) },
    propostas: await openProposalsReport(clinicId, now),
    pacotes: { fonte: "interna (o Clínica Experts não fornece saldo de sessões neste cliente)", alertas: (await clinicPackageAlerts(clinicId, now)).length },
    segmentacao: { criterio: `atendimentos concluídos nos últimos 12 meses: recorrente >= ${SEGMENT_LIMITS.recorrente}, vip >= ${SEGMENT_LIMITS.vip}`, ...seg, usoInterno: true },
  };
}
