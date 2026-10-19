// RECONTATOS E RETOMADAS DE AVALIACAO (pedido da Lisboa, 17-18/10/2026). Relogio controlado (nada de `new Date()` solto), banco temporario, OpenAI e UAZAPI
// simuladas. O servidor roda em UTC de proposito: o fuso que vale e o da CLINICA (America/Sao_Paulo).
//  1) cronograma PURO (vencimento, abertura, prazo, politica de recuperacao);
//  2) recontato por silencio de ponta a ponta: selecao de candidatas -> juiz -> reserva -> envio -> persistencia do resultado;
//  3) retomada de avaliacao cancelada e de avaliacao sem fechamento;
//  4) coordenacao entre automacoes, concorrencia, diagnostico e relatorio.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC"; // a VPS roda em UTC: o horario que vale e o da clinica
const dbFile = path.join(os.tmpdir(), `alice-recontatos-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ---- servicos simulados
const posts = []; // mensagens que a UAZAPI aceitou
let uazapiMode = "ok"; // ok | http500 | timeout
let judgeAnswer = { recontact: true, reason: "pediu informacao e sumiu" }; // resposta do juiz; null = IA fora do ar
let reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" };
let judgeHook = null; // chamado quando o juiz de IA e consultado (permite mudar o banco ENTRE a selecao e o envio)
const judgeCalls = [];
const reviewCalls = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    const system = String(body.messages?.[0]?.content ?? "");
    if (/REVISOR DE ENVIO/.test(system)) { reviewCalls.push(body); return jsonRes(200, completion(reviewDecision)); }
    if (/RECONTATO automatico|RETOMADA a uma pessoa/.test(system)) {
      judgeCalls.push(body);
      if (judgeHook) await judgeHook();
      if (judgeAnswer === null) return jsonRes(500, { error: { message: "IA fora do ar" } });
      return jsonRes(200, completion(judgeAnswer));
    }
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapiMode === "http500") return jsonRes(500, { error: "fora do ar" });
    if (uazapiMode === "timeout") throw Object.assign(new Error("The operation timed out (TimeoutError)"), { name: "TimeoutError" });
    posts.push({ number: JSON.parse(init.body).number, text: JSON.parse(init.body).text });
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const sched = await import("../dist/crm/followupSchedule.js");
const { runFollowUpCheck } = await import("../dist/crm/followup.js");
const { runResumeFlows, markResumeTarget, suggestNoCloseCandidates, cancelEvidence, previewResumeFlow } = await import("../dist/crm/resumeFlows.js");
const { sendText } = await import("../dist/uazapi/client.js");
const guard = await import("../dist/crm/resumeGuard.js");
const ledger = await import("../dist/crm/followupLedger.js");
const { diagnoseJobs, nextCronRun } = await import("../dist/crm/automationRuns.js");
const { buildDailyReport } = await import("../dist/crm/dailyReport.js");
const { runCallbackCheck } = await import("../dist/crm/hotLeads.js");
const { conferirRecontatosLisboa } = await import("../dist/maintenance/lisboaRecontatos.js");
const { isNonCommercialHandoff } = await import("../dist/crm/nonCommercial.js");
const { resetBreakerForTests } = await import("../dist/ai/sendGate.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`); // "2026-10-15T08:10" (hora de Sao Paulo) -> instante
const noSleep = async () => undefined;
const HOUR = 3_600_000;

// calendario de uma clinica "Lisboa": seg-sab, 8h-21h, sabado ate 15h
const CAL = { timezone: TZ, workDays: "1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, hoursByDay: JSON.stringify({ 6: [8, 15] }), closedOnHolidays: false, holidayOpen: null };
const RULE_NEXTDAY = { afterMinutes: 1440, afterDays: 1, nextDayHour: 8, sendWindowStart: 8, sendWindowEnd: 12 };
const RULE_4H = { afterMinutes: 240, afterDays: 1, nextDayHour: null, sendWindowStart: null, sendWindowEnd: null };
const RULE_FROM_12 = { afterMinutes: 240, afterDays: 1, nextDayHour: null, sendWindowStart: 12, sendWindowEnd: 18 };

// ================================================================ 1) CRONOGRAMA PURO

test("'dia seguinte as 8h' vale no fuso da CLINICA mesmo com o servidor em UTC: vence 08:00 de Sao Paulo, nunca 08:00 UTC nem 24h corridas", () => {
  assert.equal(new Date().getTimezoneOffset(), 0, "o processo de teste roda em UTC");
  const last = sp("2026-10-14T15:00"); // quarta 15h em SP
  const due = sched.ruleDueAt(RULE_NEXTDAY, last, TZ);
  assert.equal(due.toISOString(), "2026-10-15T11:00:00.000Z"); // quinta 08:00 SP
  // 07:55 em SP ainda nao venceu; 08:00 em SP vence
  assert.equal(sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T07:55"), CAL).action, "wait");
  assert.equal(sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T08:00"), CAL).action, "send");
  // 24h corridas (quinta 15h) ja estaria fora da janela 8h-12h: a regra e do dia seguinte as 8h, nao "24h depois".
  // O que acontece com uma etapa que perdeu a janela e POLITICA DA CLINICA (Clinic.followupRecoveryHours): com 4h de recuperacao (= a janela) ela expira; sem decisao vale o padrao antigo.
  const lateInDay = sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T15:00"), CAL, { recoveryHours: 4 });
  assert.equal(lateInDay.action, "expire");
  assert.equal(lateInDay.code, "janela_perdida");
  const legacy = sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T15:00"), CAL);
  assert.equal(legacy.action, "wait", "padrao antigo (clinica sem decisao): espera a janela abrir de novo (dia seguinte 8h), dentro da tolerancia de 3 dias");
  assert.equal(legacy.opensAt.toISOString(), sp("2026-10-16T08:00").toISOString());
});

test("'a partir das 12h' (janela 12h-18h) e diferente de 'janela 8h-12h': a regra de 12h nunca sai antes das 12h", () => {
  const last = sp("2026-10-15T08:00"); // 4h de silencio vence 12:00
  assert.equal(sched.decideTiming(RULE_FROM_12, last, sp("2026-10-15T11:59"), CAL).action, "wait");
  assert.equal(sched.decideTiming(RULE_FROM_12, last, sp("2026-10-15T12:00"), CAL).action, "send");
  // conversa que acabou as 6h: vence 10h, mas so abre as 12h
  const early = sched.decideTiming(RULE_FROM_12, sp("2026-10-15T06:00"), sp("2026-10-15T10:30"), CAL);
  assert.equal(early.action, "wait");
  assert.equal(early.code, "fora_da_janela");
  assert.equal(early.opensAt.toISOString(), sp("2026-10-15T12:00").toISOString());
  // a janela 8h-12h NAO envia as 12:00 (fim exclusivo)
  assert.equal(sched.openAt({ sendWindowStart: 8, sendWindowEnd: 12 }, CAL, sp("2026-10-15T12:00")).open, false);
  assert.equal(sched.openAt({ sendWindowStart: 8, sendWindowEnd: 12 }, CAL, sp("2026-10-15T11:59")).open, true);
});

test("job rodando minutos atrasado ainda envia dentro da janela; depois da janela, a etapa EXPIRA (nao sai atrasada nem acumulada)", () => {
  const last = sp("2026-10-14T15:00");
  const late = sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T08:40"), CAL);
  assert.equal(late.action, "send");
  assert.equal(Math.round(late.lateMs / 60_000), 40);
  assert.equal(sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T11:59"), CAL).action, "send", "ate o fim da janela ainda vale");
  const out = sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T12:01"), CAL, { recoveryHours: 4 });
  assert.equal(out.action, "expire", "com a politica de 4h de recuperacao: o dia seguinte acabou sem a mensagem sair, nao sai no dia seguinte ao seguinte");
  assert.equal(out.code, "janela_perdida");
  const semRecuperar = sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T08:10"), CAL, { recoveryHours: 0 });
  assert.equal(semRecuperar.action, "send", "'nao recupera': dentro da rodada em que a janela abriu ainda sai");
  assert.equal(sched.decideTiming(RULE_NEXTDAY, last, sp("2026-10-15T08:25"), CAL, { recoveryHours: 0 }).action, "expire", "'nao recupera': passou a tolerancia tecnica de uma rodada (20 min), expira");
});

test("reinicio do servidor DENTRO da janela retoma e envia; FORA da janela expira conforme a politica da clinica (24h depois da abertura, aqui); sem decisao vale o padrao antigo de 3 dias", () => {
  const P24 = { recoveryHours: 24 };
  const last = sp("2026-10-15T09:00"); // 4h -> vence 13:00 (sem janela propria, clinica aberta)
  assert.equal(sched.decideTiming(RULE_4H, last, sp("2026-10-15T14:30"), CAL).action, "send", "o servidor voltou as 14:30: ainda dentro do expediente");
  const next = sched.decideTiming(RULE_4H, sp("2026-10-15T19:30"), sp("2026-10-15T23:30"), CAL); // vence 23:30, clinica fechada
  assert.equal(next.action, "wait");
  assert.equal(next.opensAt.toISOString(), sp("2026-10-16T08:00").toISOString(), "espera abrir amanha cedo");
  assert.equal(sched.decideTiming(RULE_4H, sp("2026-10-15T19:30"), sp("2026-10-16T08:05"), CAL).action, "send");
  assert.equal(sched.decideTiming(RULE_4H, sp("2026-10-15T19:30"), sp("2026-10-17T08:05"), CAL, P24).action, "expire", "politica de 24h: passou 24h da abertura, contexto velho");
  assert.equal(sched.decideTiming(RULE_4H, sp("2026-10-15T19:30"), sp("2026-10-17T08:05"), CAL).action, "send", "sem decisao da clinica vale o padrao antigo: ainda dentro dos 3 dias do vencimento");
  assert.equal(sched.decideTiming(RULE_4H, sp("2026-10-15T19:30"), sp("2026-10-18T23:00"), CAL).code, "conversa_fria", "e depois de 3 dias, conversa fria");
  assert.equal(sched.decideTiming(RULE_4H, sp("2026-10-10T09:00"), sp("2026-10-15T14:30"), CAL).code, "conversa_fria", "mais de 3 dias de atraso: conversa fria");
});

test("dias uteis e feriados: domingo fechado, sabado ate 15h, feriado nacional fechado (so quando a clinica fecha em feriado)", () => {
  // conversa de sabado 16h: 4h -> domingo 08:00 (fechado) -> abre segunda 08:00
  const sat = sched.decideTiming(RULE_4H, sp("2026-10-10T16:00"), sp("2026-10-11T10:00"), CAL); // sabado 10/10/2026, domingo 11
  assert.equal(sat.action, "wait");
  assert.equal(sat.opensAt.toISOString(), sp("2026-10-12T08:00").toISOString());
  // sabado as 15h30 ja esta fechado
  assert.equal(sched.openAt({ sendWindowStart: null, sendWindowEnd: null }, CAL, sp("2026-10-10T15:30")).open, false);
  // feriado: 02/11/2026 (Finados, segunda). Fechado quando a clinica fecha em feriado; aberto quando nao.
  const closed = { ...CAL, closedOnHolidays: true };
  assert.deepEqual(sched.openAt({ sendWindowStart: null, sendWindowEnd: null }, closed, sp("2026-11-02T10:00")), { open: false, reason: "feriado" });
  assert.equal(sched.openAt({ sendWindowStart: null, sendWindowEnd: null }, CAL, sp("2026-11-02T10:00")).open, true);
  const afterHoliday = sched.firstOpenAtOrAfter({ sendWindowStart: null, sendWindowEnd: null }, closed, sp("2026-11-02T10:00"));
  assert.equal(afterHoliday.toISOString(), sp("2026-11-03T08:00").toISOString());
  // clinica que abre naquele feriado (holidayOpen)
  assert.equal(sched.openAt({ sendWindowStart: null, sendWindowEnd: null }, { ...closed, holidayOpen: "Finados" }, sp("2026-11-02T10:00")).open, true);
});

test("a jornada das profissionais NAO e janela comercial: o cronograma nao depende de nenhum campo de profissional", () => {
  const src = fs.readFileSync(new URL("../src/crm/followupSchedule.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /[Pp]rofessional|workStartMinute/);
});

test("proxima rodada do cron (para o diagnostico) e a descricao de cada regra", () => {
  assert.equal(nextCronRun("*/15 * * * *", new Date("2026-10-15T11:07:30Z")).toISOString(), "2026-10-15T11:15:00.000Z");
  assert.equal(nextCronRun("*/15 * * * *", new Date("2026-10-15T11:15:00Z")).toISOString(), "2026-10-15T11:30:00.000Z");
  assert.equal(sched.describeRule(RULE_NEXTDAY), "dia seguinte às 8h, só entre 8h e 12h");
  assert.equal(sched.describeRule(RULE_4H), "4h de silêncio");
});

test("contato nao comercial: motivos de transferencia por curriculo/fornecedor/parceria/cobranca saem da cascata; mensagem mista nao", () => {
  for (const r of ["Candidata a vaga de emprego (currículo)", "Fornecedor ou representante (não é paciente)", "Proposta de parceria (não é paciente)", "Cobrança/financeiro de empresa (não é paciente)"]) assert.equal(isNonCommercialHandoff(r), true, r);
  for (const r of ["Vaga de emprego + pedido de paciente na mesma mensagem", "pedido de desconto", null, ""]) assert.equal(isNonCommercialHandoff(r), false, String(r));
});

// ================================================================ 2) RECONTATO POR SILENCIO (ponta a ponta)

let seq = 0;
async function mkClinic(name, over = {}) {
  return prisma.clinic.create({
    data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, hoursByDay: JSON.stringify({ 6: [8, 15] }), closedOnHolidays: false, ...over },
  });
}
async function mkRule(clinicId, order, over = {}) {
  return prisma.followUpRule.create({
    data: { clinicId, order, name: `Regra ${order}`, afterDays: 1, afterMinutes: 240, message: `Oi, {primeiro_nome}! Recontato ${order}.`, repeatMode: "once", skipIfHumanTakeover: true, skipIfUpcomingAppt: true, active: true, ...over },
  });
}
// pessoa + conversa: a pessoa escreveu em `userAt` e a Alice respondeu 1 min depois
async function lead(clinic, { name = "Maria Teste", userAt, aliceAt, userText = "Quero saber sobre limpeza de pele", aliceText = "Claro! A limpeza de pele custa a avaliacao gratuita. Quer ver um horario?", patient = {}, conv = {} } = {}) {
  seq++;
  const p = await prisma.patient.create({ data: { clinicId: clinic.id, name, phone: `551198888${String(1000 + seq)}`, interestNote: "limpeza de pele", ...patient } });
  const c = await prisma.conversation.create({ data: { patientId: p.id, status: "active", lastMessageAt: aliceAt ?? new Date(userAt.getTime() + 60_000), ...conv } });
  await prisma.message.create({ data: { conversationId: c.id, role: "user", content: userText, createdAt: userAt } });
  if (aliceText) await prisma.message.create({ data: { conversationId: c.id, role: "assistant", content: aliceText, createdAt: aliceAt ?? new Date(userAt.getTime() + 60_000), deliveryStatus: "sent" } });
  return { p, c };
}
const reset = () => { judgeHook = null; posts.length = 0; judgeCalls.length = 0; reviewCalls.length = 0; uazapiMode = "ok"; judgeAnswer = { recontact: true, reason: "pediu informacao e sumiu" }; reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" }; process.env.AI_SEND_REVIEW = "off"; resetBreakerForTests(); };
let current = null; // clinica do teste em andamento: a rodada e dirigida a ela (testes nao se atrapalham)
const use = (c) => (current = c);
const runAt = (iso) => runFollowUpCheck({ now: sp(iso), sleep: noSleep, clinicId: current.id });
const ledgerOf = (patientId, flow = "recontato") => prisma.followUpDispatch.findMany({ where: { patientId, flow }, orderBy: { createdAt: "asc" } });
const pointer = async (c) => (await prisma.conversation.findUnique({ where: { id: c.id } })).lastFollowUpOrder;
const runRows = (clinicId, job = "recontato") => prisma.automationRun.findMany({ where: { clinicId, job }, orderBy: { finishedAt: "asc" } }); // (ordem em que as rodadas ACONTECERAM)

// cascata parecida com a da Lisboa: etapa 1 DESLIGADA no meio (caso real: so a de 1 dia foi ligada), etapa 2 "dia seguinte as 8h" e etapa 3 de 3 dias
async function freshLisboa(name = "Lisboa Recontato Teste") {
  const c = await mkClinic(name);
  await mkRule(c.id, 1, { name: "4 horas", ...RULE_4H, active: false });
  await mkRule(c.id, 2, { name: "1 dia", ...RULE_NEXTDAY, message: "Oi, {primeiro_nome}! Conseguiu pensar com calma?" });
  await mkRule(c.id, 3, { name: "3 dias", afterMinutes: 4320, afterDays: 3, message: "Oi, {primeiro_nome}! Ficou alguma duvida?" });
  return use(c);
}

test("INTEGRADO: do 'dia seguinte as 8h' (servidor em UTC, etapa 1 desligada) ate o envio, o registro no chat, o ponteiro da cascata, o controle persistente e o resumo da rodada", async () => {
  reset();
  const lisboa = await freshLisboa();
  const { p, c } = await lead(lisboa, { userAt: sp("2026-10-14T15:00") });
  await runAt("2026-10-15T07:50"); // antes da hora
  assert.equal(posts.length, 0);
  assert.equal(await pointer(c), 0);
  await runAt("2026-10-15T08:10");
  assert.equal(posts.length, 1, "uma mensagem saiu");
  assert.equal(posts[0].text, "Oi, Maria! Conseguiu pensar com calma?");
  assert.equal(await pointer(c), 2, "a etapa 1 estava desligada: a cascata PULOU para a 2 em vez de travar");
  const msg = await prisma.message.findFirst({ where: { conversationId: c.id, authorName: "Recontato automático" } });
  assert.equal(msg.content, "Oi, Maria! Conseguiu pensar com calma?");
  const rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map((r) => [r.step, r.state, r.layer]), [[2, "sent", "envio"]]);
  assert.match(rows[0].version, /^2026-10-1/);
  const runs = await runRows(lisboa.id);
  const last = runs.at(-1);
  assert.equal(last.sent, 1);
  assert.ok(last.candidates >= 1 && last.eligible >= 1);
  assert.equal(JSON.parse(last.reasons)["enviado:etapa_2"], 1);
  // a mesma hora de novo (rodada repetida): nada sai, nada duplica
  await runAt("2026-10-15T08:25");
  assert.equal(posts.length, 1);
  assert.equal((await ledgerOf(p.id)).length, 1);
  // e o conversa nao foi marcada como perdida (o bug antigo: etapa 1 desligada => "cascata esgotada")
  assert.equal((await prisma.conversation.findUnique({ where: { id: c.id } })).status, "active");
});

test("queda do servidor: depois de varios dias nao dispara VARIAS etapas velhas de uma vez; so a que ainda vale, no maximo uma por rodada", async () => {
  reset();
  // ultima mensagem ha 3,5 dias. Etapa 2 (dia seguinte) ja expirou; etapa 3 (3 dias) venceu ha 12h e ainda esta no prazo.
  const lisboa = await freshLisboa();
  await prisma.clinic.update({ where: { id: lisboa.id }, data: { followupRecoveryHours: 24 } }); // politica de recuperacao ESCOLHIDA (sem ela vale o padrao antigo, testado a seguir)
  const { p, c } = await lead(lisboa, { userAt: sp("2026-10-12T10:00") });
  await runAt("2026-10-15T22:00"); // fechado (21h): espera
  assert.equal(posts.length, 0);
  await runAt("2026-10-16T09:00");
  assert.equal(posts.length, 1, "uma so mensagem");
  assert.match(posts[0].text, /Ficou alguma duvida/, "e a da etapa 3, nao a velha");
  const rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map((r) => [r.step, r.state]).sort(), [[2, "expired"], [3, "sent"]]);
  assert.equal(rows.find((r) => r.step === 2).layer, "janela");
  assert.equal(await pointer(c), 3);
  await runAt("2026-10-16T09:20");
  assert.equal(posts.length, 1);
});

test("SEM politica de recuperacao decidida (padrao antigo): a etapa velha NAO e gravada nem reativada; so a que ainda esta dentro dos 3 dias sai, uma por rodada", async () => {
  reset();
  const lisboa = await freshLisboa(); // followupRecoveryHours = null
  assert.equal((await prisma.clinic.findUnique({ where: { id: lisboa.id } })).followupRecoveryHours, null);
  const { p } = await lead(lisboa, { userAt: sp("2026-10-12T10:00") });
  await runAt("2026-10-16T09:00");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Ficou alguma duvida/);
  assert.deepEqual((await ledgerOf(p.id)).map((r) => [r.step, r.state]), [[3, "sent"]], "a etapa 2 (vencida ha mais de 3 dias) e conversa fria: nada gravado");
  await runAt("2026-10-16T09:20");
  assert.equal(posts.length, 1);
});

test("conversa fria demais (mais de 3 dias de atraso em todas as etapas) NAO recebe nada e nada e gravado (sem reativar mensagem antiga em massa)", async () => {
  reset();
  const lisboa = await freshLisboa();
  const { p } = await lead(lisboa, { userAt: sp("2026-09-20T10:00") });
  await runAt("2026-10-16T09:00");
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(p.id)).length, 0);
  assert.ok(JSON.parse((await runRows(lisboa.id)).at(-1).reasons)["ignorado:conversa_fria"] >= 1);
});

test("regra que comeca as 12h nao envia antes das 12h (de ponta a ponta, servidor em UTC)", async () => {
  reset();
  const c12 = use(await mkClinic("Clinica 12h"));
  await mkRule(c12.id, 1, { name: "A partir das 12h", ...RULE_FROM_12 });
  const { p } = await lead(c12, { userAt: sp("2026-10-15T08:00") });
  await runAt("2026-10-15T11:50");
  assert.equal(posts.length, 0);
  await runAt("2026-10-15T12:05");
  assert.equal(posts.length, 1);
  assert.deepEqual((await ledgerOf(p.id)).map((r) => r.state), ["sent"]);
});

test("exclusoes: cliente respondeu antes do envio, ja agendou, optou por sair, sem interesse, retorno combinado no futuro, atendimento humano e contato nao comercial", async () => {
  reset();
  const lisboa = await freshLisboa();
  const base = { userAt: sp("2026-10-14T15:00") };
  const respondeu = await lead(lisboa, { ...base, name: "Respondeu" });
  await prisma.message.create({ data: { conversationId: respondeu.c.id, role: "user", content: "Ainda estou vendo os valores", createdAt: sp("2026-10-15T07:00") } });
  const agendou = await lead(lisboa, { ...base, name: "Agendou" });
  await prisma.appointment.create({ data: { clinicId: lisboa.id, patientId: agendou.p.id, procedureId: (await prisma.procedure.create({ data: { clinicId: lisboa.id, name: `Limpeza ${seq}`, durationMin: 30 } })).id, scheduledAt: sp("2026-10-20T10:00"), source: "presencial" } });
  const saiu = await lead(lisboa, { ...base, name: "Saiu", patient: { optedOut: true } });
  const semInteresse = await lead(lisboa, { ...base, name: "Sem Interesse", patient: { noInterest: true } });
  const retorno = await lead(lisboa, { ...base, name: "Retorno", patient: { callbackAt: sp("2026-10-25T10:00") } });
  const humano = await lead(lisboa, { ...base, name: "Humano", conv: { humanTakeover: true, handoffPending: true } });
  const naoComercial = await lead(lisboa, { ...base, name: "Candidata", conv: { handoffReason: "Candidata a vaga de emprego (currículo)" } });
  await runAt("2026-10-15T08:10");
  assert.equal(posts.length, 0, "ninguem dessa lista recebe recontato");
  for (const x of [respondeu, agendou, saiu, semInteresse, retorno, humano, naoComercial]) assert.equal((await ledgerOf(x.p.id)).length, 0, x.p.name);
  const reasons = JSON.parse((await runRows(lisboa.id)).at(-1).reasons);
  assert.ok(reasons["ignorado:pessoa_falou_por_ultimo"] >= 1 || reasons["ignorado:aguardando:nao_venceu"] >= 0);
  assert.ok(reasons["ignorado:ja_tem_horario"] >= 1);
  assert.ok(reasons["ignorado:contato_nao_comercial"] >= 1);
});

test("'ok'/'estarei ai' encerra o assunto; retorno combinado vencido volta a valer", async () => {
  reset();
  const lisboa = await freshLisboa();
  const ok = await lead(lisboa, { userAt: sp("2026-10-14T15:00"), name: "Ok", userText: "Obrigada!" });
  const venceu = await lead(lisboa, { userAt: sp("2026-10-14T15:00"), name: "Venceu", patient: { callbackAt: sp("2026-10-15T07:00") } });
  await runAt("2026-10-15T08:10");
  assert.equal((await ledgerOf(ok.p.id)).length, 0);
  assert.equal(posts.length, 1);
  assert.deepEqual((await ledgerOf(venceu.p.id)).map((r) => r.state), ["sent"]);
});

test("conversa EM ATENDIMENTO HUMANO parada: nao recebe recontato comercial, mas aparece no diagnostico e no relatorio (nao some)", async () => {
  reset();
  const c2 = use(await mkClinic("Clinica Parada"));
  await mkRule(c2.id, 1, RULE_4H);
  const parada = await lead(c2, { userAt: sp("2026-10-14T08:00"), conv: { humanTakeover: true, handoffPending: true, handoffReason: "pedido de desconto", lastMessageAt: sp("2026-10-14T08:05") } });
  await runAt("2026-10-15T09:00");
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(parada.p.id)).length, 0);
  const reasons = JSON.parse((await runRows(c2.id)).at(-1).reasons);
  assert.equal(reasons["ignorado:transferencia_parada_com_a_equipe"], 1);
  const report = await buildDailyReport(c2.id, TZ);
  assert.match(report, /Esperando a equipe há mais de 12h/);
});

test("a equipe (pessoa) falou ha menos de 2h: nenhum recontato comercial concorrente; passado o tempo, a cascata segue", async () => {
  reset();
  const ch = use(await mkClinic("Clinica Equipe Atendendo"));
  await mkRule(ch.id, 1, RULE_4H);
  const { p, c } = await lead(ch, { userAt: sp("2026-10-15T09:00") });
  await prisma.message.create({ data: { conversationId: c.id, role: "human", content: "Oi! Sou da recepcao, posso te ajudar?", authorName: "Recepcao", createdAt: sp("2026-10-15T12:30") } });
  await runAt("2026-10-15T13:30");
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(p.id)).length, 0);
  assert.equal(JSON.parse((await runRows(ch.id)).at(-1).reasons)["ignorado:equipe_atendendo_recentemente"], 1);
  await runAt("2026-10-15T14:45");
  assert.equal(posts.length, 1);
});

test("VETO da revisao de envio: temporario, nao consome a etapa, reavalia quando o contexto muda; definitivo so no 2o veto", async () => {
  reset();
  process.env.AI_SEND_REVIEW = "on";
  const c3 = use(await mkClinic("Clinica Veto"));
  await mkRule(c3.id, 1, RULE_4H);
  const { p, c } = await lead(c3, { userAt: sp("2026-10-15T09:00") });
  reviewDecision = { decisao: "nao_enviar", confianca: "alta", motivo: "a pessoa disse que esta de viagem" };
  await runAt("2026-10-15T13:30");
  assert.equal(posts.length, 0);
  let rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map((r) => [r.state, r.layer, r.temporary]), [["vetoed", "revisao_envio", true]]);
  assert.equal(await pointer(c), 0, "a etapa NAO foi consumida pelo veto");
  assert.ok(rows[0].reevaluateAt.getTime() > sp("2026-10-15T13:30").getTime());
  // mesma situacao, 30 min depois: nao tenta de novo (aguarda a reavaliacao), nao gasta IA
  const callsBefore = reviewCalls.length;
  await runAt("2026-10-15T14:00");
  assert.equal(reviewCalls.length, callsBefore);
  // o contexto muda (ela mudou de etapa no funil): reavalia na hora e, agora, a revisao libera
  await prisma.patient.update({ where: { id: p.id }, data: { funnelStage: "recuperacao" } });
  reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" };
  await runAt("2026-10-15T14:30");
  assert.equal(posts.length, 1);
  rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map((r) => [r.state, r.attempt]), [["sent", 2]]);
  assert.equal(await pointer(c), 1);
});

test("dois vetos da revisao = definitivo (etapa consumida, cascata segue); veredito em cache do juiz expira com o tempo e com a mudanca de contexto", async () => {
  reset();
  process.env.AI_SEND_REVIEW = "on";
  const c4 = use(await mkClinic("Clinica Veto2"));
  await mkRule(c4.id, 1, RULE_4H);
  await mkRule(c4.id, 2, { ...RULE_4H, afterMinutes: 1440, message: "Segunda etapa {primeiro_nome}" });
  const { p, c } = await lead(c4, { userAt: sp("2026-10-15T09:00") });
  reviewDecision = { decisao: "nao_enviar", confianca: "alta", motivo: "momento inadequado" };
  await runAt("2026-10-15T13:30");
  await runAt("2026-10-15T20:00"); // 6h30 depois: reavalia e barra de novo
  const rows = await ledgerOf(p.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].state, rows[0].temporary, rows[0].attempt], ["vetoed", false, 2]);
  assert.equal(await pointer(c), 1, "definitivo: a etapa foi consumida e a cascata segue para a proxima");
  assert.equal(posts.length, 0);

  // juiz: "nao" em cache so vale por poucas horas e para o mesmo contexto
  reset();
  const c4b = use(await mkClinic("Clinica Cache"));
  await mkRule(c4b.id, 1, RULE_4H);
  const { p: p2, c: c2 } = await lead(c4b, { userAt: sp("2026-10-16T09:00"), name: "Cache" });
  judgeAnswer = { recontact: false, reason: "respondeu ha pouco" };
  await runAt("2026-10-16T13:30");
  assert.equal(judgeCalls.length, 1);
  assert.equal(posts.length, 0);
  const conv = await prisma.conversation.findUnique({ where: { id: c2.id } });
  assert.equal(conv.recontactVerdict, "no");
  assert.ok(conv.recontactJudgedAt && conv.recontactFingerprint);
  // 8h depois a decisao do juiz e refeita (a situacao mudou: o tempo e parte do criterio)
  judgeAnswer = { recontact: true, reason: "agora faz sentido" };
  await runAt("2026-10-16T20:30");
  assert.equal(judgeCalls.length, 2, "o veredito antigo nao vale para sempre");
  assert.equal(posts.length, 1);
  assert.ok(p2);
});

test("falha TECNICA do juiz de IA nao e decisao de negocio: adia, registra 'incerto' e tenta de novo quando a IA volta (a mensagem sai)", async () => {
  reset();
  const c5 = use(await mkClinic("Clinica Juiz"));
  await mkRule(c5.id, 1, RULE_4H);
  const { p, c } = await lead(c5, { userAt: sp("2026-10-15T09:00") });
  judgeAnswer = null; // IA fora do ar
  await runAt("2026-10-15T13:30");
  assert.equal(posts.length, 0);
  let rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map((r) => [r.state, r.layer, r.temporary]), [["deferred", "juiz_ia", true]]);
  assert.match(rows[0].reason, /falha tecnica.*nao e decisao de negocio/);
  assert.equal(await pointer(c), 0);
  assert.equal(JSON.parse((await runRows(c5.id)).at(-1).reasons)["incerto:juiz_de_IA_indisponivel"], 1);
  judgeAnswer = { recontact: true, reason: "ok" };
  await runAt("2026-10-15T13:50"); // passou o intervalo de nova tentativa
  assert.equal(posts.length, 1);
  rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map((r) => r.state), ["sent"]);
});

test("falha do provedor: erro definitivo tenta de novo com intervalo; resultado AMBIGUO (timeout) nunca reenvia as cegas e consome a etapa", async () => {
  reset();
  const c6 = use(await mkClinic("Clinica Provedor"));
  await mkRule(c6.id, 1, RULE_4H);
  const a = await lead(c6, { userAt: sp("2026-10-15T09:00"), name: "Falha" });
  uazapiMode = "http500";
  await runAt("2026-10-15T13:30");
  assert.equal(posts.length, 0);
  assert.deepEqual((await ledgerOf(a.p.id)).map((r) => [r.state, r.layer]), [["failed", "envio"]]);
  assert.equal(await pointer(a.c), 0, "nada saiu: a etapa continua pendente");
  uazapiMode = "ok";
  await runAt("2026-10-15T13:35"); // antes do intervalo minimo entre tentativas (10 min)
  assert.equal(posts.length, 0);
  await runAt("2026-10-15T14:00");
  assert.equal(posts.length, 1);
  assert.deepEqual((await ledgerOf(a.p.id)).map((r) => [r.state, r.attempt]), [["sent", 2]]);

  const b = await lead(c6, { userAt: sp("2026-10-15T09:00"), name: "Timeout" });
  uazapiMode = "timeout";
  await runAt("2026-10-15T14:30");
  assert.deepEqual((await ledgerOf(b.p.id)).map((r) => r.state), ["unconfirmed"]);
  assert.equal(await pointer(b.c), 1, "pode ter sido entregue: etapa consumida");
  uazapiMode = "ok";
  const before = posts.length;
  await runAt("2026-10-15T15:30");
  assert.equal(posts.length, before, "nao reenvia");
  assert.equal(await prisma.message.count({ where: { conversationId: b.c.id, authorName: "Recontato automático" } }), 0, "nao registra no chat uma mensagem que pode nem ter saido");
});

test("coordenacao entre automacoes: outra automacao ha menos de 6h segura o generico; fluxo especifico em andamento nunca e acompanhado pelo generico", async () => {
  reset();
  const c7 = use(await mkClinic("Clinica Coord"));
  await mkRule(c7.id, 1, RULE_4H);
  const recente = await lead(c7, { userAt: sp("2026-10-15T09:00"), name: "Recente" });
  await prisma.message.create({ data: { conversationId: recente.c.id, role: "assistant", content: "Pesquisa de satisfacao 0 a 10", authorName: "Pesquisa de satisfação", createdAt: sp("2026-10-15T10:30"), deliveryStatus: "sent" } });
  const especifico = await lead(c7, { userAt: sp("2026-10-15T09:00"), name: "Especifico" });
  await prisma.followUpDispatch.create({ data: { clinicId: c7.id, patientId: especifico.p.id, flow: "avaliacao_cancelada", step: 1, cycleKey: "appt-x", state: "sent", attempt: 1 } });
  const livre = await lead(c7, { userAt: sp("2026-10-15T09:00"), name: "Livre" });
  await runAt("2026-10-15T13:30");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^Oi, Livre! /);
  const reasons = JSON.parse((await runRows(c7.id)).at(-1).reasons);
  assert.equal(reasons["ignorado:concorrencia:automacao_recente"], 1);
  assert.equal(reasons["ignorado:concorrencia:fluxo_especifico_em_andamento"], 1);
  assert.equal((await ledgerOf(livre.p.id)).length, 1);
  assert.equal((await ledgerOf(recente.p.id)).length, 0);
  assert.equal((await ledgerOf(especifico.p.id)).length, 0);
});

test("duas copias do servidor / rodadas sobrepostas disputando o MESMO contato: a reserva atomica deixa passar uma so", async () => {
  const key = { clinicId: "clinica-concorrencia", patientId: "p-concorrencia", conversationId: null, flow: "recontato", ruleId: "r1", step: 1, cycleKey: "1234", dueAt: new Date() };
  const results = await Promise.all([ledger.acquireFlow(key, "fp", new Date()), ledger.acquireFlow(key, "fp", new Date()), ledger.acquireFlow(key, "fp", new Date())]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.why === "in_progress" || r.why === "already_handled"));
  // reserva que o processo deixou sem desfecho vira 'unconfirmed' (nunca reenvia as cegas)
  await prisma.followUpDispatch.updateMany({ where: { patientId: "p-concorrencia" }, data: { updatedAt: new Date(Date.now() - 2 * HOUR) } });
  const again = await ledger.acquireFlow(key, "fp", new Date());
  assert.deepEqual([again.ok, again.state], [false, "unconfirmed"]);
});

test("isolamento: regras de uma clinica nao valem em outra; clinica sem regras ativas registra o motivo; Laleblu (modo loja) segue o mesmo cronograma proprio", async () => {
  reset();
  const semRegra = await mkClinic("Clinica Sem Regra");
  const loja = await mkClinic("Laleblu Teste", { businessType: "geral" });
  await mkRule(loja.id, 1, { ...RULE_4H, message: "Oi, {primeiro_nome}! Ainda tem interesse na bolsa?" });
  const x = await lead(semRegra, { userAt: sp("2026-10-15T09:00"), name: "SemRegra" });
  const y = await lead(loja, { userAt: sp("2026-10-15T09:00"), name: "Cliente" });
  use(semRegra);
  await runAt("2026-10-15T13:30");
  assert.deepEqual(posts, [], "a clinica sem regras nao envia nada (e nao usa as regras da outra)");
  use(loja);
  await runAt("2026-10-15T13:30");
  assert.deepEqual(posts.map((p) => p.text), ["Oi, Cliente! Ainda tem interesse na bolsa?"]);
  assert.equal((await ledgerOf(x.p.id)).length, 0);
  assert.equal(JSON.parse((await runRows(semRegra.id)).at(-1).reasons)["ignorado:sem_regras_ativas"], 1);
  assert.equal((await runRows(loja.id)).at(-1).sent, 1);
  assert.equal((await ledgerOf(y.p.id)).length, 1);
});

// ================================================================ 3) RETORNO COMBINADO

test("retorno combinado: se a revisao barra a mensagem, a equipe e AVISADA (a promessa feita a pessoa nao some em silencio)", async () => {
  reset();
  process.env.AI_SEND_REVIEW = "on";
  const c8 = await mkClinic("Clinica Retorno", { notifyPhone: "5511977776666", notifyEvents: "automation_failed,human_handoff,daily_report" });
  const { p } = await lead(c8, { userAt: sp("2026-10-10T09:00"), patient: { callbackAt: sp("2026-10-15T09:00") } });
  reviewDecision = { decisao: "nao_enviar", confianca: "alta", motivo: "esta no hospital" };
  const handled = await runCallbackCheck(sp("2026-10-15T10:00"), { clinicId: c8.id });
  assert.equal(handled, 1);
  assert.equal(posts.filter((x) => /retomar/.test(x.text) && x.number.endsWith("8888") === false && /Voce tinha me pedido|Você tinha me pedido/.test(x.text)).length, 0, "a mensagem ao cliente nao saiu");
  assert.ok(posts.some((x) => x.number === "5511977776666" && /NÃO foi enviado/.test(x.text)), "a equipe recebeu o aviso");
  assert.ok(p);
});

// ================================================================ 4) RETOMADA DE AVALIACAO CANCELADA

const CANCEL_TEXT = "Oi, {primeiro_nome}! 💗 Aqui é a Alice, da {unidade}. Vi que a sua avaliação não pôde acontecer. Se ainda tiver interesse, é só me responder por aqui que eu te ajudo a retomar, sem compromisso. ✨";
const MONDAY = "2026-10-19T10:00"; // segunda-feira

// clinica da retomada: avaliacao + limpeza no catalogo e a retomada de avaliacao cancelada LIGADA (segunda-feira, texto aprovado)
async function freshRet(cfg = {}) {
  const retClinic = use(await mkClinic("Clinica Retomada"));
  const evalProc = await prisma.procedure.create({ data: { clinicId: retClinic.id, name: "Avaliação Estética", durationMin: 30 } });
  const limpezaProc = await prisma.procedure.create({ data: { clinicId: retClinic.id, name: "Limpeza de Pele", durationMin: 30 } });
  await prisma.resumeFlowConfig.create({ data: { clinicId: retClinic.id, flow: "avaliacao_cancelada", enabled: true, weekday: 1, message: CANCEL_TEXT, lookbackDays: 7, maxPerRun: 10, maxPerDay: 20, enabledAt: sp("2026-10-12T09:00"), ...cfg } });
  return { retClinic, evalProc, limpezaProc };
}

async function cancelada(R, over = {}, procedureId = R.evalProc.id) {
  const { retClinic } = R;
  const l = await lead(retClinic, { userAt: sp("2026-10-12T10:00"), aliceAt: sp("2026-10-12T10:01"), name: over.name ?? "Paciente", patient: over.patient ?? {}, conv: over.conv ?? {} });
  const a = await prisma.appointment.create({
    data: { clinicId: retClinic.id, patientId: l.p.id, procedureId, scheduledAt: over.scheduledAt ?? sp("2026-10-17T14:00"), status: "cancelled", source: "whatsapp", cancelledAt: "cancelledAt" in over ? over.cancelledAt : sp("2026-10-16T11:00"), cancelSource: "cancelSource" in over ? over.cancelSource : "paciente_whatsapp" },
  });
  return { ...l, a };
}
const runResume = (iso) => runResumeFlows({ now: sp(iso), sleep: noSleep, clinicId: current.id });

test("avaliacao cancelada ELEGIVEL: o convite sai (sem dizer que desistiu, sem motivo inventado, sem desconto e sem horarios), e fica registrado", async () => {
  reset();
  const R = await freshRet(); const retClinic = R.retClinic;
  const x = await cancelada(R, { name: "Elegivel Uma" });
  await runResume(MONDAY);
  assert.equal(posts.length, 1);
  const text = posts[0].text;
  assert.match(text, /^Oi, Elegivel! /);
  assert.match(text, /Clinica Retomada/);
  assert.doesNotMatch(text, /desist|descont|promo|gratis|gratuit|\d{1,2}:\d{2}|hor[aá]rio/i, text);
  assert.deepEqual((await ledgerOf(x.p.id, "avaliacao_cancelada")).map((r) => [r.state, r.layer, r.cycleKey === x.a.id]), [["sent", "envio", true]]);
  const chat = await prisma.message.findFirst({ where: { authorName: "Retomada de avaliação", conversation: { patientId: x.p.id } } });
  assert.ok(chat, "a mensagem aparece no chat");
  assert.equal((await runRows(retClinic.id, "retomada-avaliacao-cancelada")).at(-1).sent, 1);
  // rodada repetida no mesmo dia: nao duplica
  await runResume("2026-10-19T10:20");
  assert.equal(posts.length, 1);
});

test("a janela e do que a CLINICA configurou: desligada, sem texto, outro dia da semana ou fora do horario nao enviam", async () => {
  reset();
  const R = await freshRet(); const retClinic = R.retClinic;
  await cancelada(R, { name: "Janela" });
  await runResume("2026-10-20T10:00"); // terca
  assert.equal(posts.length, 0);
  await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: retClinic.id, flow: "avaliacao_cancelada" } }, data: { startHour: 14, endHour: 16 } });
  await runResume(MONDAY); // segunda, mas 10h (janela 14h-16h)
  assert.equal(posts.length, 0);
  await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: retClinic.id, flow: "avaliacao_cancelada" } }, data: { startHour: null, endHour: null, enabled: false } });
  await runResume(MONDAY);
  assert.equal(posts.length, 0);
  assert.equal(JSON.parse((await runRows(retClinic.id, "retomada-avaliacao-cancelada")).at(-1).reasons)["ignorado:fluxo_desligado"], 1);
  await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: retClinic.id, flow: "avaliacao_cancelada" } }, data: { enabled: true, message: "   " } });
  await runResume(MONDAY);
  assert.equal(posts.length, 0, "sem texto aprovado nao envia");
  await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: retClinic.id, flow: "avaliacao_cancelada" } }, data: { message: CANCEL_TEXT } });
  await runResume(MONDAY); // tudo certo de novo: agora sai
  assert.equal(posts.length, 1);
});

test("NAO entram: remarcou (cancelamento seguido de remarcacao), nova reserva com outro id, avaliacao feita depois, procedimento que nao e avaliacao, falta, cancelamento sem prova", async () => {
  reset();
  const R = await freshRet(); const { retClinic, evalProc, limpezaProc } = R;
  const remarcou = await cancelada(R, { name: "Remarcou" });
  await prisma.appointment.create({ data: { clinicId: retClinic.id, patientId: remarcou.p.id, procedureId: evalProc.id, scheduledAt: sp("2026-10-23T10:00"), source: "whatsapp", status: "confirmed" } });
  const outroId = await cancelada(R, { name: "OutroId" });
  await prisma.appointment.create({ data: { clinicId: retClinic.id, patientId: outroId.p.id, procedureId: evalProc.id, scheduledAt: sp("2026-10-16T09:00"), source: "presencial", status: "confirmed", createdAt: sp("2026-10-16T11:05") } }); // reserva nova criada logo apos o cancelamento (outro uuid)
  const feita = await cancelada(R, { name: "Feita" });
  await prisma.appointment.create({ data: { clinicId: retClinic.id, patientId: feita.p.id, procedureId: evalProc.id, scheduledAt: sp("2026-10-18T10:00"), source: "presencial", status: "completed" } });
  const naoAvaliacao = await cancelada(R, { name: "Limpeza" }, limpezaProc.id);
  const faltou = await lead(retClinic, { userAt: sp("2026-10-12T10:00"), name: "Faltou" });
  await prisma.appointment.create({ data: { clinicId: retClinic.id, patientId: faltou.p.id, procedureId: evalProc.id, scheduledAt: sp("2026-10-16T14:00"), status: "no_show", source: "whatsapp" } });
  const apagada = await cancelada(R, { name: "Apagada", cancelSource: "ce_apagada" });
  const desfeita = await cancelada(R, { name: "Desfeita", cancelSource: "sistema_desfeito" });
  const semOrigem = await cancelada(R, { name: "SemOrigem", cancelSource: null });
  const antiga = await cancelada(R, { name: "Antiga", cancelledAt: null }); // cancelado antes do registro existir
  await runResume(MONDAY);
  assert.equal(posts.length, 0, posts.map((p) => p.text).join(" | "));
  for (const x of [remarcou, outroId, feita, naoAvaliacao, faltou, antiga]) assert.equal((await ledgerOf(x.p.id, "avaliacao_cancelada")).filter((r) => r.state === "sent").length, 0, x.p.name);
  // remarcou/outroId/feita: exclusao DEFINITIVA registrada; sem prova: pendencia registrada, com o motivo
  assert.match((await ledgerOf(remarcou.p.id, "avaliacao_cancelada"))[0].reason, /ja_remarcou_ou_tem_nova_reserva/);
  assert.match((await ledgerOf(outroId.p.id, "avaliacao_cancelada"))[0].reason, /ja_remarcou_ou_tem_nova_reserva/);
  assert.match((await ledgerOf(feita.p.id, "avaliacao_cancelada"))[0].reason, /ja_remarcou_ou_tem_nova_reserva/);
  for (const [x, why] of [[apagada, /Clinica Experts/], [desfeita, /desfeita pelo sistema/], [semOrigem, /sem origem/]]) {
    const row = (await ledgerOf(x.p.id, "avaliacao_cancelada"))[0];
    assert.deepEqual([row.state, row.layer], ["skipped", "elegibilidade"], x.p.name);
    assert.match(row.reason, /origem_nao_comprovada/);
    assert.match(row.reason, why);
  }
  // as origens que provam
  for (const s of ["paciente_whatsapp", "equipe_painel", "api_externa", "ce_cancelada"]) assert.equal(cancelEvidence({ cancelledAt: new Date(), cancelSource: s }).ok, true, s);
  assert.equal(cancelEvidence({ cancelledAt: null, cancelSource: "paciente_whatsapp" }).ok, false);
});

test("NAO entram (temporario ou por escolha da pessoa): sem interesse, pediu para parar, retorno combinado futuro, atendimento humano, conversa em andamento, recontato recente, cancelamento antigo", async () => {
  reset();
  const R = await freshRet(); const retClinic = R.retClinic;
  const semInteresse = await cancelada(R, { name: "SemInt", patient: { noInterest: true } });
  const saiu = await cancelada(R, { name: "Saiu", patient: { optedOut: true } });
  const retorno = await cancelada(R, { name: "Retorno", patient: { callbackAt: sp("2026-10-30T10:00") } });
  const humano = await cancelada(R, { name: "Humano", conv: { humanTakeover: true } });
  const falando = await cancelada(R, { name: "Falando" });
  await prisma.message.create({ data: { conversationId: falando.c.id, role: "user", content: "Oi, pode me ajudar?", createdAt: sp("2026-10-19T09:30") } });
  await prisma.conversation.update({ where: { id: falando.c.id }, data: { lastMessageAt: sp("2026-10-19T09:30") } });
  const recontatada = await cancelada(R, { name: "Recontatada" });
  await prisma.message.create({ data: { conversationId: recontatada.c.id, role: "assistant", content: "Oi! Conseguiu pensar?", authorName: "Recontato automático", createdAt: sp("2026-10-18T10:00"), deliveryStatus: "sent" } });
  const velha = await cancelada(R, { name: "Velha", cancelledAt: sp("2026-10-05T11:00") });
  await runResume(MONDAY);
  assert.equal(posts.length, 0, posts.map((p) => p.text).join(" | "));
  const reasons = JSON.parse((await runRows(retClinic.id, "retomada-avaliacao-cancelada")).at(-1).reasons);
  for (const k of ["ignorado:sem_interesse", "ignorado:pediu_para_nao_receber", "ignorado:retorno_combinado_futuro", "ignorado:atendimento_humano_em_curso", "ignorado:conversa_em_andamento"]) assert.ok(reasons[k] >= 1, k);
  assert.ok(Object.keys(reasons).some((k) => /contato_equivalente_recente|concorrencia/.test(k)));
  assert.equal((await ledgerOf(velha.p.id, "avaliacao_cancelada")).length, 0, "cancelamento fora dos 7 dias nem e candidato (nada de mensagem antiga em massa)");
  // exclusoes por ESCOLHA da pessoa ficam registradas como definitivas; as temporarias nao viram linha
  assert.equal((await ledgerOf(semInteresse.p.id, "avaliacao_cancelada"))[0].state, "skipped");
  assert.equal((await ledgerOf(saiu.p.id, "avaliacao_cancelada"))[0].state, "skipped");
  assert.equal((await ledgerOf(retorno.p.id, "avaliacao_cancelada")).length, 0);
  assert.equal((await ledgerOf(humano.p.id, "avaliacao_cancelada")).length, 0);
  assert.ok(recontatada);
});

test("limites: no maximo maxPerRun por rodada e maxPerDay por dia (nada de disparo em massa)", async () => {
  reset();
  const R = await freshRet({ maxPerRun: 2, maxPerDay: 3 }); const retClinic = R.retClinic;
  for (let i = 0; i < 5; i++) await cancelada(R, { name: `Lote${i}` });
  await runResume(MONDAY);
  assert.equal(posts.length, 2);
  await runResume("2026-10-19T10:20");
  assert.equal(posts.length, 3, "o teto do dia (3) vale mesmo que sobrem candidatas");
  await runResume("2026-10-19T10:40");
  assert.equal(posts.length, 3);
  assert.ok(retClinic);
});

test("juiz de IA e revisao de envio nas retomadas: veto temporario reavaliavel; falha da IA e provedor nao viram decisao de negocio", async () => {
  reset();
  const R = await freshRet(); const retClinic = R.retClinic;
  const v = await cancelada(R, { name: "Juiz" });
  judgeAnswer = { recontact: false, reason: "a pessoa reclamou do atendimento" };
  await runResume(MONDAY);
  assert.equal(posts.length, 0);
  assert.deepEqual((await ledgerOf(v.p.id, "avaliacao_cancelada")).map((r) => [r.state, r.layer, r.temporary]), [["vetoed", "juiz_ia", true]]);
  judgeAnswer = null;
  await prisma.followUpDispatch.updateMany({ where: { patientId: v.p.id }, data: { reevaluateAt: sp("2026-10-19T09:00") } });
  await runResume("2026-10-19T10:30");
  assert.equal((await ledgerOf(v.p.id, "avaliacao_cancelada"))[0].state, "deferred");
  judgeAnswer = { recontact: true, reason: "ok" };
  uazapiMode = "http500";
  await runResume("2026-10-19T10:50");
  assert.equal((await ledgerOf(v.p.id, "avaliacao_cancelada"))[0].state, "failed");
  uazapiMode = "ok";
  await runResume("2026-10-19T11:10");
  assert.equal(posts.length, 1);
  assert.equal((await ledgerOf(v.p.id, "avaliacao_cancelada"))[0].state, "sent");
  assert.ok(retClinic);
});

test("a retomada reconhece o cancelamento pelo registro de ORIGEM: cada ponto que cancela grava cancelledAt + cancelSource (e o rollback do sistema NAO e desistencia)", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  assert.match(read("../src/ai/alice.ts"), /status: "cancelled", cancelledAt: new Date\(\), cancelSource: "sistema_desfeito"/);
  assert.match(read("../src/ai/alice.ts"), /status: "cancelled", cancelledAt: new Date\(\), cancelSource: "paciente_whatsapp"/);
  assert.match(read("../src/api/routes.ts"), /cancelSource: "equipe_painel"/);
  assert.match(read("../src/api/external/router.ts"), /cancelSource: "api_externa"/);
  assert.match(read("../src/clinicaexperts/liveCheck.ts"), /"ce_apagada" : "ce_cancelada"/);
  assert.match(read("../src/clinicaexperts/pull.ts"), /cancelSource = "ce_cancelada"/);
});

// ================================================================ 5) AVALIACAO REALIZADA SEM FECHAMENTO

test("sem fechamento: so recebe quem a EQUIPE marcou; a sugestao nao dispara; fechou/remarcou fica inelegivel", async () => {
  reset();
  const noClose = use(await mkClinic("Clinica Sem Fechamento"));
  const ev = await prisma.procedure.create({ data: { clinicId: noClose.id, name: "Avaliação Estética", durationMin: 30 } });
  const proc = await prisma.procedure.create({ data: { clinicId: noClose.id, name: "Peeling", durationMin: 30 } });
  await prisma.resumeFlowConfig.create({ data: { clinicId: noClose.id, flow: "avaliacao_sem_fechamento", enabled: true, message: "Oi, {primeiro_nome}! 💗 Aqui é a Alice, da {unidade}. Passando para saber como você está depois da sua avaliação. ✨", lookbackDays: 7 } });
  const mk = async (name, extra = {}) => {
    const l = await lead(noClose, { userAt: sp("2026-10-10T10:00"), name });
    await prisma.appointment.create({ data: { clinicId: noClose.id, patientId: l.p.id, procedureId: ev.id, scheduledAt: sp("2026-10-14T10:00"), status: "completed", source: "presencial" } });
    return { ...l, ...extra };
  };
  const marcada = await mk("Marcada");
  const naoMarcada = await mk("NaoMarcada");
  const fechou = await mk("Fechou");
  await prisma.appointment.create({ data: { clinicId: noClose.id, patientId: fechou.p.id, procedureId: proc.id, scheduledAt: sp("2026-10-16T10:00"), status: "completed", source: "presencial" } });
  const sugestoes = await suggestNoCloseCandidates(noClose.id, 30, sp("2026-10-19T09:00"));
  assert.deepEqual(sugestoes.map((s) => s.name).sort(), ["Marcada", "NaoMarcada"], "quem fechou nao e sugerido");
  await runResume(MONDAY);
  assert.equal(posts.length, 0, "nao marcou ninguem: nada sai (nunca varre todas as avaliadas)");
  assert.deepEqual(await markResumeTarget(noClose.id, marcada.p.id, "Recepcao", "disse que ia pensar"), { ok: true, id: (await prisma.resumeTarget.findFirst({ where: { patientId: marcada.p.id } })).id });
  assert.equal((await markResumeTarget(noClose.id, "pessoa-de-outra-clinica", "Recepcao", null)).ok, false);
  await markResumeTarget(noClose.id, fechou.p.id, "Recepcao", null);
  await runResume("2026-10-19T10:30");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^Oi, Marcada! /);
  assert.equal((await prisma.resumeTarget.findFirst({ where: { patientId: marcada.p.id } })).status, "sent");
  const fRow = await prisma.resumeTarget.findFirst({ where: { patientId: fechou.p.id } });
  assert.equal(fRow.status, "ineligible");
  assert.match(fRow.resultNote, /ja_remarcou_ou_tem_nova_reserva/);
  assert.ok(naoMarcada);
  // quem ja recebeu nao pode ser marcada de novo por 30 dias
  assert.equal((await markResumeTarget(noClose.id, marcada.p.id, "Recepcao", null)).ok, false);
});

// ================================================================ 6) DIAGNOSTICO E CONFIGURACAO DA LISBOA

test("diagnostico: distingue 'nao rodou', 'rodou sem candidatas', 'todas excluidas' e 'rodou e enviou', com a ultima e a proxima rodada", async () => {
  reset();
  const dc = use(await mkClinic("Clinica Diagnostico"));
  await mkRule(dc.id, 1, RULE_4H);
  let diag = (await diagnoseJobs(dc.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T14:00"))).find((j) => j.job === "recontato");
  assert.equal(diag.state, "nunca_rodou");
  await runAt("2026-10-15T13:30");
  diag = (await diagnoseJobs(dc.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T13:40"))).find((j) => j.job === "recontato");
  assert.equal(diag.state, "rodou_sem_candidatas");
  assert.equal(diag.nextRunAt.toISOString(), sp("2026-10-15T13:45").toISOString());
  await lead(dc, { userAt: sp("2026-10-15T09:00"), patient: { optedOut: true } });
  await runAt("2026-10-15T13:45");
  diag = (await diagnoseJobs(dc.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T13:50"))).find((j) => j.job === "recontato");
  assert.equal(diag.candidates, 0, "quem optou por sair nem e candidata");
  await lead(dc, { userAt: sp("2026-10-15T09:00"), name: "Ja Agendada" }).then(async ({ p }) => prisma.appointment.create({ data: { clinicId: dc.id, patientId: p.id, procedureId: (await prisma.procedure.create({ data: { clinicId: dc.id, name: "Proc A", durationMin: 30 } })).id, scheduledAt: sp("2026-10-20T10:00"), source: "presencial" } }));
  await runAt("2026-10-15T14:00");
  diag = (await diagnoseJobs(dc.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T14:05"))).find((j) => j.job === "recontato");
  assert.equal(diag.state, "todas_excluidas");
  assert.ok(diag.topReasons.some((r) => r.reason === "ignorado:ja_tem_horario"));
  await lead(dc, { userAt: sp("2026-10-15T09:00"), name: "Livre" });
  await runAt("2026-10-15T14:15");
  diag = (await diagnoseJobs(dc.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T14:20"))).find((j) => j.job === "recontato");
  assert.equal(diag.state, "rodou_e_enviou");
  assert.equal(diag.sent, 1);
  // 1 hora depois sem nenhuma rodada: o job "nao rodou no prazo"
  diag = (await diagnoseJobs(dc.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T16:30"))).find((j) => j.job === "recontato");
  assert.equal(diag.state, "nao_rodou_no_prazo");
});

test("relatorio das 20h usa o resultado PERSISTIDO (enviado x nao confirmado x barrado x adiado) e avisa quando o job nao rodou", async () => {
  reset();
  const rc = use(await mkClinic("Clinica Relatorio"));
  await mkRule(rc.id, 1, { ...RULE_4H, name: "4 horas" });
  const s = await lead(rc, { userAt: sp("2026-10-15T09:00"), name: "Saiu" });
  const t = await lead(rc, { userAt: sp("2026-10-15T09:00"), name: "Timeout" });
  uazapiMode = "ok";
  const spy = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/send/text") && JSON.parse(init.body).number.endsWith(String(t.p.phone).slice(-4))) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    first = false;
    return spy(url, init);
  };
  try { await runAt("2026-10-15T13:30"); } finally { globalThis.fetch = spy; }
  assert.ok(first === false || first === true);
  const nowReal = Date.now();
  // o relatorio olha "hoje" no relogio real; reescreve as linhas do ledger para hoje para conferir o texto
  await prisma.followUpDispatch.updateMany({ where: { clinicId: rc.id }, data: { decidedAt: new Date(nowReal) } });
  await prisma.automationRun.updateMany({ where: { clinicId: rc.id }, data: { startedAt: new Date(nowReal - 60_000) } });
  const text = await buildDailyReport(rc.id, TZ);
  assert.match(text, /Recontatos\*: 1 enviado\(s\) hoje/);
  assert.match(text, /1 sem confirmação do provedor \(não reenviado\)/);
  assert.match(text, /O job rodou \d+ vez\(es\) hoje/);
  assert.match(text, /4 horas \(4h de silêncio\)/);
  assert.ok(s);
  await prisma.automationRun.deleteMany({ where: { clinicId: rc.id } });
  const sem = await buildDailyReport(rc.id, TZ);
  assert.match(sem, /O job de recontato NÃO rodou hoje/);
});

test("Lisboa: a reconferencia mostra a matriz, os conflitos e as perguntas; a previa nao grava; criar a configuracao e idempotente e nasce DESLIGADA e sem texto; ligar exige aprovacao", async () => {
  const lc = await mkClinic("Lisboa Beauty Center");
  const outra = await mkClinic("Outra Clinica Qualquer");
  const r1 = await prisma.followUpRule.create({ data: { clinicId: lc.id, order: 1, name: "Recontato Lisboa - 4 horas", afterDays: 1, afterMinutes: 240, message: "m1", active: true } });
  await prisma.followUpRule.create({ data: { clinicId: lc.id, order: 2, name: "Recontato Lisboa - 1 dia", afterDays: 1, afterMinutes: 1440, nextDayHour: 8, sendWindowStart: 8, sendWindowEnd: 12, message: "m2", active: true } });
  await prisma.followUpRule.create({ data: { clinicId: lc.id, order: 3, name: "Recontato Lisboa - 3 dias", afterDays: 3, afterMinutes: 4320, message: "m3", active: false } });
  const previa = await conferirRecontatosLisboa(lc.id, { dryRun: true });
  assert.equal(previa.dryRun, true);
  assert.deepEqual(previa.regras.map((r) => [r.ordem, r.ativa, r.quando]), [[1, true, "4h de silêncio"], [2, true, "dia seguinte às 8h, só entre 8h e 12h"], [3, false, "3 dia(s) de silêncio"]]);
  assert.ok(previa.conflitos.some((c) => /MESMO início de manhã/.test(c)), "a colisao entre a etapa de 4h e a do dia seguinte e apontada");
  assert.ok(previa.perguntasPendentes.some((q) => /8h .*12h/.test(q)), "pergunta objetiva sobre 8h x 12h");
  assert.ok(previa.perguntasPendentes.some((q) => /segundas/.test(q)));
  assert.equal(previa.exemploDeConversa.length, 3);
  const noite = previa.exemploDeConversa.find((e) => /20h/.test(e.fim));
  assert.equal(noite.etapas.find((e) => e.ordem === 1).podeSairEm, "terça 08h00", "conversa de segunda 20h: 4h vence 00h, abre terça 8h");
  assert.equal(await prisma.resumeFlowConfig.count({ where: { clinicId: lc.id } }), 0, "previa nao grava");
  assert.equal((await prisma.followUpRule.findUnique({ where: { id: r1.id } })).active, true, "nao liga/desliga nenhum recontato");

  const ap = await conferirRecontatosLisboa(lc.id, { dryRun: false, actorName: "Admin" });
  assert.deepEqual(ap.aplicado.configuracoesCriadas.sort(), ["avaliacao_cancelada", "avaliacao_sem_fechamento"]);
  const cfg = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId: lc.id, flow: "avaliacao_cancelada" } } });
  assert.deepEqual([cfg.enabled, cfg.weekday, cfg.startHour, cfg.message], [false, 1, null, null]);
  const again = await conferirRecontatosLisboa(lc.id, { dryRun: false });
  assert.deepEqual(again.aplicado.configuracoesCriadas, [], "idempotente");
  await assert.rejects(conferirRecontatosLisboa(lc.id, { dryRun: false, ativar: { fluxo: "avaliacao_cancelada", aprovadoPor: "", mensagem: "x" } }), /quem aprovou/);
  await assert.rejects(conferirRecontatosLisboa(lc.id, { dryRun: false, ativar: { fluxo: "avaliacao_cancelada", aprovadoPor: "Dra. Aline" } }), /texto aprovado/);
  const on = await conferirRecontatosLisboa(lc.id, { dryRun: false, ativar: { fluxo: "avaliacao_cancelada", aprovadoPor: "Dra. Aline", mensagem: CANCEL_TEXT, diaDaSemana: 1, horaInicio: 10, horaFim: 12 } });
  assert.deepEqual(on.aplicado.ligadas, ["avaliacao_cancelada"]);
  const ligada = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId: lc.id, flow: "avaliacao_cancelada" } } });
  assert.deepEqual([ligada.enabled, ligada.weekday, ligada.startHour, ligada.endHour, ligada.updatedBy], [true, 1, 10, 12, "aprovado por Dra. Aline"]);
  // a outra clinica nao foi tocada
  assert.equal(await prisma.resumeFlowConfig.count({ where: { clinicId: outra.id } }), 0);
});

test("rotas: diagnostico (clinica propria), configuracao da retomada, marcacao pela equipe e reconferencia da Lisboa (so admin, previa por padrao)", () => {
  const routes = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  const bloco = /"\/clinics\/lisboa-recontatos"[\s\S]{0,1600}/.exec(routes)?.[0] ?? "";
  assert.match(bloco, /requireAdmin\(req, res\)/);
  assert.match(bloco, /name: "Lisboa Beauty Center"/);
  assert.match(bloco, /dryRun: b\.dryRun !== false/);
  assert.match(routes, /"\/automations\/diagnostico"/);
  assert.match(routes, /"\/retomadas\/config\/:flow"/);
  assert.match(routes, /Para ligar a retomada informe o texto aprovado/);
  assert.match(routes, /"\/patients\/:id\/retomada-pos-avaliacao"/);
  assert.match(routes, /assertClinicAccess\(req, res, patient\.clinicId\)/);
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /startResumeFlowsJob\(\)/);
});


// ================================================================ 5) MODO RESTRITO (validacao controlada com contatos de teste)

const restringe = (R, pessoas, limite = 1, fluxo = "avaliacao_cancelada") =>
  conferirRecontatosLisboa(R.retClinic.id, { dryRun: false, modoRestrito: { fluxo, aprovadoPor: "Dono (teste)", telefones: pessoas.map((x) => x.p.phone), limite } });
const configRow = (clinicId, flow = "avaliacao_cancelada") => prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow } } });

test("RESTRITO: so o contato de teste autorizado recebe; os demais NAO sao lidos, nao ganham registro de controle e o modo fica gravado na rodada e na decisao", async () => {
  reset();
  const R = await freshRet();
  const a = await cancelada(R, { name: "Autorizada Teste" });
  const b = await cancelada(R, { name: "Outra Paciente" });
  const c = await cancelada(R, { name: "Terceira Paciente" });
  const res = await restringe(R, [a], 1);
  assert.deepEqual(res.aplicado.restritas, ["avaliacao_cancelada"]);
  assert.equal(res.retomadas.find((r) => r.fluxo === "avaliacao_cancelada").modo, "restrito");
  await runResume(MONDAY);
  assert.deepEqual(posts.map((p) => p.number), [a.p.phone], "so o contato autorizado recebeu");
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: { in: [b.p.id, c.p.id] } } }), 0, "os demais nem ganharam registro de controle");
  const rowA = (await ledgerOf(a.p.id, "avaliacao_cancelada"))[0];
  assert.equal(rowA.state, "sent");
  assert.equal(rowA.runMode, "restrito", "o modo em que a decisao foi tomada fica gravado");
  const run = (await runRows(R.retClinic.id, "retomada-avaliacao-cancelada")).at(-1);
  assert.equal(run.mode, "restrito");
  assert.equal(run.sent, 1);
});

test("RESTRITO: o limite do teste vale entre rodadas (mesmo com mais contatos autorizados e com o teto do dia folgado)", async () => {
  reset();
  const R = await freshRet({ maxPerRun: 10, maxPerDay: 20 });
  const a = await cancelada(R, { name: "Teste Um" });
  const b = await cancelada(R, { name: "Teste Dois" });
  await restringe(R, [a, b], 1);
  await runResume(MONDAY);
  assert.equal(posts.length, 1, "o limite do teste e 1, embora 2 contatos estejam autorizados e o teto do dia seja 20");
  await runResume("2026-10-19T10:30");
  await runResume("2026-10-19T11:00");
  assert.equal(posts.length, 1, "rodadas seguintes nao passam do limite");
  const last = (await runRows(R.retClinic.id, "retomada-avaliacao-cancelada")).at(-1);
  assert.equal(JSON.parse(last.reasons)["ignorado:limite_do_teste_atingido"], 1);
  // so a autorizada que ja recebeu tem registro; a outra autorizada ficou sem enviar (limite), sem registro de tentativa consumida
  assert.equal(await prisma.followUpDispatch.count({ where: { flow: "avaliacao_cancelada", patientId: { in: [a.p.id, b.p.id] }, state: "sent" } }), 1);
});

test("RESTRITO invalido NUNCA libera todos: lista vazia, JSON quebrado, ids de outra clinica, limite ausente/zero/enorme, inicio ausente e modo desconhecido bloqueiam a rodada inteira", async () => {
  reset();
  const R = await freshRet();
  const alvo = await cancelada(R, { name: "Alvo Bloqueado" });
  const outraClinica = await mkClinic("Outra Clinica Restrita");
  const estranho = (await lead(outraClinica, { userAt: sp("2026-10-12T10:00"), name: "De Outra Clinica" })).p;
  const base = { runMode: "restrito", testPatientIds: JSON.stringify([alvo.p.id]), testMaxSends: 3, testStartedAt: sp("2026-10-19T00:00") };
  const variantes = {
    "lista nula": { testPatientIds: null },
    "lista vazia": { testPatientIds: "[]" },
    "json quebrado": { testPatientIds: "[nao-e-json" },
    "nao e lista": { testPatientIds: JSON.stringify({ id: alvo.p.id }) },
    "item que nao e texto": { testPatientIds: JSON.stringify([alvo.p.id, 7]) },
    "so id de outra clinica": { testPatientIds: JSON.stringify([estranho.id]) },
    "limite ausente": { testMaxSends: null },
    "limite zero": { testMaxSends: 0 },
    "limite enorme": { testMaxSends: 5000 },
    "inicio ausente": { testStartedAt: null },
    "modo desconhecido": { runMode: "teste" },
  };
  for (const [nome, over] of Object.entries(variantes)) {
    await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: R.retClinic.id, flow: "avaliacao_cancelada" } }, data: { ...base, ...over } });
    await runResume(MONDAY);
    assert.equal(posts.length, 0, `${nome}: nada pode ser enviado`);
    assert.equal(await prisma.followUpDispatch.count({ where: { patientId: alvo.p.id } }), 0, `${nome}: nenhum registro de controle foi criado`);
  }
  const reasons = JSON.parse((await runRows(R.retClinic.id, "retomada-avaliacao-cancelada")).at(-1).reasons);
  assert.ok(reasons["ignorado:modo_restrito_invalido"] >= 1);
  // e a configuracao valida volta a funcionar (prova que o bloqueio era mesmo pela configuracao)
  await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: R.retClinic.id, flow: "avaliacao_cancelada" } }, data: base });
  await runResume(MONDAY);
  assert.equal(posts.length, 1);
});

test("RESTRITO: a restricao e REVALIDADA imediatamente antes do envio (a configuracao muda enquanto o juiz de IA ainda esta lendo)", async () => {
  reset();
  const R = await freshRet();
  const a = await cancelada(R, { name: "Muda No Meio" });
  const b = await cancelada(R, { name: "Nova Autorizada" });
  await restringe(R, [a], 2);
  judgeHook = async () => { // depois de selecionar e reservar, alguem troca a lista de teste para OUTRA pessoa
    judgeHook = null;
    await prisma.resumeFlowConfig.update({ where: { clinicId_flow: { clinicId: R.retClinic.id, flow: "avaliacao_cancelada" } }, data: { testPatientIds: JSON.stringify([b.p.id]) } });
  };
  await runResume(MONDAY);
  assert.equal(posts.length, 0, "a primeira pessoa deixou de ser autorizada antes do envio: nao sai");
  const row = (await ledgerOf(a.p.id, "avaliacao_cancelada"))[0];
  assert.equal(row.state, "deferred");
  assert.equal(row.layer, "politica");
  assert.match(row.reason, /fora_da_selecao_de_teste/);
  assert.equal(row.temporary, true);
});

test("RESTRITO vale tambem fora da rodada: chamada DIRETA ao envio e nova tentativa nao alcancam quem nao e contato de teste", async () => {
  reset();
  const R = await freshRet();
  const a = await cancelada(R, { name: "Direta Autorizada" });
  const b = await cancelada(R, { name: "Direta Fora" });
  await restringe(R, [a], 2);
  assert.equal(await sendText(R.retClinic.id, b.p.phone, "Oi! Mensagem de retomada de teste para quem nao esta autorizada.", { kind: "retomada", flow: "avaliacao_cancelada" }), "blocked");
  assert.equal(await sendText(R.retClinic.id, b.p.phone, "Oi! Mensagem de retomada sem informar o fluxo, para quem nao esta autorizada.", { kind: "retomada" }), "blocked", "sem informar o fluxo vale o mais restritivo");
  assert.equal(posts.length, 0);
  assert.equal(await sendText(R.retClinic.id, a.p.phone, "Oi! Mensagem de retomada de teste para a pessoa autorizada.", { kind: "retomada", flow: "avaliacao_cancelada" }), "sent");
  assert.deepEqual(posts.map((p) => p.number), [a.p.phone]);
  // nova tentativa depois de falha do provedor: o contato foi retirado da lista de teste => nao tenta de novo
  uazapiMode = "http500";
  const c = await cancelada(R, { name: "Falha Depois Fora" });
  await restringe(R, [c], 3);
  await runResume(MONDAY);
  assert.equal((await ledgerOf(c.p.id, "avaliacao_cancelada"))[0].state, "failed");
  uazapiMode = "ok";
  await restringe(R, [a], 3); // c saiu da lista
  await runResume("2026-10-19T11:00");
  assert.equal(posts.filter((p) => p.number === c.p.phone).length, 0, "a nova tentativa respeita a lista atual: quem saiu da lista de teste nao recebe");
  // outros tipos de envio nao sao afetados (a restricao e das retomadas/convite)
  assert.equal(await sendText(R.retClinic.id, b.p.phone, "Mensagem comum que nao e retomada nem convite de indicacao.", { kind: "lembrete" }), "sent");
});

test("RESTRITO e do convite de indicacao tambem, e uma pessoa de OUTRA clinica nunca vira contato de teste", async () => {
  reset();
  const R = await freshRet();
  const a = await cancelada(R, { name: "Indica Autorizada" });
  const b = await cancelada(R, { name: "Indica Fora" });
  const outraClinica = await mkClinic("Clinica Alheia Indicacao");
  const alheia = (await lead(outraClinica, { userAt: sp("2026-10-12T10:00"), name: "Alheia" })).p;
  await prisma.resumeFlowConfig.create({ data: { clinicId: R.retClinic.id, flow: "indicacao", enabled: true, message: "Se tiver uma amiga, compartilhe o nosso contato. 💗", delayMinutes: 60, startHour: null, endHour: null } });
  const recusa = await conferirRecontatosLisboa(R.retClinic.id, { dryRun: true, modoRestrito: { fluxo: "indicacao", aprovadoPor: "x", telefones: [alheia.phone], limite: 1 } });
  assert.equal(recusa.modoRestrito.valido, false);
  assert.match(recusa.modoRestrito.problemas.join(" "), /sem paciente nesta clinica/);
  await assert.rejects(() => conferirRecontatosLisboa(R.retClinic.id, { dryRun: false, modoRestrito: { fluxo: "indicacao", aprovadoPor: "x", telefones: [alheia.phone], limite: 1 } }), /Modo restrito recusado/);
  assert.equal((await configRow(R.retClinic.id, "indicacao")).runMode, "normal", "pedido recusado nao altera nada");
  await restringe(R, [a], 1, "indicacao");
  assert.equal(await sendText(R.retClinic.id, b.p.phone, "Se tiver uma amiga, compartilhe o nosso contato. 💗 (fora)", { kind: "indicacao", flow: "indicacao" }), "blocked");
  assert.equal(await sendText(R.retClinic.id, alheia.phone, "Se tiver uma amiga, compartilhe o nosso contato. 💗 (outra clinica)", { kind: "indicacao", flow: "indicacao" }), "blocked");
  assert.equal(posts.length, 0);
});

test("PREVIA: lista quem seria selecionado, com regra, evento, motivo, janela e teto, SEM enviar, SEM consumir tentativa, SEM gravar controle e SEM expor telefone", async () => {
  reset();
  const R = await freshRet();
  const ok = await cancelada(R, { name: "Camila Previa Souza" });
  const falou = await cancelada(R, { name: "Falou Agora", conv: { lastMessageAt: sp("2026-10-19T09:30") } }); // conversa nas ultimas 24h
  const semProva = await cancelada(R, { name: "Sem Prova", cancelSource: "ce_apagada" });
  const antes = {
    ledger: await prisma.followUpDispatch.count(),
    runs: await prisma.automationRun.count(),
    judge: judgeCalls.length,
    posts: posts.length,
  };
  const p = await previewResumeFlow(R.retClinic.id, "avaliacao_cancelada", sp(MONDAY));
  assert.equal(await prisma.followUpDispatch.count(), antes.ledger, "nenhum registro de controle foi gravado (nem de 'pulada')");
  assert.equal(await prisma.automationRun.count(), antes.runs, "a previa nao conta como rodada");
  assert.equal(judgeCalls.length, antes.judge, "o juiz de IA nao foi consultado");
  assert.equal(posts.length, antes.posts);
  assert.equal(p.modo, "normal");
  assert.equal(p.agora.janelaAberta, true);
  assert.equal(p.agora.diaConfiguradoOk, true);
  const byName = Object.fromEntries(p.candidatos.map((c) => [c.nome, c]));
  assert.equal(byName["Camila S."].situacao, "elegivel");
  assert.equal(byName["Camila S."].regra, "avaliacao_cancelada");
  assert.ok(byName["Camila S."].evento);
  assert.equal(byName["Falou A."].situacao, "excluido");
  assert.equal(byName["Falou A."].motivo, "conversa_em_andamento");
  assert.equal(p.candidatos.some((c) => c.ref === semProva.p.id), false, "cancelamento sem prova nem entra na lista (e a pendencia fica so no diagnostico)");
  assert.equal(p.resumo.elegiveis, 1);
  assert.equal(p.resumo.elegiveisNoModoNormal, 1);
  const json = JSON.stringify(p);
  for (const x of [ok, falou, semProva]) assert.ok(!json.includes(x.p.phone) && !json.includes(x.p.phone.slice(-8)), "telefone nao aparece na previa");
  assert.ok(!json.includes("Souza"), "so o primeiro nome e a inicial");

  // no modo restrito a previa mostra o ESCOPO e quantas pessoas reais o modo normal alcancaria
  await restringe(R, [ok], 1);
  const q = await previewResumeFlow(R.retClinic.id, "avaliacao_cancelada", sp(MONDAY));
  assert.equal(q.modo, "restrito");
  assert.equal(q.restricao.valida, true);
  assert.equal(q.restricao.contatosAutorizados, 1);
  assert.equal(q.restricao.limiteDeEnvios, 1);
  assert.equal(q.resumo.noEscopo, 1);
  assert.equal(q.resumo.foraDaSelecao, 1, "a conversa em andamento e a unica outra com prova de cancelamento");
  assert.equal(q.candidatos.length, 1);
});

test("voltar ao modo normal e um pedido explicito e separado: ligar/desligar a retomada nao muda o modo; sem aprovador nao volta", async () => {
  reset();
  const R = await freshRet();
  const a = await cancelada(R, { name: "Volta Normal A" });
  const b = await cancelada(R, { name: "Volta Normal B" });
  await restringe(R, [a], 5);
  await conferirRecontatosLisboa(R.retClinic.id, { dryRun: false, ativar: { fluxo: "avaliacao_cancelada", aprovadoPor: "Dono", mensagem: CANCEL_TEXT } });
  assert.equal((await configRow(R.retClinic.id)).runMode, "restrito", "ligar nao tira da restricao");
  await assert.rejects(() => conferirRecontatosLisboa(R.retClinic.id, { dryRun: false, voltarAoNormal: { fluxo: "avaliacao_cancelada", aprovadoPor: "  " } }), /quem aprovou/);
  assert.equal((await configRow(R.retClinic.id)).runMode, "restrito");
  await runResume(MONDAY);
  assert.deepEqual(posts.map((p) => p.number), [a.p.phone]);
  const volta = await conferirRecontatosLisboa(R.retClinic.id, { dryRun: false, voltarAoNormal: { fluxo: "avaliacao_cancelada", aprovadoPor: "Dono (teste)" } });
  assert.deepEqual(volta.aplicado.voltaramAoNormal, ["avaliacao_cancelada"]);
  const row = await configRow(R.retClinic.id);
  assert.deepEqual([row.runMode, row.testPatientIds, row.testMaxSends], ["normal", null, null]);
  await runResume("2026-10-19T10:30");
  assert.ok(posts.some((p) => p.number === b.p.phone), "depois de voltar ao normal a outra pessoa elegivel passa a receber");
  // a previa de dryRun nao grava o modo
  const c = await cancelada(R, { name: "Volta Normal C" });
  const dry = await conferirRecontatosLisboa(R.retClinic.id, { dryRun: true, modoRestrito: { fluxo: "avaliacao_cancelada", aprovadoPor: "x", telefones: [c.p.phone], limite: 1 } });
  assert.equal(dry.modoRestrito.valido, true);
  assert.deepEqual(dry.modoRestrito.contatos.map((x) => x.final), [c.p.phone.slice(-4)], "so o final do telefone aparece");
  assert.equal((await configRow(R.retClinic.id)).runMode, "normal");
});

// ================================================================ 6) RECUPERACAO DE RECONTATOS VENCIDOS (politica da clinica) E PREVIA DA PRIMEIRA RODADA

const { previewFollowUpRound } = await import("../dist/crm/followupPreview.js");

test("RECUPERACAO: reinicio DENTRO e FORA da janela, por politica (padrao antigo, 'nao recupera', 24h); nada de etapas velhas acumuladas", async () => {
  // politica, e quantas mensagens saem quando o servidor volta: (a) 14:30 do mesmo dia (vencia 13:00, clinica aberta), (b) 08:05 do dia seguinte (vencia 23:30, clinica fechada), (c) 2 dias depois
  const cenarios = [
    { politica: null, mesmoDia: 1, diaSeguinte: 1, doisDias: 1 },
    { politica: 0, mesmoDia: 0, diaSeguinte: 1, doisDias: 0 }, // (08:05 do dia seguinte e a rodada em que a janela ABRIU: e o horario normal, nao recuperacao)
    { politica: 24, mesmoDia: 1, diaSeguinte: 1, doisDias: 0 },
  ];
  const voltas = [
    ["mesmoDia", "2026-10-15T09:00", "2026-10-15T14:30", "2026-10-15T14:50"],
    ["diaSeguinte", "2026-10-15T19:30", "2026-10-16T08:05", "2026-10-16T08:25"],
    ["doisDias", "2026-10-13T19:30", "2026-10-15T08:05", "2026-10-15T08:25"],
  ];
  for (const c of cenarios) {
    for (const [nome, ultima, volta, voltaDepois] of voltas) {
      reset();
      const cl = use(await mkClinic(`Recuperacao ${c.politica}-${nome}`, { followupRecoveryHours: c.politica }));
      await mkRule(cl.id, 1, RULE_4H);
      const { p } = await lead(cl, { userAt: sp(ultima) });
      await runAt(volta); // o servidor ficou fora do ar desde antes de vencer; a primeira rodada acontece agora
      assert.equal(posts.length, c[nome], `politica=${c.politica} cenario=${nome}`);
      const rows = await ledgerOf(p.id);
      if (c[nome]) assert.deepEqual(rows.map((r) => r.state), ["sent"]);
      else if (c.politica === null) assert.equal(rows.length, 0, "padrao antigo: o que passou de 3 dias e conversa fria, nada gravado");
      else assert.deepEqual(rows.map((r) => [r.state, r.layer]), [["expired", "janela"]], `politica=${c.politica}: etapa expirada e registrada (nao volta)`);
      const antes = posts.length;
      await runAt(voltaDepois);
      assert.equal(posts.length, antes, "uma segunda rodada nao acumula nem reenvia");
    }
  }
});

test("RECUPERACAO: cascata com varias etapas vencidas durante a queda sai no maximo UMA por rodada e a politica 'nao recupera' nao envia nenhuma delas", async () => {
  reset();
  const cl = use(await mkClinic("Cascata Queda", { followupRecoveryHours: 0 }));
  await mkRule(cl.id, 1, { name: "4 horas", ...RULE_4H });
  await mkRule(cl.id, 2, { name: "1 dia", afterMinutes: 1440, afterDays: 1, nextDayHour: null, sendWindowStart: null, sendWindowEnd: null, message: "Oi, {primeiro_nome}! Dia 2." });
  await mkRule(cl.id, 3, { name: "3 dias", afterMinutes: 4320, afterDays: 3, message: "Oi, {primeiro_nome}! Dia 3." });
  const { p, c } = await lead(cl, { userAt: sp("2026-10-12T10:00") });
  await runAt("2026-10-14T10:00"); // servidor voltou 2 dias depois: as etapas 1 e 2 venceram
  assert.equal(posts.length, 0, "sem recuperacao nada atrasado sai");
  assert.deepEqual((await ledgerOf(p.id)).map((r) => [r.step, r.state]).sort(), [[1, "expired"], [2, "expired"]]);
  assert.equal(await pointer(c), 2, "a cascata seguiu: as etapas perdidas nao voltam");
  await runAt("2026-10-14T10:20");
  assert.equal(posts.length, 0);
  await runAt("2026-10-15T10:05"); // a etapa 3 vence 15/10 10:00 e a rodada a pega no horario
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Dia 3/);
});

test("PREVIA do recontato: lista a primeira rodada com regra, vencimento, abertura, prazo e motivo, SEM enviar nem gravar nada, e o que ela diz 'enviaria' e exatamente o que a rodada real envia", async () => {
  reset();
  const cl = use(await mkClinic("Clinica Previa Recontato", { followupRecoveryHours: 24 }));
  await mkRule(cl.id, 1, RULE_4H);
  const agora = "2026-10-15T14:30";
  const ok1 = (await lead(cl, { name: "Ana Prevista Costa", userAt: sp("2026-10-15T09:00") })).p; // venceu 13:00, clinica aberta
  const ok2 = (await lead(cl, { name: "Bia Prevista Lima", userAt: sp("2026-10-15T08:30") })).p;
  const aguarda = (await lead(cl, { name: "Carla Aguarda", userAt: sp("2026-10-15T12:00") })).p; // vence 16:00
  const velha = (await lead(cl, { name: "Dora Velha", userAt: sp("2026-10-12T09:00") })).p; // venceu ha dias
  const respondeu = await lead(cl, { name: "Eva Respondeu", userAt: sp("2026-10-15T09:00"), aliceAt: sp("2026-10-15T09:01") });
  await prisma.message.create({ data: { conversationId: respondeu.c.id, role: "user", content: "E o valor?", createdAt: sp("2026-10-15T09:30") } });
  const comHorario = (await lead(cl, { name: "Fabi Marcada", userAt: sp("2026-10-15T09:00") })).p;
  const proc = await prisma.procedure.create({ data: { clinicId: cl.id, name: "Avaliação", durationMin: 30 } });
  await prisma.appointment.create({ data: { clinicId: cl.id, patientId: comHorario.id, procedureId: proc.id, scheduledAt: sp("2026-10-20T10:00"), status: "confirmed", source: "whatsapp" } });
  const optout = (await lead(cl, { name: "Gabi Saiu", userAt: sp("2026-10-15T09:00"), patient: { optedOut: true } })).p;
  const retorno = (await lead(cl, { name: "Helo Retorno", userAt: sp("2026-10-15T09:00"), patient: { callbackAt: sp("2026-10-20T10:00") } })).p;

  const pointersNow = async () => JSON.stringify(await prisma.conversation.findMany({ select: { id: true, lastFollowUpOrder: true }, orderBy: { id: "asc" } }));
  const antes = { ledger: await prisma.followUpDispatch.count(), runs: await prisma.automationRun.count(), judge: judgeCalls.length, posts: posts.length, pointers: await pointersNow() };
  const prev = await previewFollowUpRound(cl.id, sp(agora));
  assert.equal(await prisma.followUpDispatch.count(), antes.ledger, "nada gravado no controle");
  assert.equal(await prisma.automationRun.count(), antes.runs);
  assert.equal(judgeCalls.length, antes.judge, "juiz de IA nao consultado");
  assert.equal(posts.length, antes.posts, "nada enviado");
  assert.equal(await pointersNow(), antes.pointers, "ponteiro da cascata intacto");
  assert.equal(prev.politicaDeRecuperacao.valor, 24);
  assert.equal(prev.politicaDeRecuperacao.decididaPelaClinica, true);
  const por = Object.fromEntries(prev.pessoas.map((x) => [x.nome, x]));
  assert.equal(por["Ana C."].decisao, "enviaria");
  assert.equal(por["Ana C."].regra.ordem, 1);
  assert.ok(por["Ana C."].vence && por["Ana C."].abreEm);
  assert.equal(por["Bia L."].decisao, "enviaria");
  assert.equal(por["Carla A."].decisao, "aguardando");
  assert.equal(por["Carla A."].motivo, "nao_venceu");
  assert.equal(por["Dora V."].decisao, "expira");
  assert.equal(por["Eva R."].decisao, "excluida");
  assert.equal(por["Eva R."].motivo, "pessoa_falou_por_ultimo");
  assert.ok(prev.motivosDeExclusao.ja_tem_horario >= 1, "reserva vigente");
  assert.equal(prev.pessoas.some((x) => [optout.id, retorno.id, comHorario.id].includes(x.ref)), false, "opt-out, retorno combinado e reserva vigente nem entram na lista de pessoas");
  assert.deepEqual([prev.resumo.enviaria, prev.resumo.aguardando, prev.resumo.expira], [2, 1, 1]);
  const json = JSON.stringify(prev);
  for (const x of [ok1, ok2, aguarda, velha]) assert.ok(!json.includes(x.phone), "telefone nunca aparece");
  assert.ok(!json.includes("Costa"), "so o primeiro nome e a inicial");

  // a rodada REAL, no mesmo instante, envia exatamente a quem a previa disse "enviaria"
  await runAt(agora);
  assert.deepEqual([...new Set(posts.map((x) => x.number))].sort(), [ok1.phone, ok2.phone].sort());
});

test("REVALIDACAO imediatamente antes do envio: a pessoa responde, pede para sair, a equipe assume, ela reserva ou combina retorno ENQUANTO o juiz de IA le: a mensagem nao sai", async () => {
  const mudancas = {
    "pessoa respondeu": { motivo: /pessoa_respondeu/, estado: "deferred", fazer: async (p, c) => { await prisma.message.create({ data: { conversationId: c.id, role: "user", content: "Oi, ainda quero sim!", createdAt: sp("2026-10-15T14:29") } }); } },
    "pediu para sair": { motivo: /pediu_para_nao_receber/, estado: "skipped", fazer: async (p) => { await prisma.patient.update({ where: { id: p.id }, data: { optedOut: true } }); } },
    "sem interesse": { motivo: /sem_interesse/, estado: "skipped", fazer: async (p) => { await prisma.patient.update({ where: { id: p.id }, data: { noInterest: true } }); } },
    "equipe assumiu": { motivo: /atendimento_humano/, estado: "deferred", fazer: async (p, c) => { await prisma.conversation.update({ where: { id: c.id }, data: { humanTakeover: true } }); } },
    "equipe falou agora": { motivo: /equipe_atendendo_recentemente/, estado: "deferred", fazer: async (p, c) => { await prisma.message.create({ data: { conversationId: c.id, role: "human", content: "Oi, aqui e a recepcao", authorName: "Recepcao", createdAt: sp("2026-10-15T14:20") } }); } },
    "combinou retorno": { motivo: /retorno_combinado/, estado: "deferred", fazer: async (p) => { await prisma.patient.update({ where: { id: p.id }, data: { callbackAt: sp("2026-10-20T10:00") } }); } },
    "reservou": { motivo: /ja_tem_horario/, estado: "deferred", fazer: async (p, c, cl) => { const proc = await prisma.procedure.create({ data: { clinicId: cl.id, name: `Av ${Math.random()}`, durationMin: 30 } }); await prisma.appointment.create({ data: { clinicId: cl.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp("2026-10-21T10:00"), status: "confirmed", source: "whatsapp" } }); } },
  };
  for (const [nome, m] of Object.entries(mudancas)) {
    reset();
    const cl = use(await mkClinic(`Revalida ${nome}`));
    await mkRule(cl.id, 1, RULE_4H);
    const { p, c } = await lead(cl, { userAt: sp("2026-10-15T09:00") });
    judgeHook = async () => { judgeHook = null; await m.fazer(p, c, cl); };
    await runAt("2026-10-15T14:30");
    assert.equal(posts.length, 0, `${nome}: nao pode sair`);
    const row = (await ledgerOf(p.id))[0];
    assert.equal(row.state, m.estado, nome);
    assert.match(row.reason, m.motivo, nome);
    assert.equal(row.layer, "elegibilidade");
    assert.equal(await pointer(c), 0, `${nome}: o ponteiro da cascata nao andou (nada foi consumido)`);
  }
});
