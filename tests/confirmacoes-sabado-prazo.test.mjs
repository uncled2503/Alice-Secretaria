// CONFIRMACOES (Lisboa, 21/10/2026): (1) dia seguinte ate as 9h do dia anterior, por DATA LOCAL do atendimento; (2) rotina de SABADO (quarta, sexta, lembrete no dia) que SUBSTITUI a generica.
// Banco isolado, relogio controlado (fuso do processo = UTC, clinica = America/Sao_Paulo), WhatsApp simulado por um fetch falso. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-conf-sabado-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const enviados = [];
let whatsappOk = true;
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (!whatsappOk) return jsonRes(500, { error: "fora do ar" });
    const b = JSON.parse(init.body);
    enviados.push({ phone: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg-1", data: {} });
};

const { prisma } = await import("../dist/db/client.js");
const cron = await import("../dist/reminders/cron.js");
const policy = await import("../dist/reminders/policy.js");
const controlled = await import("../dist/reminders/controlled.js");
const { conferirConfirmacoesLisboa, sabadoTextFrom } = await import("../dist/maintenance/lisboaConfirmacoes.js");
const { resolvePresence } = await import("../dist/ai/presenceConfirmation.js");
const { getClinicTemplateInfo } = await import("../dist/crm/template.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`); // horario de parede de Sao Paulo
const OLD = sp("2026-10-01T10:00"); // criado ha muito tempo (antes de qualquer janela)
let seq = 0;

const TXT_DIA_ANTERIOR = "Olá, {primeiro_nome}!\nPassando para confirmar o seu agendamento:\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n\nPosso confirmar a sua presença?";
const TXT_COBRANCA = "Olá, {primeiro_nome}! Ainda não recebemos a sua confirmação do agendamento de amanhã: {data} {hora}. Pode confirmar?";
const TXT_VESPERA = "Olá, {primeiro_nome}! Estamos te esperando amanhã às {hora} 💗";
const TXT_DIA = "Bom dia, {primeiro_nome}! Estamos felizes em te receber hoje às {hora}.";

async function clinica(nome, { sabado = true, explicit = true } = {}) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}` } });
  const base = { clinicId: c.id, pauseMinSec: 0, pauseMaxSec: 0, active: true };
  const generic = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 9, message: TXT_DIA_ANTERIOR, ...(explicit ? { purpose: "confirmacao" } : {}) } });
  const cobranca = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 16, sendMinute: 0, sendEndHour: 17, message: TXT_COBRANCA, parentRuleId: generic.id, ...(explicit ? { purpose: "cobranca" } : {}) } });
  const doDia = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, message: TXT_DIA, ...(explicit ? { purpose: "lembrete" } : {}) } });
  let quarta = null, sexta = null;
  if (sabado) {
    quarta = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 72, dayOffset: 3, sendHour: 8, sendMinute: 0, sendEndHour: 9, message: TXT_DIA_ANTERIOR.replace("(amanhã)", "(sábado)"), weekdays: "6", purpose: "confirmacao" } });
    sexta = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 16, sendMinute: 0, sendEndHour: 17, message: TXT_VESPERA, weekdays: "6", purpose: "lembrete" } }); // pedido da Aline: lembrete na sexta para TODOS
  }
  return { c, generic, cobranca, doDia, quarta, sexta };
}
async function agenda(c, nome, quando, extra = {}) {
  seq++;
  const proc = (await prisma.procedure.findFirst({ where: { clinicId: c.id } })) ?? (await prisma.procedure.create({ data: { clinicId: c.id, name: "Lavieen", durationMin: 30 } }));
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119777${String(10000 + seq)}` } });
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp(quando), source: "presencial", createdAt: OLD, ...extra } });
  return { p, a };
}
const rodar = (iso) => cron.runReminderCycle({ now: sp(iso) });
const para = (p) => enviados.filter((e) => e.phone === p.phone);
const zera = () => { enviados.length = 0; whatsappOk = true; };

test("policy: dia da semana pela DATA LOCAL (23h30 de sexta em Sao Paulo ja e sabado em UTC), dias invalidos, substituicao e conflito", () => {
  assert.equal(policy.weekdayInZone(sp("2026-10-23T23:30"), TZ), 5, "sexta em SP, mesmo sendo sabado em UTC");
  assert.equal(policy.weekdayInZone(sp("2026-10-24T00:30"), TZ), 6);
  assert.deepEqual(policy.parseWeekdays("6"), { days: new Set([6]), valid: true });
  assert.equal(policy.parseWeekdays("9").valid, false);
  assert.equal(policy.parseWeekdays("a,6").valid, false);
  assert.equal(policy.parseWeekdays(null).days, null);
  const g = { id: "g", parentRuleId: null, message: TXT_DIA_ANTERIOR, active: true, purpose: "confirmacao", weekdays: null, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 9 };
  const s = { ...g, id: "s", weekdays: "6", dayOffset: 3 };
  assert.equal(policy.overridingRule(g, 6, [g, s])?.id, "s");
  assert.equal(policy.overridingRule(g, 5, [g, s]), null);
  assert.equal(policy.overridingRule(s, 6, [g, s]), null, "a especifica nunca e substituida");
  const lemb0 = { id: "l0", parentRuleId: null, message: TXT_DIA, active: true, purpose: "lembrete", weekdays: null, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8 };
  const lemb1 = { ...lemb0, id: "l1", weekdays: "6", dayOffset: 1, sendHour: 16, sendEndHour: 17 };
  assert.equal(policy.overridingRule(g, 6, [g, lemb1])?.id, "l1", "lembrete de sexta substitui a confirmacao generica do mesmo dia-offset");
  assert.equal(policy.overridingRule(lemb0, 6, [lemb0, lemb1]), null, "o lembrete de sabado (dia 0) nao e substituido pelo de sexta");
  assert.equal(policy.findPolicyConflicts([g, s]).length, 0);
  assert.equal(policy.findPolicyConflicts([g, { ...g, id: "g2" }]).length, 1, "duas genericas iguais se pisam");
  assert.equal(policy.ruleProblems({ ...g, sendEndHour: null }).some((p) => p.code === "sem_janela_de_calendario"), true, "confirmacao sem janela de calendario e invalida");
  assert.equal(policy.ruleProblems({ ...g, dayOffset: null, sendHour: null, sendEndHour: null }).length > 0, true);
  assert.equal(policy.ruleProblems({ ...g, sendEndHour: 11 }, 9).some((p) => p.code === "passa_do_prazo"), true);
  assert.equal(policy.perRunCap(5, null, new Date()), 12);
  assert.equal(policy.perRunCap(80, sp("2026-10-20T09:00"), sp("2026-10-20T08:10")), 20, "80 pessoas em 4 rodadas restantes (8h10 a 9h) sobe o teto, com limite 30");
  assert.equal(policy.perRunCap(500, sp("2026-10-20T09:00"), sp("2026-10-20T08:50")), 30);
});

test("a politica do dia anterior: amanha cedo e amanha a noite entram na janela de ate as 9h do dia anterior; nada e enviado fora dela", async () => {
  zera();
  const L = await clinica("Conf Dia Anterior");
  const cedo = await agenda(L.c, "Ana Cedo", "2026-10-21T08:00");
  const noite = await agenda(L.c, "Bia Noite", "2026-10-21T20:30");
  const depois = await agenda(L.c, "Cris Depois", "2026-10-22T09:00"); // quinta: nao e "amanha"
  await rodar("2026-10-20T07:50"); // antes de abrir
  assert.equal(enviados.length, 0, "a janela abre as 8h");
  await rodar("2026-10-20T08:10");
  assert.equal(para(cedo.p).length, 1);
  assert.equal(para(noite.p).length, 1);
  assert.equal(para(depois.p).length, 0);
  assert.match(para(cedo.p)[0].text, /\(amanhã\)/);
  await rodar("2026-10-20T08:25"); // outra rodada da mesma janela: nada em dobro
  assert.equal(enviados.length, 2);
  // a janela fechou as 9h: quem sobrar nao recebe "24h antes" depois
  const tarde = await agenda(L.c, "Dani Tarde", "2026-10-21T15:00");
  await rodar("2026-10-20T09:15");
  assert.equal(para(tarde.p).length, 0, "criado ANTES da janela e sem envio nela: a janela passou, nao sai lote atrasado");
});

test("virada de dia UTC x Sao Paulo: 22h30 de quarta em SP (quinta em UTC) e 'amanha' na terca; 00h30 de quinta em SP nao e", async () => {
  zera();
  const L = await clinica("Conf Virada UTC");
  const quartaNoite = await agenda(L.c, "Quarta Noite", "2026-10-21T22:30"); // 2026-10-22T01:30Z
  const quintaMadrugada = await agenda(L.c, "Quinta Madrugada", "2026-10-22T00:30"); // 03:30Z
  assert.equal(quartaNoite.a.scheduledAt.toISOString(), "2026-10-22T01:30:00.000Z");
  await rodar("2026-10-20T08:10");
  assert.equal(para(quartaNoite.p).length, 1);
  assert.equal(para(quintaMadrugada.p).length, 0);
});

test("agendado/remarcado DEPOIS da janela: reposicao visivel (entre 8h e 20h, com 2h de folga); a remarcacao e anotada pelo banco em qualquer caminho", async () => {
  zera();
  const L = await clinica("Conf Reposicao");
  const novo = await agenda(L.c, "Novo Depois", "2026-10-21T14:00", { createdAt: sp("2026-10-20T09:30") });
  const remarcado = await agenda(L.c, "Remarcada", "2026-10-25T14:00"); // criada ha muito, quinta/domingo
  // a camada do banco anota a remarcacao SEM ninguem lembrar de anotar, e regravar o mesmo horario nao conta
  const antes = await prisma.appointment.findUnique({ where: { id: remarcado.a.id } });
  assert.equal(antes.scheduleChangedAt, null);
  await prisma.appointment.update({ where: { id: remarcado.a.id }, data: { scheduledAt: sp("2026-10-25T14:00") } });
  assert.equal((await prisma.appointment.findUnique({ where: { id: remarcado.a.id } })).scheduleChangedAt, null, "mesmo horario nao e remarcacao");
  await prisma.appointment.update({ where: { id: remarcado.a.id }, data: { scheduledAt: sp("2026-10-21T16:00") } });
  const dep = await prisma.appointment.findUnique({ where: { id: remarcado.a.id } });
  assert.ok(dep.scheduleChangedAt, "remarcado: anotado");
  // para controlar o relogio do teste, fixa o instante da remarcacao (depois da janela de terca)
  await prisma.appointment.update({ where: { id: remarcado.a.id }, data: { scheduleChangedAt: sp("2026-10-20T10:00") } });
  await rodar("2026-10-20T09:45"); // criado 9h30 (apos o fim da janela, 9h): reposicao
  assert.equal(para(novo.p).length, 1, "reposicao do agendamento criado depois da janela");
  await rodar("2026-10-20T10:30");
  assert.equal(para(remarcado.p).length, 1, "remarcado depois da janela tambem tem reposicao (antes ficava sem cobertura)");
  await rodar("2026-10-20T10:45");
  assert.equal(enviados.length, 2, "uma vez so");
});

test("a Alice conversou ha pouco com quem foi agendado depois da janela: a reposicao ESPERA (retida e registrada), depois pede; regra legada dispensa mas REGISTRA", async () => {
  zera();
  const L = await clinica("Conf Conversa");
  const x = await agenda(L.c, "Conversou", "2026-10-21T16:00", { createdAt: sp("2026-10-20T09:30") });
  const conv = await prisma.conversation.create({ data: { patientId: x.p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Agendado! Amanhã às 16h.", createdAt: sp("2026-10-20T09:31") } });
  await rodar("2026-10-20T10:00");
  assert.equal(para(x.p).length, 0, "falou com ela ha 30 min: espera");
  const rule = await prisma.reminderRule.findUnique({ where: { id: L.generic.id } });
  const sel = await cron.selectReminderCandidates(rule, sp("2026-10-20T10:00"), TZ);
  assert.equal(sel.held.find((h) => h.appointmentId === x.a.id)?.code, "reposicao_aguardando_conversa_recente");
  await rodar("2026-10-20T13:00"); // 3h27 depois da conversa
  assert.equal(para(x.p).length, 1);
  // regra LEGADA (sem finalidade explicita): comportamento antigo de dispensar, agora visivel
  const Lg = await clinica("Conf Legada", { sabado: false, explicit: false });
  const y = await agenda(Lg.c, "Legada", "2026-10-21T16:00", { createdAt: sp("2026-10-20T09:30") });
  const conv2 = await prisma.conversation.create({ data: { patientId: y.p.id } });
  await prisma.message.create({ data: { conversationId: conv2.id, role: "assistant", content: "Agendado!", createdAt: sp("2026-10-20T09:31") } });
  const sel2 = await cron.selectReminderCandidates(Lg.generic, sp("2026-10-20T14:00"), TZ);
  assert.equal(sel2.due.length, 0);
  assert.equal(sel2.held.find((h) => h.appointmentId === y.a.id)?.code, "reposicao_dispensada_ja_houve_conversa");
});

test("SABADO: quarta pede, sexta LEMBRA a TODOS (inclusive confirmados), sabado lembra de novo; a generica NAO manda no sabado e o lembrete de sabado nao some", async () => {
  zera();
  const L = await clinica("Conf Sabado");
  const a = await agenda(L.c, "Sab Ana", "2026-10-24T10:00");
  const b = await agenda(L.c, "Sab Bia", "2026-10-24T15:00");
  const seg = await agenda(L.c, "Seg Cris", "2026-10-26T10:00"); // segunda: regra generica (domingo)
  // QUARTA 21/10 8h-9h
  await rodar("2026-10-21T08:10");
  assert.equal(para(a.p).length, 1);
  assert.equal(para(b.p).length, 1);
  assert.match(para(a.p)[0].text, /\(sábado\)/);
  assert.doesNotMatch(para(a.p)[0].text, /amanhã/);
  assert.equal(para(seg.p).length, 0);
  // a Bia confirma na quinta
  await prisma.appointment.update({ where: { id: b.a.id }, data: { patientConfirmed: true, confirmedAt: sp("2026-10-22T11:00") } });
  // QUINTA: nada
  const n0 = enviados.length;
  await rodar("2026-10-22T08:10");
  await rodar("2026-10-22T16:10");
  assert.equal(enviados.length, n0);
  // SEXTA 23/10 8h-9h: a generica do dia anterior NAO manda para sabado (a especifica substitui; nunca as duas)
  await rodar("2026-10-23T08:10");
  assert.equal(enviados.length, n0, "a confirmacao generica nao duplica o sabado");
  // SEXTA 16h-17h: lembrete para TODOS, com o texto ja cadastrado da vespera
  await rodar("2026-10-23T16:10");
  assert.equal(para(a.p).length, 2, "Ana: lembrete de sexta");
  assert.equal(para(b.p).length, 2, "Bia confirmou e recebe o lembrete de sexta mesmo assim");
  assert.match(para(b.p)[1].text, /Estamos te esperando amanhã/);
  // SABADO 24/10 7h-8h: lembrete a todos
  await rodar("2026-10-24T07:10");
  assert.equal(para(a.p).length, 3);
  assert.equal(para(b.p).length, 3, "confirmada tambem recebe o lembrete de sabado");
  assert.match(para(b.p)[2].text, /hoje às/);
  // domingo 25/10 8h: a confirmacao generica da segunda sai normalmente
  await rodar("2026-10-25T08:10");
  assert.equal(para(seg.p).length, 1);
  // nao ha duplicidade em nenhuma rodada repetida
  const total = enviados.length;
  await rodar("2026-10-24T07:25");
  assert.equal(enviados.length, total);
});

test("SABADO: criado na quinta ou na sexta entra nas proximas etapas validas; cancelado e remarcado nao recebem o horario antigo", async () => {
  zera();
  const L = await clinica("Conf Sabado Tardio");
  const quinta = await agenda(L.c, "Criada Quinta", "2026-10-24T11:00", { createdAt: sp("2026-10-22T10:00") });
  const sexta = await agenda(L.c, "Criada Sexta", "2026-10-24T12:00", { createdAt: sp("2026-10-23T09:30") });
  const cancelada = await agenda(L.c, "Cancelada", "2026-10-24T13:00", { status: "cancelled" });
  const remarcada = await agenda(L.c, "Remarcada Segunda", "2026-10-26T13:00"); // era sabado? agora segunda: nao e sabado
  await rodar("2026-10-22T10:30"); // quinta: reposicao da quarta
  assert.equal(para(quinta.p).length, 1);
  assert.match(para(quinta.p)[0].text, /\(sábado\)/);
  await rodar("2026-10-23T09:45"); // sexta: reposicao
  assert.equal(para(sexta.p).length, 1);
  assert.equal(para(cancelada.p).length, 0);
  // a da quinta recebe tambem a nova solicitacao de sexta (nao confirmou, passou o intervalo)
  await rodar("2026-10-23T16:10");
  assert.equal(para(quinta.p).length, 2);
  assert.equal(para(sexta.p).length, 2, "criada na sexta: reposicao da confirmacao + lembrete de sexta (sem reposicao de lembrete em dobro)");
  assert.equal(para(remarcada.p).length, 0);
});

test("cancelamento e remarcacao ENTRE a selecao e o envio: nada sai (estado fresco revalidado)", async () => {
  zera();
  const L = await clinica("Conf Revalida", { sabado: false });
  const x = await agenda(L.c, "Vai Cancelar", "2026-10-21T10:00");
  const y = await agenda(L.c, "Vai Remarcar", "2026-10-21T11:00");
  const z = await agenda(L.c, "Vai Confirmar", "2026-10-21T12:00");
  const agora = sp("2026-10-20T08:10");
  const rule = await prisma.reminderRule.findUnique({ where: { id: L.generic.id } });
  const sel = await cron.selectReminderCandidates(rule, agora, TZ);
  assert.equal(sel.due.length, 3);
  await prisma.appointment.update({ where: { id: x.a.id }, data: { status: "cancelled" } });
  await prisma.appointment.update({ where: { id: y.a.id }, data: { scheduledAt: sp("2026-10-22T11:00") } });
  await prisma.appointment.update({ where: { id: z.a.id }, data: { patientConfirmed: true } });
  const env = { clock: () => agora, tz: TZ, clinicInfo: await getClinicTemplateInfo(L.c.id), stat: { deferred: 0, exhausted: 0, reasons: new Set() }, ceDown: new Map(), ceFailures: new Map() };
  for (const appt of sel.due) assert.equal(await cron.deliverReminder(env, rule, appt), false);
  assert.equal(enviados.length, 0);
});

test("quem ja confirmou nao recebe nova solicitacao (salvo politica explicita); regra legada mantem o comportamento de sempre", async () => {
  zera();
  const L = await clinica("Conf Ja Confirmou", { sabado: false });
  const c1 = await agenda(L.c, "Confirmada", "2026-10-21T10:00", { patientConfirmed: true });
  await rodar("2026-10-20T08:10");
  assert.equal(para(c1.p).length, 0);
  await prisma.reminderRule.update({ where: { id: L.generic.id }, data: { resendIfConfirmed: true } });
  await rodar("2026-10-20T08:25");
  assert.equal(para(c1.p).length, 1, "politica explicita cadastrada: reenvia");
  // clinica LEGADA (sem finalidade): a confirmada continua recebendo, como sempre foi (nao e regressao)
  const Lg = await clinica("Conf Legada 2", { sabado: false, explicit: false });
  const c2 = await agenda(Lg.c, "Confirmada Legada", "2026-10-21T10:00", { patientConfirmed: true });
  await rodar("2026-10-20T08:40");
  assert.equal(para(c2.p).length, 1);
});

test("reserva NAO efetivada no Clinica Experts nao e apresentada como agendamento confirmado: fica retida com o motivo", async () => {
  zera();
  const L = await clinica("Conf Nao Efetivada", { sabado: false });
  const x = await agenda(L.c, "Reserva Pendente", "2026-10-21T10:00");
  await prisma.ceBookingAttempt.create({ data: { clinicId: L.c.id, appointmentId: x.a.id, kind: "create", state: "uncertain" } });
  const y = await agenda(L.c, "Reserva Firme", "2026-10-21T11:00", { ceBookingUuid: "uuid-firme" });
  const rule = await prisma.reminderRule.findUnique({ where: { id: L.generic.id } });
  const sel = await cron.selectReminderCandidates(rule, sp("2026-10-20T08:10"), TZ);
  assert.deepEqual(sel.due.map((a) => a.id), [y.a.id]);
  assert.equal(sel.held.find((h) => h.appointmentId === x.a.id)?.code, "reserva_nao_efetivada_no_ce");
});

test("cobertura: com a AMPLIACAO desligada pela clinica, depois do fim da janela a equipe e avisada UMA vez, com motivo e quantidade; nada e enviado fora da janela", async () => {
  zera();
  const L = await clinica("Conf Cobertura", { sabado: false });
  await prisma.dispatchPolicy.create({ data: { clinicId: L.c.id, kind: "confirmacao", extendEnabled: false } }); // decisao da clinica: sem ampliacao
  const x = await agenda(L.c, "Sem Mensagem", "2026-10-21T10:00");
  await rodar("2026-10-20T09:15"); // a janela (8h-9h) fechou sem nenhuma rodada: WhatsApp/servidor fora
  assert.equal(para(x.p).length, 0, "ampliacao desligada nesta clinica: nada sai fora da janela (outras clinicas do banco de teste seguem as proprias politicas)");
  const logs = await prisma.activityLog.findMany({ where: { clinicId: L.c.id, type: "reminder_gap" } });
  assert.equal(logs.length, 1);
  assert.match(logs[0].description, /1 agendamento\(s\) ainda sem a solicitação/);
  await rodar("2026-10-20T09:30");
  assert.equal((await prisma.activityLog.count({ where: { clinicId: L.c.id, type: "reminder_gap" } })), 1, "uma vez por dia");
  assert.equal(x.a.id.length > 0, true);
});

test("WhatsApp fora no meio da janela: nada e perdido silenciosamente nem duplicado quando volta dentro da janela", async () => {
  zera();
  const L = await clinica("Conf Whatsapp Fora", { sabado: false });
  const x = await agenda(L.c, "Fora Do Ar", "2026-10-21T10:00");
  whatsappOk = false;
  await rodar("2026-10-20T08:10");
  assert.equal(enviados.length, 0);
  whatsappOk = true;
  await prisma.clinic.update({ where: { id: L.c.id }, data: { uazapiDownSince: null, uazapiDownReason: null } });
  // o controle grava updatedAt com o relogio do banco; o teste usa relogio proprio, entao alinha o intervalo entre tentativas
  await prisma.reminderDispatch.updateMany({ where: { clinicId: L.c.id }, data: { updatedAt: sp("2026-10-20T08:11") } });
  await rodar("2026-10-20T08:40");
  await rodar("2026-10-20T08:55");
  assert.equal(para(x.p).length, 1);
});

test("PREVIA do proximo sabado: data explicita, quantidade e motivos; nao grava nem envia", async () => {
  zera();
  const L = await clinica("Conf Previa Sabado");
  await agenda(L.c, "Elegivel Um", "2026-10-24T09:00");
  await agenda(L.c, "Elegivel Dois", "2026-10-24T10:00");
  await agenda(L.c, "Ja Confirmou", "2026-10-24T11:00", { patientConfirmed: true });
  await agenda(L.c, "Cancelada", "2026-10-24T12:00", { status: "cancelled" });
  const pend = await agenda(L.c, "Nao Efetivada", "2026-10-24T13:00");
  await prisma.ceBookingAttempt.create({ data: { clinicId: L.c.id, appointmentId: pend.a.id, kind: "create", state: "pending" } });
  await agenda(L.c, "Remarcada", "2026-10-24T14:00", { scheduleChangedAt: sp("2026-10-20T10:00") });
  const antes = await prisma.reminderSent.count();
  const prev = await controlled.previewConfirmationsFor(L.c.id, { now: sp("2026-10-21T10:00"), diaDaSemana: 6 });
  assert.equal(prev.dataDoAtendimento, "2026-10-24");
  assert.equal(prev.diaDaSemana, "sábado");
  assert.equal(prev.somenteLeitura, true);
  assert.equal(prev.totais.agendamentosNaData, 6);
  assert.equal(prev.totais.elegiveis, 3, "dois + a remarcada");
  assert.equal(prev.totais.canceladosOuEncerrados, 1);
  assert.equal(prev.totais.reservasNaoEfetivadas, 1);
  assert.equal(prev.totais.remarcados, 1);
  assert.equal(prev.porMotivo.ja_confirmou, 1);
  assert.equal(prev.regra.real, true);
  assert.match(prev.avisos.join(" "), /já fechou/, "quarta 10h: a janela de 8h-9h ja fechou");
  assert.equal(enviados.length, 0);
  assert.equal(await prisma.reminderSent.count(), antes);
  // 'proximo sabado' resolvido pelo relogio e pelo fuso: sabado 24/10 e hoje -> o da semana seguinte
  assert.equal(controlled.nextDateOfWeekday(sp("2026-10-21T10:00"), TZ, 6), "2026-10-24");
  assert.equal(controlled.nextDateOfWeekday(sp("2026-10-24T10:00"), TZ, 6), "2026-10-31");
  assert.equal(controlled.nextDateOfWeekday(sp("2026-10-23T23:30"), TZ, 6), "2026-10-24", "23h30 de sexta em SP (sabado em UTC) ainda e sexta");
});

test("EXECUCAO controlada da antecipacao: envia uma vez; o ciclo automatico depois nao repete", async () => {
  zera();
  const L = await clinica("Conf Antecipa");
  const a = await agenda(L.c, "Antecipa Um", "2026-10-31T10:00");
  const b = await agenda(L.c, "Antecipa Dois", "2026-10-31T11:00");
  assert.equal(enviados.length, 0);
  const r = await controlled.executeConfirmationsFor(L.c.id, { data: "2026-10-31", regraId: L.quarta.id, now: () => sp("2026-10-21T11:00"), sleep: async () => undefined });
  assert.equal(r.tentados, 2);
  assert.equal(para(a.p).length, 1);
  assert.equal(para(b.p).length, 1);
  const r2 = await controlled.executeConfirmationsFor(L.c.id, { data: "2026-10-31", regraId: L.quarta.id, now: () => sp("2026-10-21T11:05"), sleep: async () => undefined });
  assert.equal(r2.tentados, 0, "ja atendidas");
  await rodar("2026-10-28T08:10"); // a quarta da semana seguinte: ja recebeu
  assert.equal(enviados.length, 2);
  // regra que nao vale para o dia: recusa
  await assert.rejects(() => controlled.executeConfirmationsFor(L.c.id, { data: "2026-10-30", regraId: L.quarta.id }), /dia da semana/);
});

test("resposta de confirmacao entre quarta e sexta e associada ao agendamento de sabado (mais de 72h de distancia); ambiguidade pede esclarecimento", async () => {
  zera();
  const L = await clinica("Conf Resposta");
  const a = await agenda(L.c, "Resp Ana", "2026-10-24T15:00");
  await rodar("2026-10-21T08:10");
  assert.equal(para(a.p).length, 1);
  const conv = await prisma.conversation.findFirst({ where: { patientId: a.p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Confirmo!", createdAt: sp("2026-10-21T12:00") } });
  const history = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
  const d = await resolvePresence({ clinicId: L.c.id, patient: a.p, history, now: sp("2026-10-21T12:01"), tz: TZ });
  assert.equal(d.kind, "confirm");
  assert.equal(d.option.appointmentId, a.a.id);
  // a mesma pessoa tem outro horario em outro dia que o lembrete NAO citou: continua sem ambiguidade
  // e se o lembrete citou dois dias diferentes, pergunta
  const p2 = await agenda(L.c, "Resp Dois Dias", "2026-10-24T10:00");
  const outro = await prisma.appointment.create({ data: { clinicId: L.c.id, patientId: p2.p.id, procedureId: p2.a.procedureId, scheduledAt: sp("2026-10-23T10:00"), source: "presencial", createdAt: OLD } });
  const conv2 = await prisma.conversation.create({ data: { patientId: p2.p.id } });
  for (const ap of [p2.a, outro]) await prisma.reminderDispatch.create({ data: { clinicId: L.c.id, bookingKey: `appt:${ap.id}`, appointmentId: ap.id, patientId: p2.p.id, ruleId: L.generic.id, kind: ap.id === outro.id ? "dia_seguinte" : "confirmacao_d3", startsAt: ap.scheduledAt, sendDay: "2026-10-21", state: "sent" } });
  await prisma.message.create({ data: { conversationId: conv2.id, role: "user", content: "Confirmo", createdAt: sp("2026-10-22T12:00") } });
  const h2 = await prisma.message.findMany({ where: { conversationId: conv2.id }, orderBy: { createdAt: "asc" } });
  const d2 = await resolvePresence({ clinicId: L.c.id, patient: p2.p, history: h2, now: sp("2026-10-22T12:01"), tz: TZ });
  assert.equal(d2.kind, "ambiguous", "dois horarios em dias diferentes citados: pergunta qual");
});

test("assistente da Lisboa: o plano propoe janelas REAPROVEITADAS, expoe as decisoes, nao aplica sem aprovacao e nao inventa texto", async () => {
  const c = await prisma.clinic.create({ data: { name: "Plano Lisboa", whatsappPhone: "5511900001111", timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}` } });
  const g = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, pauseMinSec: 10, pauseMaxSec: 30, message: TXT_DIA_ANTERIOR } });
  const ch = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 16, sendMinute: 0, sendEndHour: 17, pauseMinSec: 10, pauseMaxSec: 30, message: TXT_COBRANCA, parentRuleId: g.id } });
  const vespera = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 15, sendMinute: 0, sendEndHour: 16, pauseMinSec: 10, pauseMaxSec: 30, message: TXT_VESPERA, active: false } });
  const d0 = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, pauseMinSec: 10, pauseMaxSec: 30, message: TXT_DIA } });
  const plano = await conferirConfirmacoesLisboa(c.id, { agora: sp("2026-10-21T10:00") });
  assert.equal(plano.somentePrevia, true);
  assert.equal(plano.aplicado, false);
  assert.equal((await prisma.reminderRule.findUnique({ where: { id: g.id } })).sendEndHour, 11, "previa nao altera nada");
  assert.equal(plano.prazoHora, 10);
  assert.ok(plano.itens.some((i) => i.acao === "ajustar" && i.regra === g.id && i.para === "08:00-10:00"));
  assert.ok(plano.itens.some((i) => i.acao === "criar" && /SÁBADO/.test(i.descricao)));
  const cod = plano.decisoesPendentes.map((d) => d.codigo);
  assert.ok(cod.includes("confirmar_janela_quarta") && cod.includes("confirmar_janela_sexta") && cod.includes("confirmar_texto_quarta"));
  assert.equal(plano.previaProximoSabado.dataDoAtendimento, "2026-10-24");
  assert.equal(plano.previaProximoSabado.regra.real, false, "ainda e a proposta");
  assert.equal(plano.sabado.lembrete.includes(d0.id), true, "o lembrete de sabado e o do dia cadastrado, janela preservada");
  // aplica: regras de sabado nascem DESLIGADAS; a generica termina as 9h; textos e janelas do lembrete intactos
  const ap = await conferirConfirmacoesLisboa(c.id, { dryRun: false, agora: sp("2026-10-21T10:00") });
  assert.equal(ap.aplicado, true);
  const g2 = await prisma.reminderRule.findUnique({ where: { id: g.id } });
  assert.deepEqual([g2.sendHour, g2.sendEndHour, g2.purpose], [8, 10, "confirmacao"]);
  const d2 = await prisma.reminderRule.findUnique({ where: { id: d0.id } });
  assert.deepEqual([d2.sendHour, d2.sendEndHour, d2.message], [7, 8, TXT_DIA]);
  const sab = await prisma.reminderRule.findMany({ where: { clinicId: c.id, weekdays: "6" } });
  assert.equal(sab.length, 2);
  assert.ok(sab.every((r) => r.active === false));
  assert.match(sab.find((r) => r.dayOffset === 3).message, /\(sábado\)/);
  const sx = sab.find((r) => r.dayOffset === 1);
  assert.equal(sx.purpose, "lembrete", "sexta e LEMBRETE para todos, nao cobranca");
  assert.equal(sx.parentRuleId, null);
  assert.equal(sx.message, TXT_VESPERA, "usa o texto ja cadastrado, sem alteracao");
  assert.equal([sx.sendHour, sx.sendEndHour].join("-"), "15-16");
  assert.equal((await prisma.reminderRule.findUnique({ where: { id: ch.id } })).purpose, "cobranca");
  // idempotente
  const outra = await conferirConfirmacoesLisboa(c.id, { dryRun: false, agora: sp("2026-10-21T10:00") });
  assert.equal(await prisma.reminderRule.count({ where: { clinicId: c.id, weekdays: "6" } }), 2);
  assert.ok(outra.itens.every((i) => i.acao === "manter"));
  // ligar o sabado exige os horarios aprovados
  await assert.rejects(() => conferirConfirmacoesLisboa(c.id, { dryRun: false, ativarSabado: true }), /janelasAprovadas/);
  await conferirConfirmacoesLisboa(c.id, { dryRun: false, ativarSabado: true, janelasAprovadas: { quarta: "08:00-10:00", sexta: "15:00-16:00" } });
  assert.ok((await prisma.reminderRule.findMany({ where: { clinicId: c.id, weekdays: "6" } })).every((r) => r.active));
  // texto sem a marca '(amanhã)': nao inventa
  assert.equal(sabadoTextFrom("Confirme sua presença amanhã."), null);
  assert.equal(sabadoTextFrom("Data: {data} (amanhã)"), "Data: {data} (sábado)");
});

test("isolamento por clinica: regras e agendamentos de outra clinica nao afetam o sabado nem a janela", async () => {
  zera();
  const A = await clinica("Conf Iso A");
  const B = await clinica("Conf Iso B", { sabado: false });
  const a = await agenda(A.c, "Iso A", "2026-10-24T10:00");
  const b = await agenda(B.c, "Iso B", "2026-10-24T10:00");
  await rodar("2026-10-21T08:10");
  assert.equal(para(a.p).length, 1, "A tem regra de quarta para sabado");
  assert.equal(para(b.p).length, 0, "B nao tem: so recebe a generica na sexta");
  await rodar("2026-10-23T08:10");
  assert.equal(para(b.p).length, 1);
  assert.equal(para(a.p).length, 1, "A nao recebe a generica na sexta");
});
