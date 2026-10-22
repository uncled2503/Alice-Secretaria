// DISPAROS (21/10/2026), parte 1 - ENVIO: telefones, fallback do 9, erro funcional com HTTP 200, ampliacao autorizada da janela, aniversarios, estado de entrega.
// Banco isolado, relogio controlado (clinica = America/Sao_Paulo), provedor de WhatsApp simulado. Nenhuma mensagem real, nenhuma chamada paga.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-disparos-envio-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = []; // { number, text, token }
let mid = 0;
let behavior = null; // (req) => { status, body } | Error
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
  return jsonRes(404, {});
};

const { prisma } = await import("../dist/db/client.js");
const phone = await import("../dist/uazapi/phone.js");
const client = await import("../dist/uazapi/client.js");
const registry = await import("../dist/uazapi/phoneRegistry.js");
const cron = await import("../dist/reminders/cron.js");
const policyMod = await import("../dist/dispatch/policy.js");
const delivery = await import("../dist/dispatch/delivery.js");
const bday = await import("../dist/reminders/birthday.js");

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

async function clinica(nome) {
  return prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}-${++seq}` } });
}
const TXT = "Olá, {primeiro_nome}!\nPassando para confirmar o seu agendamento:\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n\nPosso confirmar a sua presença?";
async function regraConfirmacao(c, extra = {}) {
  return prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 9, message: TXT, purpose: "confirmacao", pauseMinSec: 0, pauseMaxSec: 0, active: true, ...extra } });
}
async function agenda(c, nome, quando, { phoneNumber } = {}) {
  seq++;
  const proc = (await prisma.procedure.findFirst({ where: { clinicId: c.id } })) ?? (await prisma.procedure.create({ data: { clinicId: c.id, name: "Lavieen", durationMin: 30 } }));
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: phoneNumber ?? `55119777${String(10000 + seq)}` } });
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp(quando), source: "presencial", createdAt: OLD } });
  return { p, a };
}
const rodar = (iso) => cron.runReminderCycle({ now: sp(iso) });

// ============================================================ TELEFONES
test("TELEFONES: leitura central (DDI com/sem, 9o digito, fixo, internacional, JID, duplicacao so quando inequivoca)", () => {
  const ok = (raw, dest, kind) => { const r = phone.parsePhone(raw); assert.equal(r.valid, true, `${raw}: ${r.invalid}`); assert.equal(r.destination, dest, raw); if (kind) assert.equal(r.kind, kind, raw); return r; };
  ok("11988887777", "5511988887777", "br_mobile");
  ok("5511988887777", "5511988887777", "br_mobile");
  ok("+55 (11) 98888-7777", "5511988887777", "br_mobile");
  ok("0055 11 98888 7777", "5511988887777", "br_mobile");
  ok("011988887777", "5511988887777", "br_mobile");
  ok("1133334444", "551133334444", "br_landline");
  const old = ok("1188887777", "551188887777", "br_mobile"); // celular antigo sem o 9: respeita a forma cadastrada; a com 9 e a alternativa estrutural
  assert.equal(old.alternate, "5511988887777", "alternativa estrutural unica (com o 9)");
  const ddi = ok("+14155552671", "14155552671", "international");
  assert.equal(ddi.alternate, null);
  ok("555511988887777", "5511988887777"); // DDI duplicado: so quando o miolo e um BR valido
  for (const bad of ["", "123", "abc", "5511", "00000000000", "551198888", "119888877778888", "(11) 3333-444"]) assert.equal(phone.parsePhone(bad).valid, false, `invalido: ${bad}`);
  assert.equal(phone.parsePhone("5511988887777@s.whatsapp.net").valid, false, "JID nao e telefone cadastrado");
  assert.equal(phone.parsePhone("11 28887777").kind === "br_landline" || phone.parsePhone("11 28887777").valid === false, true);
  // fixo nunca ganha 9 e nunca tem alternativa
  assert.equal(phone.parsePhone("1133334444").alternate, null);
  // DDD inexistente
  assert.equal(phone.parsePhone("10988887777").valid, false);
  // identidade: nunca funde pelos 8 ultimos digitos; so a forma canonica (com 9) iguala as duas escritas do MESMO celular
  assert.equal(phone.canonicalKey("11988887777"), phone.canonicalKey("551188887777"));
  assert.notEqual(phone.canonicalKey("11988887777"), phone.canonicalKey("21988887777"), "mesmos 8 digitos finais, DDD diferente: pessoas diferentes");
  assert.equal(phone.maskDigits("5511988887777").includes("9888"), false, "mascara nao mostra o numero");
});

// ============================================================ FALLBACK DO 9 / ERRO FUNCIONAL
test("FALLBACK: so apos REJEICAO EXPLICITA do provedor, uma alternativa estrutural, nunca os dois; guarda origem/destino; nunca apos timeout/429/queda", async () => {
  zera();
  const c = await clinica("Fallback");
  const original = "5511988887777"; // com 9; alternativa sem 9 (miolo comeca com 8)
  const alt = "551188887777";
  const send = (txt, n = original) => client.sendText(c.id, n, txt, { kind: "lembrete" });
  const textoLongo = (s) => `Mensagem de teste ${s} para validar o envio com tamanho suficiente.`;

  // 1) rejeicao explicita do primeiro destino -> tenta a alternativa UMA vez e a resolucao fica guardada
  behavior = (r) => (r.number === original ? { status: 400, body: { error: "number is not on WhatsApp" } } : null);
  assert.equal(await send(textoLongo("A")), "sent");
  assert.deepEqual(posts.map((p) => p.number), [original, alt]);
  await new Promise((r) => setTimeout(r, 50));
  const res = await prisma.phoneResolution.findFirst({ where: { clinicId: c.id } });
  assert.ok(res, "resolucao validada guardada");
  assert.equal(res.source, "fallback_rejeicao_explicita");
  // 2) a proxima mensagem vai direto ao destino validado (nao repete a tentativa rejeitada)
  zera();
  assert.equal(await send(textoLongo("B")), "sent");
  assert.deepEqual(posts.map((p) => p.number), [alt]);

  // 3) timeout no primeiro destino: NUNCA tenta o outro (o primeiro pode ter saido)
  zera();
  await prisma.phoneResolution.deleteMany({ where: { clinicId: c.id } });
  behavior = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  await assert.rejects(() => send(textoLongo("C")));
  assert.equal(posts.length, 1, "uma unica chamada");
  // 4) 429, 500 e desconexao: idem
  for (const status of [429, 500, 503]) {
    zera();
    behavior = () => ({ status, body: { error: status === 429 ? "rate limit; not on WhatsApp?" : "indisponivel" } });
    await assert.rejects(() => send(textoLongo(`D${status}`)));
    assert.equal(posts.length, 1, `HTTP ${status}: sem segunda tentativa`);
  }
  // 5) erro funcional com HTTP 200 e SEM id: nao e envio aceito
  zera();
  behavior = () => ({ status: 200, body: { error: "Internal failure while queueing" } });
  await assert.rejects(() => send(textoLongo("E")));
  assert.equal(posts.length, 1);
  // 6) erro funcional com HTTP 200 dizendo explicitamente que o numero nao esta no WhatsApp: vale como rejeicao explicita
  zera();
  behavior = (r) => (r.number === original ? { status: 200, body: { error: "number not on whatsapp" } } : null);
  assert.equal(await send(textoLongo("F")), "sent");
  assert.deepEqual(posts.map((p) => p.number), [original, alt]);
  // 7) HTTP 200 COM id e um campo solto "error": envio aceito (o id manda)
  zera();
  await prisma.phoneResolution.deleteMany({ where: { clinicId: c.id } });
  behavior = () => ({ status: 200, body: { id: "owner:MIDX00001", error: "aviso qualquer" } });
  assert.equal(await send(textoLongo("G")), "sent");
  // 8) celular SEM alternativa estrutural (miolo comeca com 2): rejeicao explicita nao inventa o outro numero
  zera();
  behavior = () => ({ status: 400, body: { error: "not on whatsapp" } });
  await assert.rejects(() => send(textoLongo("H"), "5511922223333"));
  assert.equal(posts.length, 1);
  // 9) numero invalido nas automacoes: nao sai e nao conta como "sem WhatsApp" do provedor
  zera();
  behavior = null;
  await assert.rejects(() => send(textoLongo("I"), "123"), (e) => e.code === "invalid_phone");
  assert.equal(posts.length, 0);
  await registry.clearResolution?.(c.id, original);
});

// ============================================================ AMPLIACAO AUTORIZADA DA JANELA
test("AMPLIACAO: so com causa operacional, no dia local, ate o limite; chega ao limite = expira; atendimento perto demais nao recebe; politica desligada nao amplia", async () => {
  zera();
  // funcoes puras
  const p = policyMod.effectivePolicy("confirmacao", null);
  const winEnd = sp("2026-10-20T09:00");
  const far = policyMod.extendedDeadline(p, { windowEnd: winEnd, appointmentStart: sp("2026-10-21T14:00"), timeZone: TZ });
  assert.equal(far.getTime(), sp("2026-10-20T15:00").getTime(), "9h + 360 min (menor entre limite 18h, 21h e a antecedencia)");
  const near = policyMod.extendedDeadline(p, { windowEnd: winEnd, appointmentStart: sp("2026-10-20T11:00"), timeZone: TZ });
  assert.equal(near, null, "atendimento 2h depois do fim da janela: sem espaco com a antecedencia minima");
  assert.equal(policyMod.extendedDeadline({ ...p, extendEnabled: false }, { windowEnd: winEnd, appointmentStart: sp("2026-10-21T14:00"), timeZone: TZ }), null);
  const late = policyMod.extendedDeadline({ ...p, extendUntil: "23:00", maxExtendMin: 720 }, { windowEnd: winEnd, appointmentStart: sp("2026-10-23T14:00"), timeZone: TZ });
  assert.equal(late.getTime(), sp("2026-10-20T21:00").getTime(), "teto duro 21h do dia local, mesmo com limite configurado maior");
  assert.equal(policyMod.effectivePolicy("lembrete", { maxPerRun: 999, retryGapMin: 1, maxAttempts: 99 }).maxPerRun, 30);

  // ponta a ponta: o job NAO rodou na janela (nenhuma rodada) -> as 11h a confirmacao de amanha ainda sai, marcada como janela estendida
  const c = await clinica("Ampliacao");
  const rule = await regraConfirmacao(c);
  const a1 = await agenda(c, "Ana Estendida", "2026-10-21T14:00");
  await rodar("2026-10-20T11:00");
  const sent = posts.filter((x) => x.number === a1.p.phone);
  assert.equal(sent.length, 1, "enviada na janela estendida");
  const row = await prisma.reminderDispatch.findFirst({ where: { appointmentId: a1.a.id, ruleId: rule.id } });
  assert.equal(row.state, "sent");
  assert.equal(row.extendedReason, "job_nao_rodou_na_janela");
  assert.ok(row.deadlineAt, "prazo final registrado");
  assert.ok(row.providerId?.startsWith("owner:MID"), "id do provedor guardado");
  assert.equal(row.deliveryState, "accepted", "aceito pelo provedor != entregue");
  assert.ok(row.destination && !row.destination.includes("@"), "destino realmente usado guardado");
  assert.ok(row.attemptedAt, "tentativa registrada antes do provedor");
  await rodar("2026-10-20T11:15");
  assert.equal(posts.filter((x) => x.number === a1.p.phone).length, 1, "a rodada seguinte nao repete");

  // depois do prazo final (15h) nao sai mais; a equipe e avisada de expirado por cobertura (e nada vai de madrugada)
  const c2 = await clinica("Ampliacao Prazo");
  await regraConfirmacao(c2);
  const a2 = await agenda(c2, "Bia Tarde", "2026-10-21T14:00");
  await rodar("2026-10-20T15:10");
  assert.equal(posts.filter((x) => x.number === a2.p.phone).length, 0, "depois do prazo final: expirou, nao envia");
  await rodar("2026-10-20T21:30");
  assert.equal(posts.filter((x) => x.number === a2.p.phone).length, 0, "nunca depois das 21h");

  // politica desligada pela clinica: nada fora da janela
  const c3 = await clinica("Ampliacao Desligada");
  await regraConfirmacao(c3);
  await prisma.dispatchPolicy.create({ data: { clinicId: c3.id, kind: "confirmacao", extendEnabled: false } });
  const a3 = await agenda(c3, "Cris Sem Ampliar", "2026-10-21T14:00");
  await rodar("2026-10-20T11:00");
  assert.equal(posts.filter((x) => x.number === a3.p.phone).length, 0);

  // janela cumprida sem problema (rodadas ok): NAO ha causa para ampliar
  const c4 = await clinica("Ampliacao Sem Causa");
  const r4 = await regraConfirmacao(c4);
  for (const hhmm of ["08:00", "08:15", "08:30", "08:45"]) await prisma.automationRun.create({ data: { job: "lembretes", clinicId: c4.id, startedAt: sp(`2026-10-20T${hhmm}`), finishedAt: sp(`2026-10-20T${hhmm}`), outcome: "ok", reasons: "{}" } });
  const ctx = await policyMod.resolveExtension(r4, "confirmacao", TZ, sp("2026-10-21T14:00"), sp("2026-10-20T11:00"));
  assert.equal(ctx.allowed, false, "janela rodou normalmente: sem causa operacional");
  await prisma.automationRun.create({ data: { job: "lembretes", clinicId: c4.id, startedAt: sp("2026-10-20T08:50"), finishedAt: sp("2026-10-20T08:50"), outcome: "ok", reasons: JSON.stringify({ "adiado:ce_indisponivel": 3 }) } });
  const ctx2 = await policyMod.resolveExtension(r4, "confirmacao", TZ, sp("2026-10-21T14:00"), sp("2026-10-20T11:00"));
  assert.equal(ctx2.allowed, true);
  assert.equal(ctx2.cause, "falhas_ou_capacidade");
});

test("CAPACIDADE: fila maior que as rodadas que restam avisa a equipe UMA vez antes do prazo e uma clinica com falha nao atrasa as outras", async () => {
  zera();
  const ruim = await clinica("Clinica Ruim");
  const boa = await clinica("Clinica Boa");
  await regraConfirmacao(ruim);
  await regraConfirmacao(boa);
  // A: provedor fora do ar so para o token dela
  behavior = (r) => (r.token === ruim.uazapiToken ? { status: 500, body: { error: "fora do ar" } } : null);
  for (let i = 0; i < 4; i++) await agenda(ruim, `Falha ${i}`, "2026-10-21T14:00");
  const b = await agenda(boa, "Boa Pessoa", "2026-10-21T14:00");
  await rodar("2026-10-20T08:10");
  assert.equal(posts.filter((x) => x.number === b.p.phone).length, 1, "a clinica saudavel enviou na mesma rodada");
  assert.equal(await prisma.reminderDispatch.count({ where: { clinicId: ruim.id, state: "failed" } }), 4, "as falhas da outra clinica ficam REGISTRADAS (nao somem)");
  // capacidade: muitas pessoas, poucas rodadas
  const cap = await clinica("Capacidade");
  const rule = await regraConfirmacao(cap);
  for (let i = 0; i < 40; i++) await agenda(cap, `Fila ${i}`, "2026-10-21T14:00");
  await rodar("2026-10-20T08:50");
  await new Promise((r) => setTimeout(r, 100));
  const alerts = await prisma.activityLog.count({ where: { clinicId: cap.id, type: "dispatch_capacity_risk" } });
  assert.equal(alerts, 1, "um aviso de capacidade");
  await rodar("2026-10-20T08:55");
  assert.equal(await prisma.activityLog.count({ where: { clinicId: cap.id, type: "dispatch_capacity_risk" } }), 1, "nao repete o aviso no mesmo dia/regra");
  const sentCount = await prisma.reminderDispatch.count({ where: { clinicId: cap.id, state: "sent" } });
  assert.ok(sentCount > 0 && sentCount <= 60, `envios limitados por rodada: ${sentCount}`);
  void rule;
});

// ============================================================ ANIVERSARIOS
const hojeAs = (h, m = 5) => sp(`2026-10-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const nasc = () => new Date(Date.UTC(1990, 9, 20));
async function bClinica(nome, extra = {}) {
  const c = await clinica(nome);
  const regra = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário, {primeiro_nome}! A equipe te deseja um dia muito especial.", ...extra } });
  return { c, regra };
}
const bPatient = (c, nome, phoneNumber) => prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: phoneNumber ?? `55119666${String(10000 + ++seq)}`, birthDate: nasc() } });

test("ANIVERSARIO: reserva sem chamada ao provedor e liberada; reserva com chamada iniciada e INCERTA e nunca reenviada; erro de uma pessoa nao para as outras", async () => {
  zera();
  const { c, regra } = await bClinica("Aniv Estados");
  const solta = await bPatient(c, "Solta Reserva");
  const incerta = await bPatient(c, "Incerta Chamada");
  const legada = await bPatient(c, "Legada Antiga");
  const ruim = await bPatient(c, "Telefone Ruim", "123");
  const boa = await bPatient(c, "Boa Pessoa");
  const stale = new Date(hojeAs(11).getTime() - 2 * 3_600_000);
  await prisma.birthdaySent.create({ data: { patientId: solta.id, ruleId: regra.id, year: 2026, state: "reserved", attempts: 1, sentAt: stale } }); // v. nova, sem attemptedAt
  await prisma.birthdaySent.create({ data: { patientId: incerta.id, ruleId: regra.id, year: 2026, state: "reserved", attempts: 1, attemptedAt: stale, sentAt: stale } });
  await prisma.birthdaySent.create({ data: { patientId: legada.id, ruleId: regra.id, year: 2026, state: "reserved", sentAt: stale } }); // anterior ao controle (attempts 0)
  await bday.runBirthdayCycle(hojeAs(11), { clinicId: c.id });
  const num = (p) => posts.filter((x) => x.number === p.phone).length;
  assert.equal(num(solta), 1, "reserva abandonada ANTES do provedor: liberada e enviada");
  assert.equal(num(incerta), 0, "chamada iniciada: resultado incerto, NAO reenvia");
  assert.equal(num(legada), 0, "registro antigo: incerto, NAO reenvia");
  assert.equal(num(boa), 1, "o telefone invalido de outra pessoa nao interrompeu");
  assert.equal(num(ruim), 0);
  const st = async (p) => (await prisma.birthdaySent.findFirst({ where: { patientId: p.id } }))?.state ?? null;
  assert.equal(await st(solta), "sent");
  assert.equal(await st(incerta), "unconfirmed");
  assert.equal(await st(legada), "unconfirmed");
  assert.equal(await st(ruim), null, "telefone invalido: nem tentativa; aparece na aba com o motivo");
  const rowSolta = await prisma.birthdaySent.findFirst({ where: { patientId: solta.id } });
  assert.ok(rowSolta.providerId && rowSolta.destination && rowSolta.attemptedAt, "id do provedor, destino e tentativa registrados");
  assert.equal(rowSolta.deliveryState, "accepted");
  // segunda rodada na mesma hora: nada de novo
  const before = posts.length;
  await bday.runBirthdayCycle(hojeAs(12), { clinicId: c.id });
  assert.equal(posts.length, before);
});

test("ANIVERSARIO: falha definitiva so tenta de novo com telefone CORRIGIDO; falha comum tenta de novo no mesmo dia; nao envia no dia seguinte nem apos o limite; duplicidade so com evidencia", async () => {
  zera();
  const { c } = await bClinica("Aniv Retentativa");
  const p = await bPatient(c, "Corrige Telefone", "5511922223333");
  behavior = () => ({ status: 400, body: { error: "not on whatsapp" } });
  await bday.runBirthdayCycle(hojeAs(11), { clinicId: c.id });
  const row = () => prisma.birthdaySent.findFirst({ where: { patientId: p.id } });
  assert.equal((await row()).state, "failed_permanent");
  const n1 = posts.length;
  await bday.runBirthdayCycle(hojeAs(12), { clinicId: c.id });
  assert.equal(posts.length, n1, "mesmo telefone: nao insiste");
  // a equipe corrige o cadastro e o provedor volta a aceitar
  behavior = null;
  await prisma.patient.update({ where: { id: p.id }, data: { phone: "5511988112233" } });
  await bday.runBirthdayCycle(hojeAs(13), { clinicId: c.id });
  assert.equal((await row()).state, "sent", "telefone corrigido libera a nova tentativa no mesmo dia");
  assert.equal(posts[posts.length - 1].number, "5511988112233");

  // falha comum (500): fica visivel, nao consome o ano, tenta de novo depois do intervalo
  const q = await bPatient(c, "Falha Comum");
  behavior = () => ({ status: 500, body: { error: "fora do ar" } });
  await bday.runBirthdayCycle(hojeAs(14), { clinicId: c.id });
  const rq = await prisma.birthdaySent.findFirst({ where: { patientId: q.id } });
  assert.equal(rq.state, "failed");
  assert.ok(rq.nextAttemptAt, "proxima tentativa planejada");
  behavior = null;
  await bday.runBirthdayCycle(hojeAs(14, 6), { clinicId: c.id });
  assert.equal((await prisma.birthdaySent.findFirst({ where: { patientId: q.id } })).state, "failed", "ainda dentro do intervalo entre tentativas");
  await bday.runBirthdayCycle(hojeAs(15, 5), { clinicId: c.id });
  assert.equal((await prisma.birthdaySent.findFirst({ where: { patientId: q.id } })).state, "sent");

  // dia seguinte: o aniversario de ontem nao e recuperado
  const r = await bPatient(c, "Ontem");
  const amanha = new Date(hojeAs(11).getTime() + 24 * 3_600_000);
  const n2 = posts.length;
  await bday.runBirthdayCycle(amanha, { clinicId: c.id });
  assert.equal(posts.filter((x, i) => i >= n2 && x.number === r.phone).length, 0);
  // depois do teto duro (21h) nada sai, mesmo com causa
  await bday.runBirthdayCycle(hojeAs(21, 10), { clinicId: c.id });
  assert.equal(posts.filter((x) => x.number === r.phone).length, 0);

  // duplicidade apontada so pela memoria do processo, SEM a mensagem no chat: nao vira cobertura
  const s = await bPatient(c, "Sem Evidencia");
  const conv = await prisma.conversation.create({ data: { patientId: s.id } });
  void conv;
  const out = await bday.deliverBirthday((await prisma.birthdayRule.findFirst({ where: { clinicId: c.id } })), s, TZ, () => hojeAs(16));
  assert.equal(out.state, "sent");
});

test("ANIVERSARIO: ampliacao do dia so com causa operacional (job nao rodou) e ate o limite; sem causa ou depois de 21h nao envia", async () => {
  zera();
  const { c } = await bClinica("Aniv Ampliacao");
  const p = await bPatient(c, "Atrasada Do Job");
  // 20h05: janela normal fechou; nenhuma rodada no dia = causa
  await bday.runBirthdayCycle(hojeAs(20, 5), { clinicId: c.id });
  assert.equal(posts.filter((x) => x.number === p.phone).length, 1, "job nao rodou durante o dia: parabens ainda sai ate o limite");
  const row = await prisma.birthdaySent.findFirst({ where: { patientId: p.id } });
  assert.match(row.detail ?? "", /janela estendida/);
  // com todas as rodadas do dia registradas e nenhum problema, nao ha causa
  const { c: c2 } = await bClinica("Aniv Sem Causa");
  const q = await bPatient(c2, "Sem Causa");
  for (let h = 10; h < 20; h++) await prisma.automationRun.create({ data: { job: "aniversario", clinicId: c2.id, startedAt: hojeAs(h, 5), finishedAt: hojeAs(h, 5), outcome: "ok", reasons: "{}" } });
  await bday.runBirthdayCycle(hojeAs(20, 5), { clinicId: c2.id });
  assert.equal(posts.filter((x) => x.number === q.phone).length, 0, "sem causa: o dia acabou");
  // o aviso de "ficou sem parabens" existe
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(await prisma.activityLog.findFirst({ where: { clinicId: c2.id, type: "birthday_expired" } }));
  // politica desligada
  const { c: c3 } = await bClinica("Aniv Desligada");
  await prisma.dispatchPolicy.create({ data: { clinicId: c3.id, kind: "aniversario", extendEnabled: false } });
  const t = await bPatient(c3, "Desligada");
  await bday.runBirthdayCycle(hojeAs(20, 5), { clinicId: c3.id });
  assert.equal(posts.filter((x) => x.number === t.phone).length, 0);
});

// ============================================================ ESTADO DE ENTREGA (webhook)
test("ENTREGA: aceito != entregue != lido; estados so avancam, repetem e chegam fora de ordem; 'falhou' depois de aceito nao autoriza reenvio", async () => {
  zera();
  const c = await clinica("Entrega");
  await regraConfirmacao(c);
  const x = await agenda(c, "Entrega Teste", "2026-10-21T14:00");
  await rodar("2026-10-20T08:10");
  const row = () => prisma.reminderDispatch.findFirst({ where: { appointmentId: x.a.id } });
  const r0 = await row();
  assert.equal(r0.deliveryState, "accepted");
  const id = r0.providerId; // "owner:MID......"
  const payload = (status, extra = {}) => ({ EventType: "messages_update", token: c.uazapiToken, data: { id, status, ...extra } });
  assert.equal(await delivery.ingestDeliveryStatus(c.id, payload("Delivered")), "applied");
  assert.equal((await row()).deliveryState, "delivered");
  assert.equal(await delivery.ingestDeliveryStatus(c.id, payload("Read")), "applied");
  assert.equal((await row()).deliveryState, "read");
  await delivery.ingestDeliveryStatus(c.id, payload("Delivered")); // chegou fora de ordem/repetido
  assert.equal((await row()).deliveryState, "read", "nunca regride");
  await delivery.ingestDeliveryStatus(c.id, payload("Failed"));
  assert.equal((await row()).deliveryState, "read", "falha tardia nao desfaz entrega comprovada");
  // id do provedor com formato "dono:id" ou so o id: casa pelo final
  assert.equal(await delivery.ingestDeliveryStatus(c.id, { EventType: "messages_update", data: { messageid: id.split(":")[1], state: "Read" } }), "ignored");
  // evento de OUTRA clinica nunca atualiza esta
  const outra = await clinica("Entrega Outra");
  assert.equal(await delivery.ingestDeliveryStatus(outra.id, payload("Failed")), "ignored");
  // payload que nao e status
  assert.equal(await delivery.ingestDeliveryStatus(c.id, { EventType: "messages", data: { text: "oi" } }), "not_status");
  // "falhou" apos "aceito": registra como entrega_falhou mas o envio continua 'sent' (sem reenvio automatico)
  const y = await agenda(c, "Entrega Falhou", "2026-10-21T15:00");
  await rodar("2026-10-20T08:20");
  const ry = await prisma.reminderDispatch.findFirst({ where: { appointmentId: y.a.id } });
  await delivery.ingestDeliveryStatus(c.id, { EventType: "messages_update", data: { id: ry.providerId, status: "Failed" } });
  const ry2 = await prisma.reminderDispatch.findFirst({ where: { appointmentId: y.a.id } });
  assert.equal(ry2.state, "sent");
  assert.equal(ry2.deliveryState, "failed");
  const n = posts.length;
  await rodar("2026-10-20T08:30");
  assert.equal(posts.length, n, "nada e reenviado depois de aceito");
  // o webhook real entrega o status sem colocar na fila de conversa
  assert.equal(await client.enqueueWebhook(c.id, payload("Delivered")), "status");
});
