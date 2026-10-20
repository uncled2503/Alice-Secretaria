// INCIDENTE DA LISBOA, 20/10/2026: recuperacao segura das confirmacoes antecipada e do dia. Banco de verdade (SQLite temporario), provedor de WhatsApp e OpenAI SIMULADOS, relogio
// controlado, dados FICTICIOS. Nada e enviado de verdade. Verifica o que SAI para a pessoa E o estado gravado: previa sem efeito, uma mensagem por pessoa, nada de reenvio as cegas.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-incidente-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
let providerMode = "ok"; // ok | timeout | http500
let reviewMode = "enviar"; // enviar | nao_enviar | fora_do_ar
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    if (reviewMode === "fora_do_ar") return jsonRes(500, { error: { message: "fora do ar" } });
    const body = JSON.parse(init.body);
    if (/REVISOR (DE ENVIO|das respostas)/.test(String(body.messages?.[0]?.content))) {
      return jsonRes(200, completion(reviewMode === "nao_enviar" ? { decisao: "nao_enviar", confianca: "alta", motivo: "teste: barrado", categoria: "outro" } : { decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" }));
    }
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (providerMode === "timeout") throw Object.assign(new Error("The operation timed out (TimeoutError)"), { name: "TimeoutError" });
    if (providerMode === "http500") return jsonRes(500, { error: "fora do ar" });
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
    return jsonRes(200, { id: "msg" });
  }
  return jsonRes(200, { instance: { status: "connected" }, status: { connected: true } });
};

const { prisma } = await import("../dist/db/client.js");
const rec = await import("../dist/maintenance/lisboaRecuperacaoLembretes.js");
const gate = await import("../dist/ai/sendGate.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const DIA = "2026-11-10";
const sp = (hhmm, dia = DIA) => new Date(`${dia}T${hhmm}:00-03:00`);
const AGORA = () => sp("08:40");
let n = 0;
const reset = () => { posts.length = 0; providerMode = "ok"; reviewMode = "enviar"; gate.resetBreakerForTests(); };

async function lisboa(nome) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", active: true, aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, closedOnHolidays: false } });
  const antecipada = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, pauseMinSec: 0, pauseMaxSec: 0, message: "Oi, {primeiro_nome}! Confirmando seu horário de amanhã (*{data}*) às {hora} para {procedimento}. Responda CONFIRMO." } });
  const doDia = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, pauseMinSec: 0, pauseMaxSec: 0, message: "Bom dia, {primeiro_nome}! Confirmando seu horário de hoje às {hora} para {procedimento}." } });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza de pele", durationMin: 60 } });
  return { c, antecipada, doDia, proc };
}
async function paciente(c, nome) { return prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119666${String(10000 + ++n)}` } }); }
async function agenda(L, p, hhmm, extra = {}) {
  return prisma.appointment.create({ data: { clinicId: L.c.id, patientId: p.id, procedureId: L.proc.id, scheduledAt: sp(hhmm), status: "confirmed", source: "presencial", createdAt: sp("09:00", "2026-11-05"), ...extra } });
}
const linhaDe = (previa, a) => previa.linhas.find((l) => l.agendamento === a.id);
const executar = (L, extra = {}) => rec.executarRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA, executar: true, autorizado: true, sleep: async () => undefined, ...extra });
const estadosDe = async (a) => (await prisma.reminderDispatch.findMany({ where: { appointmentId: a.id }, orderBy: { createdAt: "asc" } })).map((d) => `${d.kind}:${d.state}`);

test("PREVIA: nada e enviado nem gravado; separa quem precisa de mensagem de quem ja confirmou, ja recebeu, esta perto demais ou ja passou", async () => {
  reset();
  const L = await lisboa("Lisboa Previa");
  const ausente = await agenda(L, await paciente(L.c, "Ausente Um"), "10:00");
  const confirmou = await agenda(L, await paciente(L.c, "Confirmou Dois"), "10:30", { patientConfirmed: true });
  const recebeu = await agenda(L, await paciente(L.c, "Recebeu Tres"), "11:00");
  await prisma.reminderDispatch.create({ data: { clinicId: L.c.id, bookingKey: `appt:${recebeu.id}`, appointmentId: recebeu.id, patientId: recebeu.patientId, ruleId: L.doDia.id, kind: "do_dia", startsAt: recebeu.scheduledAt, sendDay: DIA, state: "sent" } });
  const perto = await agenda(L, await paciente(L.c, "Perto Quatro"), "09:20");
  const passou = await agenda(L, await paciente(L.c, "Passou Cinco"), "08:00");
  const antes = { disp: await prisma.reminderDispatch.count(), sent: await prisma.reminderSent.count(), msgs: await prisma.message.count() };
  const previa = await rec.previaRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA() });
  assert.equal(previa.somenteLeitura, true);
  assert.equal(linhaDe(previa, ausente).acao, "enviar");
  assert.equal(linhaDe(previa, confirmou).acao, "nao_enviar");
  assert.match(linhaDe(previa, confirmou).motivo, /JA confirmou/);
  assert.equal(linhaDe(previa, recebeu).acao, "nao_enviar");
  assert.equal(linhaDe(previa, recebeu).envioPorTipo.do_dia.estado, "aceito_pelo_provedor");
  assert.match(linhaDe(previa, recebeu).envioPorTipo.do_dia.detalhe, /NAO confirmada/);
  assert.match(linhaDe(previa, perto).motivo, /menos de 60 min/);
  assert.match(linhaDe(previa, passou).motivo, /ja passou/);
  assert.equal(posts.length, 0);
  assert.deepEqual({ disp: await prisma.reminderDispatch.count(), sent: await prisma.reminderSent.count(), msgs: await prisma.message.count() }, antes, "a previa nao gravou nada");
  assert.ok(linhaDe(previa, ausente).vencimento.do_dia.includes("JANELA JA FECHADA"));
  assert.ok(previa.pos, "a auditoria do pos-procedimento vem junto, separada");
  assert.equal(previa.totais.enviar, 1);
});

test("antecipada ausente + mensagem do dia ausente: UMA mensagem (a do dia), nunca as duas; a antecipada ('amanha') nao e reenviada hoje", async () => {
  reset();
  const L = await lisboa("Lisboa Ambas");
  const a = await agenda(L, await paciente(L.c, "Ambas Ausente"), "10:00");
  const r = await executar(L);
  assert.equal(r.aceitosPeloProvedor, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Bom dia, Ambas/);
  assert.doesNotMatch(posts[0].text, /amanhã/i);
  assert.deepEqual(await estadosDe(a), ["do_dia:sent"]);
  // segunda execucao (e o cron normal depois): nada de novo
  const r2 = await executar(L);
  assert.equal(r2.tentados, 0);
  assert.equal(posts.length, 1);
});

test("antecipada enviada ontem, mensagem do dia ausente: manda so a do dia; resposta 'Confirmado' da paciente evita cobrar confirmacao", async () => {
  reset();
  const L = await lisboa("Lisboa Antecipada");
  const recebeuOntem = await agenda(L, await paciente(L.c, "Ontem Recebeu"), "10:00");
  const ontem = sp("09:30", "2026-11-09");
  const conv = await prisma.conversation.create({ data: { patientId: recebeuOntem.patientId, lastMessageAt: ontem } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Oi! Confirmando seu horário de amanhã (*10/11*) às 10:00 para Limpeza de pele.", authorName: "Lembrete de consulta", createdAt: ontem, deliveryStatus: "sent" } });
  await prisma.reminderDispatch.create({ data: { clinicId: L.c.id, bookingKey: `appt:${recebeuOntem.id}`, appointmentId: recebeuOntem.id, patientId: recebeuOntem.patientId, ruleId: L.antecipada.id, kind: "dia_seguinte", startsAt: recebeuOntem.scheduledAt, sendDay: "2026-11-09", state: "sent" } });
  const respondeu = await agenda(L, await paciente(L.c, "Ontem Confirmou"), "10:30");
  const conv2 = await prisma.conversation.create({ data: { patientId: respondeu.patientId, lastMessageAt: ontem } });
  await prisma.message.create({ data: { conversationId: conv2.id, role: "assistant", content: "Oi! Confirmando seu horário de amanhã (*10/11*) às 10:30.", authorName: "Lembrete de consulta", createdAt: ontem, deliveryStatus: "sent" } });
  await prisma.message.create({ data: { conversationId: conv2.id, role: "user", content: "Confirmado!", createdAt: sp("10:15", "2026-11-09") } });
  const previa = await rec.previaRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA() });
  assert.equal(linhaDe(previa, recebeuOntem).acao, "enviar");
  assert.equal(linhaDe(previa, recebeuOntem).envioPorTipo.dia_seguinte.estado, "aceito_pelo_provedor");
  assert.equal(linhaDe(previa, respondeu).acao, "nao_enviar");
  assert.match(linhaDe(previa, respondeu).confirmacaoDePresenca, /parece confirmar/);
  const r = await executar(L);
  assert.equal(r.aceitosPeloProvedor, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Ontem/);
});

test("reserva cancelada ou remarcada: nada sai com o horario velho (antes da previa e DURANTE a execucao)", async () => {
  reset();
  const L = await lisboa("Lisboa Mudou");
  const cancelada = await agenda(L, await paciente(L.c, "Cancelou Um"), "10:00");
  const remarcada = await agenda(L, await paciente(L.c, "Remarcou Dois"), "10:30");
  await prisma.appointment.update({ where: { id: cancelada.id }, data: { status: "cancelled" } });
  await prisma.appointment.update({ where: { id: remarcada.id }, data: { scheduledAt: sp("08:50") } }); // faltam 10 min: perdeu a pertinencia
  const r = await executar(L);
  assert.equal(r.tentados, 0);
  assert.equal(posts.length, 0, "cancelada nao entra; remarcada para cima da hora nao e enviada");
  // mudanca DURANTE a execucao: depois do 1o envio, a 2a reserva e cancelada e a 3a remarcada para cima da hora; a revalidacao pega as duas
  const primeira = await agenda(L, await paciente(L.c, "Primeira Tres"), "11:00");
  const segunda = await agenda(L, await paciente(L.c, "Segunda Quatro"), "11:30");
  const terceira = await agenda(L, await paciente(L.c, "Terceira Cinco"), "12:00");
  let chamadas = 0;
  const r2 = await executar(L, { sleep: async () => { if (++chamadas === 1) { await prisma.appointment.update({ where: { id: segunda.id }, data: { status: "cancelled" } }); await prisma.appointment.update({ where: { id: terceira.id }, data: { scheduledAt: sp("08:55") } }); } } });
  assert.equal(r2.aceitosPeloProvedor, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Primeira/);
  assert.ok(r2.naoEnviados.some((x) => x.agendamento === segunda.id && /nao esta mais confirmada/.test(x.motivo)));
  assert.ok(r2.naoEnviados.some((x) => x.agendamento === terceira.id && /revalidacao: .*menos de 60 min/.test(x.motivo)));
  assert.deepEqual(await estadosDe(primeira), ["do_dia:sent"]);
});

test("WhatsApp indisponivel: nada e tentado nem consumido; quando volta, sai UMA vez", async () => {
  reset();
  const L = await lisboa("Lisboa Zap");
  const a = await agenda(L, await paciente(L.c, "Zap Fora"), "11:00");
  await prisma.clinic.update({ where: { id: L.c.id }, data: { uazapiDownSince: new Date(), uazapiDownReason: "teste", uazapiDownCheckedAt: new Date() } });
  const r = await executar(L);
  assert.equal(r.tentados, 0);
  assert.equal(posts.length, 0);
  assert.ok(r.naoEnviados.some((x) => /WhatsApp desconectado/.test(x.motivo)));
  assert.deepEqual(await estadosDe(a), [], "nenhuma etapa consumida");
  await prisma.clinic.update({ where: { id: L.c.id }, data: { uazapiDownSince: null, uazapiDownReason: null, uazapiDownCheckedAt: null } });
  const r2 = await executar(L);
  assert.equal(r2.aceitosPeloProvedor, 1);
  assert.equal(posts.length, 1);
});

test("revisao por IA fora do ar: o lembrete (mensagem ligada a reserva) sai sem a revisao; revisao que BARRA: nao sai, fica 'veto' e vai para conferencia humana", async () => {
  reset();
  const L = await lisboa("Lisboa Revisao");
  const fora = await agenda(L, await paciente(L.c, "Revisao Fora"), "10:00");
  reviewMode = "fora_do_ar";
  const r = await executar(L, { apenas: [fora.id] });
  assert.equal(r.aceitosPeloProvedor, 1, "politica existente: lembrete nao fica retido pela falta do revisor");
  assert.equal(posts.length, 1);
  reset();
  const L2 = await lisboa("Lisboa Veto");
  const barrada = await agenda(L2, await paciente(L2.c, "Veto Barrada"), "10:00");
  reviewMode = "nao_enviar";
  const r2 = await executar(L2);
  assert.equal(r2.aceitosPeloProvedor, 0);
  assert.equal(posts.length, 0);
  assert.deepEqual(await estadosDe(barrada), ["do_dia:vetoed"]);
  reviewMode = "enviar";
  const previa = await rec.previaRecuperacaoLembretes(L2.c.id, { dia: DIA, agora: AGORA() });
  assert.equal(linhaDe(previa, barrada).acao, "conferir_humano");
  assert.equal(linhaDe(previa, barrada).envioPorTipo.do_dia.estado, "veto");
  assert.equal(linhaDe(previa, barrada).causa.comprovada, true);
});

test("resultado INCERTO (timeout): nao e reenviado as cegas, nem pela segunda execucao nem pelo cron; vai para conferencia humana", async () => {
  reset();
  const L = await lisboa("Lisboa Incerto");
  const a = await agenda(L, await paciente(L.c, "Incerto Timeout"), "10:00");
  providerMode = "timeout";
  const r = await executar(L);
  assert.equal(r.incertos.length, 1);
  providerMode = "ok";
  const r2 = await executar(L);
  assert.equal(r2.tentados, 0);
  assert.equal(posts.length, 0);
  assert.deepEqual(await estadosDe(a), ["do_dia:unconfirmed"]);
  const previa = await rec.previaRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA() });
  assert.equal(linhaDe(previa, a).acao, "conferir_humano");
  assert.equal(linhaDe(previa, a).envioPorTipo.do_dia.estado, "incerto");
});

test("duas execucoes ao mesmo tempo: cada pessoa recebe UMA mensagem", async () => {
  reset();
  const L = await lisboa("Lisboa Concorrente");
  for (const nome of ["Conc Um", "Conc Dois", "Conc Tres"]) await agenda(L, await paciente(L.c, nome), "11:00");
  const [r1, r2] = await Promise.all([executar(L), executar(L)]);
  assert.equal(posts.length, 3);
  assert.equal(r1.aceitosPeloProvedor + r2.aceitosPeloProvedor, 3);
  assert.equal(new Set(posts.map((p) => p.number)).size, 3);
});

test("autorizacao: sem `executar` E `autorizado` o comando recusa; tipo antecipada para atendimento de hoje nao e enviado; uma mensagem por pessoa por dia", async () => {
  reset();
  const L = await lisboa("Lisboa Auth");
  const p = await paciente(L.c, "Auth Pessoa");
  const primeira = await agenda(L, p, "10:00");
  const segunda = await agenda(L, p, "14:00");
  await assert.rejects(() => rec.executarRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA, executar: true, autorizado: false }), /autorizacao explicita/);
  await assert.rejects(() => rec.executarRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA, executar: false, autorizado: true }), /autorizacao explicita/);
  assert.equal(posts.length, 0);
  const ant = await rec.previaRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA(), tipo: "dia_seguinte" });
  assert.ok(ant.linhas.every((l) => l.acao === "nao_enviar" && /amanha/.test(l.motivo)));
  const previa = await rec.previaRecuperacaoLembretes(L.c.id, { dia: DIA, agora: AGORA() });
  assert.equal(linhaDe(previa, primeira).acao, "enviar");
  assert.equal(linhaDe(previa, segunda).acao, "nao_enviar");
  assert.match(linhaDe(previa, segunda).motivo, /primeiro horario do dia/);
});

test("fora do horario de comunicacao (depois das 20h) ou antes das 7h: recalcula e nao forca mensagem vencida", async () => {
  reset();
  const L = await lisboa("Lisboa Tarde");
  const a = await agenda(L, await paciente(L.c, "Tarde Pessoa"), "21:30");
  const previa = await rec.previaRecuperacaoLembretes(L.c.id, { dia: DIA, agora: sp("20:30") });
  assert.equal(linhaDe(previa, a).acao, "nao_enviar");
  assert.match(linhaDe(previa, a).motivo, /fora do horario de comunicacao/);
});

test("looksLikeConfirmation: so afirmacoes claras; cancelar/remarcar/duvida nao contam", () => {
  for (const t of ["Confirmado", "confirmo, obrigada!", "Ok", "Sim, estarei aí", "👍"]) assert.equal(rec.looksLikeConfirmation(t), true, t);
  for (const t of ["Preciso remarcar", "não vou conseguir", "Qual o endereço?", "Posso trocar o horário?", ""]) assert.equal(rec.looksLikeConfirmation(t), false, t);
});

test("DIAGNOSTICO SEM DEPLOY: scripts/incidente-lembretes.mjs le o banco (somente leitura), mostra migracoes, regras, rodadas, locks e a agenda do dia com o estado de cada envio, telefones mascarados", async () => {
  reset();
  const L = await lisboa("Lisboa Script");
  const a = await agenda(L, await paciente(L.c, "Script Pessoa"), "10:00");
  await prisma.reminderDispatch.create({ data: { clinicId: L.c.id, bookingKey: `appt:${a.id}`, appointmentId: a.id, patientId: a.patientId, ruleId: L.antecipada.id, kind: "dia_seguinte", startsAt: a.scheduledAt, sendDay: "2026-11-09", state: "deferred", detail: "teste de retencao" } });
  await prisma.automationRun.create({ data: { job: "lembretes", clinicId: L.c.id, startedAt: sp("08:15", "2026-11-09"), finishedAt: sp("08:16", "2026-11-09"), outcome: "ok", candidates: 3, deferred: 3, reasons: JSON.stringify({ "adiado:whatsapp_desconectado_ou_revisao": 3 }), version: "teste" } });
  const antes = { disp: await prisma.reminderDispatch.count(), runs: await prisma.automationRun.count() };
  const saida = execFileSync(process.execPath, ["scripts/incidente-lembretes.mjs", DIA, "Lisboa Script"], { cwd: root, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const j = JSON.parse(saida);
  assert.equal(j.somenteLeitura, true);
  assert.equal(j.agenda.total, 1);
  assert.match(j.agenda.linhas[0].antecipada, /deferred \(teste de retencao\)/);
  assert.equal(j.agenda.linhas[0].doDia, "sem linha de controle");
  assert.match(j.agenda.linhas[0].pessoa, /^Script \(\.\.\.\d{4}\)$/);
  assert.ok(!saida.includes((await prisma.patient.findUnique({ where: { id: a.patientId } })).phone), "telefone completo nunca aparece");
  assert.equal(j.jobs[0].rodadasRegistradas, 1);
  assert.ok(Array.isArray(j.regras) && j.regras.length === 2);
  assert.deepEqual({ disp: await prisma.reminderDispatch.count(), runs: await prisma.automationRun.count() }, antes, "o diagnostico nao gravou nada");
});
