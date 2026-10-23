// REGRA FINAL DE CONFIRMACOES (Lisboa, 22/10/2026) pelo motor GERAL de politica + correcoes do motor de lembretes:
//   7h lembrete do dia | 8h-10h confirmacao da vespera | 17h nova solicitacao so para quem nao confirmou | sabado: quarta 8h-10h, sexta 17h, sabado 7h (lembrete de sexta = PENDENCIA)
//   reposicao nunca manda "amanha" para atendimento de hoje | limites configuraveis | intervalo entre etapas | pedido inicial recuperado na etapa da cobranca | pedido de remarcacao
//   suspende o horario | nova versao (remarcou) invalida a confirmacao | reserva sem procedimento = texto neutro + aviso unico.
// Banco isolado, relogio controlado (processo em UTC, clinica em America/Sao_Paulo), WhatsApp simulado por fetch falso. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-politica-final-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const enviados = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    const b = JSON.parse(init.body);
    enviados.push({ phone: b.number, text: b.text });
  }
  return jsonRes(200, { id: `msg-${enviados.length}`, data: {} });
};

const { prisma } = await import("../dist/db/client.js");
const cron = await import("../dist/reminders/cron.js");
const { planejarPolitica, cronogramaDe } = await import("../dist/reminders/confirmationPolicy.js");
const { LISBOA_POLITICA_CONFIRMACOES } = await import("../dist/maintenance/lisboaPoliticaConfirmacoes.js");
const { confirmationStateFor, markRescheduleRequested, confirmationStateOf } = await import("../dist/reminders/confirmationStatus.js");
const { PLACEHOLDER_PROCEDURE_NAME } = await import("../dist/clinicaexperts/placeholderProcedure.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground().catch(() => undefined);
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
const OLD = sp("2026-10-01T10:00");
let seq = 0;

// textos e janelas como os da Lisboa HOJE (seedLisboa): confirmacao 8h-11h, cobranca 16h-17h, lembrete do dia 7h-8h
const TXT_CONF = "Olá, {primeiro_nome}! ♥️\nPassando para confirmar o seu agendamento conosco:\n\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\n\nPosso confirmar a sua presença?";
const TXT_COB_ANTIGA = "Olá, {primeiro_nome}! Ainda não recebemos a sua confirmação de amanhã ({data} {hora}). Pode confirmar?";
const TXT_DIA_ANTIGO = "Bom dia, {primeiro_nome}! Estamos muito felizes em te receber hoje às {hora} 🥰";

async function clinicaComoLisboa(nome, extra = {}) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}`, ...extra } });
  const base = { clinicId: c.id, pauseMinSec: 0, pauseMaxSec: 0, active: true };
  const conf = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, message: TXT_CONF } });
  const cob = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 16, sendMinute: 0, sendEndHour: 17, message: TXT_COB_ANTIGA, parentRuleId: conf.id } });
  const dia = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, message: TXT_DIA_ANTIGO } });
  return { c, conf, cob, dia };
}
async function agenda(c, nome, quando, extra = {}, procName = "Lavieen") {
  seq++;
  const proc = (await prisma.procedure.findFirst({ where: { clinicId: c.id, name: procName } })) ?? (await prisma.procedure.create({ data: { clinicId: c.id, name: procName, durationMin: 30 } }));
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119666${String(10000 + seq)}` } });
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp(quando), source: "presencial", createdAt: OLD, ...extra } });
  return { p, a };
}
const rodar = (iso) => cron.runReminderCycle({ now: sp(iso) });
const para = (p) => enviados.filter((e) => e.phone === p.phone);
const zera = () => { enviados.length = 0; };

test("planejador: previa da regra final sobre o cadastro atual (nada muda), pendencias explicitas, aprovacao obrigatoria e idempotencia", async () => {
  const { c, conf, cob, dia } = await clinicaComoLisboa("Politica Previa");
  const antes = await prisma.reminderRule.findMany({ where: { clinicId: c.id }, orderBy: { createdAt: "asc" } });
  const p = await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: true });
  assert.equal(p.somentePrevia, true);
  assert.equal(p.aplicado, false);
  const by = (k) => p.itens.find((i) => i.etapa === k);
  assert.equal(by("lembrete_do_dia").acao, "ajustar");
  assert.equal(by("lembrete_do_dia").regra, dia.id);
  assert.equal(by("lembrete_do_dia").para.texto, LISBOA_POLITICA_CONFIRMACOES.etapas[0].texto);
  assert.equal(by("lembrete_do_dia").para.janela, undefined, "7h-8h ja e a janela cadastrada (duracao reaproveitada)");
  assert.equal(by("confirmacao_vespera").acao, "ajustar");
  assert.deepEqual([by("confirmacao_vespera").de.janela, by("confirmacao_vespera").para.janela], ["08:00–11:00", "08:00–10:00"]);
  assert.equal(by("confirmacao_vespera").para.texto, undefined, "o texto aprovado da confirmacao e mantido");
  assert.equal(by("cobranca_vespera").regra, cob.id);
  assert.deepEqual([by("cobranca_vespera").de.janela, by("cobranca_vespera").para.janela], ["16:00–17:00", "17:00–18:00"]);
  assert.equal(by("sabado_confirmacao_quarta").acao, "criar");
  assert.match(by("sabado_confirmacao_quarta").para.texto, /\(sábado\)/);
  assert.doesNotMatch(by("sabado_confirmacao_quarta").para.texto, /amanh/);
  assert.equal(by("sabado_cobranca_sexta").acao, "criar");
  assert.equal(by("sabado_cobranca_sexta").para.janela, "17:00–18:00");
  assert.equal(by("sabado_lembrete_sexta").acao, "pendencia", "hora do lembrete de sexta nao informada: nada e criado");
  assert.equal(by("sabado_lembrete_do_dia").acao, "criar");
  assert.equal(by("sabado_lembrete_do_dia").para.janela, "07:00–08:00");
  assert.ok(p.pendencias.some((x) => x.codigo === "hora_lembrete_sexta"));
  assert.ok(p.pendencias.some((x) => x.codigo === "etapa_sabado_lembrete_sexta"));
  assert.equal(p.limites.pendente.length, 4, "limite noturno, inicio, antecedencia e intervalo nao informados = pendencias (vale o vigente)");
  assert.ok(cronogramaDe(LISBOA_POLITICA_CONFIRMACOES).some((l) => /quarta-feira/.test(l) && /08:00–10:00/.test(l)));
  const depois = await prisma.reminderRule.findMany({ where: { clinicId: c.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(depois, antes, "previa nao altera nada");

  await assert.rejects(() => planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false }), /aprovado=true/);
  const ap = await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true, actorName: "teste" });
  assert.equal(ap.aplicado, true);
  assert.deepEqual(ap.conflitosDepois, [], "nenhuma regra ativa se pisa depois de aplicar");
  const regras = await prisma.reminderRule.findMany({ where: { clinicId: c.id } });
  assert.equal(regras.length, 6, "3 ajustadas + 3 criadas (lembrete de sexta pendente)");
  const confDepois = regras.find((r) => r.id === conf.id);
  assert.equal(confDepois.sendEndHour, 10);
  assert.equal(confDepois.purpose, "confirmacao");
  assert.equal(confDepois.message, TXT_CONF);
  const sexta = regras.find((r) => r.weekdays === "6" && r.parentRuleId);
  const quarta = regras.find((r) => r.weekdays === "6" && r.dayOffset === 3);
  assert.equal(sexta.parentRuleId, quarta.id, "a cobranca de sexta depende do pedido de quarta");
  const de_novo = await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: true });
  assert.deepEqual(de_novo.itens.filter((i) => i.acao !== "manter" && i.acao !== "pendencia"), [], "idempotente: na segunda vez nao ha o que mudar");
});

test("planejador: regra antiga que se sobrepoe vira DESLIGAR (nunca apagar); regra 'N horas antes' que pede confirmacao tambem", async () => {
  const { c } = await clinicaComoLisboa("Politica Conflito");
  const velha = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, message: "Olá {primeiro_nome}, confirma seu horário de amanhã às {hora}?", purpose: "confirmacao", active: true } });
  const p = await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: true });
  const it = p.itens.find((i) => i.regra === velha.id);
  assert.equal(it?.acao, "desativar");
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  const v = await prisma.reminderRule.findUnique({ where: { id: velha.id } });
  assert.equal(v.active, false, "desligada");
  assert.ok(v, "e nao apagada");
});

test("semana simulada com a regra final: 7h do dia, 8h-10h vespera, 17h so quem nao confirmou; sabado: quarta, sexta 17h, sabado 7h (sem generica)", async () => {
  zera();
  const { c } = await clinicaComoLisboa("Politica Semana");
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  // 2026-10-29 = quinta; 2026-10-31 = sabado; 2026-10-28 = quarta; 2026-10-30 = sexta
  const quinta = await agenda(c, "Quinta Silva", "2026-10-29T14:00");
  const sabA = await agenda(c, "Sabado Confirma", "2026-10-31T10:00");
  const sabB = await agenda(c, "Sabado Silencio", "2026-10-31T11:00");

  await rodar("2026-10-28T08:00");
  assert.equal(para(quinta.p).length, 1, "quinta: confirmacao na vespera (quarta 8h)");
  assert.match(para(quinta.p)[0].text, /\(amanhã\)/);
  assert.equal(para(sabA.p).length, 1, "sabado: confirmacao antecipada na quarta");
  assert.match(para(sabA.p)[0].text, /\(sábado\)/);
  assert.doesNotMatch(para(sabA.p)[0].text, /amanh/i);
  assert.equal(para(sabB.p).length, 1);
  await prisma.appointment.update({ where: { id: sabA.a.id }, data: { patientConfirmed: true, confirmedAt: sp("2026-10-28T09:00") } });

  await rodar("2026-10-28T10:15");
  assert.equal(enviados.length, 3, "a janela das 8h-10h fechou; nada novo");
  await rodar("2026-10-28T16:00");
  assert.equal(enviados.length, 3, "16h nao e mais a cobranca (agora 17h)");
  await rodar("2026-10-28T17:00");
  assert.equal(para(quinta.p).length, 2, "17h: quem nao confirmou recebe a nova solicitacao");
  assert.match(para(quinta.p)[1].text, /Ainda não conseguimos confirmar seu atendimento de amanhã, às/);
  assert.equal(para(sabB.p).length, 1, "o sabado nao e cobrado na quarta");

  await rodar("2026-10-29T07:00");
  assert.equal(para(quinta.p).length, 3);
  assert.match(para(quinta.p)[2].text, /^Bom dia, Quinta! 💗 Passando para lembrar do seu atendimento hoje, às /);
  assert.doesNotMatch(para(quinta.p)[2].text, /confirmar/i, "o lembrete das 7h nao pede confirmacao");

  await rodar("2026-10-30T08:00");
  assert.equal(para(sabA.p).length, 1, "sexta 8h: a confirmacao generica NAO vale para sabado (a de quarta substitui)");
  assert.equal(para(sabB.p).length, 1);
  await rodar("2026-10-30T17:00");
  assert.equal(para(sabA.p).length, 1, "quem confirmou na quarta nao e cobrado na sexta");
  assert.equal(para(sabB.p).length, 2, "quem nao confirmou recebe a etapa das 17h de sexta");
  assert.match(para(sabB.p)[1].text, /Ainda não conseguimos confirmar seu atendimento de amanhã/);

  await rodar("2026-10-31T07:00");
  for (const s of [sabA, sabB]) {
    const last = para(s.p).at(-1).text;
    assert.match(last, /Hoje é dia do seu atendimento na Lisboa! ✨ Te esperamos às /, "sabado 7h: texto proprio de sabado (confirmados tambem recebem)");
  }
  assert.equal(para(sabA.p).length, 2);
  assert.ok(!enviados.some((e) => /Passando para lembrar do seu atendimento hoje/.test(e.text) && [sabA.p.phone, sabB.p.phone].includes(e.phone)), "o lembrete generico das 7h nao sai no sabado");
});

test("reposicao: agendado HOJE para hoje nao recebe 'amanha'; agendado depois das 10h para amanha recebe; limite noturno configuravel", async () => {
  zera();
  const { c } = await clinicaComoLisboa("Politica Reposicao");
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  const hoje = await agenda(c, "Hoje Mesmo", "2026-11-03T18:00", { createdAt: sp("2026-11-03T09:00") });
  const amanha = await agenda(c, "Amanha Depois", "2026-11-04T15:00", { createdAt: sp("2026-11-03T11:00") });
  await rodar("2026-11-03T11:30");
  assert.equal(para(hoje.p).length, 0, "atendimento de hoje: nada de pedido de 'amanha'");
  assert.equal(para(amanha.p).length, 1, "reposicao para quem foi agendado depois da janela");
  assert.match(para(amanha.p)[0].text, /\(amanhã\)/);

  const noite = await agenda(c, "Noite Tarde", "2026-11-04T16:00", { createdAt: sp("2026-11-03T18:20") });
  await prisma.dispatchPolicy.create({ data: { clinicId: c.id, kind: "confirmacao", lateEndHour: 18 } });
  await rodar("2026-11-03T18:30");
  assert.equal(para(noite.p).length, 0, "limite noturno da clinica = 18h: nao repoe as 18h30");
  await prisma.dispatchPolicy.update({ where: { clinicId_kind: { clinicId: c.id, kind: "confirmacao" } }, data: { lateEndHour: 20 } });
  await rodar("2026-11-03T18:45");
  assert.equal(para(noite.p).length, 1, "com o limite em 20h, repoe");
});

test("intervalo minimo entre etapas e configuravel; cobranca de quem recebeu a reposicao tarde espera o intervalo", async () => {
  zera();
  const { c } = await clinicaComoLisboa("Politica Intervalo");
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  const x = await agenda(c, "Tarde Silva", "2026-11-05T15:00", { createdAt: sp("2026-11-04T16:40") });
  await rodar("2026-11-04T16:50");
  assert.equal(para(x.p).length, 1, "reposicao 16h50");
  await rodar("2026-11-04T17:00");
  assert.equal(para(x.p).length, 1, "17h: a cobranca nao sai 10 min depois (intervalo padrao 180 min)");
  await prisma.dispatchPolicy.create({ data: { clinicId: c.id, kind: "cobranca", stepMinGapMin: 30 } });
  await rodar("2026-11-04T17:30");
  assert.equal(para(x.p).length, 2, "com intervalo de 30 min configurado, a cobranca sai 40 min depois");
});

test("etapa das 17h: pedido inicial que NUNCA saiu e recuperado com o texto do pedido inicial; incerto nao e reenviado", async () => {
  zera();
  const { c } = await clinicaComoLisboa("Politica Recupera");
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  const nunca = await agenda(c, "Nunca Tentado", "2026-11-06T14:00");
  const incerto = await agenda(c, "Talvez Saiu", "2026-11-06T15:00");
  const falhou = await agenda(c, "Falhou Uma", "2026-11-06T16:00");
  const conf = await prisma.reminderRule.findFirst({ where: { clinicId: c.id, dayOffset: 1, parentRuleId: null, weekdays: null, purpose: "confirmacao" } });
  const row = (a, p, state, attempt) => prisma.reminderDispatch.create({ data: { clinicId: c.id, bookingKey: `appt:${a.id}`, appointmentId: a.id, patientId: p.id, ruleId: conf.id, kind: "dia_seguinte", startsAt: a.scheduledAt, sendDay: "2026-11-05", state, attempt, attemptedAt: sp("2026-11-05T08:30") } });
  await row(incerto.a, incerto.p, "unconfirmed", 1);
  await row(falhou.a, falhou.p, "failed", 1);
  await prisma.$executeRawUnsafe(`UPDATE "ReminderDispatch" SET "updatedAt" = ? WHERE "clinicId" = ?`, sp("2026-11-05T08:30").getTime(), c.id);
  // o job NAO rodou na janela 8h-10h (reinicio): primeira rodada as 17h
  await rodar("2026-11-05T17:00");
  assert.equal(para(nunca.p).length, 1, "recebe o pedido INICIAL (nao a cobranca de algo que nunca recebeu)");
  assert.match(para(nunca.p)[0].text, /Posso confirmar a sua presença\?/);
  assert.doesNotMatch(para(nunca.p)[0].text, /Ainda não conseguimos/);
  assert.equal(para(falhou.p).length, 1, "falha recuperavel (nada saiu) tambem recupera o pedido inicial");
  assert.equal(para(incerto.p).length, 0, "pedido incerto (pode ter saido) nao e reenviado nem cobrado");
  const d = await prisma.reminderDispatch.findFirst({ where: { appointmentId: nunca.a.id, ruleId: conf.id } });
  assert.equal(d.state, "sent");
  assert.match(d.detail ?? "", /recuperacao_do_pedido_inicial/);
  await rodar("2026-11-05T17:30");
  assert.equal(para(nunca.p).length, 1, "a cobranca nao vem logo atras do pedido recuperado");
  const st = await confirmationStateFor(c.id, nunca.a.id);
  assert.equal(st.estado, "nao_respondeu");
  assert.equal((await confirmationStateFor(c.id, incerto.a.id)).estado, "pedido_incerto");
});

test("pedido de remarcacao suspende as mensagens do horario; remarcar = nova versao (confirmacao e pedido zerados)", async () => {
  zera();
  const { c } = await clinicaComoLisboa("Politica Remarca");
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  const x = await agenda(c, "Quer Trocar", "2026-11-10T14:00");
  assert.equal(await markRescheduleRequested(x.a.id, sp("2026-11-08T12:00")), true);
  assert.equal(await markRescheduleRequested(x.a.id, sp("2026-11-08T12:05")), false, "idempotente");
  await rodar("2026-11-09T08:00");
  assert.equal(para(x.p).length, 0, "pediu remarcacao: a confirmacao deste horario nao sai");
  assert.equal((await confirmationStateFor(c.id, x.a.id)).estado, "pediu_remarcacao");
  await prisma.appointment.update({ where: { id: x.a.id }, data: { patientConfirmed: true, confirmedAt: new Date() } });
  await prisma.appointment.update({ where: { id: x.a.id }, data: { scheduledAt: sp("2026-11-11T15:00") } });
  const a2 = await prisma.appointment.findUnique({ where: { id: x.a.id } });
  assert.equal(a2.rescheduleRequestedAt, null, "o pedido de remarcacao era do horario antigo");
  assert.equal(a2.patientConfirmed, false, "a confirmacao era do horario antigo");
  assert.ok(a2.scheduleChangedAt);
  await rodar("2026-11-10T08:00");
  assert.equal(para(x.p).length, 1, "o novo horario recebe a confirmacao");
});

test("reserva SEM procedimento: texto neutro (sem a linha do procedimento) e aviso UNICO a equipe", async () => {
  zera();
  const { c } = await clinicaComoLisboa("Politica Sem Proc", { notifyPhone: "5511900001111" });
  await planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, { dryRun: false, aprovado: true });
  const x = await agenda(c, "Sem Procedimento", "2026-11-12T14:00", {}, PLACEHOLDER_PROCEDURE_NAME);
  await rodar("2026-11-11T08:00");
  assert.equal(para(x.p).length, 1);
  assert.doesNotMatch(para(x.p)[0].text, /Procedimento:/);
  assert.doesNotMatch(para(x.p)[0].text, /Horário sem procedimento/);
  await (await import("../dist/jobs/background.js")).drainBackground().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  const avisos = () => enviados.filter((e) => e.phone === "5511900001111" && /SEM procedimento vinculado/.test(e.text));
  assert.equal(avisos().length, 1, "a equipe e avisada");
  await rodar("2026-11-11T17:00"); // cobranca: mesma reserva
  await rodar("2026-11-12T07:00"); // lembrete do dia
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(avisos().length, 1, "o aviso nao se repete nas outras etapas");
  assert.ok((await prisma.appointment.findUnique({ where: { id: x.a.id } })).missingProcedureAlertAt);
});

test("estado da resposta (puro): cancelou x cancelada x confirmou x nao respondeu x sem pedido; nao responder nunca e cancelar", () => {
  const at = sp("2026-11-20T10:00");
  const base = { status: "confirmed", cancelSource: null, cancelledAt: null, patientConfirmed: false, confirmedAt: null, rescheduleRequestedAt: null, scheduledAt: at };
  const sent = [{ ruleId: "r", kind: "dia_seguinte", state: "sent", attemptedAt: at, updatedAt: at, startsAt: at }];
  assert.equal(confirmationStateOf(base, []).estado, "sem_pedido");
  assert.equal(confirmationStateOf(base, sent).estado, "nao_respondeu");
  assert.equal(confirmationStateOf({ ...base, patientConfirmed: true }, sent).estado, "confirmou");
  assert.equal(confirmationStateOf({ ...base, status: "cancelled", cancelSource: "paciente_whatsapp" }, sent).estado, "cancelou");
  assert.equal(confirmationStateOf({ ...base, status: "cancelled", cancelSource: "ce_apagada" }, sent).estado, "cancelada");
  const old = [{ ...sent[0], startsAt: sp("2026-11-19T10:00") }];
  assert.equal(confirmationStateOf(base, old).estado, "sem_pedido", "pedido do horario ANTIGO nao vale para o novo");
  assert.equal(confirmationStateOf(base, [{ ...sent[0], state: "failed" }]).estado, "pedido_nao_enviado");
});
