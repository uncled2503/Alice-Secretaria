// REINICIO DO SERVIDOR (item 3 da revisao de 19/10/2026). "O contexto da resposta final fica em memoria" significa: o ReplyContext (o que as ferramentas FIZERAM e DEVOLVERAM
// na geracao) vive num Map do processo (ai/replyGuard.ts) com validade de 15 min, e so serve para a ENTREGA validar o texto que vai sair (inclusive o reescrito pela revisao
// por IA). Reserva, procedimento escolhido, remarcacao, pesquisa, encaminhamento e deduplicacao vem do BANCO e da propria conversa. Aqui:
//  - o resumo minimo do contexto acompanha a mensagem ainda nao entregue (Message.replyContext) e sobrevive ao reinicio;
//  - sequencias com reinicio DE VERDADE (processos Node novos sobre o mesmo SQLite, morte injetada no ponto exato) provam que nao ha nova reserva, oferta incompativel ou reenvio.
// OpenAI e UAZAPI sao simuladas (modelo roteirizado): prova-se o que o CODIGO faz, nao o que o modelo real escreveria.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-reinicio-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const guard = await import("../dist/ai/replyGuard.js");
const store = await import("../dist/ai/replyContextStore.js");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "alice-reinicio-w-"));
const workerPath = path.join(root, "tests", "helpers", "restart-worker.mjs");
const logFile = path.join(workDir, "events.jsonl");
const specFile = path.join(workDir, "spec.json");
test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* temporario */ }
});

let logOffset = 0;
function worker(spec) {
  fs.writeFileSync(specFile, JSON.stringify({ ...spec, log: logFile }));
  const r = spawnSync(process.execPath, [workerPath, specFile], { env: { ...process.env }, encoding: "utf8", timeout: 240_000 });
  const all = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const events = all.slice(logOffset).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  logOffset = all.length;
  return { status: r.status, stderr: `${r.stderr}\n${r.stdout}`, events };
}
const sendsOf = (events) => events.filter((e) => e.t === "send");

// ---------------------------------------------------------------- cenario
const TZ = "America/Sao_Paulo";
const DAY = 24 * 3_600_000;
const isoDay = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + n * DAY));
const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00-03:00`);
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const DIA = isoDay(4);
const DIA2 = isoDay(5);

const clinic = await prisma.clinic.create({
  data: { name: "Clinica Reinicio", whatsappPhone: "5511900007777", timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-reinicio",
    workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, closedOnHolidays: false, silentHandoff: true, notOfferedServices: "luz pulsada", npsEnabled: true,
    notifyPhone: "5511900001234", notifyEvents: "reschedule" }, // so a remarcacao avisa a equipe (para provar que a repeticao nao avisa de novo)
});
const pro = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Dra. Teste", active: true } });
const limpeza = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Limpeza de Pele", durationMin: 60, bookingMode: "direct", professionals: { connect: [{ id: pro.id }] } } });
await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30, professionals: { connect: [{ id: pro.id }] } } });

let seq = 0;
async function pessoa(nome, { mensagens = [], appt = null } = {}) {
  seq++;
  const phone = `551197777${String(1000 + seq)}`;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, status: "active" } });
  let t = Date.now() - (mensagens.length + 2) * 60_000;
  for (const [role, content, authorName] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 60_000)), ...(role === "assistant" ? { deliveryStatus: "sent" } : {}) } });
  const appointment = appt ? await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: limpeza.id, professionalId: pro.id, scheduledAt: appt, source: "whatsapp", status: "confirmed" } }) : null;
  return { patient, conv, phone, appointment };
}
const payload = (phone, text, id = `MSG-${Math.random().toString(36).slice(2)}`) => ({
  EventType: "messages",
  message: { messageid: id, sender_pn: `${phone}@s.whatsapp.net`, senderName: "Paciente Teste", fromMe: false, isGroup: false, messageType: "text", text },
});
const tool = (name, args) => ({ tool: { name, args } });
// "o servidor ficou fora do ar por alguns minutos": o evento que ficou "processing" e as respostas paradas ficam velhos no banco
async function envelhece(c, minutos = 10) {
  const old = new Date(Date.now() - minutos * 60_000);
  await prisma.uazapiWebhookEvent.updateMany({ where: { clinicId: clinic.id, status: "processing" }, data: { updatedAt: old } });
  // TODAS as mensagens da conversa recuam o mesmo tanto (a fala da pessoa continua anterior a resposta, como na vida real)
  for (const m of await prisma.message.findMany({ where: { conversationId: c.conv.id, createdAt: { gt: new Date(Date.now() - minutos * 60_000) } } })) {
    await prisma.message.update({ where: { id: m.id }, data: { createdAt: new Date(m.createdAt.getTime() - minutos * 60_000) } });
  }
}
const diag = (r) => `eventos=${JSON.stringify(r.events.map((e) => (e.t === "model" || e.t === "send" ? e : e.t === "recover" ? e : e.t)))} stderr=${r.stderr.slice(-600)}`;
const nAppts = (c, where = {}) => prisma.appointment.count({ where: { patientId: c.patient.id, ...where } });
const lastMsgs = (c) => prisma.message.findMany({ where: { conversationId: c.conv.id }, orderBy: { createdAt: "asc" } });

// ================================================================ 1) FUNCOES PURAS: o resumo vai e volta sem perder nada que a validacao usa

test("o resumo persistido do contexto vai e volta (conjuntos incluidos), guarda so o minimo e NAO leva texto de conversa", () => {
  const ctx = {
    conversationId: "c1", tz: TZ, now: new Date("2026-10-19T12:00:00Z"), todayIso: "2026-10-19", situationKind: "normal",
    forbidEvaluationOffer: true, forbidSlotOffer: false, request: { dates: ["2026-10-22"], weekdays: [], onlyWeekdays: false, times: ["10:00"], notBefore: null, notAfter: null, period: null },
    trusted: false, agenda: true,
    actions: { booked: true, cancelled: false, rescheduled: false, transferred: false }, evidence: { cancelledRecently: false, rescheduledRecently: true },
    slots: { state: { times: new Set(["10:00", "11:00"]), dates: new Set(["22/10"]), instants: [1, 2], offer: [{ iso: "2026-10-22T13:00:00Z", professional: "Dra. Teste" }], booked: { label: "quinta, 22/10 às 10:00", professional: null } },
      toolUsed: true, strict: { times: new Set(["10:00"]), dates: new Set(["22/10"]) }, loose: { times: new Set(["10:00", "11:00"]), dates: new Set(["22/10"]) }, toolDates: ["2026-10-22"] },
    upcoming: [{ dateIso: "2026-10-22", time: "10:00", ddmm: "22/10" }], complaintTexts: ["TEXTO PRIVADO DA PACIENTE sobre celulite"], silentHandoff: true,
    objective: { concerns: ["celulite"], regions: ["coxas"] }, allowedProcedures: ["Enzimas"], notOffered: ["luz pulsada"],
  };
  const json = guard.serializeReplyContext(ctx, 2);
  assert.ok(!json.includes("TEXTO PRIVADO"), "o texto da conversa nao e gravado");
  assert.ok(json.length < 4000, `resumo pequeno (${json.length} bytes)`);
  assert.equal(guard.persistedComplaintCount(json), 2);
  const back = guard.deserializeReplyContext(json, "c1", ["a", "b"]);
  assert.deepEqual([...back.slots.state.times], ["10:00", "11:00"]);
  assert.deepEqual([...back.slots.strict.dates], ["22/10"]);
  assert.equal(back.now.toISOString(), ctx.now.toISOString());
  assert.deepEqual(back.actions, ctx.actions);
  assert.deepEqual(back.notOffered, ["luz pulsada"]);
  assert.deepEqual(back.complaintTexts, ["a", "b"]);
  assert.equal(guard.deserializeReplyContext("{quebrado", "c1", []), null, "JSON quebrado = sem contexto, nunca excecao");
  assert.equal(guard.deserializeReplyContext(JSON.stringify({ v: 99 }), "c1", []), null, "versao desconhecida = sem contexto");
  // a validacao da entrega decide IGUAL com o contexto da memoria e com o recuperado do resumo
  const texto = "Fazemos luz pulsada, ótima para manchas! 💗";
  const a = guard.checkFinalReply(texto, ctx, { strict: false });
  const b = guard.checkFinalReply(texto, back, { strict: false });
  assert.deepEqual(b.map((p) => p.code), a.map((p) => p.code));
  assert.ok(b.some((p) => p.code === "not_offered"));
});

test("sem contexto (o que acontecia depois do reinicio) uma reescrita que cita servico recusado PASSAVA; com o resumo ela e recusada", () => {
  const original = "A gente fica na Av. Índico, 294. 💗";
  const reescrita = "A gente fica na Av. Índico, 294. Fazemos luz pulsada, ótima para manchas! 💗";
  const ctx = guard.deserializeReplyContext(guard.serializeReplyContext({
    conversationId: "c", tz: TZ, now: new Date(), todayIso: isoDay(0), situationKind: "normal", forbidEvaluationOffer: false, forbidSlotOffer: false,
    request: { dates: [], weekdays: [], onlyWeekdays: false, times: [], notBefore: null, notAfter: null, period: null }, trusted: false, agenda: true,
    actions: { booked: false, cancelled: false, rescheduled: false, transferred: false }, evidence: { cancelledRecently: false, rescheduledRecently: false },
    slots: { state: { times: new Set(), dates: new Set(), instants: [], offer: [], booked: null }, toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] },
    upcoming: [], complaintTexts: [], silentHandoff: false, notOffered: ["luz pulsada"],
  }, 0), "c", []);
  const sem = guard.chooseFinalReply({ ctx: null, original, rewritten: reescrita });
  assert.equal(sem.source, "rewrite", "SEM contexto a reescrita saia (comportamento anterior ao resumo persistido)");
  const com = guard.chooseFinalReply({ ctx, original, rewritten: reescrita });
  assert.equal(com.source, "original", "COM o resumo a reescrita e recusada e sai a original");
  assert.ok(com.rejected.some((r) => r.problems.some((p) => p.code === "not_offered")));
});

test("o resumo so existe enquanto a resposta ainda pode ser entregue: estados finais o apagam", async () => {
  const c = await pessoa("Poda Contexto");
  const mk = (status) => prisma.message.create({ data: { conversationId: c.conv.id, role: "assistant", content: `resposta ${status}`, deliveryStatus: status, replyContext: "{\"v\":1}" } });
  const rows = {};
  for (const s of ["pending", "sending", "failed", "sent", "unconfirmed", "failed_permanent", "blocked", "vetoed", "expired"]) rows[s] = await mk(s);
  rows.nulo = await mk(null);
  await store.pruneReplyContexts();
  const left = new Set((await prisma.message.findMany({ where: { id: { in: Object.values(rows).map((r) => r.id) }, replyContext: { not: null } }, select: { id: true } })).map((r) => r.id));
  for (const s of ["pending", "sending", "failed"]) assert.ok(left.has(rows[s].id), `${s}: ainda pode ser entregue, o resumo fica`);
  for (const s of ["sent", "unconfirmed", "failed_permanent", "blocked", "vetoed", "expired", "nulo"]) assert.ok(!left.has(rows[s].id), `${s}: estado final, resumo apagado`);
});

// ================================================================ 2) REINICIO DE VERDADE

test("R1) reserva: o processo MORRE entre a ferramenta (reserva gravada) e a resposta; ao subir de novo nao ha segunda reserva e a pessoa recebe UMA resposta", async () => {
  const c = await pessoa("Renata Reserva Silva");
  const hora = "10:00";
  const a = worker({
    op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, `Quero agendar a Limpeza de Pele no dia ${ddmm(DIA)} às ${hora}`),
    model: [tool("book_appointment", { procedure_name: "Limpeza de Pele", date: DIA, time: hora, patient_full_name: "Renata Reserva Silva" }), { crash: true }],
  });
  assert.equal(a.status, 137, `o processo A foi morto: ${a.stderr.slice(0, 300)}`);
  assert.equal(await nAppts(c, { status: "confirmed" }), 1, "a reserva ja estava gravada");
  assert.equal(sendsOf(a.events).length, 0, "nada saiu para a pessoa");
  assert.equal((await lastMsgs(c)).filter((m) => m.role === "assistant").length, 0, "nenhuma resposta gravada");
  assert.equal((await prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id }, orderBy: { createdAt: "desc" } })).status, "processing");

  await envelhece(c);
  // o modelo, no pior caso, tenta reservar DE NOVO (a ficha ja mostra a agenda, mas aqui nao se confia nisso)
  const b = worker({
    op: "boot", clinicId: clinic.id,
    model: [tool("book_appointment", { procedure_name: "Limpeza de Pele", date: DIA, time: hora, patient_full_name: "Renata Reserva Silva" }), { content: `Você já tem a Limpeza de Pele agendada para ${ddmm(DIA)} às ${hora}. 💗` }],
  });
  assert.equal(b.status, 0, b.stderr.slice(0, 400));
  assert.match(String(b.events.find((e) => e.t === "model" && e.lastTool)?.lastTool), /JA tem Limpeza de Pele agendado nesse dia/, "a ferramenta recusou a segunda reserva");
  assert.equal(await nAppts(c, { status: "confirmed" }), 1, "continua uma so reserva");
  const s = sendsOf(b.events);
  assert.equal(s.length, 1, "uma unica resposta saiu");
  assert.match(s[0].text, new RegExp(`${ddmm(DIA)} às ${hora}`));
  assert.equal((await prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id }, orderBy: { createdAt: "desc" } })).status, "done");

  // o provedor reentrega o MESMO webhook depois: reconhecido, nada novo
  const again = worker({ op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, "x", (await prisma.message.findFirst({ where: { conversationId: c.conv.id, role: "user" } })).externalId), model: [] });
  assert.equal(again.status, 0);
  assert.equal(sendsOf(again.events).length, 0);
  assert.equal(await nAppts(c), 1);
});

test("R2) a resposta esta gravada (pending, com o resumo) e o processo morre na REVISAO; depois do reinicio ela e retomada e a reescrita da revisao e validada com o contexto recuperado", async () => {
  const c = await pessoa("Edna Endereco");
  const a = worker({
    op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, "Qual o endereço de vocês?"),
    model: [{ content: "A gente fica na Av. Índico, 294. 💗" }], crash: { review: true },
  });
  assert.equal(a.status, 137, a.stderr.slice(0, 300));
  const pend = await prisma.message.findFirst({ where: { conversationId: c.conv.id, role: "assistant" } });
  assert.equal(pend.deliveryStatus, "pending");
  assert.ok(pend.replyContext, "o resumo do contexto foi gravado junto da resposta");
  assert.ok(!pend.replyContext.includes("endereço"), "o resumo nao carrega o texto da conversa");
  assert.equal(sendsOf(a.events).length, 0);

  await envelhece(c);
  const b1 = worker({ op: "boot", clinicId: clinic.id, model: [] });
  assert.equal(b1.status, 0, b1.stderr.slice(0, 400));
  assert.equal(sendsOf(b1.events).length, 0, "o evento reprocessado nao gera outra resposta nem reenvia as cegas");
  assert.equal((await prisma.message.count({ where: { conversationId: c.conv.id, role: "assistant" } })), 1, "continua uma so resposta gravada");

  await envelhece(c);
  const b2 = worker({
    op: "maintain", clinicId: clinic.id, model: [],
    review: { decisao: "reescrever", confianca: "alta", motivo: "tom", texto: "A gente fica na Av. Índico, 294. Fazemos luz pulsada, ótima para manchas! 💗" },
  });
  assert.equal(b2.status, 0, b2.stderr.slice(0, 400));
  const s = sendsOf(b2.events);
  assert.equal(s.length, 1, `exatamente um envio: ${diag(b2)}`);
  assert.equal(s[0].text, "A gente fica na Av. Índico, 294. 💗", "a reescrita que cita servico recusado foi barrada pelo contexto recuperado: saiu a original");
  assert.match(b2.stderr, /rewrite recusada[^\n]*not_offered/, "a recusa veio da validacao COMPLETA (nao da comparacao sem contexto)");
  const done = await prisma.message.findUnique({ where: { id: pend.id } });
  assert.equal(done.deliveryStatus, "sent");
  assert.equal(done.replyContext, null, "estado final: o resumo foi apagado");

  const b3 = worker({ op: "maintain", clinicId: clinic.id, model: [] });
  assert.equal(sendsOf(b3.events).length, 0, "nova manutencao nao reenvia");
});

test("R3) a morte acontece DEPOIS de o texto ter ido para o WhatsApp: nada e reenviado (fica 'sem confirmacao' e a equipe e avisada pelo painel de saude)", async () => {
  const c = await pessoa("Sonia Saida");
  const a = worker({ op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, "Qual o endereço de vocês?"), model: [{ content: "Estamos na Av. Índico, 294. 💗" }], crash: { send: "after" } });
  assert.equal(a.status, 137);
  assert.equal(sendsOf(a.events).length, 1, "o texto chegou a sair");
  await envelhece(c);
  const b = worker({ op: "boot", clinicId: clinic.id, model: [] });
  const m = worker({ op: "maintain", clinicId: clinic.id, model: [] });
  assert.equal(sendsOf(b.events).length + sendsOf(m.events).length, 0, "nunca reenvia o que pode ter chegado");
  const row = await prisma.message.findFirst({ where: { conversationId: c.conv.id, role: "assistant" } });
  assert.equal(row.deliveryStatus, "unconfirmed");
  assert.equal(row.replyContext, null);
});

test("R4) pesquisa aguardando resposta atravessa o reinicio: a nota e lida pelo codigo (sem modelo), grava uma vez, e o 'obrigada' seguinte so fecha", async () => {
  const c = await pessoa("Paula Pesquisa", { mensagens: [["assistant", "Oi Paula! Como foi sua experiencia? De 0 a 10, qual nota voce daria?", "Pesquisa de satisfação"]] });
  await prisma.satisfactionSurvey.create({ data: { clinicId: clinic.id, patientId: c.patient.id, askedAt: new Date(Date.now() - 3_600_000) } });
  const nota = worker({ op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, "10"), model: [] }); // processo novo: sem NADA em memoria
  assert.equal(nota.status, 0, nota.stderr.slice(0, 300));
  const survey = await prisma.satisfactionSurvey.findFirst({ where: { patientId: c.patient.id } });
  assert.equal(survey.score, 10);
  assert.notEqual(survey.linkState, "enviado", "esta clinica de teste nao tem link do Google: agradece sem link");
  const s1 = sendsOf(nota.events).filter((e) => e.number === c.phone); // (o aviso interno "nota alta sem link" vai para o numero da equipe, nao para a paciente)
  assert.equal(s1.length, 1);
  assert.doesNotMatch(s1[0].text, /https?:\/\//);
  assert.equal(nota.events.filter((e) => e.t === "model").length, 0, "a nota nao passa pelo modelo");

  const obrig = worker({ op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, "Obrigada!"), model: [] }); // outro processo novo
  assert.equal(obrig.status, 0, obrig.stderr.slice(0, 300));
  assert.equal(obrig.events.filter((e) => e.t === "model").length, 0, "agradecimento depois da pesquisa nao chama o modelo");
  for (const e of sendsOf(obrig.events).filter((x) => x.number === c.phone)) assert.doesNotMatch(e.text, /avalia|hor[aá]rio|agendar|nota/i);
  assert.equal(await prisma.satisfactionSurvey.count({ where: { patientId: c.patient.id } }), 1, "nenhuma pesquisa nova");
  assert.equal((await prisma.satisfactionSurvey.findFirst({ where: { patientId: c.patient.id } })).score, 10, "a nota nao foi regravada");
});

test("R5) encaminhamento para a equipe: o processo morre depois da transferencia; ao subir de novo a Alice NAO responde (a conversa e da equipe)", async () => {
  const c = await pessoa("Helena Humano");
  const a = worker({
    op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, "Quero falar com a gerente sobre uma cobrança"),
    model: [tool("transfer_to_human", { reason: "Quer falar com a gerente", summary: "Cobranca." }), { crash: true }],
  });
  assert.equal(a.status, 137, a.stderr.slice(0, 300));
  const conv = await prisma.conversation.findUnique({ where: { id: c.conv.id } });
  assert.ok(conv.humanTakeover || conv.handoffPending, "a transferencia ja estava gravada");
  await envelhece(c);
  const b = worker({ op: "boot", clinicId: clinic.id, model: [] });
  assert.equal(b.status, 0, b.stderr.slice(0, 400));
  assert.equal(b.events.filter((e) => e.t === "model").length, 0, "o modelo nao e chamado numa conversa transferida");
  assert.equal(sendsOf(b.events).length, 0);
  assert.ok(!b.events.some((e) => e.t === "erro"), JSON.stringify(b.events.filter((e) => e.t === "erro")));
});

test("R6) remarcacao: o processo morre depois de remarcar; ao subir de novo continua UMA reserva, no horario novo, e a resposta cita o horario certo", async () => {
  const c = await pessoa("Rita Remarca", { appt: at(DIA, "10:00") });
  const novo = "15:00";
  const a = worker({
    op: "enqueue", clinicId: clinic.id, payload: payload(c.phone, `Preciso remarcar para o dia ${ddmm(DIA2)} às ${novo}`),
    model: [tool("manage_my_appointment", { action: "reschedule", new_date: DIA2, new_time: novo }), { crash: true }],
  });
  assert.equal(a.status, 137, a.stderr.slice(0, 300));
  const after = await prisma.appointment.findFirst({ where: { patientId: c.patient.id, status: "confirmed" } });
  assert.equal(after.scheduledAt.getTime(), at(DIA2, novo).getTime(), "a remarcacao ja estava gravada");
  const logsA = await prisma.activityLog.count({ where: { patientId: c.patient.id, type: "appointment_rescheduled" } });
  assert.equal(logsA, 1);
  const equipeA = sendsOf(a.events).filter((e) => e.number === "5511900001234");
  assert.equal(equipeA.length, 1, "a equipe foi avisada da remarcacao UMA vez");
  // um lembrete ja controlado para o horario novo (nao pode ser apagado pela repeticao)
  const regra = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 24, message: "Lembrete de teste" } });
  const marca = await prisma.reminderSent.create({ data: { appointmentId: after.id, ruleId: regra.id } });

  await envelhece(c);
  const b = worker({
    op: "boot", clinicId: clinic.id,
    model: [tool("manage_my_appointment", { action: "reschedule", new_date: DIA2, new_time: novo }), { content: `Pronto! Sua Limpeza de Pele ficou remarcada para ${ddmm(DIA2)} às ${novo}. 💗` }],
  });
  assert.equal(b.status, 0, b.stderr.slice(0, 400));
  assert.equal(await nAppts(c), 1, "uma so reserva");
  const fim = await prisma.appointment.findFirst({ where: { patientId: c.patient.id } });
  assert.equal(fim.scheduledAt.getTime(), at(DIA2, novo).getTime());
  assert.equal(sendsOf(b.events).filter((e) => e.number === "5511900001234").length, 0, "a equipe NAO e avisada de novo");
  const s = sendsOf(b.events).filter((e) => e.number === c.phone);
  assert.equal(s.length, 1, diag(b));
  assert.match(s[0].text, new RegExp(`${ddmm(DIA2)} às ${novo}`));
  assert.ok(await prisma.reminderSent.findUnique({ where: { id: marca.id } }), "o controle dos lembretes nao foi apagado: nenhum lembrete sai de novo");
  assert.equal(await prisma.activityLog.count({ where: { patientId: c.patient.id, type: "appointment_rescheduled" } }), 1, "a remarcacao nao foi registrada duas vezes");
});
