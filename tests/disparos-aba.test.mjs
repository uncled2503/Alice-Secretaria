// DISPAROS (21/10/2026), parte 2 - ABA: cobertura/contadores, filtros e paginacao, API com escopo de clinica, recuperacao em fila persistida (duplo clique, pausa, cancelamento, reinicio,
// reagendamento no meio, cron x painel), exportacao. Banco isolado, relogio controlado, provedor simulado. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-disparos-aba-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const realFetch = globalThis.fetch;
const posts = [];
let mid = 0;
let behavior = null;
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") {
      const b = JSON.parse(init.body);
      const req = { number: b.number, text: b.text, token: init.headers?.token, n: posts.length + 1 };
      posts.push(req);
      const r = behavior ? behavior(req) : null;
      if (r instanceof Error) throw r;
      if (r) return jsonRes(r.status, r.body);
      return jsonRes(200, { id: `owner:MID${String(++mid).padStart(6, "0")}` });
    }
    return jsonRes(200, { instance: { status: "connected" }, status: { connected: true } });
  }
  return realFetch(url, init);
};

const { prisma } = await import("../dist/db/client.js");
const cron = await import("../dist/reminders/cron.js");
const model = await import("../dist/dispatch/model.js");
const actions = await import("../dist/dispatch/actions.js");
const delivery = await import("../dist/dispatch/delivery.js");
const bday = await import("../dist/reminders/birthday.js");
const { dispatchesRouter, resetDispatchLimitsForTests } = await import("../dist/api/dispatches.js");
const { default: express } = await import("express");
actions.setDispatchAutoKick(false);

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
const OLD = sp("2026-10-01T10:00");
let seq = 0;
const zera = () => { posts.length = 0; behavior = null; };
const TXT = "Olá, {primeiro_nome}!\nPassando para confirmar o seu agendamento:\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n\nPosso confirmar a sua presença?";
const noSleep = async () => {};

async function clinica(nome) {
  // o ciclo automatico varre TODAS as clinicas do banco: desliga as regras dos cenarios anteriores para que so a clinica corrente envie
  await prisma.reminderRule.updateMany({ where: { active: true }, data: { active: false } });
  await prisma.birthdayRule.updateMany({ where: { active: true }, data: { active: false } });
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}-${++seq}` } });
  const rule = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 9, message: TXT, purpose: "confirmacao", pauseMinSec: 0, pauseMaxSec: 0, active: true } });
  return { c, rule };
}
async function agenda(c, nome, quando, { phoneNumber, status, extraPatient = {}, extraAppt = {} } = {}) {
  seq++;
  const proc = (await prisma.procedure.findFirst({ where: { clinicId: c.id } })) ?? (await prisma.procedure.create({ data: { clinicId: c.id, name: "Lavieen", durationMin: 30 } }));
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: phoneNumber ?? `55119777${String(10000 + seq)}`, ...extraPatient } });
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp(quando), source: "presencial", createdAt: OLD, ...(status ? { status } : {}), ...extraAppt } });
  return { p, a };
}
const rodar = (iso) => cron.runReminderCycle({ now: sp(iso) });
const viewAt = (c, iso, f = {}) => model.buildDispatchView(c.id, f, sp(iso));
const para = (p) => posts.filter((x) => x.number === p.phone);

// cenario completo de uma clinica, depois da janela das 8h (visto as 10:30)
async function cenarioCompleto(nome) {
  zera();
  const { c, rule } = await clinica(nome);
  await prisma.dispatchPolicy.create({ data: { clinicId: c.id, kind: "confirmacao", extendEnabled: false } }); // cenario SEM ampliacao automatica: o que a janela perdeu fica "expirado"
  const ok = await agenda(c, "Ana Enviada", "2026-10-21T14:00");
  const falha = await agenda(c, "Bia Falhou", "2026-10-21T14:30");
  const cancel = await agenda(c, "Cris Cancelou", "2026-10-21T15:00", { status: "cancelled" });
  const confirmou = await agenda(c, "Dani Confirmou", "2026-10-21T15:30", { extraAppt: { patientConfirmed: true } });
  const invalido = await agenda(c, "Eva Telefone Ruim", "2026-10-21T16:00", { phoneNumber: "123" });
  const optout = await agenda(c, "Fabi Optout", "2026-10-21T16:30", { extraPatient: { optedOut: true } });
  behavior = (r) => (r.number === falha.p.phone ? { status: 500, body: { error: "fora do ar" } } : null);
  await rodar("2026-10-20T08:10");
  behavior = null;
  const tarde = await agenda(c, "Gabi Cadastrada Tarde", "2026-10-21T17:00"); // entrou depois da janela
  return { c, rule, ok, falha, cancel, confirmou, invalido, optout, tarde };
}

test("ABA: contadores separados (aceito/entregue/lido), excluidos legitimos com motivo, telefone invalido visivel, soma fecha e cobertura nunca inventa 100%", async () => {
  const S = await cenarioCompleto("Aba Completa");
  const v0 = await viewAt(S.c, "2026-10-20T10:30", { view: "hoje" });
  const by = (name) => v0.items.find((i) => i.patientName === name);
  assert.equal(by("Ana Enviada").status, "aceito", "aceito pelo provedor");
  assert.equal(by("Bia Falhou").status, "falhou");
  assert.equal(by("Bia Falhou").reason, "falha_provedor");
  assert.equal(by("Cris Cancelou").status, "excluido");
  assert.equal(by("Cris Cancelou").reason, "cancelado");
  assert.equal(by("Dani Confirmou").status, "excluido");
  assert.equal(by("Dani Confirmou").reason, "confirmado");
  assert.equal(by("Fabi Optout").reason, "plano_ou_opt_out");
  assert.equal(by("Eva Telefone Ruim").status, "falhou", "o ciclo ja tentou e o envio foi recusado antes do provedor");
  assert.equal(by("Eva Telefone Ruim").reason, "telefone_invalido");
  assert.equal(by("Eva Telefone Ruim").recoverable, false, "so volta a ser recuperavel depois de corrigir o cadastro");
  assert.equal(by("Gabi Cadastrada Tarde").status, "expirado", "sem tentativa e a janela fechou");
  assert.ok(!JSON.stringify(v0).includes(S.ok.p.phone), "o telefone completo nunca aparece");
  // entrega confirmada pelo provedor: vira entregue SEM somar com aceito
  const rowOk = await prisma.reminderDispatch.findFirst({ where: { appointmentId: S.ok.a.id } });
  await delivery.ingestDeliveryStatus(S.c.id, { EventType: "messages_update", data: { id: rowOk.providerId, status: "Delivered" } });
  const v1 = await viewAt(S.c, "2026-10-20T10:30", { view: "hoje" });
  const c = v1.counters;
  assert.equal(c.aceitos, 0);
  assert.equal(c.entregues, 1);
  assert.equal(c.lidos, 0);
  assert.equal(c.excluidos, 3);
  // a soma dos baldes fecha com o total de esperados (nada some, nada conta duas vezes)
  const soma = c.excluidos + c.nao_tentados + c.em_andamento + c.aceitos + c.entregues + c.lidos + c.entrega_falhou + c.adiados + c.barrados + c.falhos + c.incertos + c.expirados + c.bloqueados + c.cobertos;
  assert.equal(soma, c.esperados);
  assert.equal(c.esperados, v1.total);
  const conf = v1.cobertura.find((k) => k.kind === "confirmacao");
  assert.equal(conf.fonteCompleta, true, "agenda da propria Alice (sem Clinica Experts)");
  assert.equal(typeof conf.cobertura, "number");
  assert.ok(conf.cobertura < 100, "ha falhas e expirados: nunca 100%");
  const aniv = v1.cobertura.find((k) => k.kind === "aniversario");
  assert.equal(aniv.fonteCompleta, false);
  assert.equal(aniv.cobertura, null, "fonte incompleta: sem percentual");
  // clinica com Clinica Experts: a fonte da agenda tambem e incompleta (reservas nao importadas nao aparecem)
  await prisma.clinicaExpertsAccount.create({ data: { clinicId: S.c.id, tokenEnc: "x" } });
  const v2 = await viewAt(S.c, "2026-10-20T10:30", { view: "hoje" });
  const conf2 = v2.cobertura.find((k) => k.kind === "confirmacao");
  assert.equal(conf2.fonteCompleta, false);
  assert.equal(conf2.cobertura, null, "fonte externa incompleta: percentual nao calculavel");
});

test("ABA: filtros (tipo, estado, motivo, busca por nome e final do telefone), recuperavel hoje, paginacao e selecao de TODOS os resultados", async () => {
  const S = await cenarioCompleto("Aba Filtros");
  const f = (x) => viewAt(S.c, "2026-10-20T10:30", { view: "hoje", ...x });
  assert.equal((await f({ status: ["falhou"] })).total, 2);
  assert.equal((await f({ reason: "cancelado" })).total, 1);
  assert.equal((await f({ kinds: ["aniversario"] })).total, 0);
  assert.equal((await f({ q: "gabi" })).items[0].patientName, "Gabi Cadastrada Tarde");
  assert.equal((await f({ q: S.ok.p.phone.slice(-4) })).items[0].patientName, "Ana Enviada");
  const rec = await f({ recoverableToday: true });
  assert.deepEqual(rec.items.map((i) => i.patientName).sort(), ["Bia Falhou", "Gabi Cadastrada Tarde"], "recuperaveis hoje: o que falhou e quem a janela deixou para tras");
  assert.equal(rec.counters.recuperaveis_hoje, 2);
  const pag = await f({ pageSize: 2, page: 2 });
  assert.equal(pag.items.length, 2);
  assert.equal(pag.total, 7, "total conta o filtro inteiro, nao a pagina");
  const all = await actions.previewRecovery(S.c.id, { allFiltered: true, filters: { view: "hoje" } }, sp("2026-10-20T10:30"));
  assert.equal(all.total, 7);
  assert.equal(all.elegiveis.length, 2);
  assert.equal(all.somenteLeitura, true);
  assert.ok(all.excluidos.every((e) => e.motivo), "cada excluido diz por que");
  // visao Precisam de atencao: so o que pede acao
  const att = await viewAt(S.c, "2026-10-20T10:30", { view: "atencao" });
  assert.ok(att.items.every((i) => ["falhou", "incerto", "expirado", "adiado", "nao_tentado", "entrega_falhou", "barrado"].includes(i.status)));
  // proximos: amanha ainda nao e hora
  const prox = await viewAt(S.c, "2026-10-20T10:30", { view: "proximos" });
  assert.ok(prox.items.every((i) => i.sendDay > "2026-10-20"));
});

// ------------------------------------------------------------------ recuperacao em fila
test("RECUPERACAO: fila persistida; duplo clique/segundo usuario nao duplica; revalida cada item; cron e painel juntos mandam UMA vez", async () => {
  const S = await cenarioCompleto("Recup Fila");
  const now = () => sp("2026-10-20T10:30");
  const ids = (await viewAt(S.c, "2026-10-20T10:30", { recoverableToday: true })).items.map((i) => i.id);
  assert.equal(ids.length, 2);
  const actor = { name: "Aline" };
  const r1 = await actions.createRecoveryRun(S.c.id, { ids }, actor, "teste", now());
  assert.equal(r1.queued, 2);
  assert.equal(posts.length, 1 /* so o envio inicial da Ana (a falha da Bia nao entra) */ + 1, "criar a fila nao envia nada no HTTP (so o 1o ciclo e a tentativa falha da Bia)");
  const antes = posts.length;
  // duplo clique / outro usuario com a mesma selecao: nenhum item novo
  const r2 = await actions.createRecoveryRun(S.c.id, { ids }, { name: "Outro usuario" }, "duplicado", now());
  assert.equal(r2.queued, 0);
  assert.equal(r2.skipped.length, 2);
  assert.match(r2.skipped[0].motivo, /outra recuperação|em andamento/);
  // cron e worker AO MESMO TEMPO: cada pessoa recebe no maximo uma mensagem
  await Promise.all([actions.processDispatchRuns({ now, sleep: noSleep }), cron.runReminderCycle({ now: now() })]);
  assert.equal(para(S.falha.p).filter((p) => p.n > antes).length, 1, "Bia recebeu UMA vez");
  assert.equal(para(S.tarde.p).length <= 1, true);
  const run = await prisma.dispatchRun.findUnique({ where: { id: r1.runId }, include: { items: true } });
  assert.equal(run.state, "completed");
  assert.ok(run.items.every((i) => i.activeKey === null && ["done", "failed"].includes(i.state)), "terminou: libera a chave ativa");
  // nova passagem do worker e novo ciclo: nada repete
  const n = posts.length;
  await actions.processDispatchRuns({ now, sleep: noSleep });
  await cron.runReminderCycle({ now: now() });
  assert.equal(posts.length, n);
  // e o evento volta a poder ser recuperado? nao: ja foi enviado
  const v = await viewAt(S.c, "2026-10-20T10:30", { view: "hoje" });
  assert.equal(v.items.find((i) => i.patientName === "Bia Falhou").recoverable, false);
});

test("RECUPERACAO: pausa e cancelamento do lote; sent/cancelado/remarcado depois da previa sai da fila; WhatsApp fora adia; reinicio retoma sem duplicar", async () => {
  const S = await cenarioCompleto("Recup Controle");
  const now = () => sp("2026-10-20T10:30");
  const extra = [];
  for (let i = 0; i < 4; i++) extra.push(await agenda(S.c, `Lote ${i}`, `2026-10-21T1${i}:00`.replace("T1", "T1")));
  // as 4 pessoas do lote entraram depois da janela (expirado, recuperavel)
  const ids = (await viewAt(S.c, "2026-10-20T10:30", { recoverableToday: true, q: "Lote" })).items.map((i) => i.id);
  assert.equal(ids.length, 4);
  const actor = { name: "Aline" };
  const run = await actions.createRecoveryRun(S.c.id, { ids }, actor, "lote", now());
  assert.equal(run.queued, 4);
  // 1) pausa antes do worker: nada sai
  await actions.runControl(S.c.id, run.runId, "pause", actor, now());
  const n0 = posts.length;
  await actions.processDispatchRuns({ now, sleep: noSleep });
  assert.equal(posts.length, n0, "fila pausada nao envia");
  // 2) muda no meio: uma pessoa remarcada, uma cancelada, uma ja recebeu por outro caminho
  await prisma.appointment.update({ where: { id: extra[0].a.id }, data: { scheduledAt: sp("2026-10-21T18:00") } });
  await prisma.appointment.update({ where: { id: extra[1].a.id }, data: { status: "cancelled" } });
  await prisma.reminderDispatch.create({ data: { clinicId: S.c.id, bookingKey: `appt:${extra[2].a.id}`, appointmentId: extra[2].a.id, patientId: extra[2].p.id, ruleId: S.rule.id, kind: "dia_seguinte", startsAt: extra[2].a.scheduledAt, sendDay: "2026-10-20", state: "sent", detail: "enviado por outro caminho" } });
  // 3) WhatsApp fora: o item volta para a fila e nada sai
  await prisma.clinic.update({ where: { id: S.c.id }, data: { uazapiDownSince: sp("2026-10-20T10:00"), uazapiDownCheckedAt: sp("2026-10-20T10:29") } });
  await actions.runControl(S.c.id, run.runId, "resume", actor, now());
  await actions.processDispatchRuns({ now, sleep: noSleep });
  assert.equal(posts.length, n0, "WhatsApp fora: nada tentado");
  const pend = await prisma.dispatchRunItem.count({ where: { runId: run.runId, state: "pending" } });
  assert.ok(pend >= 1, "continua pendente");
  await prisma.clinic.update({ where: { id: S.c.id }, data: { uazapiDownSince: null, uazapiDownCheckedAt: null } });
  // 4) reinicio no meio: concessao vencida + item "running" volta a pendente e termina
  const first = await prisma.dispatchRunItem.findFirst({ where: { runId: run.runId, state: "pending" }, orderBy: { id: "asc" } });
  await prisma.dispatchRunItem.update({ where: { id: first.id }, data: { state: "running", attempts: 1, nextAt: null } });
  await prisma.dispatchRunItem.updateMany({ where: { runId: run.runId, state: "pending" }, data: { nextAt: null } }); // (a espera de 5 min depois do WhatsApp fora ja passou)
  await prisma.dispatchRun.update({ where: { id: run.runId }, data: { state: "running", leaseHolder: "processo-morto", leaseUntil: sp("2026-10-20T10:00") } });
  for (let i = 0; i < 3; i++) await actions.processDispatchRuns({ now, sleep: noSleep });
  const items = await prisma.dispatchRunItem.findMany({ where: { runId: run.runId } });
  const result = Object.fromEntries(items.map((i) => [i.ref, `${i.state}:${i.result}:${i.reason ?? ""}`]));
  assert.match(result[extra[0].a.id], /skipped.*horário mudou/, "remarcado depois da previa: nova versao do horario, nao envia");
  assert.match(result[extra[1].a.id], /skipped.*cancelled/, "cancelado depois da previa: nao envia");
  assert.match(result[extra[2].a.id], /skipped/, "ja recebeu depois da previa: sai da fila");
  assert.match(result[extra[3].a.id], /done:sent/, "o restante sai uma vez");
  assert.equal(para(extra[3].p).length, 1);
  assert.equal(para(extra[0].p).length + para(extra[1].p).length + para(extra[2].p).length, 0);
  assert.equal((await prisma.dispatchRun.findUnique({ where: { id: run.runId } })).state, "completed");
  // cancelamento de uma fila nova: o que nao saiu nao sai
  const novo = await agenda(S.c, "Cancelada Antes", "2026-10-21T19:00");
  const ids2 = (await viewAt(S.c, "2026-10-20T10:30", { recoverableToday: true, q: "Cancelada Antes" })).items.map((i) => i.id);
  const r2 = await actions.createRecoveryRun(S.c.id, { ids: ids2 }, actor, null, now());
  await actions.runControl(S.c.id, r2.runId, "cancel", actor, now());
  await actions.processDispatchRuns({ now, sleep: noSleep });
  assert.equal(para(novo.p).length, 0);
  const re = await actions.runControl(S.c.id, r2.runId, "resume", actor, now());
  assert.equal(re.ok, false, "fila encerrada nao volta");
});

test("ACOES: conciliar resultado incerto (so com decisao da equipe), cancelar pendente, reprogramar no mesmo dia, corrigir telefone sem reenvio imediato, resolver destino, encaminhar para a equipe; tudo no Diario", async () => {
  const S = await cenarioCompleto("Acoes");
  const now = sp("2026-10-20T10:30");
  const actor = { name: "Aline" };
  const bia = (await viewAt(S.c, "2026-10-20T10:30")).items.find((i) => i.patientName === "Bia Falhou");
  // conciliar so serve para incerto
  assert.equal((await actions.reconcileItem(S.c.id, bia.id, actor, "enviado", "", now)).ok, false);
  const row = await prisma.reminderDispatch.findFirst({ where: { appointmentId: S.falha.a.id } });
  await prisma.reminderDispatch.update({ where: { id: row.id }, data: { state: "unconfirmed", detail: "tempo esgotado" } });
  const inc = (await viewAt(S.c, "2026-10-20T10:30")).items.find((i) => i.patientName === "Bia Falhou");
  assert.equal(inc.status, "incerto");
  assert.equal(inc.recoverable, false, "incerto nunca e reenviado sem conciliar");
  const rc = await actions.reconcileItem(S.c.id, inc.id, actor, "nao_enviado", "conferi no celular", now);
  assert.equal(rc.ok, true);
  const depois = (await viewAt(S.c, "2026-10-20T10:30")).items.find((i) => i.patientName === "Bia Falhou");
  assert.equal(depois.status, "falhou");
  assert.equal(depois.recoverable, true);
  // reprogramar: dentro do dia e antes de 21h
  assert.equal((await actions.scheduleLater(S.c.id, depois.id, 60, actor, now)).ok, true);
  assert.equal((await actions.scheduleLater(S.c.id, depois.id, 480, actor, sp("2026-10-20T15:00"))).ok, false, "passa das 21h");
  // corrigir cadastro: valida, nao reenvia, nao apaga historico, nao aceita telefone de outro cadastro
  const n = posts.length;
  const bad = await actions.correctRegistration(S.c.id, S.falha.p.id, "abc", actor);
  assert.equal(bad.ok, false);
  const dup = await actions.correctRegistration(S.c.id, S.falha.p.id, S.ok.p.phone, actor);
  assert.equal(dup.ok, false, "telefone de outra pessoa");
  const okc = await actions.correctRegistration(S.c.id, S.falha.p.id, "(11) 98877-6655", actor);
  assert.equal(okc.ok, true);
  assert.equal(posts.length, n, "corrigir o cadastro nao dispara envio");
  assert.ok(await prisma.reminderDispatch.findFirst({ where: { appointmentId: S.falha.a.id } }), "historico preservado");
  // cancelar pendente: a Alice nao envia mais
  const gabi = (await viewAt(S.c, "2026-10-20T10:30")).items.find((i) => i.patientName === "Gabi Cadastrada Tarde");
  assert.equal((await actions.cancelPending(S.c.id, gabi.id, actor)).ok, true);
  const gabi2 = (await viewAt(S.c, "2026-10-20T10:30")).items.find((i) => i.patientName === "Gabi Cadastrada Tarde");
  assert.equal(gabi2.status, "cancelado");
  assert.equal(gabi2.reason, "cancelado_pela_equipe");
  assert.equal(gabi2.recoverable, false);
  // envio ja feito nao pode ser cancelado
  const ana = (await viewAt(S.c, "2026-10-20T10:30")).items.find((i) => i.patientName === "Ana Enviada");
  assert.equal((await actions.cancelPending(S.c.id, ana.id, actor)).ok, false);
  // encaminhar para a equipe: so afirma com aviso ACEITO pelo provedor (a clinica precisa ter o telefone de avisos)
  assert.equal((await actions.handoffToHuman(S.c.id, depois.id, actor, "ligar")).ok, false, "sem telefone de avisos: NAO foi avisada");
  await prisma.clinic.update({ where: { id: S.c.id }, data: { notifyPhone: "5511977112233", notifyEvents: "human_handoff" } });
  assert.equal((await actions.handoffToHuman(S.c.id, depois.id, actor, "ligar")).ok, true);
  // detalhe: linha do tempo, destino mascarado e id do provedor encurtado
  const det = await actions.dispatchDetail(S.c.id, ana.id, now);
  assert.ok(det.timeline.length >= 2);
  assert.ok(det.item.providerId.includes("…"));
  assert.ok(!JSON.stringify(det).includes(S.ok.p.phone));
  // Diario: quem fez o que
  const log = await prisma.activityLog.findMany({ where: { clinicId: S.c.id, type: "dispatch_action" } });
  assert.ok(log.length >= 5 && log.every((l) => l.actorName === "Aline"));
});

// ------------------------------------------------------------------ aniversarios na aba
test("ABA: aniversario com telefone invalido aparece com o motivo; recuperar so quem e do dia e esta elegivel; dia passado expira", async () => {
  zera();
  const { c } = await clinica("Aba Aniv");
  await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário, {primeiro_nome}! A equipe te deseja um dia muito especial." } });
  const dia = new Date(Date.UTC(1990, 9, 20));
  const boa = await prisma.patient.create({ data: { clinicId: c.id, name: "Aniv Boa", phone: "5511966611111", birthDate: dia } });
  const ruim = await prisma.patient.create({ data: { clinicId: c.id, name: "Aniv Ruim", phone: "55", birthDate: dia } });
  const ontem = await prisma.patient.create({ data: { clinicId: c.id, name: "Aniv Ontem", phone: "5511966622222", birthDate: new Date(Date.UTC(1991, 9, 19)) } });
  const semData = await prisma.patient.create({ data: { clinicId: c.id, name: "Sem Data", phone: "5511966633333" } });
  void semData;
  const v = await viewAt(c, "2026-10-20T10:20", { view: "hoje", kinds: ["aniversario"] });
  assert.equal(v.items.find((i) => i.patientName === "Aniv Ruim").reason, "telefone_invalido");
  assert.equal(v.items.find((i) => i.patientName === "Aniv Boa").recoverable, true);
  const ant = await viewAt(c, "2026-10-20T10:20", { from: "2026-10-19", to: "2026-10-19", kinds: ["aniversario"] });
  const o = ant.items.find((i) => i.patientName === "Aniv Ontem");
  assert.equal(o.status, "expirado");
  assert.equal(o.recoverable, false, "aniversario de ontem nao e recuperado hoje");
  const r = await actions.createRecoveryRun(c.id, { ids: v.items.map((i) => i.id) }, { name: "Aline" }, null, sp("2026-10-20T10:20"));
  assert.equal(r.queued, 1);
  await actions.processDispatchRuns({ now: () => sp("2026-10-20T10:20"), sleep: noSleep });
  assert.equal(para(boa).length, 1);
  assert.equal(para(ruim).length + para(ontem).length, 0);
  const v2 = await viewAt(c, "2026-10-20T10:20", { view: "hoje", kinds: ["aniversario"] });
  assert.equal(v2.items.find((i) => i.patientName === "Aniv Boa").status, "aceito");
  assert.equal(v2.cobertura.find((k) => k.kind === "aniversario").cobertura, null);
  void bday;
});

// ------------------------------------------------------------------ API
function startApi(resolveStaff) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.staff = resolveStaff(req); next(); });
  app.use("/dispatches", dispatchesRouter);
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const api = (base, staff) => async (method, url, body) => {
  const r = await realFetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-staff": staff ? JSON.stringify(staff) : "" }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text, buf, headers: r.headers };
};

test("API: escopo de clinica e permissao no SERVIDOR (cliente nunca sai da propria clinica), sem login = 401, politica por clinica, exportacao mascarada, repeticao limitada", async () => {
  resetDispatchLimitsForTests();
  const A = await cenarioCompleto("Api A");
  const B = await cenarioCompleto("Api B");
  const staffs = {
    clientA: { id: "uA", name: "Aline", clinicId: A.c.id, role: "client", epoch: 0, exp: 0 },
    clientB: { id: "uB", name: "Bruna", clinicId: B.c.id, role: "client", epoch: 0, exp: 0 },
    admin: { id: "adm", name: "Admin", clinicId: null, role: "admin", epoch: 0, exp: 0 },
  };
  const { srv, base } = await startApi((req) => { const h = req.headers["x-staff"]; return h ? JSON.parse(h) : null; });
  try {
    const anon = api(base, null), cA = api(base, staffs.clientA), cB = api(base, staffs.clientB), adm = api(base, staffs.admin);
    assert.equal((await anon("GET", "/dispatches/")).status, 401);
    // a data/hora do servidor e a real; pedimos o dia dos dados via from/to para nao depender do relogio
    const q = "?from=2026-10-20&to=2026-10-20";
    const ra = await cA("GET", `/dispatches/${q}&clinicId=${B.c.id}`); // tentativa de olhar a outra clinica
    assert.equal(ra.status, 200);
    const nomesA = ra.json.items.map((i) => i.patientName);
    assert.ok(nomesA.includes("Ana Enviada"));
    // as duas clinicas tem os mesmos nomes; o que prova o escopo e o conjunto de ids: todos pertencem a clinica A
    const idsA = new Set(ra.json.items.map((i) => i.id));
    const rb = await cB("GET", `/dispatches/${q}`);
    const idsB = new Set(rb.json.items.map((i) => i.id));
    assert.equal([...idsA].filter((x) => idsB.has(x)).length, 0, "nenhum item em comum");
    const rAdmB = await adm("GET", `/dispatches/${q}&clinicId=${B.c.id}`);
    assert.deepEqual([...new Set(rAdmB.json.items.map((i) => i.id))].sort(), [...idsB].sort(), "admin escolhe a clinica por clinicId");
    // item de outra clinica: 404 no detalhe e nas acoes (nunca revela que existe)
    const itemB = rb.json.items[0].id;
    assert.equal((await cA("GET", `/dispatches/item?id=${encodeURIComponent(itemB)}`)).status, 404);
    assert.equal((await cA("POST", "/dispatches/action", { id: itemB, action: "cancelar_pendente" })).status, 404);
    const prev = await cA("POST", "/dispatches/recovery/preview", { ids: [itemB] });
    assert.equal(prev.json.total, 0, "selecao com id de outra clinica e ignorada");
    // politica por clinica: alterar a A nao muda a B
    const put = await cA("PUT", "/dispatches/policy/confirmacao", { extendEnabled: false, maxPerRun: 5, extendUntil: "17:30" });
    assert.equal(put.status, 200);
    assert.equal(put.json.politica.extendEnabled, false);
    assert.equal((await cB("GET", "/dispatches/policy")).json.politica.confirmacao.extendUntil, "18:00", "a politica da outra clinica nao mudou");
    assert.equal(put.json.politica.extendUntil, "17:30");
    assert.equal((await cA("PUT", "/dispatches/policy/confirmacao", { extendUntil: "25:99" })).status, 400);
    assert.equal((await cA("PUT", "/dispatches/policy/confirmacao", { maxPerRun: 9999 })).json.politica.maxPerRun, 30, "limite seguro aplicado");
    assert.equal((await cA("PUT", "/dispatches/policy/inexistente", {})).status, 400);
    // exportacao: BOM, cabecalho, telefone mascarado, injecao de formula neutralizada
    await prisma.patient.update({ where: { id: A.ok.p.id }, data: { name: "=HYPERLINK(1)" } });
    const csv = await cA("GET", `/dispatches/export.csv${q}`);
    assert.equal(csv.status, 200);
    assert.deepEqual([...csv.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM para abrir no Excel");
  assert.ok(csv.text.replace(/^﻿/, "").startsWith("dia;tipo;pessoa"));
    assert.ok(!csv.text.includes(A.ok.p.phone));
    assert.ok(csv.text.includes("'=HYPERLINK"), "celula que parece formula e neutralizada");
    // protecao contra repeticao: muitas criacoes de recuperacao seguidas
    resetDispatchLimitsForTests();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await cA("POST", "/dispatches/recovery", { ids: [] })).status);
    assert.ok(codes.includes(429), `limite de repeticao: ${codes}`);
    // filtros invalidos nao quebram nem escapam do escopo
    assert.equal((await cA("GET", `/dispatches/?view=xx&status=foo&kinds=bar&page=-3&pageSize=100000`)).status, 200);
  } finally { srv.close(); }
});

test("JOBS: saude mostra ultima rodada, duracao, resultado e proxima esperada; sem rodada recente fica 'atrasado'", async () => {
  const { c } = await clinica("Jobs");
  const now = sp("2026-10-20T12:00");
  let h = await actions.jobsHealth(c.id, now);
  assert.equal(h.find((j) => j.job === "lembretes").atrasado, true);
  await prisma.automationRun.create({ data: { job: "lembretes", clinicId: c.id, startedAt: sp("2026-10-20T11:50"), finishedAt: sp("2026-10-20T11:50:30".slice(0, 16)), outcome: "ok", reasons: "{}" } });
  h = await actions.jobsHealth(c.id, now);
  const l = h.find((j) => j.job === "lembretes");
  assert.equal(l.atrasado, false);
  assert.equal(l.resultado, "ok");
  assert.ok(l.proximaEsperada);
});
