// CONFERENCIA E RECUPERACAO CONTROLADA DOS RECONTATOS (Lisboa, 21/10/2026). Banco isolado, relogio controlado, OpenAI e WhatsApp simulados. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-rec-recuperacao-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
let uazapiMode = "ok";
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ recontact: true, reason: "pediu informacao e sumiu", categoria: "outro" }) }, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: 20 } });
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapiMode === "timeout") { const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; }
    posts.push(JSON.parse(init.body).number);
  }
  return jsonRes(200, { id: "msg", data: {} });
};

const { prisma } = await import("../dist/db/client.js");
const { runFollowUpCheck } = await import("../dist/crm/followup.js");
const rec = await import("../dist/crm/followupRecovery.js");

test.after(async () => {
  await (await import("../dist/ai/usageStats.js")).flushUsage();
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
const noSleep = async () => undefined;
const AGORA = sp("2026-10-21T10:00");
let seq = 0;

async function clinica(nome) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}` } });
  const r1 = await prisma.followUpRule.create({ data: { clinicId: c.id, order: 1, name: "4 horas", afterDays: 1, afterMinutes: 240, message: "Oi, {primeiro_nome}! Recontato 1.", repeatMode: "once" } });
  const r2 = await prisma.followUpRule.create({ data: { clinicId: c.id, order: 2, name: "Dia seguinte 8h", afterDays: 1, afterMinutes: 0, nextDayHour: 8, sendWindowStart: 8, sendWindowEnd: 12, message: "Oi, {primeiro_nome}! Recontato 2.", repeatMode: "once" } });
  return { c, r1, r2 };
}
// lead que escreveu em `userAt` e foi respondido 1 min depois (silencio da pessoa)
async function lead(S, nome, userAt, { optedOut = false, humano = false, comHorario = false } = {}) {
  seq++;
  const p = await prisma.patient.create({ data: { clinicId: S.c.id, name: nome, phone: `55119555${String(10000 + seq)}`, interestNote: "limpeza de pele", optedOut } });
  const at = sp(userAt);
  const conv = await prisma.conversation.create({ data: { patientId: p.id, status: "active", lastMessageAt: new Date(at.getTime() + 60_000), humanTakeover: humano } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Quero saber sobre limpeza de pele", createdAt: at } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Claro! Quer ver um horario?", createdAt: new Date(at.getTime() + 60_000), deliveryStatus: "sent" } });
  if (comHorario) {
    const proc = (await prisma.procedure.findFirst({ where: { clinicId: S.c.id } })) ?? (await prisma.procedure.create({ data: { clinicId: S.c.id, name: "Limpeza", durationMin: 30 } }));
    await prisma.appointment.create({ data: { clinicId: S.c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp("2026-10-22T10:00"), source: "presencial" } });
  }
  return { p, conv, userAt: at };
}
const ctl = (S, L, state, extra = {}) => prisma.followUpDispatch.create({
  data: { clinicId: S.c.id, patientId: L.p.id, conversationId: L.conv.id, flow: "recontato", ruleId: S.r1.id, step: 1, cycleKey: String(L.userAt.getTime()), dueAt: new Date(L.userAt.getTime() + 240 * 60_000), state, decidedAt: sp("2026-10-20T13:05"), updatedAt: sp("2026-10-20T13:05"), ...extra },
});
const linha = (f, L, ordem = 1) => f.linhas.find((l) => l.ref === L.p.id && l.regra.ordem === ordem);

test("conferencia: previstos, elegiveis, retidos (com motivo), aceitos x entregues, sem confirmacao, falhos; 'aceito' nunca vira 'entregue' sem evidencia", async () => {
  posts.length = 0;
  const S = await clinica("Rec Conferencia");
  const A = await lead(S, "Ana Sem Registro", "2026-10-20T09:00"); // venceu 13h de ontem, sem linha de controle
  const B = await lead(S, "Bia Aceita Respondeu", "2026-10-20T09:00");
  const C = await lead(S, "Cris Aceita Sem Resposta", "2026-10-20T09:00");
  const D = await lead(S, "Dani Timeout", "2026-10-20T09:00");
  const E = await lead(S, "Edu Falhou", "2026-10-20T09:00");
  const F = await lead(S, "Fabi Vetada", "2026-10-20T09:00");
  const G = await lead(S, "Gabi Pediu Sair", "2026-10-20T09:00", { optedOut: true });
  const H = await lead(S, "Hugo Equipe", "2026-10-20T09:00", { humano: true });
  const I = await lead(S, "Ivo Tem Horario", "2026-10-20T09:00", { comHorario: true });
  await ctl(S, B, "sent");
  await prisma.message.create({ data: { conversationId: B.conv.id, role: "user", content: "Oi, tenho interesse", createdAt: sp("2026-10-20T14:00") } });
  await ctl(S, C, "sent");
  await ctl(S, D, "unconfirmed", { layer: "envio", reason: "tempo esgotado" });
  await ctl(S, E, "failed_permanent", { layer: "envio", reason: "numero recusado" });
  await ctl(S, F, "vetoed", { layer: "revisao_envio", reason: "revisao barrou", temporary: true });

  const f = await rec.conferirRecontatos(S.c.id, { de: "2026-10-20", now: AGORA });
  assert.equal(f.somenteLeitura, true);
  assert.equal(linha(f, A).estado, "elegivel_agora");
  assert.equal(linha(f, A).recuperavel, true);
  assert.equal(linha(f, B).estado, "aceito_pelo_provedor");
  assert.equal(linha(f, B).entregaComprovada, true, "ela respondeu depois");
  assert.equal(linha(f, C).entregaComprovada, false, "aceito pelo provedor NAO e entregue");
  assert.match(linha(f, C).motivo, /NÃO comprovada/);
  assert.equal(linha(f, D).estado, "sem_confirmacao_do_resultado");
  assert.equal(linha(f, E).grupo, "falho");
  assert.equal(linha(f, F).estado, "vetada_temporariamente");
  assert.equal(linha(f, G).grupo, "excluido");
  assert.match(linha(f, G).motivo, /pediu_para_nao_receber/);
  assert.match(linha(f, H).motivo, /atendimento_humano/);
  assert.match(linha(f, I).motivo, /ja_tem_horario/);
  assert.equal(f.totais.aceitosPeloProvedor, 2);
  assert.equal(f.totais.entreguesComprovados, 1);
  assert.equal(f.totais.semConfirmacaoDoResultado, 1);
  assert.equal(f.totais.falhos, 1);
  assert.equal(f.totais.recuperaveisAgora, 1, "so a Ana");
  assert.match(f.avisos.join(" "), /rodada AUTOMÁTICA vai enviá-las sozinha/);
  assert.equal(posts.length, 0, "a conferencia nao envia nada");
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: A.p.id } }), 0, "nem grava controle");
  // 'hoje': o que ainda nao venceu aparece como futuro, nao como falha
  const hoje = await rec.conferirRecontatos(S.c.id, { de: "2026-10-21", now: AGORA });
  assert.ok(hoje.linhas.every((l) => l.estado !== "sem_registro" || l.grupo !== "futuro"));
  // a regra pedida filtra
  const so2 = await rec.conferirRecontatos(S.c.id, { de: "2026-10-21", now: AGORA, regraIds: [S.r2.id] });
  assert.ok(so2.linhas.every((l) => l.regra.ordem === 2));
});

test("recuperacao controlada: envia SO o aprovado; revalida (quem respondeu sai); uma etapa por pessoa; sem duplicar com a rodada automatica", async () => {
  posts.length = 0; uazapiMode = "ok";
  const S = await clinica("Rec Recuperacao");
  const A = await lead(S, "Ana Recupera", "2026-10-20T09:00");
  const B = await lead(S, "Bia Respondeu", "2026-10-20T09:00");
  const C = await lead(S, "Cris Equipe", "2026-10-20T09:00", { humano: true });
  const common = { de: "2026-10-20", now: AGORA, sleep: noSleep };
  assert.equal(posts.length, 0);
  // a previa inclui Ana e Bia; Bia responde ANTES da execucao
  const previa = await rec.conferirRecontatos(S.c.id, { de: "2026-10-20", now: AGORA });
  assert.deepEqual(previa.linhas.filter((l) => l.recuperavel).map((l) => l.ref).sort(), [A.p.id, B.p.id].sort());
  await prisma.message.create({ data: { conversationId: B.conv.id, role: "user", content: "Oi! Ainda tenho interesse", createdAt: sp("2026-10-21T09:50") } });
  const r = await rec.executarRecuperacaoRecontatos(S.c.id, { ...common });
  assert.equal(r.aceitosPeloProvedor, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0], A.p.phone);
  const row = await prisma.followUpDispatch.findFirst({ where: { patientId: A.p.id, step: 1 } });
  assert.equal(row.state, "sent");
  assert.equal(row.runMode, "recuperacao");
  assert.match(row.reason, /aprovada por administrador/);
  assert.equal((await prisma.conversation.findUnique({ where: { id: A.conv.id } })).lastFollowUpOrder, 1);
  // a etapa 2 (dia seguinte 8h, ja vencida hoje) foi ABSORVIDA: nao se acumula
  const s2 = await prisma.followUpDispatch.findFirst({ where: { patientId: A.p.id, step: 2 } });
  assert.equal(s2.state, "expired");
  assert.match(s2.reason, /não se acumulam|nao se acumulam/);
  // segunda execucao: nada de novo. Rodada automatica depois (mesmo 7h adiante): nada de novo para a Ana
  const r2 = await rec.executarRecuperacaoRecontatos(S.c.id, { ...common });
  assert.equal(r2.aprovadas, 0);
  await runFollowUpCheck({ now: sp("2026-10-21T17:30"), sleep: noSleep, clinicId: S.c.id });
  assert.equal(posts.filter((p) => p === A.p.phone).length, 1);
  assert.equal(posts.filter((p) => p === C.p.phone).length, 0, "atendimento humano respeitado");
  assert.equal(posts.filter((p) => p === B.p.phone).length, 0);
});

test("resultado incerto (timeout) nao e reenviado pela recuperacao nem pela rodada automatica", async () => {
  posts.length = 0;
  const S = await clinica("Rec Timeout");
  const A = await lead(S, "Ana Timeout", "2026-10-20T09:00");
  uazapiMode = "timeout";
  const r = await rec.executarRecuperacaoRecontatos(S.c.id, { de: "2026-10-20", now: AGORA, sleep: noSleep });
  uazapiMode = "ok";
  assert.equal(r.semConfirmacao, 1);
  assert.equal(posts.length, 0);
  const again = await rec.executarRecuperacaoRecontatos(S.c.id, { de: "2026-10-20", now: sp("2026-10-21T10:30"), sleep: noSleep });
  assert.equal(again.aprovadas, 0, "a etapa esta consumida como 'sem confirmacao'");
  await runFollowUpCheck({ now: sp("2026-10-21T11:00"), sleep: noSleep, clinicId: S.c.id });
  assert.equal(posts.length, 0);
  const f = await rec.conferirRecontatos(S.c.id, { de: "2026-10-20", now: sp("2026-10-21T11:00") });
  assert.equal(linha(f, A).estado, "sem_confirmacao_do_resultado");
});

test("reinicio: 'reservado' que ficou sem desfecho (processo caiu) vira 'sem confirmacao' e nunca e reenviado; reinicio nao dispara lote", async () => {
  posts.length = 0; uazapiMode = "ok";
  const S = await clinica("Rec Reinicio");
  const A = await lead(S, "Ana Reservada", "2026-10-20T09:00");
  await ctl(S, A, "reserved", { updatedAt: sp("2026-10-21T08:30") });
  await runFollowUpCheck({ now: AGORA, sleep: noSleep, clinicId: S.c.id });
  assert.equal(posts.length, 0);
  assert.equal((await prisma.followUpDispatch.findFirst({ where: { patientId: A.p.id, step: 1 } })).state, "unconfirmed");
  // 12 leads vencidos: uma rodada (como apos um deploy) nunca passa do teto por clinica
  const S2 = await clinica("Rec Lote");
  for (let i = 0; i < 12; i++) await lead(S2, `Lote ${i}`, "2026-10-20T09:00");
  posts.length = 0;
  await runFollowUpCheck({ now: AGORA, sleep: noSleep, clinicId: S2.c.id });
  assert.ok(posts.length <= 8, `teto de 8 por rodada, enviou ${posts.length}`);
});

test("concorrencia: enquanto a recuperacao detem a trava da clinica a rodada automatica NAO mexe nela; trava de outra copia impede a recuperacao", async () => {
  posts.length = 0;
  const S = await clinica("Rec Concorrencia");
  const A = await lead(S, "Ana Trava", "2026-10-20T09:00");
  await prisma.jobLock.create({ data: { name: `recontato-recuperacao:${S.c.id}`, holder: "outra-copia", expiresAt: new Date(AGORA.getTime() + 20 * 60_000) } });
  await runFollowUpCheck({ now: AGORA, sleep: noSleep, clinicId: S.c.id });
  assert.equal(posts.length, 0, "a rodada automatica respeita a recuperacao em andamento");
  await assert.rejects(() => rec.executarRecuperacaoRecontatos(S.c.id, { de: "2026-10-20", now: AGORA, sleep: noSleep }), /em andamento/);
  await prisma.jobLock.deleteMany({ where: { name: `recontato-recuperacao:${S.c.id}` } });
  await runFollowUpCheck({ now: AGORA, sleep: noSleep, clinicId: S.c.id });
  assert.equal(posts.length, 1, "liberada a trava, a rodada normal segue");
  assert.equal(posts[0], A.p.phone);
});

test("isolamento: a recuperacao de uma clinica nao toca a outra e respeita o filtro de regra e o limite", async () => {
  posts.length = 0; uazapiMode = "ok";
  const S1 = await clinica("Rec Iso 1");
  const S2 = await clinica("Rec Iso 2");
  const a = await lead(S1, "Ana Um", "2026-10-20T09:00");
  const b = await lead(S2, "Bia Dois", "2026-10-20T09:00");
  const nenhuma = await rec.executarRecuperacaoRecontatos(S1.c.id, { de: "2026-10-20", now: AGORA, sleep: noSleep, regraIds: [S2.r1.id] });
  assert.equal(nenhuma.aprovadas, 0, "regra de OUTRA clinica nao seleciona ninguem");
  assert.equal(posts.length, 0);
  await rec.executarRecuperacaoRecontatos(S1.c.id, { de: "2026-10-20", now: AGORA, sleep: noSleep });
  assert.deepEqual(posts, [a.p.phone], "so a clinica 1");
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: b.p.id } }), 0, "a clinica 2 nao foi tocada");
});
