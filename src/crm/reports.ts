import { prisma } from "../db/client.js";

const SOURCES = ["whatsapp", "instagram", "presencial", "telefone"] as const;

// Relatorio operacional da clinica num periodo: funil, no-show, faturamento,
// origem dos agendamentos, ranking de procedimentos, recuperados pela Alice.
export async function buildReport(clinicId: string, start: Date, end: Date) {
  const now = new Date();

  const [patients, appts, inboundRows, followUps, satisfaction] = await Promise.all([
    prisma.patient.findMany({
      where: { clinicId, createdAt: { gte: start, lte: end } },
      select: { id: true },
    }),
    prisma.appointment.findMany({
      where: { clinicId, scheduledAt: { gte: start, lte: end } },
      include: {
        procedure: { select: { name: true, price: true } },
        professional: { select: { id: true, name: true } },
      },
    }),
    prisma.message.findMany({
      where: { role: "user", createdAt: { gte: start, lte: end }, conversation: { patient: { clinicId } } },
      select: { conversation: { select: { patientId: true } } },
      distinct: ["conversationId"],
    }),
    prisma.followUpSent.findMany({
      where: { conversation: { patient: { clinicId } } },
      select: { sentAt: true, conversation: { select: { patientId: true } } },
      orderBy: { sentAt: "asc" },
    }),
    prisma.satisfactionSurvey.findMany({
      where: { clinicId, answeredAt: { gte: start, lte: end }, score: { not: null } },
      select: { score: true, comment: true, answeredAt: true, patient: { select: { name: true } } },
      orderBy: { answeredAt: "desc" },
    }),
  ]);

  const priceOf = (a: (typeof appts)[number]) => a.procedure.price ?? 0;
  const past = appts.filter((a) => a.scheduledAt <= now);
  const completed = appts.filter((a) => a.status === "completed");
  const noShow = past.filter((a) => a.status === "no_show");
  const cancelled = appts.filter((a) => a.status === "cancelled");
  const resolved = completed.length + noShow.length + cancelled.length;

  // Funil do periodo
  const bookedPatientIds = new Set(appts.map((a) => a.patientId));
  const funnel = {
    leads: patients.length,
    agendaram: bookedPatientIds.size,
    compareceram: completed.length,
    nao_compareceram: noShow.length,
    cancelaram: cancelled.length,
    conversao: resolved ? Math.round((completed.length / resolved) * 100) : 0,
  };
  const noShowRate = resolved ? Math.round((noShow.length / resolved) * 100) : 0;

  // Faturamento
  const realizado = completed.reduce((s, a) => s + priceOf(a), 0);
  const futurosConfirmados = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", scheduledAt: { gt: now } },
    select: { procedure: { select: { price: true } } },
  });
  const pipeline = futurosConfirmados.reduce((s, a) => s + (a.procedure.price ?? 0), 0);

  // Ranking de procedimentos (por atendimento concluido)
  const procMap = new Map<string, { name: string; count: number; total: number }>();
  for (const a of completed) {
    const e = procMap.get(a.procedureId) ?? { name: a.procedure.name, count: 0, total: 0 };
    e.count++;
    e.total += priceOf(a);
    procMap.set(a.procedureId, e);
  }
  const topProcedures = [...procMap.values()].sort((x, y) => y.total - x.total).slice(0, 10);

  // Por profissional
  const profMap = new Map<string, { name: string; concluidos: number; total: number; noShow: number }>();
  const bump = (id: string | null, name: string | null) => {
    const key = id ?? "__none__";
    const e = profMap.get(key) ?? { name: name ?? "Sem profissional", concluidos: 0, total: 0, noShow: 0 };
    profMap.set(key, e);
    return e;
  };
  for (const a of completed) {
    const e = bump(a.professionalId, a.professional?.name ?? null);
    e.concluidos++;
    e.total += priceOf(a);
  }
  for (const a of noShow) bump(a.professionalId, a.professional?.name ?? null).noShow++;
  const byProfessional = [...profMap.values()]
    .filter((e) => e.concluidos > 0 || e.noShow > 0)
    .sort((x, y) => y.total - x.total);

  // Origem dos agendamentos
  const bySource: { source: string; agendamentos: number; faturamento: number }[] = SOURCES.map((src) => {
    const list = appts.filter((a) => a.source === src);
    return { source: src as string, agendamentos: list.length, faturamento: list.filter((a) => a.status === "completed").reduce((s, a) => s + priceOf(a), 0) };
  }).filter((x) => x.agendamentos > 0);
  const semOrigem = appts.filter((a) => !a.source).length;
  if (semOrigem) bySource.push({ source: "nao_informado", agendamentos: semOrigem, faturamento: 0 });

  // Recuperados pela Alice: paciente que recebeu recontato antes de fechar/agendar no periodo
  const firstFollowUpByPatient = new Map<string, Date>();
  for (const f of followUps) {
    const pid = f.conversation.patientId;
    if (!firstFollowUpByPatient.has(pid)) firstFollowUpByPatient.set(pid, f.sentAt);
  }
  const recuperados = new Set(
    appts
      .filter((a) => {
        const ff = firstFollowUpByPatient.get(a.patientId);
        return ff && ff < a.createdAt && (a.status === "completed" || a.status === "confirmed");
      })
      .map((a) => a.patientId),
  ).size;

  // Atendidos pela Alice
  const atendidos = new Set(inboundRows.map((r) => r.conversation.patientId)).size;

  // Satisfacao / NPS
  const scores = satisfaction.map((s) => s.score!).filter((n) => typeof n === "number");
  const promoters = scores.filter((n) => n >= 9).length;
  const detractors = scores.filter((n) => n <= 6).length;
  const nps = scores.length ? Math.round(((promoters - detractors) / scores.length) * 100) : null;
  const satisfacao = {
    respostas: scores.length,
    nps,
    media: scores.length ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 10) / 10 : null,
    comentarios: satisfaction.filter((s) => s.comment?.trim()).slice(0, 15).map((s) => ({ nome: s.patient.name, score: s.score, comentario: s.comment })),
  };

  // Serie diaria
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const dailyMap = new Map<string, { agendamentos: number; faturamento: number }>();
  for (const a of appts) {
    const k = dayKey(a.scheduledAt);
    const e = dailyMap.get(k) ?? { agendamentos: 0, faturamento: 0 };
    e.agendamentos++;
    if (a.status === "completed") e.faturamento += priceOf(a);
    dailyMap.set(k, e);
  }
  const daily: { date: string; agendamentos: number; faturamento: number }[] = [];
  for (let c = new Date(start); c <= end && daily.length < 100; c.setDate(c.getDate() + 1)) {
    const k = dayKey(c);
    daily.push({ date: k, ...(dailyMap.get(k) ?? { agendamentos: 0, faturamento: 0 }) });
  }

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    funnel,
    noShowRate,
    revenue: { realizado, pipeline, porProcedimento: topProcedures, porProfissional: byProfessional },
    bySource,
    recuperados,
    atendidos,
    satisfacao,
    daily,
  };
}
