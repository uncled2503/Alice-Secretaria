// DIAGNOSTICO SOMENTE LEITURA do incidente de lembretes da Lisboa (20/10/2026). NAO precisa de deploy: usa so o @prisma/client ja instalado e consultas SQL de leitura (SELECT),
// tolerantes a bancos de revisoes diferentes (tabela/coluna ausente vira "indisponivel", nunca erro).
//   node scripts/incidente-lembretes.mjs [AAAA-MM-DD] ["Lisboa Beauty Center"]      (rodar na pasta do app, onde esta o .env / DATABASE_URL de PRODUCAO)
// Nao envia, nao grava, nao altera nada. Telefones saem mascarados (so os 4 ultimos digitos).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TZ_DEFAULT = "America/Sao_Paulo";
const arg1 = process.argv[2];
const dia = /^\d{4}-\d{2}-\d{2}$/.test(arg1 ?? "") ? arg1 : null;
const nomeClinica = process.argv[dia ? 3 : 2] ?? "Lisboa Beauty Center";

const q = async (sql, ...params) => { try { return await prisma.$queryRawUnsafe(sql, ...params); } catch (e) { return { erro: String(e.message ?? e).slice(0, 160) }; } };
const isErr = (r) => !Array.isArray(r);
const num = (v) => (typeof v === "bigint" ? Number(v) : v);
const fmt = (ms, tz) => { if (ms == null) return null; const d = new Date(Number(ms)); const p = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d); return p.replace(",", ""); };
const mask = (p) => `...${String(p ?? "").slice(-4)}`;
const first = (n) => (n ?? "").trim().split(/\s+/)[0] || "(sem nome)";
function localDay(date, tz) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
// instante UTC (ms) de AAAA-MM-DD hh:00 no fuso (sem horario de verao no Brasil desde 2019: offset fixo -3 para America/Sao_Paulo; para outro fuso, calcula pelo Intl)
function zoned(dia, h, tz) {
  const guess = Date.parse(`${dia}T${String(h).padStart(2, "0")}:00:00Z`);
  const off = (() => { const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)); const g = (t) => Number(f.find((x) => x.type === t).value); return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - guess; })();
  return guess - off;
}
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const out = { somenteLeitura: true, geradoEm: new Date().toISOString(), clinica: nomeClinica };

const clinicas = await q(`SELECT id, name, timezone, uazapiDownSince, uazapiDownReason, plan, active, aliceActive FROM "Clinic" WHERE name = ?`, nomeClinica);
if (isErr(clinicas) || !clinicas.length) { console.log(JSON.stringify({ ...out, erro: `clinica nao encontrada ou consulta falhou: ${JSON.stringify(clinicas)}` }, null, 2)); process.exit(1); }
const c = clinicas[0];
const tz = c.timezone || TZ_DEFAULT;
const hoje = dia ?? localDay(new Date(), tz);
out.fuso = tz; out.dia = hoje;
// o job de lembretes so le regras de clinicas FORA do plano gratis (PAID_CLINIC_WHERE: plan != 'free'): plano trocado/vencido tira a Lisboa das automacoes
out.cadastroDaClinica = { plano: c.plan, ativa: !!num(c.active), aliceAtiva: !!num(c.aliceActive), automacoesRodamParaEstaClinica: c.plan !== 'free' };

// 1) VERSAO REAL DO BANCO (o /health mostra a revisao do codigo; aqui a ultima migracao APLICADA)
const mig = await q(`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 3`);
out.migracoesAplicadas = isErr(mig) ? mig : mig.map((m) => m.migration_name);
out.observacao_versao = "A revisao do CODIGO em execucao so o /health informa (campo revision). Compare com o commit esperado; uma migracao nova aplicada indica que o servidor ja subiu com a versao que a trouxe.";

// 2) REGRAS DE LEMBRETE
const regras = await q(`SELECT id, hoursBefore, dayOffset, sendHour, sendMinute, sendEndHour, parentRuleId, pauseMinSec, pauseMaxSec, active, substr(message,1,120) AS msg FROM "ReminderRule" WHERE clinicId = ? ORDER BY createdAt`, c.id);
out.regras = isErr(regras) ? regras : regras.map((r) => ({ id: r.id, ativa: !!num(r.active), tipo: r.parentRuleId ? "cobranca (filha)" : num(r.dayOffset) === 1 ? "antecipada (dia anterior)" : num(r.dayOffset) === 0 ? "do dia" : `${r.hoursBefore}h antes`, janela: r.sendHour != null ? `${r.sendHour}:${String(r.sendMinute ?? 0).padStart(2, "0")} ate ${r.sendEndHour ?? "?"}h` : "-", pausa: `${r.pauseMinSec}-${r.pauseMaxSec}s`, texto: String(r.msg).replace(/\s+/g, " ") }));

// 3) EXECUCAO DOS JOBS (AutomationRun) nas janelas, e locks
const jan = [
  ["antecipada (dia anterior 08-11h)", zoned(addDays(hoje, -1), 8, tz), zoned(addDays(hoje, -1), 11, tz)],
  ["do dia (07-08h)", zoned(hoje, 7, tz), zoned(hoje, 8, tz)],
];
out.jobs = [];
for (const [nome, a, b] of jan) {
  const runs = await q(`SELECT startedAt, outcome, candidates, sent, deferred, ignored, vetoed, failed, uncertain, reasons, version, error FROM "AutomationRun" WHERE job = 'lembretes' AND clinicId = ? AND startedAt >= ? AND startedAt < ? ORDER BY startedAt`, c.id, a, b);
  out.jobs.push({ janela: nome, rodadasRegistradas: isErr(runs) ? runs : runs.length, rodadas: isErr(runs) ? undefined : runs.map((r) => ({ inicio: fmt(r.startedAt, tz), resultado: r.outcome, candidatos: num(r.candidates), enviados: num(r.sent), adiados: num(r.deferred), ignorados: num(r.ignored), vetados: num(r.vetoed), falhas: num(r.failed), incertos: num(r.uncertain), versao: r.version, erro: r.error, motivos: r.reasons })) });
}
const nunca = await q(`SELECT COUNT(*) AS n, MIN(startedAt) AS primeira, MAX(startedAt) AS ultima FROM "AutomationRun" WHERE job = 'lembretes' AND clinicId = ?`, c.id);
out.rodadasDeLembretesNoTotal = isErr(nunca) ? nunca : { total: num(nunca[0].n), primeira: fmt(nunca[0].primeira, tz), ultima: fmt(nunca[0].ultima, tz) };
const locks = await q(`SELECT name, holder, expiresAt FROM "JobLock" WHERE name IN ('lembretes','pos-procedimento','recontato')`);
out.locks = isErr(locks) ? locks : locks.map((l) => ({ tarefa: l.name, dono: String(l.holder).slice(0, 8), expiraEm: fmt(l.expiresAt, tz), vencido: Number(l.expiresAt) < Date.now() }));
out.whatsapp = { desconectadoDesde: c.uazapiDownSince ? fmt(c.uazapiDownSince, tz) : null, motivo: c.uazapiDownReason ?? null };

// 4) EVENTOS DO DIARIO (vetos, adiamentos, alertas) desde ontem 07h
const desde = zoned(addDays(hoje, -1), 7, tz);
const ev = await q(`SELECT type, COUNT(*) AS n, MIN(createdAt) AS primeiro, MAX(createdAt) AS ultimo FROM "ActivityLog" WHERE clinicId = ? AND createdAt >= ? AND (area = 'automacoes' OR type IN ('message_blocked_ai','reminder_deferred','review_quality_alert')) GROUP BY type ORDER BY n DESC`, c.id, desde);
out.diarioDeAutomacoes = isErr(ev) ? ev : ev.map((e) => ({ tipo: e.type, quantidade: num(e.n), primeiro: fmt(e.primeiro, tz), ultimo: fmt(e.ultimo, tz) }));

// 5) AGENDA DO DIA E EVIDENCIAS POR RESERVA (uma linha no banco NAO e prova de envio: veja o estado)
const ini = zoned(hoje, 0, tz), fim = zoned(addDays(hoje, 1), 0, tz);
const ags = await q(`SELECT a.id, a.scheduledAt, a.status, a.patientConfirmed, a.ceBookingUuid, a.createdAt, p.id AS pid, p.name AS pname, p.phone, p.optedOut, pr.name AS proc FROM "Appointment" a JOIN "Patient" p ON p.id = a.patientId JOIN "Procedure" pr ON pr.id = a.procedureId WHERE a.clinicId = ? AND a.scheduledAt >= ? AND a.scheduledAt < ? ORDER BY a.scheduledAt`, c.id, ini, fim);
if (isErr(ags)) { out.agenda = ags; } else {
  const ruleKind = new Map((isErr(regras) ? [] : regras).map((r) => [r.id, r.parentRuleId ? "cobranca" : num(r.dayOffset) === 1 ? "antecipada" : num(r.dayOffset) === 0 ? "do_dia" : "outra"]));
  const linhas = [];
  for (const a of ags) {
    const key = a.ceBookingUuid ? `ce:${a.ceBookingUuid}` : `appt:${a.id}`;
    const disp = await q(`SELECT ruleId, kind, state, attempt, substr(detail,1,100) AS detail, updatedAt FROM "ReminderDispatch" WHERE clinicId = ? AND bookingKey = ? AND startsAt = ?`, c.id, key, a.scheduledAt);
    const enviados = await q(`SELECT ruleId, sentAt FROM "ReminderSent" WHERE appointmentId = ?`, a.id);
    const msgs = await q(`SELECT m.role, m.createdAt, m.authorName, m.deliveryStatus, substr(m.content,1,60) AS txt FROM "Message" m JOIN "Conversation" cv ON cv.id = m.conversationId WHERE cv.patientId = ? AND m.createdAt >= ? ORDER BY m.createdAt`, a.pid, zoned(addDays(hoje, -1), 6, tz));
    const dd = isErr(disp) ? [] : disp;
    const porTipo = (k) => dd.filter((d) => (d.kind === k) || ruleKind.get(d.ruleId) === (k === "dia_seguinte" ? "antecipada" : k)).map((d) => `${d.state}${d.detail ? ` (${d.detail})` : ""} t${d.attempt}`).join("; ") || "sem linha de controle";
    const respostas = isErr(msgs) ? [] : msgs.filter((m) => m.role === "user");
    linhas.push({
      agendamento: a.id, pessoa: `${first(a.pname)} (${mask(a.phone)})`, horario: fmt(a.scheduledAt, tz), procedimento: a.proc, status: a.status, reserva: a.ceBookingUuid ? `CE ${String(a.ceBookingUuid).slice(0, 8)}` : "local", criadaEm: fmt(a.createdAt, tz),
      confirmouPresenca: !!num(a.patientConfirmed), optOut: !!num(a.optedOut),
      antecipada: porTipo("dia_seguinte"), doDia: porTipo("do_dia"),
      registrosReminderSent: isErr(enviados) ? "indisponivel" : enviados.map((e) => `${ruleKind.get(e.ruleId) ?? "?"}@${fmt(e.sentAt, tz)}`).join(", ") || "nenhum",
      mensagensAutomaticasNoChat: isErr(msgs) ? "indisponivel" : msgs.filter((m) => m.role !== "user" && /hoje|amanh/i.test(m.txt)).map((m) => `${fmt(m.createdAt, tz)} ${m.authorName ?? m.role} [${m.deliveryStatus ?? "-"}]`),
      respostasDaPaciente: respostas.map((m) => `${fmt(m.createdAt, tz)}: "${String(m.txt).replace(/\s+/g, " ")}"`).slice(0, 4),
    });
  }
  out.agenda = { total: linhas.length, linhas };
}
out.leitura = [
  "'sent' no controle = ACEITO pelo provedor; nao ha recibo de entrega. 'unconfirmed' = incerto (nao reenviar). 'vetoed' = barrado pela revisao por IA. 'deferred' = retido/adiado.",
  "Sem linha de controle e sem rodada registrada na janela: pode ser job nao executado OU versao anterior ao resumo de rodada. Nao conclua so por isso.",
  "Conferir tambem no WhatsApp da clinica (aparelho/painel do provedor) antes de qualquer reenvio.",
];
console.log(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
await prisma.$disconnect();
