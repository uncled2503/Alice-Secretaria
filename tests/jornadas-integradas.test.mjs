// JORNADAS INTEGRADAS DA LISBOA (revisao de 18/10/2026). Cada jornada percorre o CODIGO REAL de ponta a ponta (generateReply -> ferramentas -> CE -> entrega ->
// jobs), com banco temporario, relogio controlado nos jobs e OpenAI / UAZAPI / Clinica Experts SIMULADOS. O modelo e roteirizado: estes testes provam o que o
// codigo ENVIA ao modelo, quais ferramentas executa/recusa, o que grava e o que sai - NAO provam como o modelo real se comporta (isso exige o roteiro de
// validacao controlada em docs/revisao-integrada-lisboa.md).
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-jornadas-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ---------------------------------------------------------------- redes simuladas
let script = []; // respostas do modelo da conversa
const modelCalls = [];
const reviewCalls = [];
let reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" };
let judgeAnswer = { recontact: true, reason: "pediu informacao e sumiu" };
const posts = []; // mensagens que a UAZAPI aceitou
let uazapiMode = "ok"; // ok | http500 | timeout
const ceLog = [];
let cePost = () => ({ status: 200, body: { data: { uuid: "ce-novo" } } });
let cePut = () => ({ status: 200, body: { data: {} } });
let ceDetail = () => ({ status: 404, body: {} });
let ceList = () => [];
const cells = () => { const out = []; for (let m = 0; m < 24 * 60; m += 15) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return out; };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const plain = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
const completion = ({ content = null, tool = null }) => ({
  id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content, ...(tool ? { tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    const system = String(body.messages?.[0]?.content ?? "");
    if (/REVISOR (DE ENVIO|das respostas)/.test(system)) { reviewCalls.push(body); return jsonRes(200, plain(typeof reviewDecision === "function" ? reviewDecision(body) : reviewDecision)); }
    if (/RECONTATO automatico|RETOMADA a uma pessoa/.test(system)) return jsonRes(200, plain(judgeAnswer));
    if (!body.tools) return jsonRes(200, plain("{}"));
    modelCalls.push(body);
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (o modelo foi chamado a mais do que o esperado)");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  if (u.hostname.includes("clinicaexperts")) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    ceLog.push({ method, path: u.pathname, body });
    if (u.pathname.endsWith("/available-hours")) return jsonRes(200, { data: cells() });
    const mDetail = /\/bookings\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && mDetail) { const r = await ceDetail(mDetail[1]); return jsonRes(r.status, r.body); }
    if (method === "GET" && u.pathname.endsWith("/bookings")) return jsonRes(200, { data: await ceList() });
    if (method === "GET" && u.pathname.endsWith("/patients")) return jsonRes(200, { data: [] });
    if (method === "POST" && u.pathname.endsWith("/patients")) return jsonRes(200, { data: { uuid: "pac-uuid" } });
    if (method === "POST" && u.pathname.endsWith("/bookings")) { const r = cePost(body); return jsonRes(r.status, r.body); }
    if (method === "PUT") { const r = cePut(body); return jsonRes(r.status, r.body); }
    return jsonRes(200, { data: [] });
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapiMode === "http500") return jsonRes(500, { error: "fora do ar" });
    if (uazapiMode === "timeout") throw Object.assign(new Error("The operation timed out (TimeoutError)"), { name: "TimeoutError" });
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { generateReply } = await import("../dist/ai/alice.js");
const { deliverAliceReply } = await import("../dist/uazapi/client.js");
const { invalidateCeCache } = await import("../dist/clinicaexperts/availability.js");
const { runReminderCycle } = await import("../dist/reminders/cron.js");
const { pullClinicBookings } = await import("../dist/clinicaexperts/pull.js");
const { applyLiveVerdict } = await import("../dist/clinicaexperts/liveCheck.js");
const { runFollowUpCheck } = await import("../dist/crm/followup.js");
const { runResumeFlows } = await import("../dist/crm/resumeFlows.js");
const { runNpsCycle } = await import("../dist/reminders/nps.js");
const { runReferralSteps } = await import("../dist/reminders/surveyFlow.js");
const { buildDailyReport } = await import("../dist/crm/dailyReport.js");
const { attendanceHealth } = await import("../dist/crm/attendanceHealth.js");
const { reviewOutbound, noteVerdict, breakerOpen, resetBreakerForTests } = await import("../dist/ai/sendGate.js");
const { PLACEHOLDER_PROCEDURE_NAME } = await import("../dist/clinicaexperts/placeholderProcedure.js");
const { acquireJobLock, releaseMyLocks, INSTANCE_ID } = await import("../dist/jobs/lock.js");
const { preflightLisboa } = await import("../dist/maintenance/lisboaPreflight.js");
const { ajustarCondutaLisboa } = await import("../dist/maintenance/lisboaConduta.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

// ---------------------------------------------------------------- cenario
const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const sp = (iso) => new Date(`${iso}-03:00`);
const noSleep = async () => undefined;
const isoDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + d * 24 * HOUR));
const DIA = isoDay(4); // agendamentos de teste daqui a 4 dias
const [Y, M, D] = DIA.split("-").map(Number);
const localUtc = (h, m = 0) => new Date(Date.UTC(Y, M - 1, D, h + 3, m));
const hhmm = (d) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const tool = (name, args) => ({ tool: { name, args } });
const lastTool = (body) => JSON.parse(body.messages.filter((m) => m.role === "tool").at(-1).content);
const reset = () => {
  invalidateCeCache();
  script = []; modelCalls.length = 0; reviewCalls.length = 0; posts.length = 0; ceLog.length = 0;
  reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" }; judgeAnswer = { recontact: true, reason: "ok" };
  uazapiMode = "ok"; cePost = () => ({ status: 200, body: { data: { uuid: "ce-novo" } } }); cePut = () => ({ status: 200, body: { data: {} } });
  ceDetail = () => ({ status: 404, body: {} }); ceList = () => [];
  process.env.AI_SEND_REVIEW = "off"; resetBreakerForTests();
};

let seq = 0;
// Uma "Lisboa" completa: Suelen/Adriana 12h-21h, Talita 8h-17h, CE conectado, luz pulsada e Protocolo do Olhar configurados.
async function mkLisboa(name, extra = {}) {
  const clinic = await prisma.clinic.create({
    data: {
      name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`,
      workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, closedOnHolidays: false, silentHandoff: true, evaluationFirst: true,
      notOfferedServices: "luz pulsada, luz intensa pulsada, IPL", unmappedOffers: "Protocolo do Olhar",
      npsEnabled: true, npsHoursAfter: 1, npsThreshold: 9, npsMessage: "Oi {primeiro_nome}! Como foi? De 0 a 10, qual nota voce daria?",
      notifyPhone: "5511900001111", notifyEvents: "human_handoff,automation_failed,cancel,new_appointment,confirmed,reschedule", ...extra,
    },
  });
  await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
  const suelen = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Suelen", active: true, ceUuid: `pro-suelen-${clinic.id.slice(-4)}`, workStartHour: 12, workEndHour: 21 } });
  const adriana = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Adriana", active: true, ceUuid: `pro-adriana-${clinic.id.slice(-4)}`, workStartHour: 12, workEndHour: 21 } });
  const talita = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Talita", active: true, ceUuid: `pro-talita-${clinic.id.slice(-4)}`, workStartHour: 8, workEndHour: 17 } });
  const link = { connect: [{ id: suelen.id }, { id: talita.id }] };
  const proc = (n, o = {}) => prisma.procedure.create({ data: { clinicId: clinic.id, name: n, durationMin: 60, professionals: link, ...o } });
  const avaliacao = await proc("Avaliação Estética", { durationMin: 30, ceId: 100 });
  const clareamento = await proc("Clareamento Corporal", { ceId: 201, bookingMode: "direct", goals: "Escurecimento corporal, Tom de pele irregular", aliases: "Clareamento de pele corporal", description: "Protocolo estético voltado à melhora gradual de áreas corporais com escurecimento." });
  const enzimas = await proc("Enzimas", { ceId: 202, goals: "Gordura localizada, Celulite, Papada", aliases: "Aplicação de enzimas, Enzimas para gordura localizada" });
  const etherea = await proc("Laser Etherea Melasma", { ceId: 203, bookingMode: "evaluation", goals: "Melasma, Manchas" });
  const limpeza = await proc("Limpeza de Pele", { ceId: 204, bookingMode: "direct", goals: "Cravos, Oleosidade" });
  return { clinic, suelen, adriana, talita, avaliacao, clareamento, enzimas, etherea, limpeza };
}
async function pessoa(L, nome, { ceUuid = `pac-${++seq}`, extra = {}, mensagens = [], appt = null } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: L.clinic.id, name: nome, phone: `551197776${String(1000 + seq)}`, ceUuid, ...extra } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, status: "active" } });
  let t = Date.now() - (mensagens.length + 1) * 60_000;
  for (const [role, content, authorName] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 60_000)), ...(role === "assistant" || role === "human" ? { deliveryStatus: "sent" } : {}) } });
  const appointment = appt ? await prisma.appointment.create({ data: { clinicId: L.clinic.id, patientId: patient.id, procedureId: appt.procedureId, professionalId: appt.professionalId ?? null, scheduledAt: appt.when, ceBookingUuid: appt.uuid ?? null, status: appt.status ?? "confirmed", source: "whatsapp", ...(appt.extra ?? {}) } }) : null;
  return { patient, conv, appointment };
}
let tick = 0;
const fala = (c, texto) => prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: texto, createdAt: new Date(Date.now() + 5 + ++tick) } });
const confirmaEnvio = (c) => prisma.message.updateMany({ where: { conversationId: c.conv.id, role: "assistant", deliveryStatus: "pending" }, data: { deliveryStatus: "sent" } });
const systems = (body) => body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const nAppts = (c, where = {}) => prisma.appointment.count({ where: { patientId: c.patient.id, ...where } });
const ceBookings = () => ceLog.filter((l) => l.method === "POST" && l.path.endsWith("/bookings"));

// ================================================================ JORNADA A — Clareamento
test("A) 'quero clarear o interno da coxa': o objetivo e entendido, nada de gordura/celulite/flacidez, nenhuma disponibilidade e consultada (nem no CE) so porque ha agenda; informacao insuficiente vira pergunta ou encaminhamento real", async () => {
  reset();
  const L = await mkLisboa("Lisboa A");
  const c = await pessoa(L, "Marina Coxa", { mensagens: [["user", "Oi! Quero clarear o interno da coxa"]] });
  script = [
    tool("check_availability", { procedure_name: "Clareamento Corporal", date: DIA }), // o modelo tenta ir direto para a agenda
    { content: "Temos o Clareamento Corporal pra isso! Também temos Enzimas para gordura localizada, quer conhecer? Qual região mais te incomoda?" },
    { content: "Temos o Clareamento Corporal pra isso! Qual região mais te incomoda?" },
  ];
  const r = await generateReply(c.conv.id);
  assert.match(systems(modelCalls[0]), /Ela contou uma QUEIXA, NAO escolheu procedimento/);
  assert.match(lastTool(modelCalls[1]).motivo, /nao e momento de oferecer horario/);
  assert.equal(ceLog.filter((l) => l.path.endsWith("/available-hours")).length, 0, "nenhuma disponibilidade foi consultada no CE");
  assert.doesNotMatch(r, /Enzimas|gordura|celulite|flacidez/i, r);
  assert.doesNotMatch(r, /\d{1,2}:\d{2}|hor[aá]rio|avalia/i, "sem horario nem avaliacao oferecidos");
  assert.match(r, /Clareamento Corporal/);
  assert.equal(await nAppts(c), 0);

  // informacao insuficiente (estrias: nenhum procedimento aprovado no cadastro): encaminhamento REAL, sem adivinhar
  const e = await pessoa(L, "Bia Estrias", { mensagens: [["user", "Tenho estrias na barriga, o que fazem?"]] });
  script = [
    tool("transfer_to_human", { reason: "Estrias: sem procedimento aprovado", summary: "Quer tratar estrias; sem indicacao aprovada no cadastro." }),
    { content: "" },
  ];
  await generateReply(e.conv.id);
  const conv = await prisma.conversation.findUnique({ where: { id: e.conv.id } });
  assert.ok(conv.humanTakeover || conv.handoffPending, "a equipe recebeu a conversa pelo mecanismo real");
  assert.equal(ceLog.filter((l) => l.path.endsWith("/available-hours")).length, 0);
});

// ================================================================ JORNADA B — Agendamento direto
test("B) agendamento direto: profissional habilitada e horario valido, nome durante o agendamento NAO reinicia, reserva so confirmada depois do CE, 'obrigada' nao gera nova oferta nem nova reserva", async () => {
  reset();
  const L = await mkLisboa("Lisboa B");
  const c = await pessoa(L, "Maria", { ceUuid: null, mensagens: [["user", "Quero agendar o Clareamento Corporal"]] });

  // 1) disponibilidade
  let oferta;
  script = [
    tool("check_availability", { procedure_name: "Clareamento Corporal", date: DIA }),
    (body) => { oferta = lastTool(body); const h = oferta.horarios.slice(0, 2).map((x) => hhmm(new Date(x.iso))); return { content: `Tenho ${h[0]} ou ${h[1]} nesse dia. Qual prefere? 💗` }; },
  ];
  await generateReply(c.conv.id);
  await confirmaEnvio(c);
  assert.ok(oferta.horarios.length > 0);
  for (const h of oferta.horarios) {
    const hora = hhmm(new Date(h.iso));
    assert.ok(["Suelen", "Talita"].includes(h.profissional), `so quem realiza: ${h.profissional}`);
    if (h.profissional === "Suelen") assert.ok(hora >= "12:00" && hora <= "20:00");
    if (h.profissional === "Talita") assert.ok(hora >= "08:00" && hora <= "16:00");
  }
  const escolhido = oferta.horarios.find((h) => h.profissional === "Suelen") ?? oferta.horarios[0];
  const hora = hhmm(new Date(escolhido.iso));
  const proId = escolhido.profissional_id;

  // 2) ela escolhe o horario; o cadastro dela nao esta no CE e ela so tem o primeiro nome: a Alice pede o nome COMPLETO, sem reservar
  await fala(c, `Pode ser às ${hora}`);
  let r2;
  script = [
    tool("book_appointment", { procedure_name: "Clareamento Corporal", date: DIA, time: hora, professional_id: proId }),
    (body) => { r2 = lastTool(body); return { content: "Para finalizar, qual é o seu nome completo? 💗" }; },
  ];
  await generateReply(c.conv.id);
  await confirmaEnvio(c);
  assert.equal(r2.agendado, false);
  assert.match(r2.motivo, /NOME COMPLETO/);
  assert.equal(await nAppts(c), 0, "ainda nao reservou");
  assert.equal(ceBookings().length, 0);

  // 3) o nome chega: e a CONTINUACAO (nao recomeca a venda, nao oferece avaliacao); a reserva so vale depois do CE aceitar
  await fala(c, "Maria Souza Lima");
  const base3 = modelCalls.length;
  script = [
    tool("book_appointment", { procedure_name: "Clareamento Corporal", date: DIA, time: hora, professional_id: proId, patient_full_name: "Maria Souza Lima" }),
    { content: `Pronto, Maria! Seu Clareamento Corporal está agendado para ${String(D).padStart(2, "0")}/${String(M).padStart(2, "0")} às ${hora}. 💗` },
  ];
  const r3 = await generateReply(c.conv.id);
  await confirmaEnvio(c);
  assert.match(systems(modelCalls[base3]), /ELA ACABOU DE INFORMAR O NOME QUE VOCE PEDIU/);
  assert.doesNotMatch(r3, /avalia/i);
  const appt = await prisma.appointment.findFirst({ where: { patientId: c.patient.id } });
  assert.ok(appt);
  assert.equal(appt.status, "confirmed");
  assert.equal(appt.ceBookingUuid, "ce-novo", "so confirmado depois que o CE criou a reserva");
  assert.equal(appt.professionalId, proId);
  assert.equal(appt.procedureId, L.clareamento.id);
  assert.equal(ceBookings().length, 1);
  assert.equal(await nAppts(c, { procedureId: L.avaliacao.id }), 0, "nenhuma avaliacao substituta");
  assert.equal((await prisma.patient.findUnique({ where: { id: c.patient.id } })).name, "Maria Souza Lima");

  // 4) 'obrigada': so fecha, sem modelo, sem oferta, sem reserva
  await fala(c, "Obrigada!");
  const antes = modelCalls.length;
  script = [];
  const r4 = await generateReply(c.conv.id);
  await confirmaEnvio(c);
  assert.equal(modelCalls.length, antes);
  assert.doesNotMatch(r4, /avalia|hor[aá]rio|agendar/i);
  assert.equal(await nAppts(c), 1);

  // 5) pedir o MESMO procedimento no mesmo dia nao cria segunda reserva
  await fala(c, "Quero agendar o Clareamento Corporal nesse dia de novo");
  script = [
    tool("book_appointment", { procedure_name: "Clareamento Corporal", date: DIA, time: hora === "14:00" ? "15:00" : "14:00", professional_id: proId }),
    (body) => { assert.match(lastTool(body).motivo, /JA tem Clareamento Corporal agendado nesse dia/); return { content: `Você já tem o Clareamento Corporal nesse dia às ${hora}. Quer remarcar? 💗` }; },
  ];
  await generateReply(c.conv.id);
  assert.equal(await nAppts(c), 1);
  assert.equal(ceBookings().length, 1, "o CE nao recebeu outra reserva");
});

// ================================================================ JORNADA C — Remarcacao
test("C) remarcacao: mantem o procedimento, o CE aceita, o historico fica, o lembrete antigo nao sai, e NENHUMA retomada de avaliacao cancelada e disparada", async () => {
  reset();
  const L = await mkLisboa("Lisboa C");
  const antigo = localUtc(14, 0);
  const c = await pessoa(L, "Fabi Remarca", { mensagens: [["user", "Preciso mudar meu horario da avaliacao para as 16h"]], appt: { procedureId: L.avaliacao.id, professionalId: L.suelen.id, when: antigo, uuid: "ce-remarca" } });
  // historico de envio do horario ANTIGO (ja recebeu a confirmacao dele)
  await prisma.reminderDispatch.create({ data: { clinicId: L.clinic.id, bookingKey: "ce:ce-remarca", appointmentId: c.appointment.id, patientId: c.patient.id, ruleId: "regra-x", kind: "dia_seguinte", startsAt: antigo, sendDay: "2026-01-01", state: "sent" } });
  await prisma.resumeFlowConfig.create({ data: { clinicId: L.clinic.id, flow: "avaliacao_cancelada", enabled: true, weekday: null, message: "Oi, {primeiro_nome}! Aqui e a Alice da {unidade}. Se quiser retomar a avaliacao, me responde aqui.", lookbackDays: 7 } });

  script = [
    tool("manage_my_appointment", { action: "reschedule", new_date: DIA, new_time: "16:00" }),
    { content: "Pronto, remarquei sua avaliação! 💗" },
  ];
  await generateReply(c.conv.id);
  const depois = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.equal(depois.scheduledAt.getTime(), localUtc(16, 0).getTime());
  assert.equal(depois.procedureId, L.avaliacao.id, "mantem o procedimento");
  assert.equal(depois.professionalId, L.suelen.id);
  assert.equal(depois.status, "confirmed");
  assert.equal(depois.cancelledAt, null, "remarcar NAO e cancelar: nao grava cancelamento");
  assert.equal(await nAppts(c), 1, "nenhuma segunda reserva");
  assert.equal(ceLog.filter((l) => l.method === "PUT").length, 1, "o CE recebeu a troca");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, type: "appointment_rescheduled" } }), "historico da remarcacao");
  // trilha do horario antigo preservada
  assert.equal(await prisma.reminderDispatch.count({ where: { bookingKey: "ce:ce-remarca", startsAt: antigo } }), 1);

  // o lembrete NAO sai para o horario antigo (nem a confirmacao repete)
  const diaAntes = new Date(localUtc(9, 0).getTime() - 24 * HOUR);
  await prisma.reminderRule.create({ data: { clinicId: L.clinic.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, pauseMinSec: 0, pauseMaxSec: 0, active: true, message: "Confirmando: {data} {hora} {procedimento}" } });
  ceDetail = () => ({ status: 200, body: { data: { uuid: "ce-remarca", status: "scheduled", starts_at: `${DIA}T16:00:00-03:00` } } });
  await runReminderCycle({ now: diaAntes });
  const lembretes = posts.filter((p) => p.number === c.patient.phone);
  assert.ok(lembretes.every((p) => !/14:00/.test(p.text)), "nenhum lembrete com o horario antigo");

  // retomada de avaliacao cancelada: nao e candidata (nao foi cancelada) e nada sai
  posts.length = 0;
  await runResumeFlows({ now: sp(`${DIA}T10:00`), sleep: noSleep, clinicId: L.clinic.id });
  assert.equal(posts.filter((p) => p.number === c.patient.phone).length, 0);

  // troca feita no proprio CE (a recepcao moveu): continua confirmada, sem origem de cancelamento, sem retomada
  const moved = await applyLiveVerdict({ id: c.appointment.id, clinicId: L.clinic.id, patientId: c.patient.id, scheduledAt: depois.scheduledAt }, { kind: "moved", to: localUtc(17, 0) }, "Fabi");
  assert.equal(moved, "skip");
  const final = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.deepEqual([final.status, final.cancelledAt, final.cancelSource], ["confirmed", null, null]);
  await runResumeFlows({ now: sp(`${DIA}T10:30`), sleep: noSleep, clinicId: L.clinic.id });
  assert.equal(posts.filter((p) => p.number === c.patient.phone && /retomar a avaliacao/.test(p.text)).length, 0);
});

// ================================================================ JORNADA D — Reserva sem procedimento
test("D) reserva sem procedimento: a importacao mantem a reserva e a identidade, a confirmacao usa data e hora corretas, o nome interno nao aparece, e reimportar/rodar de novo NAO duplica", async () => {
  reset();
  const L = await mkLisboa("Lisboa D");
  const amanha = isoDay(1);
  const [yy, mm, dd] = amanha.split("-").map(Number);
  ceList = () => [{ uuid: "sem-proc-d", status: "scheduled", starts_at: `${amanha}T09:30:00-03:00`, patient: { uuid: "pp-d", name: "Milena Brandao", phone: "+55 11 97777-0099" }, procedures: [] }];
  ceDetail = (uuid) => ({ status: 200, body: { data: { uuid, status: "scheduled", starts_at: `${amanha}T09:30:00-03:00` } } });
  await prisma.reminderRule.create({ data: { clinicId: L.clinic.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, pauseMinSec: 0, pauseMaxSec: 0, active: true, message: "Olá, {primeiro_nome}!\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\nPosso confirmar?" } });
  await pullClinicBookings(L.clinic.id);
  await pullClinicBookings(L.clinic.id);
  const appts = await prisma.appointment.findMany({ where: { clinicId: L.clinic.id }, include: { procedure: true, patient: true } });
  assert.equal(appts.length, 1, "reimportar nao duplica");
  assert.equal(appts[0].ceBookingUuid, "sem-proc-d", "identidade da reserva preservada");
  assert.equal(appts[0].procedure.name, PLACEHOLDER_PROCEDURE_NAME);

  const diaAntes = new Date(Date.UTC(yy, mm - 1, dd, 12, 0) - 24 * HOUR); // 09:00 em SP do dia anterior
  await runReminderCycle({ now: diaAntes });
  await runReminderCycle({ now: new Date(diaAntes.getTime() + 20 * 60_000) });
  await runReminderCycle({ now: new Date(diaAntes.getTime() + 40 * 60_000) });
  const msgs = posts.filter((p) => p.number === appts[0].patient.phone);
  assert.equal(msgs.length, 1, "uma confirmacao so, mesmo com varias rodadas");
  assert.match(msgs[0].text, /Horário: 09:30/);
  assert.match(msgs[0].text, new RegExp(`Data: ${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${yy}`));
  assert.ok(!/rocedimento|sem procedimento|Cl[ií]nica Experts|avalia|\{|\[/i.test(msgs[0].text), `nome interno/placeholder apareceu: ${msgs[0].text}`);
  assert.equal(await prisma.reminderDispatch.count({ where: { bookingKey: "ce:sem-proc-d", state: "sent" } }), 1);
});

// ================================================================ JORNADA E — Atendimento interrompido
test("E) revisao falha ou reescreve de forma invalida: sai a original ou uma saida segura; falha de envio fica rastreavel; o painel nao mostra entrega ficticia; o disjuntor de uma clinica nao afeta a outra", async () => {
  reset();
  process.env.AI_SEND_REVIEW = "on";
  const A = await mkLisboa("Lisboa E-A");
  const B = await mkLisboa("Lisboa E-B");
  const a = await pessoa(A, "Ana Revisao", { mensagens: [["user", "Qual o endereço?"]] });
  const b = await pessoa(B, "Beto Revisao", { mensagens: [["user", "Qual o endereço?"]] });

  // revisao devolve reescrita INVALIDA (afirma cancelamento que nao houve): a original e que sai
  const original = "O endereço é Av. Índico, 294. 💗";
  await prisma.message.create({ data: { conversationId: a.conv.id, role: "assistant", content: original, deliveryStatus: "pending" } });
  reviewDecision = { decisao: "reescrever", confianca: "alta", motivo: "melhor", texto: "Cancelei o seu horário e o endereço é Av. Índico, 294." };
  await deliverAliceReply(A.clinic.id, a.patient.phone, a.conv.id, original);
  assert.deepEqual(posts.filter((p) => p.number === a.patient.phone).map((p) => p.text), [original]);
  assert.equal((await prisma.message.findFirst({ where: { conversationId: a.conv.id, content: original } })).deliveryStatus, "sent");

  // revisao FORA DO AR: a resposta sai igual
  reviewDecision = () => { throw new Error("revisao fora do ar"); };
  const o2 = "Atendemos de segunda a sábado. 💗";
  await prisma.message.create({ data: { conversationId: a.conv.id, role: "assistant", content: o2, deliveryStatus: "pending" } });
  posts.length = 0;
  await deliverAliceReply(A.clinic.id, a.patient.phone, a.conv.id, o2);
  assert.deepEqual(posts.map((p) => p.text), [o2]);

  // falha de ENVIO: nao vira 'sent', fica rastreavel e a conversa e sinalizada
  uazapiMode = "http500";
  const o3 = "Claro! Posso ajudar com mais alguma coisa? 💗";
  await prisma.message.create({ data: { conversationId: b.conv.id, role: "assistant", content: o3, deliveryStatus: "pending" } });
  reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" };
  posts.length = 0;
  await deliverAliceReply(B.clinic.id, b.patient.phone, b.conv.id, o3).catch(() => undefined);
  const falha = await prisma.message.findFirst({ where: { conversationId: b.conv.id, content: o3 } });
  assert.notEqual(falha.deliveryStatus, "sent", "nao existe entrega ficticia");
  assert.ok(["failed", "pending", "expired", "failed_permanent"].includes(falha.deliveryStatus), falha.deliveryStatus);
  assert.equal(posts.length, 0);
  uazapiMode = "ok";

  // painel: a mensagem nao confirmada tem rotulo de problema no app.js
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /DELIVERY_PROBLEM\[m\.deliveryStatus\]/);

  // disjuntor por clinica: a Lisboa E-A abre o dela; a E-B continua sendo revisada
  for (let i = 0; i < 7; i++) noteVerdict(A.clinic.id, { send: false, reason: "teste", confidence: "alta", reviewed: true });
  assert.equal(breakerOpen(A.clinic.id), true);
  assert.equal(breakerOpen(B.clinic.id), false);
  reviewCalls.length = 0;
  reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" };
  await reviewOutbound({ clinicId: B.clinic.id, phone: b.patient.phone, text: "Lembrete de teste B", kind: "lembrete" });
  await reviewOutbound({ clinicId: A.clinic.id, phone: a.patient.phone, text: "Lembrete de teste A", kind: "lembrete" });
  assert.equal(reviewCalls.length, 1, "so a clinica B foi revisada");
  void attendanceHealth;
});

// ================================================================ JORNADA F — Recontato
test("F) recontato: lead elegivel no horario configurado; resposta, agendamento ou equipe mudam a decisao; reinicio nao perde o evento nem dispara cascata; resultado persistido", async () => {
  reset();
  const L = await mkLisboa("Lisboa F", { followupRecoveryHours: 24 }); // politica de recuperacao ESCOLHIDA (sem decisao da clinica vale o padrao antigo de 3 dias: ver recontatos-retomadas)
  await prisma.followUpRule.create({ data: { clinicId: L.clinic.id, order: 1, name: "4h", afterDays: 1, afterMinutes: 240, message: "Oi, {primeiro_nome}! Ficou alguma duvida?", repeatMode: "once", active: true } });
  await prisma.followUpRule.create({ data: { clinicId: L.clinic.id, order: 2, name: "1 dia", afterDays: 1, afterMinutes: 1440, nextDayHour: 8, sendWindowStart: 8, sendWindowEnd: 12, message: "Oi, {primeiro_nome}! Conseguiu pensar?", repeatMode: "once", active: true } });
  const lead = async (nome, userAt) => {
    const c = await pessoa(L, nome, { mensagens: [] });
    await prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: "Quero saber sobre limpeza de pele", createdAt: userAt } });
    await prisma.message.create({ data: { conversationId: c.conv.id, role: "assistant", content: "Claro! Quer ver um horário?", createdAt: new Date(userAt.getTime() + 60_000), deliveryStatus: "sent" } });
    await prisma.conversation.update({ where: { id: c.conv.id }, data: { lastMessageAt: new Date(userAt.getTime() + 60_000) } });
    return c;
  };
  const roda = (iso) => runFollowUpCheck({ now: sp(iso), sleep: noSleep, clinicId: L.clinic.id });
  const base = sp("2026-10-20T09:00"); // terca
  const elegivel = await lead("Eli Elegivel", base);
  const respondeu = await lead("Rita Respondeu", base);
  const agendou = await lead("Ana Agendou", base);
  const equipe = await lead("Eva Equipe", base);
  await roda("2026-10-20T12:30"); // antes de vencer (13:00)
  assert.equal(posts.length, 0);
  // entre a selecao e o envio o contexto muda
  await prisma.message.create({ data: { conversationId: respondeu.conv.id, role: "user", content: "Ainda estou vendo", createdAt: sp("2026-10-20T12:40") } });
  await prisma.appointment.create({ data: { clinicId: L.clinic.id, patientId: agendou.patient.id, procedureId: L.limpeza.id, scheduledAt: sp("2026-10-23T15:00"), source: "whatsapp" } });
  await prisma.message.create({ data: { conversationId: equipe.conv.id, role: "human", content: "Oi! Sou da recepcao", authorName: "Recepcao", createdAt: sp("2026-10-20T12:45") } });
  await roda("2026-10-20T13:10");
  const destinatarios = posts.map((p) => p.number);
  assert.deepEqual(destinatarios, [elegivel.patient.phone], "so quem continua elegivel recebe");
  assert.equal(posts[0].text, "Oi, Eli! Ficou alguma duvida?");
  // reinicio: roda de novo (mesma rodada refeita) e depois de varios dias de queda: nada em cascata
  await roda("2026-10-20T13:25");
  assert.equal(posts.length, 1);
  await roda("2026-10-23T09:00"); // servidor ficou fora 3 dias: etapa 2 (dia seguinte) ja expirou, nao sai atrasada
  assert.equal(posts.length, 1, "sem disparo em cascata depois da queda");
  const rows = await prisma.followUpDispatch.findMany({ where: { patientId: elegivel.patient.id, flow: "recontato" }, orderBy: { step: "asc" } });
  assert.equal(rows[0].state, "sent");
  assert.equal((await prisma.conversation.findUnique({ where: { id: elegivel.conv.id } })).lastFollowUpOrder >= 1, true);
  const run = await prisma.automationRun.findFirst({ where: { clinicId: L.clinic.id, job: "recontato", sent: 1 } });
  assert.ok(run, "o resultado da rodada ficou gravado");
});

// ================================================================ JORNADA G — Satisfacao
test("G) satisfacao: pesquisa -> nota positiva -> agradecimento com link de TESTE -> indicacao separada; novo atendimento dentro de 15 dias nao gera pesquisa; reclamacao interrompe as mensagens incompativeis", async () => {
  reset();
  const TEST_LINK = "https://g.page/r/TESTE-APENAS-NOS-TESTES/review";
  const L = await mkLisboa("Lisboa G", { workStartHour: 0, workEndHour: 24, googleReviewUrl: TEST_LINK, googleReviewConfirmedAt: new Date(), googleReviewConfirmedBy: "teste", googleReviewPlace: "Estabelecimento de Teste" });
  await prisma.resumeFlowConfig.create({ data: { clinicId: L.clinic.id, flow: "indicacao", enabled: true, message: "Se tiver uma amiga que queira conhecer a {unidade}, pode compartilhar o nosso contato. 💗", delayMinutes: 20 } });
  const p = await pessoa(L, "Julia Satisfeita", { mensagens: [] });
  const a1 = await prisma.appointment.create({ data: { clinicId: L.clinic.id, patientId: p.patient.id, procedureId: L.limpeza.id, scheduledAt: sp("2026-10-15T09:00"), status: "completed", source: "presencial" } });
  await runNpsCycle({ now: sp("2026-10-15T13:00"), clinicId: L.clinic.id });
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /De 0 a 10/);
  // a pesquisa gravada com o relogio simulado; a conversa real usa o relogio real
  await prisma.satisfactionSurvey.updateMany({ where: { patientId: p.patient.id }, data: { askedAt: new Date(Date.now() - 3 * HOUR) } });
  await prisma.message.updateMany({ where: { conversationId: p.conv.id, authorName: "Pesquisa de satisfação" }, data: { createdAt: new Date(Date.now() - 3 * HOUR) } });
  await fala(p, "10");
  const agradecimento = await generateReply(p.conv.id);
  assert.match(agradecimento, new RegExp(TEST_LINK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(modelCalls.length, 0, "a nota foi tratada pelo codigo");
  await deliverAliceReply(L.clinic.id, p.patient.phone, p.conv.id, agradecimento);
  const s = (await prisma.satisfactionSurvey.findFirst({ where: { patientId: p.patient.id } }));
  const quando = new Date(s.answeredAt.getTime() + 60 * 60_000);
  await runReferralSteps({ now: quando, sleep: noSleep, clinicId: L.clinic.id });
  const convite = posts.at(-1).text;
  assert.notEqual(convite, agradecimento, "o convite e outra mensagem");
  assert.doesNotMatch(convite, /https?:/);

  // novo atendimento dentro de 15 dias: nenhuma pesquisa
  const a2 = await prisma.appointment.create({ data: { clinicId: L.clinic.id, patientId: p.patient.id, procedureId: L.enzimas.id, scheduledAt: sp("2026-10-16T09:00"), status: "completed", source: "presencial" } });
  const antes = posts.length;
  await runNpsCycle({ now: sp("2026-10-16T13:00"), clinicId: L.clinic.id });
  assert.equal(posts.length, antes);
  assert.equal((await prisma.followUpDispatch.findFirst({ where: { patientId: p.patient.id, flow: "pesquisa", cycleKey: a2.id } })).state, "skipped");

  // reclamacao: outra pessoa da nota 9 com problema -> sem link, sem convite; e a equipe e avisada
  const q = await pessoa(L, "Lia Reclama", { mensagens: [["assistant", "Oi Lia! Como foi? De 0 a 10, qual nota voce daria?", "Pesquisa de satisfação"]] });
  await prisma.satisfactionSurvey.create({ data: { clinicId: L.clinic.id, patientId: q.patient.id, askedAt: new Date(Date.now() - HOUR) } });
  await fala(q, "Nota 9, mas tive um problema com a pele");
  posts.length = 0;
  const r = await generateReply(q.conv.id);
  assert.doesNotMatch(r, /https?:|amig/i);
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: q.patient.id, flow: "indicacao" } }), 0);
  assert.ok(posts.some((x) => x.number === "5511900001111" && /com reclamação/.test(x.text)));
  void a1;
});

// ================================================================ JORNADA H — Contato nao comercial
test("H) curriculo / fornecedor: vai para a equipe em silencio, sem horario, sem pesquisa e sem recontato comercial; a pendencia fica visivel para a equipe", async () => {
  reset();
  const L = await mkLisboa("Lisboa H");
  await prisma.followUpRule.create({ data: { clinicId: L.clinic.id, order: 1, name: "4h", afterDays: 1, afterMinutes: 240, message: "Oi, {primeiro_nome}! Ficou alguma duvida?", repeatMode: "once", active: true } });
  const cv = await pessoa(L, "Candidata Vaga", { mensagens: [["user", "Olá, envio meu currículo para a vaga de esteticista"]] });
  const forn = await pessoa(L, "Representante", { mensagens: [["user", "Sou representante da empresa Dermo e gostaria de apresentar nossos produtos"]] });
  for (const x of [cv, forn]) {
    modelCalls.length = 0; script = [];
    assert.equal(await generateReply(x.conv.id), "", "silencio: nada e escrito para a pessoa");
    assert.equal(modelCalls.length, 0, "o modelo nao e chamado: nenhum horario/venda");
    const conv = await prisma.conversation.findUnique({ where: { id: x.conv.id } });
    assert.equal(conv.humanTakeover, true);
    assert.equal(conv.handoffPending, true, "aparece como pendencia (nao lida) para a equipe");
    assert.ok(conv.handoffReason, "com o motivo");
  }
  assert.match((await prisma.conversation.findUnique({ where: { id: cv.conv.id } })).handoffReason, /vaga/i);
  assert.match((await prisma.conversation.findUnique({ where: { id: forn.conv.id } })).handoffReason, /Fornecedor/);
  // nao recebem pesquisa nem recontato comercial, mesmo que a equipe devolva a conversa a Alice
  await prisma.conversation.update({ where: { id: cv.conv.id }, data: { humanTakeover: false } });
  await prisma.conversation.update({ where: { id: forn.conv.id }, data: { humanTakeover: false } });
  await runNpsCycle({ now: sp("2026-10-20T13:00"), clinicId: L.clinic.id });
  await runFollowUpCheck({ now: new Date(Date.now() + 5 * HOUR), sleep: noSleep, clinicId: L.clinic.id });
  assert.equal(posts.filter((x) => x.number === cv.patient.phone || x.number === forn.patient.phone).length, 0);
  // a equipe enxerga: depois de 13h sem ninguem tocar, o relatorio das 20h lista a pendencia
  await prisma.conversation.update({ where: { id: cv.conv.id }, data: { humanTakeover: true, lastMessageAt: new Date(Date.now() - 13 * HOUR) } });
  const rel = await buildDailyReport(L.clinic.id, TZ);
  assert.match(rel, /Esperando a equipe há mais de 12h/);
  assert.match(rel, /Candidata Vaga/);
});

// ================================================================ PROTOCOLO DO OLHAR (oferta sem cadastro)
test("Protocolo do Olhar (anuncio sem cadastro no CE): nunca vira avaliacao nem outro procedimento sozinho; quem quer agendar vai para a equipe; se o cadastro existir, o cadastro manda", async () => {
  reset();
  const L = await mkLisboa("Lisboa Olhar");
  // a) quer agendar a oferta: o CODIGO encaminha (sem modelo, sem avaliacao, sem associar a outro procedimento)
  const a = await pessoa(L, "Livia Anuncio", { extra: { adName: "Protocolo do Olhar" }, mensagens: [["user", "Oi, vi o anúncio do Protocolo do Olhar. Quero agendar!"]] });
  assert.equal(await generateReply(a.conv.id), "");
  assert.equal(modelCalls.length, 0);
  assert.equal(await nAppts(a), 0, "nenhuma avaliacao nem procedimento criado");
  const conv = await prisma.conversation.findUnique({ where: { id: a.conv.id } });
  assert.match(conv.handoffReason, /Oferta sem cadastro: Protocolo do Olhar/);
  assert.equal(ceBookings().length, 0);

  // b) so pergunta: o modelo recebe a ordem de NAO substituir por avaliacao e a ferramenta recusa
  const b = await pessoa(L, "Bete Pergunta", { extra: { adName: "Protocolo do Olhar" }, mensagens: [["user", "Como funciona o Protocolo do Olhar?"]] });
  script = [
    tool("book_appointment", { procedure_name: "Protocolo do Olhar", date: DIA, time: "14:00" }),
    (body) => { assert.match(body.messages.filter((m) => m.role === "tool").at(-1).content, /AINDA NAO esta cadastrada/); return tool("transfer_to_human", { reason: "Oferta sem cadastro: Protocolo do Olhar", summary: "Quer saber do protocolo anunciado." }); },
    { content: "" },
  ];
  await generateReply(b.conv.id);
  assert.match(systems(modelCalls[0]), /OFERTA SEM CADASTRO/);
  assert.equal(await nAppts(b), 0);
  assert.equal(await nAppts(b, { procedureId: L.avaliacao.id }), 0, "sem avaliacao substituta");

  // c) o CADASTRO existe (a clinica mapeou no CE): a lista de ofertas sem cadastro deixa de ter efeito
  await prisma.procedure.create({ data: { clinicId: L.clinic.id, name: "Protocolo do Olhar", durationMin: 60, ceId: 301, bookingMode: "direct", professionals: { connect: [{ id: L.suelen.id }] } } });
  const c = await pessoa(L, "Cris Cadastro", { extra: { adName: "Protocolo do Olhar" }, mensagens: [["user", "Quero agendar o Protocolo do Olhar"]] });
  script = [{ content: "Claro! Prefere manhã ou tarde? 💗" }];
  await generateReply(c.conv.id);
  assert.doesNotMatch(systems(modelCalls.at(-1)), /OFERTA SEM CADASTRO/);

  // d) a previa da manutencao inclui a oferta e avisa quando ja existe cadastro
  const previa = await ajustarCondutaLisboa(L.clinic.id, { dryRun: true });
  assert.deepEqual(previa.ofertasSemCadastro.jaCadastradas, ["Protocolo do Olhar"]);
});

// ================================================================ CONFLITOS ENTRE FONTES (memoria da IA x agenda)
test("a agenda real e o resultado das ferramentas prevalecem sobre as notas antigas da IA (a memoria nao e dada como 'vale tanto quanto a agenda')", async () => {
  reset();
  const L = await mkLisboa("Lisboa Memoria");
  const c = await pessoa(L, "Nara Notas", { mensagens: [["user", "Oi, qual meu horário?"]], appt: { procedureId: L.limpeza.id, professionalId: L.suelen.id, when: localUtc(15, 0), uuid: "ce-nara" } });
  await prisma.patient.update({ where: { id: c.patient.id }, data: { briefingNotes: "- Cancelou a sessão de 10/10; não tem horário marcado.", briefingNotesAt: new Date(Date.now() - 6 * 24 * HOUR) } });
  script = [{ content: "Você tem a Limpeza de Pele agendada. 💗" }];
  await generateReply(c.conv.id);
  const sys = systems(modelCalls[0]);
  assert.match(sys, /MEMORIA DO LEAD \(notas escritas pela IA em conversas anteriores; podem estar velhas/);
  assert.match(sys, /VALE a agenda\/a ferramenta\/a fala atual/);
  assert.doesNotMatch(sys, /vale tanto quanto a agenda/);
  assert.match(sys, /AGENDA DELA[^\n]*Limpeza de Pele/);
  const src = fs.readFileSync(new URL("../src/ai/sendGate.ts", import.meta.url), "utf8");
  assert.match(src, /A AGENDA e os cancelamentos da ficha valem mais que a MEMORIA DO LEAD/);
  const sit = fs.readFileSync(new URL("../src/ai/situation.ts", import.meta.url), "utf8");
  assert.ok(sit.includes("FATOS AO VIVO (a AGENDA dela, o resultado de uma ferramenta, o que ela disse AGORA) valem mais que NOTAS antigas"));
});

// ================================================================ ISOLAMENTO E MODO LOJA
test("isolamento entre clinicas e modo loja: as regras da Lisboa (servicos nao oferecidos, ofertas sem cadastro, conduta) nao vazam para outra clinica nem para a Laleblu", async () => {
  reset();
  const L = await mkLisboa("Lisboa Iso");
  const outra = await prisma.clinic.create({ data: { name: "Outra Clinica Iso", whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-outra", workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21 } });
  await prisma.procedure.create({ data: { clinicId: outra.id, name: "Limpeza de Pele", durationMin: 30 } });
  const loja = await prisma.clinic.create({ data: { name: "Laleblu Iso", businessType: "geral", whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-loja", workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21 } });
  const mk = async (clinicId, nome, texto) => {
    seq++;
    const patient = await prisma.patient.create({ data: { clinicId, name: nome, phone: `551197775${String(1000 + seq)}`, adName: "Protocolo do Olhar" } });
    const conv = await prisma.conversation.create({ data: { patientId: patient.id, status: "active" } });
    await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: texto, createdAt: new Date(Date.now() - 60_000) } });
    return { patient, conv };
  };
  const o = await mk(outra.id, "Olga Outra", "Vocês fazem luz pulsada? Vi o Protocolo do Olhar");
  script = [{ content: "Vou verificar com a equipe, um instante!" }, { content: "Me conta o que você gostaria de tratar? 💗" }];
  await generateReply(o.conv.id);
  assert.doesNotMatch(systems(modelCalls[0]), /SERVICO QUE A CLINICA NAO OFERECE|OFERTA SEM CADASTRO/, "regras da Lisboa nao valem em outra clinica");
  const l = await mk(loja.id, "Lia Loja", "Vocês têm essa bolsa em outras cores?");
  modelCalls.length = 0;
  script = [{ content: "Temos sim! Qual cor você prefere? 😊" }];
  const r = await generateReply(l.conv.id);
  assert.equal(r, "Temos sim! Qual cor você prefere? 😊");
  assert.doesNotMatch(systems(modelCalls[0]), /OBJETIVO ATUAL DELA|PROCEDIMENTO ESCOLHIDO|OFERTA SEM CADASTRO|SERVICO QUE A CLINICA NAO OFERECE/);
  // a lista de ofertas/servicos e por clinica no banco
  assert.equal((await prisma.clinic.findUnique({ where: { id: outra.id } })).unmappedOffers, null);
  assert.equal((await prisma.clinic.findUnique({ where: { id: loja.id } })).notOfferedServices, null);
});

// ================================================================ REINICIO / LOCKS / BOOT
test("reinicio: as tarefas sao devolvidas no desligamento (a copia nova assume sem esperar o TTL), so as desta copia; nenhum seed ou manutencao roda no boot", async () => {
  const A = "copia-antiga";
  const B = "copia-nova";
  assert.equal(await acquireJobLock("tarefa-x", 15 * 60_000, new Date(), A), true);
  assert.equal(await acquireJobLock("tarefa-x", 15 * 60_000, new Date(), B), false, "enquanto a antiga detem, a nova espera");
  assert.equal(await acquireJobLock("tarefa-y", 15 * 60_000, new Date(), INSTANCE_ID), true);
  const n = await releaseMyLocks(A);
  assert.equal(n, 1, "solta so o que e dela");
  assert.equal(await acquireJobLock("tarefa-x", 15 * 60_000, new Date(), B), true, "a nova assume na hora");
  assert.equal(await acquireJobLock("tarefa-y", 15 * 60_000, new Date(), B), false, "a concessao de outra copia nao foi tocada");
  assert.equal(typeof releaseMyLocks, "function");
  void INSTANCE_ID;
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /releaseMyLocks\(\)/);
  assert.doesNotMatch(server, /seedLisboa|seedLaleblu|ajustarJornadasLisboa|ajustarCondutaLisboa|applyLisboaServicos|migrate deploy/, "o boot nao executa seed/manutencao");
  const start = fs.readFileSync(new URL("../scripts/start.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(start, /seed|ajustar|maintenance/, "o script de inicializacao so migra (se ha pendente) e sobe");
});

// ================================================================ PRONTIDAO (somente leitura)
test("conferencia de prontidao da Lisboa: so le, e separa 'aplicado' de 'preparado' e 'dependente da clinica' (jornadas, conduta, link, convite, recontato, retomadas)", async () => {
  reset();
  const L = await mkLisboa("Lisboa Preflight Teste", { npsEnabled: true, notifyPhone: null, unmappedOffers: null, notOfferedServices: null });
  // jornadas ja aplicadas em Suelen e Talita; Adriana divergente
  await prisma.professional.update({ where: { id: L.adriana.id }, data: { workStartHour: 9, workEndHour: 18 } });
  const antes = JSON.stringify(await prisma.clinic.findUnique({ where: { id: L.clinic.id } }));
  const r = await preflightLisboa(L.clinic.id);
  assert.equal(JSON.stringify(await prisma.clinic.findUnique({ where: { id: L.clinic.id } })), antes, "a conferencia nao grava nada");
  const por = Object.fromEntries(r.itens.map((i) => [i.id, i]));
  assert.equal(por["jornada.suelen"].status, "ok");
  assert.equal(por["jornada.talita"].status, "ok");
  assert.equal(por["jornada.adriana"].status, "pendente", "Adriana (9h-18h) ainda nao esta com a jornada informada (12h-21h): preparado, nao aplicado");
  assert.match(por["jornada.adriana"].evidencia, /09:00-18:00.*esperado 12:00-21:00/);
  assert.equal(por["conduta.naoOferecidos"].status, "pendente");
  assert.equal(por["conduta.ofertasSemCadastro"].status, "pendente");
  assert.equal(por["google.link"].status, "pendente");
  assert.equal(por["indicacao.politica"].status, "pendente");
  assert.equal(por["recontato.horarios"].status, "pendente");
  assert.equal(por["retomada.avaliacao_cancelada"].status, "pendente");
  assert.equal(por["atendimento.avisoInterno"].status, "pendente");
  assert.equal(por["agenda.ce"].status, "ok");
  assert.equal(por["versao.codigo"].status, "info");
  // depois de APLICAR o ajuste de conduta, os itens viram ok
  await ajustarCondutaLisboa(L.clinic.id, { dryRun: false });
  const r2 = await preflightLisboa(L.clinic.id);
  const por2 = Object.fromEntries(r2.itens.map((i) => [i.id, i]));
  assert.equal(por2["conduta.naoOferecidos"].status, "ok");
  assert.equal(por2["conduta.ofertasSemCadastro"].status, "ok");
  assert.ok(r2.resumo.pendente >= 1 && typeof r2.versaoDoCodigo === "string");
});

// ================================================================ C2 — remarcacao feita no CE (reserva apagada + nova com outro id) NAO e desistencia
test("C2) a recepcao remarca no CE apagando a reserva e criando outra (outro id): o sistema nao trata como desistencia e nenhuma retomada de avaliacao sai", async () => {
  reset();
  const L = await mkLisboa("Lisboa C2");
  await prisma.resumeFlowConfig.create({ data: { clinicId: L.clinic.id, flow: "avaliacao_cancelada", enabled: true, message: "Oi, {primeiro_nome}! Aqui e a Alice da {unidade}. Se quiser retomar a avaliacao, me responde aqui.", lookbackDays: 7 } });
  const quando = sp("2026-10-20T10:00");
  const c = await pessoa(L, "Rosa Remarcada no CE", { appt: { procedureId: L.avaliacao.id, professionalId: L.suelen.id, when: sp("2026-10-22T14:00"), uuid: "ce-antiga" } });
  await prisma.conversation.update({ where: { id: c.conv.id }, data: { lastMessageAt: sp("2026-10-10T10:00") } });
  // o CE nao conhece mais a reserva antiga (404): a confirmacao conferiu ao vivo e a marcou como cancelada AQUI, mas a origem e 'ce_apagada' (nao prova desistencia)
  const acao = await applyLiveVerdict({ id: c.appointment.id, clinicId: L.clinic.id, patientId: c.patient.id, scheduledAt: c.appointment.scheduledAt }, { kind: "gone", why: "a reserva foi apagada no Clínica Experts", localStatus: "cancelled" }, "Rosa");
  assert.equal(acao, "skip");
  const velha = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.deepEqual([velha.status, velha.cancelSource], ["cancelled", "ce_apagada"]);
  assert.ok(velha.cancelledAt);
  // e a recepcao criou a nova reserva (outro uuid) que a importacao trouxe
  await prisma.appointment.create({ data: { clinicId: L.clinic.id, patientId: c.patient.id, procedureId: L.avaliacao.id, scheduledAt: sp("2026-10-23T16:00"), ceBookingUuid: "ce-nova", source: "presencial" } });
  await prisma.appointment.update({ where: { id: c.appointment.id }, data: { cancelledAt: sp("2026-10-19T11:00") } });
  posts.length = 0;
  await runResumeFlows({ now: quando, sleep: noSleep, clinicId: L.clinic.id });
  assert.equal(posts.filter((p) => p.number === c.patient.phone).length, 0, "nenhuma retomada");
  const row = await prisma.followUpDispatch.findFirst({ where: { patientId: c.patient.id, flow: "avaliacao_cancelada" } });
  assert.equal(row.state, "skipped");
  assert.match(row.reason, /origem_nao_comprovada.*Clinica Experts/);
});

// ================================================================ retomada -> a pessoa responde -> a Alice conduz a nova avaliacao
test("retomada de avaliacao cancelada: quando a pessoa responde 'quero sim', a mensagem da automacao NAO e tratada como 'so agradeceu' e a Alice pode oferecer a avaliacao de novo", async () => {
  reset();
  const L = await mkLisboa("Lisboa Retomada Resposta");
  await prisma.resumeFlowConfig.create({ data: { clinicId: L.clinic.id, flow: "avaliacao_cancelada", enabled: true, message: "Oi, {primeiro_nome}! Aqui e a Alice da {unidade}. Se ainda tiver interesse, me responde por aqui que eu te ajudo a retomar, sem compromisso.", lookbackDays: 7 } });
  const c = await pessoa(L, "Tina Retoma", { mensagens: [] });
  await prisma.conversation.update({ where: { id: c.conv.id }, data: { lastMessageAt: sp("2026-10-10T10:00") } });
  await prisma.appointment.create({ data: { clinicId: L.clinic.id, patientId: c.patient.id, procedureId: L.avaliacao.id, scheduledAt: sp("2026-10-21T14:00"), status: "cancelled", cancelledAt: sp("2026-10-19T11:00"), cancelSource: "paciente_whatsapp", source: "whatsapp" } });
  await runResumeFlows({ now: sp("2026-10-20T10:00"), sleep: noSleep, clinicId: L.clinic.id });
  assert.equal(posts.filter((p) => p.number === c.patient.phone).length, 1);
  assert.ok(await prisma.message.findFirst({ where: { conversationId: c.conv.id, authorName: "Retomada de avaliação" } }));
  await fala(c, "Quero sim!");
  script = [{ content: "Que bom, Tina! Posso agendar uma nova avaliação gratuita pra você. Prefere manhã ou tarde? 💗" }];
  const r = await generateReply(c.conv.id);
  assert.equal(modelCalls.length >= 1, true, "a conversa segue com o modelo (nao foi tratada como agradecimento)");
  assert.match(r, /avaliação gratuita/, "a oferta de avaliacao nao foi cortada: a pessoa PEDIU para retomar");
  assert.doesNotMatch(r, /desist/i);
});

// ================================================================ agradecimento a pesquisa nao reinicia agendamento
test("depois do agradecimento a nota, um 'obrigada' so fecha: sem oferta de avaliacao, sem horarios e sem reserva", async () => {
  reset();
  const L = await mkLisboa("Lisboa Obrigada Pesquisa", { googleReviewUrl: "https://g.page/r/TESTE-APENAS-NOS-TESTES/review", googleReviewConfirmedAt: new Date(), googleReviewConfirmedBy: "teste" });
  const c = await pessoa(L, "Olivia Obrigada", { mensagens: [["assistant", "Oi Olivia! Como foi? De 0 a 10, qual nota voce daria?", "Pesquisa de satisfação"]] });
  await prisma.satisfactionSurvey.create({ data: { clinicId: L.clinic.id, patientId: c.patient.id, askedAt: new Date(Date.now() - HOUR) } });
  await fala(c, "10");
  const thanks = await generateReply(c.conv.id);
  await confirmaEnvio(c);
  assert.match(thanks, /Que bom saber, Olivia/);
  await fala(c, "Obrigada!!");
  const r = await generateReply(c.conv.id);
  assert.equal(modelCalls.length, 0);
  assert.doesNotMatch(r, /avalia|hor[aá]rio|agendar|procedimento/i, r);
  assert.equal(await nAppts(c), 0);
});

// ================================================================ FONTES CONFLITANTES (regras padrao)
test("regras recomendadas que contradiziam a conducao (toda resposta termina com horario, nunca pergunte, sempre os dois caminhos, 'a clinica nao realiza' ate a oferta sem cadastro) foram corrigidas NA FONTE e a troca no banco e seletiva, com previa e idempotente", async () => {
  reset();
  const { DEFAULT_RULES, RETIRED_DEFAULT_RULES, DEFAULT_RULE_REPLACEMENTS } = await import("../dist/ai/rules.js");
  const texts = DEFAULT_RULES.map((r) => r.instruction);
  for (const r of DEFAULT_RULE_REPLACEMENTS) {
    assert.ok(!texts.includes(r.antiga), "o texto antigo nao e mais a regra padrao");
    assert.ok(texts.includes(r.nova), "o texto novo e a regra padrao");
    assert.ok(RETIRED_DEFAULT_RULES.includes(r.antiga), "e o antigo e aposentado (qualquer reaplicacao do perfil o troca)");
  }
  assert.ok(!texts.some((t) => /Nunca encerre uma mensagem sem acao\.$/.test(t) || /^Nunca pergunte 'quer agendar\?' ou variacoes/.test(t)));
  const novaOferta = texts.find((t) => /OFERTA SEM CADASTRO/.test(t));
  assert.ok(novaOferta && /nao diga que a clinica nao realiza/.test(novaOferta));

  const L = await mkLisboa("Lisboa Regras");
  const MARK = "(regra recomendada padrao)";
  for (const r of DEFAULT_RULE_REPLACEMENTS) await prisma.customRule.create({ data: { clinicId: L.clinic.id, category: "agendamento", rawInput: MARK, instruction: r.antiga, status: "active" } });
  const editada = await prisma.customRule.create({ data: { clinicId: L.clinic.id, category: "agendamento", rawInput: "texto da clinica", instruction: DEFAULT_RULE_REPLACEMENTS[1].antiga, status: "active" } }); // MESMA frase, mas escrita a mao: nao e tocada
  const apagadaDeProposito = DEFAULT_RULES.find((r) => /Preferencia de horario nao e confirmacao/.test(r.instruction)); // o padrao que a clinica nao tem: nao pode ser recriado
  const antes = await prisma.customRule.count({ where: { clinicId: L.clinic.id } });

  const previa = await ajustarCondutaLisboa(L.clinic.id, { dryRun: true });
  assert.equal(previa.regrasPadrao.substituidas.length, DEFAULT_RULE_REPLACEMENTS.length);
  assert.equal(await prisma.customRule.count({ where: { clinicId: L.clinic.id } }), antes, "previa nao grava");

  const r1 = await ajustarCondutaLisboa(L.clinic.id, { dryRun: false });
  assert.equal(r1.aplicado.regrasPadraoTrocadas, DEFAULT_RULE_REPLACEMENTS.length);
  const depois = await prisma.customRule.findMany({ where: { clinicId: L.clinic.id } });
  for (const r of DEFAULT_RULE_REPLACEMENTS) {
    assert.equal(depois.filter((x) => x.instruction === r.nova && x.rawInput === MARK).length, 1, "texto novo presente uma vez");
    assert.equal(depois.filter((x) => x.instruction === r.antiga && x.rawInput === MARK).length, 0, "texto antigo auto-semeado removido");
  }
  assert.ok(depois.find((x) => x.id === editada.id), "a regra escrita a mao com a mesma frase continua");
  assert.equal(depois.length, antes, "nenhuma outra regra foi criada ou apagada");
  assert.ok(!depois.some((x) => x.instruction === apagadaDeProposito.instruction), "nao recria regra recomendada que a clinica nao tem");
  const r2 = await ajustarCondutaLisboa(L.clinic.id, { dryRun: false });
  assert.equal(r2.aplicado.regrasPadraoTrocadas, 0, "idempotente");
  assert.equal(await prisma.customRule.count({ where: { clinicId: L.clinic.id } }), antes);
});
