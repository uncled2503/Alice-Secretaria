// CONFIABILIDADE DOS DISPAROS (22/10/2026), lote 1: item alem dos 200, texto exato, conciliacao x evidencia do provedor, acoes com contagem, renovacao, retorno combinado, campanha, pos e
// calendario. Banco isolado, relogio controlado onde o codigo aceita relogio, provedor/OpenAI simulados. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-confiab-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
let mode = "ok"; // ok | http500 | timeout
let reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (/REVISOR (DE ENVIO|das respostas)/.test(String(body.messages?.[0]?.content))) return jsonRes(200, completion(reviewAnswer(body)));
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") {
      const b = JSON.parse(init.body);
      if (mode === "http500") return jsonRes(500, { error: "fora do ar" });
      if (mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      posts.push({ number: b.number, text: b.text });
      return jsonRes(200, { id: `owner:MID${String(posts.length).padStart(6, "0")}` });
    }
    return jsonRes(200, { instance: { status: "connected" }, status: { connected: true } });
  }
  return jsonRes(404, {});
};

const { prisma } = await import("../dist/db/client.js");
const gate = await import("../dist/ai/sendGate.js");
const model = await import("../dist/dispatch/model.js");
const actions = await import("../dist/dispatch/actions.js");
const renewal = await import("../dist/reminders/renewal.js");
const calendar = await import("../dist/reminders/calendarInterval.js");
const hot = await import("../dist/crm/hotLeads.js");
const broadcast = await import("../dist/crm/broadcast.js");
const post = await import("../dist/reminders/postProcedure.js");
actions.setDispatchAutoKick(false);

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
let seq = 0;
const reset = () => { posts.length = 0; mode = "ok"; reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" }); gate.resetBreakerForTests(); };
async function clinica(nome, extra = {}) {
  return prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", workStartHour: 0, workEndHour: 24, workDays: "0,1,2,3,4,5,6", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${++seq}`, ...extra } });
}
const pessoa = (c, nome, extra = {}) => prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119444${String(10000 + ++seq)}`, ...extra } });
async function proc(c, name = "Botox") { return (await prisma.procedure.findFirst({ where: { clinicId: c.id, name } })) ?? prisma.procedure.create({ data: { clinicId: c.id, name, durationMin: 30 } }); }
// desliga os ciclos de clinicas de cenarios anteriores (os ciclos varrem o banco todo)
const isola = async () => { await prisma.renewalRule.updateMany({ data: { active: false } }); await prisma.reminderRule.updateMany({ data: { active: false } }); await prisma.postProcedureRule.updateMany({ data: { active: false } }); await prisma.birthdayRule.updateMany({ data: { active: false } }); };

// ============================================================ A) DISPAROS: identidade, texto exato, conciliacao, acoes
test("A) item alem dos 200: detalhe e acoes funcionam em qualquer pagina (busca por identidade, sem depender da listagem)", async () => {
  reset();
  const c = await clinica("Muitos Itens");
  const NOW = sp("2026-10-20T10:30");
  const regra = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendEndHour: 9, message: "Oi {primeiro_nome}", purpose: "confirmacao", active: false } });
  const p = await proc(c);
  const N = 230;
  // massa por createMany (um insert por tabela): o objetivo e a PAGINACAO, nao o custo de criar 690 linhas uma a uma
  const stamp = Date.now();
  await prisma.patient.createMany({ data: Array.from({ length: N }, (_, i) => ({ id: `bulkp${stamp}${i}`, clinicId: c.id, name: `Pessoa ${String(i).padStart(3, "0")}`, phone: `55119333${String(10000 + i)}` })) });
  await prisma.appointment.createMany({ data: Array.from({ length: N }, (_, i) => ({ id: `bulka${stamp}${i}`, clinicId: c.id, patientId: `bulkp${stamp}${i}`, procedureId: p.id, scheduledAt: sp("2026-10-21T14:00"), source: "presencial" })) });
  await prisma.reminderDispatch.createMany({ data: Array.from({ length: N }, (_, i) => ({ clinicId: c.id, bookingKey: `appt:bulka${stamp}${i}`, appointmentId: `bulka${stamp}${i}`, patientId: `bulkp${stamp}${i}`, ruleId: regra.id, kind: "dia_seguinte", startsAt: sp("2026-10-21T14:00"), sendDay: "2026-10-20", state: "failed", detail: "Servidor HTTP 500", attempt: 1, messageText: `Texto exato ${i}`, providerId: `owner:ID${i}XYZ12` })) });
  const page1 = await model.buildDispatchView(c.id, { from: "2026-10-20", to: "2026-10-20", view: "historico", pageSize: 200, page: 1 }, NOW);
  const page2 = await model.buildDispatchView(c.id, { from: "2026-10-20", to: "2026-10-20", view: "historico", pageSize: 200, page: 2 }, NOW);
  assert.equal(page1.items.length, 200);
  assert.ok(page2.items.length >= 30, `segunda pagina: ${page2.items.length}`);
  const far = page2.items.at(-1); // fora dos 200 primeiros
  assert.ok(!page1.items.some((i) => i.id === far.id));
  const loaded = await actions.loadItem(c.id, far.id, NOW);
  assert.equal(loaded?.id, far.id, "carrega por identidade");
  const det = await actions.dispatchDetail(c.id, far.id, NOW);
  assert.equal(det.item.id, far.id);
  assert.match(det.text, /^Texto exato \d+$/, "texto exato da tentativa (gravado), nao reconstruido");
  assert.match(det.providerMessageId, /^owner:ID\d+XYZ12$/, "id completo da mensagem no provedor");
  const r = await actions.scheduleLater(c.id, far.id, 30, { name: "Aline" }, NOW);
  assert.equal(r.ok, true, r.message);
  const c2 = await actions.cancelPending(c.id, far.id, { name: "Aline" });
  assert.equal(c2.ok, true, c2.message);
  assert.equal((await actions.loadItem(c.id, far.id, NOW)).status, "cancelado");
  // item de OUTRA clinica / inexistente: nunca revela
  const outra = await clinica("Outra Clinica Itens");
  assert.equal(await actions.loadItem(outra.id, far.id, NOW), null);
  assert.equal(await actions.dispatchDetail(outra.id, far.id, NOW), null);
  assert.equal(await actions.loadItem(c.id, "rd:inexistente", NOW), null);
  assert.equal((await actions.cancelPending(outra.id, far.id, { name: "X" })).ok, false);
});

test("A) texto exato da tentativa vem do registro (nao do template de hoje nem de mensagem 'proxima no horario'); tentativa antiga sem texto diz isso", async () => {
  reset();
  const c = await clinica("Texto Exato");
  const NOW = sp("2026-10-20T10:30");
  const regra = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendEndHour: 9, message: "TEMPLATE NOVO DE HOJE", purpose: "confirmacao", active: false } });
  const p = await proc(c);
  const mk = async (nome, extra) => {
    const pt = await pessoa(c, nome);
    const ap = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: sp("2026-10-21T14:00"), source: "presencial" } });
    const row = await prisma.reminderDispatch.create({ data: { clinicId: c.id, bookingKey: `appt:${ap.id}`, appointmentId: ap.id, patientId: pt.id, ruleId: regra.id, kind: "dia_seguinte", startsAt: ap.scheduledAt, sendDay: "2026-10-20", state: "sent", attemptedAt: sp("2026-10-20T08:10"), deliveryState: "accepted", ...extra } });
    return { pt, row };
  };
  const novo = await mk("Com Texto", { messageText: "Olá, Com! Texto ENVIADO naquele dia.", providerId: "owner:MIDCOMTEXTO1" });
  const velho = await mk("Sem Texto", { providerId: null });
  // outra mensagem da Alice perto do horario: NAO pode ser usada como "o texto enviado"
  const conv = await prisma.conversation.create({ data: { patientId: novo.pt.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Outra mensagem qualquer perto do horario", createdAt: sp("2026-10-20T08:10") } });
  const d1 = await actions.dispatchDetail(c.id, `rd:${novo.row.id}`, NOW);
  assert.equal(d1.text, "Olá, Com! Texto ENVIADO naquele dia.");
  assert.ok(!/TEMPLATE NOVO/.test(JSON.stringify(d1)), "o template atual nao aparece como prova");
  const d2 = await actions.dispatchDetail(c.id, `rd:${velho.row.id}`, NOW);
  assert.equal(d2.text, null);
  assert.match(d2.textNote, /anterior ao registro do texto exato/);
  assert.equal(d2.providerMessageId, null);
});

test("A) o ciclo grava o texto EXATO e o id do provedor no momento do envio (lembrete e aniversario)", async () => {
  reset();
  await isola();
  const cron = await import("../dist/reminders/cron.js");
  const c = await clinica("Grava Texto");
  await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 9, message: "Olá, {primeiro_nome}! Confirma {data} às {hora}?", purpose: "confirmacao", pauseMinSec: 0, pauseMaxSec: 0, active: true } });
  const p = await proc(c);
  const pt = await pessoa(c, "Maria Grava");
  const ap = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: sp("2026-10-21T14:00"), source: "presencial", createdAt: sp("2026-10-01T10:00") } });
  await cron.runReminderCycle({ now: sp("2026-10-20T08:10") });
  const row = await prisma.reminderDispatch.findFirst({ where: { appointmentId: ap.id } });
  assert.equal(row.state, "sent");
  assert.equal(row.messageText, posts.find((x) => x.number === pt.phone).text, "texto gravado = texto que saiu");
  assert.match(row.messageText, /^Olá, Maria!/);
  assert.match(row.providerId, /^owner:MID/);
});

test("A) conciliacao: so de incerto; reserva recente (worker ativo) e recusada; confirmar manualmente NAO vira evidencia do provedor; transicao atomica (duas ao mesmo tempo, so uma vale)", async () => {
  reset();
  const c = await clinica("Conciliacao");
  const NOW = sp("2026-10-20T10:30");
  const regra = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendEndHour: 9, message: "x", purpose: "confirmacao", active: false } });
  const p = await proc(c);
  const mk = async (state, updatedAt) => {
    const pt = await pessoa(c, `Conc ${state} ${++seq}`);
    const ap = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: sp("2026-10-21T14:00"), source: "presencial" } });
    const row = await prisma.reminderDispatch.create({ data: { clinicId: c.id, bookingKey: `appt:${ap.id}`, appointmentId: ap.id, patientId: pt.id, ruleId: regra.id, kind: "dia_seguinte", startsAt: ap.scheduledAt, sendDay: "2026-10-20", state, detail: "x" } });
    if (updatedAt) await prisma.$executeRawUnsafe(`UPDATE "ReminderDispatch" SET updatedAt = ? WHERE id = ?`, updatedAt.getTime(), row.id);
    return row;
  };
  const actor = { name: "Aline" };
  // reserva RECENTE: pode ter envio em andamento
  const recente = await mk("reserved", NOW);
  const r0 = await actions.reconcileItem(c.id, `rd:${recente.id}`, actor, "nao_enviado", "", NOW);
  assert.equal(r0.ok, false);
  assert.match(r0.message, /recente|em andamento/i);
  assert.equal((await prisma.reminderDispatch.findUnique({ where: { id: recente.id } })).state, "reserved", "nada mudou");
  // estados que nao sao incertos
  const enviado = await mk("sent");
  assert.equal((await actions.reconcileItem(c.id, `rd:${enviado.id}`, actor, "enviado", "", NOW)).ok, false);
  // incerto + confirmacao MANUAL: nao e "aceito pelo provedor"
  const inc = await mk("unconfirmed");
  const ok = await actions.reconcileItem(c.id, `rd:${inc.id}`, actor, "enviado", "vi no celular", NOW);
  assert.equal(ok.ok, true, ok.message);
  const after = await prisma.reminderDispatch.findUnique({ where: { id: inc.id } });
  assert.equal(after.state, "sent");
  assert.equal(after.deliveryState, "staff_confirmed", "marca de confirmacao humana, nunca 'accepted'");
  assert.equal(after.providerId, null);
  const view = await model.buildDispatchView(c.id, { from: "2026-10-20", to: "2026-10-20", view: "historico" }, NOW);
  const line = view.items.find((i) => i.id === `rd:${inc.id}`);
  assert.equal(line.status, "confirmado_equipe");
  assert.equal(view.counters.aceitos, 1, "so a linha 'sent' do provedor conta como aceita: a confirmada pela equipe nao soma");
  assert.equal(view.counters.confirmados_equipe, 1);
  // duas conciliacoes simultaneas do mesmo item: exatamente uma vale
  const inc2 = await mk("unconfirmed");
  const [a, b] = await Promise.all([actions.reconcileItem(c.id, `rd:${inc2.id}`, actor, "nao_enviado", "", NOW), actions.reconcileItem(c.id, `rd:${inc2.id}`, { name: "Outra pessoa" }, "enviado", "", NOW)]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, `uma so: ${JSON.stringify([a, b])}`);
  // reserva ANTIGA (worker morto): pode conciliar
  const velha = await mk("reserved", new Date(NOW.getTime() - 2 * 3_600_000));
  assert.equal((await actions.reconcileItem(c.id, `rd:${velha.id}`, actor, "nao_enviado", "", NOW)).ok, true);
});

test("A) acoes confirmam a CONTAGEM: item que mudou de estado nao e dado como cancelado/reprogramado; 'equipe avisada' so com aviso aceito pelo provedor", async () => {
  reset();
  const c = await clinica("Acoes Contagem"); // sem telefone de avisos
  const NOW = sp("2026-10-20T10:30");
  const regra = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendEndHour: 9, message: "x", purpose: "confirmacao", active: false } });
  const p = await proc(c);
  const pt = await pessoa(c, "Mudou Estado");
  const ap = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: sp("2026-10-21T14:00"), source: "presencial" } });
  const row = await prisma.reminderDispatch.create({ data: { clinicId: c.id, bookingKey: `appt:${ap.id}`, appointmentId: ap.id, patientId: pt.id, ruleId: regra.id, kind: "dia_seguinte", startsAt: ap.scheduledAt, sendDay: "2026-10-20", state: "blocked", detail: "cancelado" } });
  const id = `rd:${row.id}`;
  // estado "bloqueado" nao e cancelavel/reprogramavel: a atualizacao atomica nao acha linha e NAO diz que deu certo
  const c1 = await actions.cancelPending(c.id, id, { name: "Aline" });
  assert.equal(c1.ok, false);
  assert.match(c1.message, /mudou de estado|nada foi cancelado/i);
  const s1 = await actions.scheduleLater(c.id, id, 30, { name: "Aline" }, NOW);
  assert.equal(s1.ok, false);
  assert.match(s1.message, /mudou de estado|nada foi reprogramado/i);
  // aviso a equipe: sem telefone de avisos = NAO avisou
  const h1 = await actions.handoffToHuman(c.id, id, { name: "Aline" }, "");
  assert.equal(h1.ok, false);
  assert.match(h1.message, /NÃO foi avisada/);
  assert.ok(await prisma.activityLog.findFirst({ where: { clinicId: c.id, title: "Aviso à equipe NÃO enviado" } }), "a tentativa fica registrada como NAO enviada");
  // com telefone e evento ligado, e o provedor aceita: avisou
  await prisma.clinic.update({ where: { id: c.id }, data: { notifyPhone: "5511988776655", notifyEvents: "human_handoff" } });
  const before = posts.length;
  const h2 = await actions.handoffToHuman(c.id, id, { name: "Aline" }, "ligar");
  assert.equal(h2.ok, true, h2.message);
  assert.equal(posts.length, before + 1);
  assert.ok(await prisma.activityLog.findFirst({ where: { clinicId: c.id, title: "Disparo encaminhado para a equipe" } }));
  // provedor recusa o aviso: tambem NAO afirma
  mode = "http500";
  const h3 = await actions.handoffToHuman(c.id, id, { name: "Aline" }, "");
  assert.equal(h3.ok, false);
  mode = "ok";
  // reprogramar de verdade tem EFEITO no ciclo (nextAttemptAt e respeitado): linha 'failed' reprogramada nao e tentada antes
  const pt2 = await pessoa(c, "Reprogramada");
  const ap2 = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt2.id, procedureId: p.id, scheduledAt: sp("2026-10-21T14:00"), source: "presencial" } });
  const row2 = await prisma.reminderDispatch.create({ data: { clinicId: c.id, bookingKey: `appt:${ap2.id}`, appointmentId: ap2.id, patientId: pt2.id, ruleId: regra.id, kind: "dia_seguinte", startsAt: ap2.scheduledAt, sendDay: "2026-10-20", state: "failed", detail: "x", attempt: 1 } });
  await prisma.$executeRawUnsafe(`UPDATE "ReminderDispatch" SET updatedAt = ? WHERE id = ?`, sp("2026-10-20T09:00").getTime(), row2.id); // (relogio do teste: o registro e anterior ao NOW)
  const s2 = await actions.scheduleLater(c.id, `rd:${row2.id}`, 120, { name: "Aline" }, NOW);
  assert.equal(s2.ok, true, s2.message);
  const ledger = await import("../dist/reminders/ledger.js");
  const key = { clinicId: c.id, bookingKey: `appt:${ap2.id}`, appointmentId: ap2.id, patientId: pt2.id, ruleId: regra.id, kind: "dia_seguinte", startsAt: ap2.scheduledAt, sendDay: "2026-10-20" };
  assert.ok(await ledger.precheckDispatch(key, new Date(NOW.getTime() + 60 * 60_000)), "dentro da reprogramacao: aguarda");
  await prisma.$executeRawUnsafe(`UPDATE "ReminderDispatch" SET updatedAt = ? WHERE id = ?`, sp("2026-10-20T10:31").getTime(), row2.id); // (o tempo anda: o registro volta a ser "antigo" para o relogio do teste)
  assert.equal(await ledger.precheckDispatch(key, new Date(NOW.getTime() + 3 * 3_600_000)), null, "passou do horario reprogramado: pode tentar");
});

// ============================================================ B) RENOVACAO
test("B) calendario: meses/anos por data civil no fuso da clinica; fim de mes e bissexto com regra explicita", () => {
  const add = (iso, m) => calendar.addCalendarMonths(new Date(iso), m, TZ).toISOString();
  assert.equal(add("2026-10-31T15:00:00Z", 4), "2027-02-28T15:00:00.000Z", "31/10 + 4 meses = ultimo dia de fevereiro (nao bissexto)");
  assert.equal(add("2027-10-31T15:00:00Z", 4), "2028-02-29T15:00:00.000Z", "bissexto: 29/02");
  assert.equal(add("2026-08-31T15:00:00Z", 1), "2026-09-30T15:00:00.000Z");
  assert.equal(add("2026-11-30T15:00:00Z", 3), "2027-02-28T15:00:00.000Z", "virada de ano");
  assert.equal(add("2028-02-29T15:00:00Z", 12), "2029-02-28T15:00:00.000Z", "29/02 + 1 ano = 28/02 (nunca 01/03)");
  assert.equal(add("2026-01-15T15:00:00Z", 12), "2027-01-15T15:00:00.000Z");
  // data LOCAL: 31/10 23h30 em Sao Paulo ja e 01/11 em UTC; vale o dia local (31/10) e o horario de parede
  assert.equal(calendar.addCalendarMonths(sp("2026-10-31T23:30"), 1, TZ).toISOString(), sp("2026-11-30T23:30").toISOString());
  assert.equal(calendar.intervalMonths(1, "years"), 12);
  assert.equal(calendar.intervalMonths(4, "months"), 4);
  assert.equal(calendar.intervalMonths(5, "years"), 24, "teto de 2 anos");
  assert.equal(calendar.intervalMonths(1, "days"), null, "unidade invalida");
  assert.equal(calendar.intervalMonths(0, "months"), null);
  // 1 ano a partir de 2028-03-01 NAO e 365 dias: 2029-03-01
  assert.equal(add("2028-03-01T15:00:00Z", 12), "2029-03-01T15:00:00.000Z");
});

async function cenarioRenovacao(nome, { quando = "2026-06-18T14:00", status = "completed", unit = "months", value = 4 } = {}) {
  await isola();
  const c = await clinica(nome);
  const regra = await prisma.renewalRule.create({ data: { clinicId: c.id, name: "Botox 4 meses", message: "Oi {primeiro_nome}, ja faz {procedimento}: vamos renovar?", intervalValue: value, intervalUnit: unit, onlyIfCompleted: true, procedureIds: "" } });
  const p = await proc(c);
  const pt = await pessoa(c, "Renova Pessoa");
  const ap = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: sp(quando), endsAt: sp(quando.replace("14:00", "14:30")), status, source: "presencial" } });
  return { c, regra, pt, ap };
}
const rowOf = (S) => prisma.renewalSent.findUnique({ where: { appointmentId_ruleId: { appointmentId: S.ap.id, ruleId: S.regra.id } } });

test("B) renovacao vetada NAO consome o evento: fica visivel, tenta de novo depois do intervalo e sai UMA vez; so 'sent' consome", async () => {
  reset();
  const S = await cenarioRenovacao("Renova Veto");
  const t0 = sp("2026-10-20T10:00"); // 18/06 14:30 + 4 meses = 18/10 14:30 (vencida ha 2 dias)
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "a pessoa reclamou ontem do atendimento", categoria: "reclamacao" });
  const r1 = await renewal.runRenewalCycle(() => t0);
  assert.equal(r1.sent, 0);
  assert.equal(posts.length, 0);
  let row = await rowOf(S);
  assert.equal(row.state, "vetoed", "visivel, NAO consumida");
  assert.equal(row.acceptedAt, null);
  assert.equal(row.attempts, 1);
  assert.match(row.messageText, /^Oi Renova,/, "texto exato da tentativa guardado");
  assert.ok(row.nextAttemptAt.getTime() > t0.getTime());
  // antes do intervalo: nao tenta
  await renewal.runRenewalCycle(() => new Date(t0.getTime() + 60 * 60_000));
  assert.equal((await rowOf(S)).attempts, 1);
  // depois do intervalo, com o motivo resolvido: sai uma vez
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
  gate.resetBreakerForTests();
  // o veredito "nao enviar" vale por 3 h para o MESMO contexto (cache do revisor); a pessoa escreveu de novo = contexto novo = revisao nova
  const conv = await prisma.conversation.create({ data: { patientId: S.pt.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Oi, tudo bem? Vi a mensagem de voces." } });
  const t1 = new Date(t0.getTime() + 7 * 3_600_000);
  assert.equal((await renewal.runRenewalCycle(() => t1)).sent, 1);
  row = await rowOf(S);
  assert.equal(row.state, "sent");
  assert.equal(row.attempts, 2);
  assert.ok(row.acceptedAt && /^owner:MID/.test(row.providerId) && row.destination);
  await renewal.runRenewalCycle(() => new Date(t1.getTime() + 7 * 3_600_000));
  assert.equal(posts.length, 1, "nunca duas vezes");
});

test("B) falha temporaria recupera sem duplicar; timeout e INCERTO e nunca reenvia; teto de tentativas; concorrencia = uma mensagem", async () => {
  reset();
  const S = await cenarioRenovacao("Renova Falha");
  const t0 = sp("2026-10-20T10:00");
  mode = "http500";
  await renewal.runRenewalCycle(() => t0);
  assert.equal((await rowOf(S)).state, "failed");
  mode = "ok";
  const [a, b] = await Promise.all([renewal.runRenewalCycle(() => new Date(t0.getTime() + 7 * 3_600_000)), renewal.runRenewalCycle(() => new Date(t0.getTime() + 7 * 3_600_000))]);
  assert.equal(a.sent + b.sent, 1, "dois ciclos ao mesmo tempo: uma unica mensagem");
  assert.equal(posts.length, 1);
  assert.equal((await rowOf(S)).state, "sent");

  reset();
  const T = await cenarioRenovacao("Renova Timeout");
  mode = "timeout";
  await renewal.runRenewalCycle(() => t0);
  assert.equal((await rowOf(T)).state, "unconfirmed");
  mode = "ok";
  await renewal.runRenewalCycle(() => new Date(t0.getTime() + 8 * 3_600_000));
  await renewal.runRenewalCycle(() => new Date(t0.getTime() + 16 * 3_600_000));
  assert.equal(posts.length, 0, "resultado incerto: NUNCA reenvia sozinho");

  reset();
  const U = await cenarioRenovacao("Renova Esgota");
  mode = "http500";
  for (let i = 0; i < 4; i++) await renewal.runRenewalCycle(() => new Date(t0.getTime() + i * 24 * 3_600_000)); // um ciclo por dia, dentro de 8h-20h
  const ru = await rowOf(U);
  assert.equal(ru.state, "exhausted");
  assert.equal(ru.attempts, 3);
});

test("B) queda: reserva sem tentativa iniciada e liberada; com tentativa iniciada vira incerta (nunca reenvia); registro antigo (legacy) continua consumido", async () => {
  reset();
  const S = await cenarioRenovacao("Renova Queda");
  const t0 = sp("2026-10-20T10:00");
  const old = new Date(t0.getTime() - 2 * 3_600_000);
  await prisma.renewalSent.create({ data: { appointmentId: S.ap.id, ruleId: S.regra.id, state: "reserved", attempts: 1, updatedAt: old } });
  await renewal.runRenewalCycle(() => t0); // libera (sem attemptedAt) e tenta no mesmo ciclo? so na proxima: deferred sem nextAttemptAt
  let row = await rowOf(S);
  assert.ok(["deferred", "sent"].includes(row.state), row.state);
  // com tentativa iniciada
  reset();
  const T = await cenarioRenovacao("Renova Queda 2");
  await prisma.renewalSent.create({ data: { appointmentId: T.ap.id, ruleId: T.regra.id, state: "reserved", attempts: 1, attemptedAt: old, updatedAt: old } });
  await renewal.runRenewalCycle(() => t0);
  assert.equal((await rowOf(T)).state, "unconfirmed");
  assert.equal(posts.length, 0);
  // legacy
  reset();
  const L = await cenarioRenovacao("Renova Legacy");
  await prisma.renewalSent.create({ data: { appointmentId: L.ap.id, ruleId: L.regra.id } }); // sem estado: default legacy = consumida
  assert.equal((await rowOf(L)).state, "legacy");
  await renewal.runRenewalCycle(() => t0);
  assert.equal(posts.length, 0);
});

test("B) so atendimento CONCLUIDO renova; nao vence antes do calendario; 1 ano em ano bissexto; fora de 8h-20h nao envia; opt-out e nao-paciente nao recebem", async () => {
  reset();
  const naoFez = await cenarioRenovacao("Renova Confirmado", { status: "confirmed" });
  await renewal.runRenewalCycle(() => sp("2026-10-20T10:00"));
  assert.equal(posts.length, 0, "agendado que passou sem conclusao NAO prova realizacao");
  assert.equal(await rowOf(naoFez), null);

  reset();
  const cedo = await cenarioRenovacao("Renova Cedo");
  await renewal.runRenewalCycle(() => sp("2026-10-18T14:00")); // 18/06 14:30 + 4m = 18/10 14:30: ainda nao
  assert.equal(posts.length, 0);
  await renewal.runRenewalCycle(() => sp("2026-10-18T14:45"));
  assert.equal(posts.length, 1, "venceu no calendario");
  void cedo;

  reset();
  const ano = await cenarioRenovacao("Renova Ano", { quando: "2028-03-01T14:00", unit: "years", value: 1 });
  await renewal.runRenewalCycle(() => sp("2029-02-28T16:00")); // 365 dias depois (bissexto): ainda nao e 01/03/2029
  assert.equal(posts.length, 0, "1 ano = mesma data do ano seguinte, nao 365 dias");
  await renewal.runRenewalCycle(() => sp("2029-03-01T15:00"));
  assert.equal(posts.length, 1);
  void ano;

  reset();
  const noite = await cenarioRenovacao("Renova Noite");
  await renewal.runRenewalCycle(() => sp("2026-10-20T21:00"));
  assert.equal(posts.length, 0, "fora de 8h-20h");
  void noite;

  reset();
  const opt = await cenarioRenovacao("Renova OptOut");
  await prisma.patient.update({ where: { id: opt.pt.id }, data: { optedOut: true } });
  const np = await cenarioRenovacao("Renova NaoPaciente");
  await prisma.patient.update({ where: { id: np.pt.id }, data: { contactKind: "nao_paciente", contactKindDetail: "parceria", contactKindSource: "equipe" } });
  await renewal.runRenewalCycle(() => sp("2026-10-20T10:00"));
  assert.equal(posts.length, 0);
});

// ============================================================ C) RETORNO COMBINADO
async function cenarioRetorno(nome, extra = {}) {
  await isola();
  const c = await clinica(nome, { aliceActive: true, ...extra });
  const pt = await pessoa(c, "Retorno Pessoa", { callbackAt: sp("2026-10-20T09:00"), callbackNote: "depois do dia 20" });
  return { c, pt };
}
const cbRow = (S) => prisma.callbackDispatch.findFirst({ where: { patientId: S.pt.id } });
const cbPatient = (S) => prisma.patient.findUnique({ where: { id: S.pt.id } });

test("C) retorno combinado: falha NAO apaga a promessa; recupera depois sem duplicar; so limpa depois do desfecho final", async () => {
  reset();
  const S = await cenarioRetorno("Retorno Falha");
  const t0 = sp("2026-10-20T10:00");
  mode = "http500";
  const r1 = await hot.runCallbackCycle(t0, { clinicId: S.c.id });
  assert.equal(r1.failed, 1);
  assert.equal(r1.sent, 0);
  let p = await cbPatient(S);
  assert.ok(p.callbackAt, "a promessa continua no cadastro");
  assert.equal(p.callbackNote, "depois do dia 20");
  let row = await cbRow(S);
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 1);
  mode = "ok";
  // antes do intervalo: nao tenta
  await hot.runCallbackCycle(new Date(t0.getTime() + 60_000), { clinicId: S.c.id });
  assert.equal(posts.length, 0);
  // depois: sai uma vez (dois ciclos ao mesmo tempo)
  const t1 = new Date(t0.getTime() + 16 * 60_000);
  const [a, b] = await Promise.all([hot.runCallbackCycle(t1, { clinicId: S.c.id }), hot.runCallbackCycle(t1, { clinicId: S.c.id })]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(posts.length, 1);
  row = await cbRow(S);
  assert.equal(row.state, "sent");
  assert.match(row.messageText, /^Oi, Retorno!/);
  assert.match(row.providerId, /^owner:MID/);
  assert.equal((await cbPatient(S)).callbackAt, null, "agora, e so agora, a promessa e limpa");
  await hot.runCallbackCycle(new Date(t1.getTime() + 3_600_000), { clinicId: S.c.id });
  assert.equal(posts.length, 1);
});

test("C) retorno combinado: indisponibilidade/timeout/queda preservam a promessa; incerto nunca reenvia; esgota e avisa sem apagar", async () => {
  reset();
  const S = await cenarioRetorno("Retorno Timeout");
  const t0 = sp("2026-10-20T10:00");
  mode = "timeout";
  const r = await hot.runCallbackCycle(t0, { clinicId: S.c.id });
  assert.equal(r.uncertain, 1);
  assert.equal((await cbRow(S)).state, "unconfirmed");
  mode = "ok";
  await hot.runCallbackCycle(new Date(t0.getTime() + 3_600_000), { clinicId: S.c.id });
  assert.equal(posts.length, 0, "incerto: nunca reenvia");

  // WhatsApp desconectado: nada tentado, promessa intacta
  reset();
  const D = await cenarioRetorno("Retorno Desconectado");
  await prisma.clinic.update({ where: { id: D.c.id }, data: { uazapiDownSince: new Date(Date.now() - 3_600_000), uazapiDownCheckedAt: new Date() } }); // (o envio usa o relogio real para a conexao)
  const rd = await hot.runCallbackCycle(t0, { clinicId: D.c.id });
  assert.equal(rd.deferred, 1);
  assert.ok((await cbPatient(D)).callbackAt, "promessa preservada");
  assert.equal(posts.length, 0);
  assert.equal((await cbRow(D)).attempts, 0, "nao gastou tentativa");

  // queda: running sem tentativa iniciada volta; com tentativa iniciada e incerto
  reset();
  const Q = await cenarioRetorno("Retorno Queda");
  const old = new Date(t0.getTime() - 2 * 3_600_000);
  await prisma.callbackDispatch.create({ data: { clinicId: Q.c.id, patientId: Q.pt.id, dueAt: Q.pt.callbackAt, state: "running", attempts: 1, updatedAt: old } });
  const rq = await hot.runCallbackCycle(t0, { clinicId: Q.c.id });
  assert.equal(rq.sent, 1, "reserva abandonada antes do provedor: retomada e enviada uma vez");
  reset();
  const Q2 = await cenarioRetorno("Retorno Queda 2");
  await prisma.callbackDispatch.create({ data: { clinicId: Q2.c.id, patientId: Q2.pt.id, dueAt: Q2.pt.callbackAt, state: "running", attempts: 1, attemptedAt: old, updatedAt: old } });
  await hot.runCallbackCycle(t0, { clinicId: Q2.c.id });
  assert.equal((await cbRow(Q2)).state, "unconfirmed");
  assert.equal(posts.length, 0);
});

test("C) retorno combinado: encaminhamento a equipe NAO conta como mensagem enviada e so fecha com o aviso aceito; veto avisa a equipe com evidencia", async () => {
  reset();
  const S = await cenarioRetorno("Retorno Equipe");
  const conv = await prisma.conversation.create({ data: { patientId: S.pt.id, humanTakeover: true } });
  void conv;
  const t0 = sp("2026-10-20T10:00");
  // sem telefone de avisos: a equipe NAO foi avisada -> promessa pendente
  const r1 = await hot.runCallbackCycle(t0, { clinicId: S.c.id });
  assert.equal(r1.forwarded, 0);
  assert.equal(r1.deferred, 1);
  assert.ok((await cbPatient(S)).callbackAt);
  assert.equal((await cbRow(S)).state, "deferred");
  // com aviso aceito: forwarded (nao e "enviada")
  await prisma.clinic.update({ where: { id: S.c.id }, data: { notifyPhone: "5511977665544", notifyEvents: "human_handoff,automation_failed" } });
  const r2 = await hot.runCallbackCycle(new Date(t0.getTime() + 16 * 60_000), { clinicId: S.c.id });
  assert.equal(r2.forwarded, 1);
  assert.equal(r2.sent, 0, "encaminhamento humano nao e mensagem enviada");
  const row = await cbRow(S);
  assert.equal(row.state, "forwarded");
  assert.equal(row.providerId, null);
  assert.equal((await cbPatient(S)).callbackAt, null);
  assert.equal(posts.filter((x) => x.number === S.pt.phone).length, 0, "nada foi mandado para a pessoa");

  // veto da revisao: avisa a equipe (aceito) -> forwarded; sem aviso aceito -> promessa continua
  reset();
  const V = await cenarioRetorno("Retorno Veto", { notifyPhone: "5511977665500", notifyEvents: "automation_failed,human_handoff" });
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "pediu para nao receber", categoria: "opt_out" });
  const rv = await hot.runCallbackCycle(t0, { clinicId: V.c.id });
  assert.equal(rv.forwarded, 1);
  assert.equal(rv.sent, 0);
  assert.equal((await cbRow(V)).state, "forwarded");
  assert.ok(posts.some((x) => /NÃO foi enviado/.test(x.text)), "a equipe recebeu o aviso");
  assert.ok(!posts.some((x) => x.number === V.pt.phone), "a pessoa nao recebeu nada");
});

// ============================================================ D) CAMPANHA
async function cenarioCampanha(nome, recipientExtra = {}) {
  await prisma.broadcastCampaign.updateMany({ where: { status: "sending" }, data: { status: "cancelled" } });
  const c = await clinica(nome);
  const camp = await prisma.broadcastCampaign.create({ data: { clinicId: c.id, title: "Promo", message: "Oi {primeiro_nome}! Promoção especial da clínica para você aproveitar.", scheduledFor: new Date(Date.now() - 60_000), status: "sending", targetMode: "contacts" } });
  const pt = await pessoa(c, "Campanha Pessoa");
  const rec = await prisma.broadcastRecipient.create({ data: { campaignId: camp.id, patientId: pt.id, ...recipientExtra } });
  return { c, camp, pt, rec };
}
const recOf = (S) => prisma.broadcastRecipient.findUnique({ where: { id: S.rec.id } });

test("D) campanha: sentAt SO quando o provedor aceitou; veto/bloqueio/falha/incerto ficam separados e visiveis; texto e id guardados", async () => {
  reset();
  const ok = await cenarioCampanha("Camp Ok");
  await broadcast.runBroadcastTick();
  let r = await recOf(ok);
  assert.equal(r.status, "sent");
  assert.ok(r.sentAt, "aceito: sentAt");
  assert.match(r.providerId, /^owner:MID/);
  assert.match(r.messageText, /^Oi Campanha!/);
  assert.equal(r.attempts, 1);
  assert.equal((await prisma.broadcastCampaign.findUnique({ where: { id: ok.camp.id } })).status, "completed");

  reset();
  const veto = await cenarioCampanha("Camp Veto");
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "pediu para nao receber", categoria: "opt_out" });
  await broadcast.runBroadcastTick();
  r = await recOf(veto);
  assert.equal(r.status, "vetoed");
  assert.equal(r.sentAt, null, "NAO houve envio: sem sentAt");
  assert.equal(posts.length, 0);

  reset();
  const falha = await cenarioCampanha("Camp Falha");
  mode = "http500";
  await broadcast.runBroadcastTick();
  r = await recOf(falha);
  assert.equal(r.status, "failed");
  assert.equal(r.sentAt, null);
  assert.ok(r.nextAttemptAt);
  assert.equal(r.attempts, 1);
  // recuperavel: depois do intervalo tenta de novo e envia UMA vez
  mode = "ok";
  await prisma.broadcastRecipient.update({ where: { id: falha.rec.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  await broadcast.runBroadcastTick();
  r = await recOf(falha);
  assert.equal(r.status, "sent");
  assert.equal(r.attempts, 2);
  assert.ok(r.sentAt);
  assert.equal(posts.length, 1);

  reset();
  const tmo = await cenarioCampanha("Camp Timeout");
  mode = "timeout";
  await broadcast.runBroadcastTick();
  r = await recOf(tmo);
  assert.equal(r.status, "unconfirmed");
  assert.equal(r.sentAt, null);
  mode = "ok";
  await broadcast.runBroadcastTick();
  await broadcast.runBroadcastTick();
  assert.equal(posts.length, 0, "incerto: nunca reenvia");
});

test("D) campanha: reserva atomica (em andamento nao e pega), reserva abandonada e liberada, nao-paciente/opt-out ignorados sem sentAt, adiada quando o WhatsApp esta fora", async () => {
  reset();
  const emAndamento = await cenarioCampanha("Camp Em Andamento", { status: "sending", attempts: 1 });
  await prisma.broadcastRecipient.update({ where: { id: emAndamento.rec.id }, data: { updatedAt: new Date() } });
  await broadcast.runBroadcastTick();
  assert.equal(posts.length, 0, "outro worker esta com ele: nao envia");
  assert.equal((await recOf(emAndamento)).status, "sending");

  reset();
  const abandonada = await cenarioCampanha("Camp Abandonada", { status: "sending", attempts: 1 });
  await prisma.broadcastRecipient.update({ where: { id: abandonada.rec.id }, data: { updatedAt: new Date(Date.now() - 2 * 3_600_000) } });
  await broadcast.runBroadcastTick();
  assert.equal((await recOf(abandonada)).status, "sent", "sem tentativa iniciada: liberada e enviada uma vez");
  assert.equal(posts.length, 1);

  reset();
  const incerta = await cenarioCampanha("Camp Queda", { status: "sending", attempts: 1, attemptedAt: new Date(Date.now() - 2 * 3_600_000) });
  await prisma.broadcastRecipient.update({ where: { id: incerta.rec.id }, data: { updatedAt: new Date(Date.now() - 2 * 3_600_000) } });
  await broadcast.runBroadcastTick();
  assert.equal((await recOf(incerta)).status, "unconfirmed");
  assert.equal(posts.length, 0);

  reset();
  const np = await cenarioCampanha("Camp NaoPaciente");
  await prisma.patient.update({ where: { id: np.pt.id }, data: { contactKind: "nao_paciente", contactKindDetail: "fornecedor", contactKindSource: "equipe" } });
  await broadcast.runBroadcastTick();
  const rnp = await recOf(np);
  assert.equal(rnp.status, "skipped");
  assert.equal(rnp.sentAt, null);
  assert.equal(posts.length, 0);

  reset();
  const fora = await cenarioCampanha("Camp WhatsApp Fora");
  await prisma.clinic.update({ where: { id: fora.c.id }, data: { uazapiDownSince: new Date(Date.now() - 3_600_000), uazapiDownCheckedAt: new Date() } });
  await broadcast.runBroadcastTick();
  const rf = await recOf(fora);
  assert.equal(rf.status, "deferred");
  assert.equal(rf.sentAt, null);
  assert.equal(rf.attempts, 0, "nao gastou tentativa");
  assert.equal(posts.length, 0);
});

test("D) campanha com resposta para humano: a atribuicao usa SO envio aceito (sentAt); veto/falha nao viram atribuicao", async () => {
  reset();
  const camp = await import("../dist/crm/campaignReply.js");
  const vetoS = await cenarioCampanha("Camp Atribuicao");
  await prisma.broadcastCampaign.update({ where: { id: vetoS.camp.id }, data: { humanAfterReply: true } });
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "x", categoria: "opt_out" });
  await broadcast.runBroadcastTick(); // vetada: sem sentAt
  const conv = await prisma.conversation.create({ data: { patientId: vetoS.pt.id } });
  assert.equal((await camp.applyCampaignHumanReply(vetoS.c.id, vetoS.pt.id, conv.id, "oi")).took, false, "campanha que NAO saiu nao e atribuida");
  reset();
  const okS = await cenarioCampanha("Camp Atribuicao Ok");
  await prisma.broadcastCampaign.update({ where: { id: okS.camp.id }, data: { humanAfterReply: true } });
  await broadcast.runBroadcastTick();
  const conv2 = await prisma.conversation.create({ data: { patientId: okS.pt.id } });
  const res = await camp.applyCampaignHumanReply(okS.c.id, okS.pt.id, conv2.id, "quanto custa?");
  assert.equal(res.took, true);
  assert.equal((await prisma.conversation.findUnique({ where: { id: conv2.id } })).humanTakeover, true);
});

// ============================================================ E) POS-PROCEDIMENTO
test("E) pos so com atendimento CONCLUIDO: 'nao cancelado' nao e prova de realizacao (nem com onlyIfCompleted=false); o resumo conta quem ficou sem evidencia", async () => {
  reset();
  await isola();
  const c = await clinica("Pos Evidencia");
  const p = await proc(c, "Limpeza de pele");
  const regra = await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos", message: "Oi {primeiro_nome}, como foi o seu {procedimento}?", intervalValue: 1, intervalUnit: "hours", onlyIfCompleted: false, procedureIds: "", active: true, lateSendUntilHour: 23 } });
  const feito = await pessoa(c, "Atendida Feito");
  const so = await pessoa(c, "So Agendada");
  const base = { clinicId: c.id, procedureId: p.id, source: "presencial", scheduledAt: sp("2026-10-20T14:00"), endsAt: sp("2026-10-20T14:30") };
  await prisma.appointment.create({ data: { ...base, patientId: feito.id, status: "completed" } });
  await prisma.appointment.create({ data: { ...base, patientId: so.id, status: "confirmed" } });
  await post.runPostProcedureCycle(() => sp("2026-10-20T16:00"));
  assert.equal(posts.filter((x) => x.number === feito.phone).length, 1, "concluido: sai");
  assert.equal(posts.filter((x) => x.number === so.phone).length, 0, "so agendada (nao cancelou): NAO sai");
  const run = await prisma.automationRun.findFirst({ where: { job: "pos-procedimento", clinicId: c.id }, orderBy: { startedAt: "desc" } });
  assert.match(run.reasons ?? "", /sem_evidencia_de_realizacao/);
  void regra;
  // marcar como concluido depois libera
  await prisma.appointment.updateMany({ where: { patientId: so.id }, data: { status: "completed" } });
  await post.runPostProcedureCycle(() => sp("2026-10-20T16:30"));
  assert.equal(posts.filter((x) => x.number === so.phone).length, 1);
});

// ============================================================ F) /health e migracao real
test("F) migracao nova: aplica sobre banco COM DADOS anteriores (SQL real), preserva linhas e fica compativel com o schema", async () => {
  const { cachedPreDb, makeProject, migrationsBefore, cli, urlOf } = await import("./helpers-migracao.mjs");
  const NEW = "20261027100000_confiabilidade_disparos";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alice-mig-conf-"));
  const dbPath = path.join(tmp, "pre.db");
  fs.copyFileSync(await cachedPreDb(NEW), dbPath); // estado imediatamente ANTERIOR (migracoes reais, cacheado)
  const url = urlOf(dbPath);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: `${url}?connection_limit=1` } } });
  try {
    const ins = async (table, values) => {
      const info = await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
      const row = { ...values };
      for (const c of info) { if (c.name in row || Number(c.notnull) !== 1 || c.dflt_value != null) continue; const ty = String(c.type).toUpperCase(); row[c.name] = ty === "TEXT" ? `${table}-${c.name}-${Math.random()}` : ty === "DATETIME" ? new Date().toISOString() : 0; }
      const cols = Object.keys(row);
      await db.$executeRawUnsafe(`INSERT INTO "${table}" (${cols.map((x) => `"${x}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...Object.values(row));
    };
    await ins("Clinic", { id: "c1", name: "C", whatsappPhone: "5511900000001" });
    await ins("Patient", { id: "p1", clinicId: "c1", phone: "5511900000002" });
    await ins("Procedure", { id: "pr1", clinicId: "c1", name: "Botox", durationMin: 30 });
    await ins("Appointment", { id: "ap1", clinicId: "c1", patientId: "p1", procedureId: "pr1", scheduledAt: "2026-06-18 14:00:00" });
    await ins("RenewalRule", { id: "rr1", clinicId: "c1", name: "R", message: "m" });
    await ins("RenewalSent", { id: "rs1", appointmentId: "ap1", ruleId: "rr1" });
    await ins("BroadcastCampaign", { id: "bc1", clinicId: "c1", title: "T", message: "m", scheduledFor: "2026-10-01 10:00:00" });
    await ins("BroadcastRecipient", { id: "br1", campaignId: "bc1", patientId: "p1", status: "sent", sentAt: "2026-10-01 10:00:00" });
  } finally { await db.$disconnect(); }
  const schema = makeProject(path.join(tmp, "proj"), migrationsBefore(NEW), [NEW]);
  const up = cli(["migrate", "deploy"], dbPath, schema);
  assert.equal(up.status, 0, up.out.slice(-600));
  const db2 = new PrismaClient({ datasources: { db: { url: `${url}?connection_limit=1` } } });
  try {
    const rs = (await db2.$queryRawUnsafe(`SELECT id, state, attempts, sentAt FROM "RenewalSent"`))[0];
    assert.deepEqual([rs.id, rs.state, Number(rs.attempts)], ["rs1", "legacy", 0], "o que ja estava consumido continua consumido (legacy)");
    const br = (await db2.$queryRawUnsafe(`SELECT id, status, attempts FROM "BroadcastRecipient"`))[0];
    assert.deepEqual([br.id, br.status, Number(br.attempts)], ["br1", "sent", 0]);
    assert.equal(Number((await db2.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "CallbackDispatch"`))[0].n), 0);
    assert.equal((await db2.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check, "ok");
  } finally { await db2.$disconnect(); }
  assert.match(cli(["migrate", "status"], dbPath, schema).out, /up to date/i);
  fs.rmSync(tmp, { recursive: true, force: true });
});
