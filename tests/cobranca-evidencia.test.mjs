// COBRANCA DE CONFIRMACAO SEM PEDIDO INICIAL (caso Tatiana, Lisboa, 21/10/2026) e montagem do texto ("AvaliacaoAvaliacao"). Banco isolado, relogio controlado, WhatsApp e revisao por IA simulados.
// Prova o contrato do codigo: a cobranca so existe com EVIDENCIA persistida do pedido inicial (mesmo agendamento, mesmo horario), aceito pelo provedor. Nao prova o que aconteceu em producao.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-cobranca-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const enviados = [];
let uazapi = "ok"; // ok | timeout | http500
let revisao = "enviar"; // enviar | veto
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const content = revisao === "veto"
      ? JSON.stringify({ decisao: "nao_enviar", confianca: "alta", motivo: "A pessoa pediu para nao receber mensagens", categoria: "opt_out" })
      : JSON.stringify({ decisao: "enviar", confianca: "alta", motivo: "ok" });
    return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapi === "timeout") { const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; }
    if (uazapi === "http500") return jsonRes(500, { error: "fora do ar" });
    const b = JSON.parse(init.body);
    enviados.push({ phone: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg-1", data: {} });
};

const { prisma } = await import("../dist/db/client.js");
const cron = await import("../dist/reminders/cron.js");
const { getClinicTemplateInfo } = await import("../dist/crm/template.js");
const { renderMessageTemplate } = await import("../dist/crm/template.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
const OLD = sp("2026-10-01T10:00");
let seq = 0;
const PEDIDO = "Olá, {primeiro_nome}!\nPassando para confirmar o seu agendamento:\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\n\nPosso confirmar a sua presença?";
const COBRANCA = "Olá, {primeiro_nome}! Ainda não recebemos a sua confirmação para {data} às {hora}. Pode nos confirmar?";

async function clinica(nome, { pedido = PEDIDO } = {}) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}` } });
  const base = { clinicId: c.id, pauseMinSec: 0, pauseMaxSec: 0, active: true };
  const mae = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 10, message: pedido, purpose: "confirmacao" } });
  const filha = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 16, sendMinute: 0, sendEndHour: 17, message: COBRANCA, parentRuleId: mae.id, purpose: "cobranca" } });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Avaliação", durationMin: 30 } });
  return { c, mae, filha, proc };
}
async function agenda(S, nome, quando, extra = {}) {
  seq++;
  const p = await prisma.patient.create({ data: { clinicId: S.c.id, name: nome, phone: `55119333${String(10000 + seq)}` } });
  const a = await prisma.appointment.create({ data: { clinicId: S.c.id, patientId: p.id, procedureId: S.proc.id, scheduledAt: sp(quando), source: "presencial", createdAt: OLD, ...extra } });
  return { p, a };
}
const rodar = (iso) => cron.runReminderCycle({ now: sp(iso) });
const para = (p) => enviados.filter((e) => e.phone === p.phone);
const zera = () => { enviados.length = 0; uazapi = "ok"; revisao = "enviar"; };
// o controle e os registros gravam updatedAt/sentAt com o relogio do BANCO; o teste usa relogio proprio: alinha os dois para o instante simulado
const alinha = async (S, iso) => { await prisma.reminderDispatch.updateMany({ where: { clinicId: S.c.id }, data: { updatedAt: sp(iso) } }); await prisma.reminderSent.updateMany({ where: { appointment: { clinicId: S.c.id } }, data: { sentAt: sp(iso) } }); };
const estadoMae = async (S, x) => (await prisma.reminderDispatch.findFirst({ where: { clinicId: S.c.id, ruleId: S.mae.id, appointmentId: x.a.id } }))?.state ?? null;

// Regra de 22/10 ("se o pedido inicial falhou, recuperar o pedido inicial com o texto adequado"): na etapa da cobranca, quem NUNCA recebeu o pedido recebe o PEDIDO INICIAL - nunca a cobranca.
test("P. sem pedido inicial de confirmacao: a cobranca NAO sai (nada para cobrar); na etapa da cobranca sai o PEDIDO INICIAL", async () => {
  zera();
  const S = await clinica("Cob P");
  const x = await agenda(S, "Sem Pedido", "2026-10-21T14:00");
  await rodar("2026-10-20T16:10"); // a janela do pedido (8h-10h) nunca rodou
  assert.equal(para(x.p).length, 1, "recebe o pedido inicial");
  assert.doesNotMatch(para(x.p)[0].text, /Ainda não recebemos/, "nunca a cobranca");
  assert.match(para(x.p)[0].text, /Posso confirmar a sua pre/);
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: x.a.id, ruleId: S.filha.id } }), 0, "a cobranca nao consta como enviada");
});

test("Q. pedido inicial que NAO saiu (barrado pela revisao, falha, incerto) nao conta como enviado: nada de cobranca; pedido enviado de fato permite UMA cobranca", async () => {
  zera();
  const S = await clinica("Cob Q");
  // Q1: a revisao por IA barrou o pedido
  const veto = await agenda(S, "Barrado", "2026-10-21T14:00");
  revisao = "veto";
  await rodar("2026-10-20T08:10");
  assert.equal(para(veto.p).length, 0);
  assert.equal(await estadoMae(S, veto), "vetoed");
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: veto.a.id, ruleId: S.mae.id } }), 0, "nada saiu: o registro de 'enviado' nao fica");
  // Q2: timeout (pode ter chegado ou nao)
  revisao = "enviar"; uazapi = "timeout";
  const incerto = await agenda(S, "Incerto", "2026-10-21T15:00");
  await rodar("2026-10-20T08:25");
  assert.equal(await estadoMae(S, incerto), "unconfirmed");
  // Q3: falha do provedor, e a janela passa sem sucesso
  uazapi = "http500";
  const falhou = await agenda(S, "Falhou", "2026-10-21T16:00");
  await rodar("2026-10-20T08:40");
  uazapi = "ok";
  assert.equal(["failed", "failed_permanent", "deferred"].includes(await estadoMae(S, falhou)), true);
  // 16h10: nenhuma cobranca para quem nao recebeu um pedido aceito
  await alinha(S, "2026-10-20T08:45");
  zera();
  await rodar("2026-10-20T16:10");
  assert.ok(!enviados.some((e) => /Ainda não recebemos/.test(e.text)), "nem barrado, nem incerto, nem falho recebe 'ainda nao recebemos sua confirmacao'");
  // regra de 22/10: o pedido que FALHOU (nada saiu) e recuperado com o texto do pedido inicial; o barrado pela revisao e o incerto (pode ter saido) NAO
  assert.deepEqual(enviados.map((e) => e.phone), [falhou.p.phone], "so o que falhou recebe o pedido inicial");
  assert.match(enviados[0].text, /Posso confirmar a sua pre/);
  const sel = await cron.selectReminderCandidates(await prisma.reminderRule.findUnique({ where: { id: S.filha.id } }), sp("2026-10-20T16:10"), TZ);
  assert.deepEqual(sel.due.map((a) => a.id), []);
  // Q5: pedido ACEITO pelo provedor: a cobranca sai, uma vez
  const bom = await agenda(S, "Recebeu", "2026-10-21T17:00");
  await rodar("2026-10-20T09:10");
  assert.equal(para(bom.p).length, 1, "o pedido inicial saiu");
  assert.equal(await estadoMae(S, bom), "sent");
  await alinha(S, "2026-10-20T09:10");
  await rodar("2026-10-20T16:10");
  assert.equal(para(bom.p).length, 2, "e so quem recebeu o pedido recebe a cobranca");
  assert.match(para(bom.p)[1].text, /Ainda não recebemos a sua confirmação/);
  assert.match(para(bom.p)[1].text, /21\/10\/2026 às 17:00/, "a cobranca cita a data/hora ATUAL do agendamento");
  await rodar("2026-10-20T16:25");
  assert.equal(para(bom.p).length, 2, "uma cobranca so");
});

test("Q4. registro ANTIGO (so ReminderSent, anterior ao controle persistente) continua valendo como pedido enviado (compatibilidade)", async () => {
  zera();
  const S = await clinica("Cob Q4");
  const x = await agenda(S, "Legado", "2026-10-21T14:00");
  await prisma.reminderSent.create({ data: { appointmentId: x.a.id, ruleId: S.mae.id, sentAt: sp("2026-10-20T08:30") } });
  await rodar("2026-10-20T16:10");
  assert.equal(para(x.p).length, 1);
});

test("R. confirmou, cancelou ou remarcou depois do pedido: nao cobra o estado anterior", async () => {
  zera();
  const S = await clinica("Cob R");
  const conf = await agenda(S, "Confirmou", "2026-10-21T10:00");
  const canc = await agenda(S, "Cancelou", "2026-10-21T11:00");
  const remarc = await agenda(S, "Remarcou", "2026-10-21T12:00");
  const resp = await agenda(S, "Respondeu", "2026-10-21T13:00");
  const mudo = await agenda(S, "Silencio", "2026-10-21T14:00");
  await rodar("2026-10-20T08:10");
  await rodar("2026-10-20T08:25");
  for (const x of [conf, canc, remarc, resp, mudo]) assert.equal(para(x.p).length, 1, x.p.name);
  await prisma.appointment.update({ where: { id: conf.a.id }, data: { patientConfirmed: true } });
  await prisma.appointment.update({ where: { id: canc.a.id }, data: { status: "cancelled" } });
  await prisma.appointment.update({ where: { id: remarc.a.id }, data: { scheduledAt: sp("2026-10-22T12:00") } }); // outro dia: o pedido do horario antigo nao vale
  const conv = await prisma.conversation.create({ data: { patientId: resp.p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Confirmo!", createdAt: sp("2026-10-20T12:00") } });
  await alinha(S, "2026-10-20T08:30");
  await rodar("2026-10-20T16:10");
  assert.equal(para(conf.p).length, 1);
  assert.equal(para(canc.p).length, 1);
  assert.equal(para(remarc.p).length, 1);
  assert.equal(para(resp.p).length, 1);
  assert.equal(para(mudo.p).length, 2, "so quem ficou em silencio e foi pedido recebe a cobranca");
});

test("S. duas execucoes simultaneas e reinicio: um unico pedido e uma unica cobranca por agendamento", async () => {
  zera();
  const S = await clinica("Cob S");
  const x = await agenda(S, "Concorrente", "2026-10-21T14:00");
  await Promise.all([rodar("2026-10-20T08:10"), rodar("2026-10-20T08:10")]);
  assert.equal(para(x.p).length, 1);
  // duas copias entregando o MESMO agendamento ao mesmo tempo (a trava do banco decide)
  const rule = await prisma.reminderRule.findUnique({ where: { id: S.filha.id } });
  await alinha(S, "2026-10-20T08:30");
  const agora = sp("2026-10-20T16:10");
  const sel = await cron.selectReminderCandidates(rule, agora, TZ);
  assert.equal(sel.due.length, 1);
  const env = { clock: () => agora, tz: TZ, clinicInfo: await getClinicTemplateInfo(S.c.id), stat: { deferred: 0, exhausted: 0, reasons: new Set() }, ceDown: new Map(), ceFailures: new Map() };
  const [a, b] = await Promise.all([cron.deliverReminder(env, rule, sel.due[0]), cron.deliverReminder(env, rule, sel.due[0])]);
  assert.equal([a, b].filter(Boolean).length, 1, "so uma das copias reserva o envio");
  assert.equal(para(x.p).length, 2);
});

test("T. varios agendamentos da mesma pessoa: a cobranca cita o agendamento que recebeu o pedido, no horario certo", async () => {
  zera();
  const S = await clinica("Cob T");
  const p = await prisma.patient.create({ data: { clinicId: S.c.id, name: "Duas Reservas", phone: "5511933399999" } });
  const amanha = await prisma.appointment.create({ data: { clinicId: S.c.id, patientId: p.id, procedureId: S.proc.id, scheduledAt: sp("2026-10-21T10:00"), source: "presencial", createdAt: OLD } });
  const depois = await prisma.appointment.create({ data: { clinicId: S.c.id, patientId: p.id, procedureId: S.proc.id, scheduledAt: sp("2026-10-23T15:00"), source: "presencial", createdAt: OLD } });
  await rodar("2026-10-20T08:10");
  assert.equal(enviados.length, 1, "o pedido sai so para o de amanha");
  assert.match(enviados[0].text, /21\/10\/2026/);
  await alinha(S, "2026-10-20T08:30");
  await rodar("2026-10-20T16:10");
  assert.equal(enviados.length, 2);
  assert.match(enviados[1].text, /21\/10\/2026 às 10:00/);
  assert.doesNotMatch(enviados[1].text, /23\/10/);
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: depois.id } }), 0);
  void amanha;
});

test("U. texto final sem 'AvaliacaoAvaliacao': o nome colado a palavra do texto cadastrado e a repeticao do nome saem; nomes legitimos ficam", async () => {
  zera();
  const S = await clinica("Cob U", { pedido: "Olá, {primeiro_nome}! Procedimento: Avaliação{procedimento}. Data {data} às {hora}. Posso confirmar a sua presença?" });
  const x = await agenda(S, "Colado", "2026-10-21T14:00");
  await rodar("2026-10-20T08:10");
  assert.equal(para(x.p).length, 1);
  assert.doesNotMatch(para(x.p)[0].text, /AvaliaçãoAvaliação/i);
  assert.match(para(x.p)[0].text, /Procedimento: Avaliação\./);
  const info = await getClinicTemplateInfo(S.c.id);
  const t = renderMessageTemplate("Procedimento: {procedimento}", { patientName: "Ana", patientPhone: "5511", clinicName: info.name, procedureName: "Avaliação Estética" });
  assert.equal(t, "Procedimento: Avaliação Estética");
});
