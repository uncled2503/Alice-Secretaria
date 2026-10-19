// Atribuicao de anuncios, etiquetas automaticas, classificacao com historico e feedback de qualificacao pra Meta (API de Conversoes para mensagens comerciais).
// Banco SQLite temporario + Meta/Marketing API simuladas por um fetch falso. Nada aqui fala com a Meta de verdade.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-anuncios-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ef".repeat(32);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const att = await import("../dist/ads/attribution.js");
const tagsMod = await import("../dist/ads/tags.js");
const cls = await import("../dist/ads/classification.js");
const msg = await import("../dist/ads/messaging.js");
const sug = await import("../dist/ads/suggest.js");
const { adsPerformance } = await import("../dist/ads/report.js");
const { processMetaEventQueue } = await import("../dist/meta/worker.js");
const { parseWebhookPayload } = await import("../dist/uazapi/client.js");
const { getFunnelStages } = await import("../dist/crm/stages.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

// ---- cenario ----
const clinic = await prisma.clinic.create({ data: { name: "Clinica Anuncios", whatsappPhone: "5511900000005", timezone: "America/Sao_Paulo" } });
const other = await prisma.clinic.create({ data: { name: "Outra Clinica", whatsappPhone: "5511900000006" } });
const proc = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliacao", durationMin: 30 } });
let phoneSeq = 0;
const mk = (clinicId = clinic.id) => prisma.patient.create({ data: { clinicId, name: `Lead ${++phoneSeq}`, phone: `55119900${String(phoneSeq).padStart(5, "0")}` } });
const labelsOf = async (patientId) => (await prisma.patientTag.findMany({ where: { patientId }, select: { tag: { select: { label: true, system: true } } } })).map((t) => t.tag.label).sort();
const REF_A = { sourceId: "120000000000001", sourceType: "ad", ctwaClid: "AfAAAA-clid-A", headline: "Anúncio A", body: "Texto A", sourceUrl: "https://fb.me/abc" };
const REF_N1 = { sourceId: "120000000000101", sourceType: "ad", ctwaClid: "AfNN-clid-1", headline: "Anúncio N1" };
const REF_N2 = { sourceId: "120000000000102", sourceType: "ad", ctwaClid: "AfNN-clid-2", headline: "Anúncio N2" };
const REF_B = { sourceId: "120000000000002", sourceType: "ad", ctwaClid: "AfBBBB-clid-B", headline: "Anúncio B", body: "Texto B", sourceUrl: "https://www.instagram.com/p/xyz" };

let handler = () => new Response("{}", { status: 404 });
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ method: init.method ?? "GET", url: u, body: init.body ? JSON.parse(init.body) : null });
  return handler(u, init);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function configureMessaging(extra = {}) {
  await prisma.metaConfig.upsert({
    where: { clinicId: clinic.id },
    update: { messagingEnabled: true, wabaId: "555000111", messagingDatasetId: "777888999", accessTokenEnc: encryptSecret("token-meta-de-teste"), capiEnabled: false, ...extra },
    create: { clinicId: clinic.id, messagingEnabled: true, wabaId: "555000111", messagingDatasetId: "777888999", accessTokenEnc: encryptSecret("token-meta-de-teste"), ...extra },
  });
}

// ---------------- puros ----------------
test("so e anuncio quando veio o ID do anuncio ou o ID do clique (nada de inferir por palavra-chave ou URL)", () => {
  assert.equal(att.isValidAdReferral({ sourceId: "1" }), true);
  assert.equal(att.isValidAdReferral({ ctwaClid: "x" }), true);
  assert.equal(att.isValidAdReferral({ headline: "Promoção", body: "Olá! Tenho interesse", sourceUrl: "https://instagram.com/p/1" }), false);
  assert.equal(att.isValidAdReferral(undefined), false);
});

test("plataforma so quando a URL deixa claro", () => {
  assert.equal(att.platformFromUrl("https://www.instagram.com/p/abc"), "instagram");
  assert.equal(att.platformFromUrl("https://fb.me/abc"), "facebook");
  assert.equal(att.platformFromUrl("https://facebook.com/x"), "facebook");
  assert.equal(att.platformFromUrl("https://exemplo.com.br"), null);
  assert.equal(att.platformFromUrl(null), null);
});

test("etiquetas: uma de origem, uma de classificacao; Qualificado e Desqualificado nunca juntas", () => {
  const base = { hasAd: true, firstPlatform: null, organicReliable: false, leadClass: null, userMessages: 0, hasAppointment: false, sold: false };
  assert.deepEqual(tagsMod.desiredLabels(base), ["Meta Ads", "Lead Novo"]);
  assert.deepEqual(tagsMod.desiredLabels({ ...base, firstPlatform: "instagram", userMessages: 3 }), ["Meta Ads", "Instagram Ads", "Em Qualificação"]);
  assert.deepEqual(tagsMod.desiredLabels({ ...base, hasAd: false }), ["Origem Não Identificada", "Lead Novo"]);
  assert.deepEqual(tagsMod.desiredLabels({ ...base, hasAd: false, organicReliable: true }), ["WhatsApp Orgânico", "Lead Novo"]);
  const q = tagsMod.desiredLabels({ ...base, leadClass: "qualificado", hasAppointment: true, sold: true });
  assert.deepEqual(q, ["Meta Ads", "Lead Qualificado", "Agendamento Realizado", "Venda Realizada"]);
  const d = tagsMod.desiredLabels({ ...base, leadClass: "desqualificado" });
  assert.ok(d.includes("Lead Desqualificado") && !d.includes("Lead Qualificado") && !d.includes("Lead Novo"));
  assert.equal(new Set(Object.values(tagsMod.TAG_COLORS)).size, Object.keys(tagsMod.TAG_COLORS).length, "cada etiqueta tem cor propria");
});

test("a IA so sugere com motivo comercial que combina; saude, silencio e 'indefinido' nao viram sugestao", () => {
  assert.equal(sug.parseSuggestion('{"status":"qualificado","codigo_motivo":"pediu_agendamento","confianca":"alta"}').reason, "Pediu ou aceitou agendar.");
  assert.equal(sug.parseSuggestion('{"status":"desqualificado","codigo_motivo":"vaga_emprego"}').status, "desqualificado");
  assert.equal(sug.parseSuggestion('{"status":"desqualificado","codigo_motivo":"interesse_real"}'), null, "motivo de qualificado nao desqualifica");
  assert.equal(sug.parseSuggestion('{"status":"desqualificado","codigo_motivo":"outro"}'), null, "sem motivo declarado nao desqualifica (ex.: so demorou a responder)");
  assert.equal(sug.parseSuggestion('{"status":"qualificado","codigo_motivo":"tem diabetes"}'), null, "texto livre/saude nao vale");
  assert.equal(sug.parseSuggestion('{"status":"indefinido","codigo_motivo":"outro"}'), null);
  assert.equal(sug.parseSuggestion("nao e json"), null);
  const prompt = sug.suggestSystem("criterio X");
  assert.match(prompt, /NUNCA use dados de saude/);
  assert.match(prompt, /NUNCA desqualifique porque a pessoa demorou/);
  for (const t of Object.values(sug.REASON_TEXT)) assert.doesNotMatch(t, /saúde|doença|diagn/i);
});

test("evento de mensagens comerciais exatamente como a documentacao: business_messaging, whatsapp, WABA + ctwa_clid, sem dado pessoal", () => {
  const ev = msg.buildMessagingEvent({ eventName: "QualifiedLead", eventId: "msg:QualifiedLead:k", wabaId: "555", ctwaClid: "clid", eventTime: 1700000000 });
  assert.deepEqual(ev, { event_name: "QualifiedLead", event_time: 1700000000, event_id: "msg:QualifiedLead:k", action_source: "business_messaging", messaging_channel: "whatsapp", user_data: { whatsapp_business_account_id: "555", ctwa_clid: "clid" } });
  const p = msg.buildMessagingEvent({ eventName: "Purchase", eventId: "e", wabaId: "1", ctwaClid: "c", value: 350 });
  assert.deepEqual(p.custom_data, { currency: "BRL", value: 350 });
  assert.ok(!msg.MESSAGING_EVENTS.includes("DisqualifiedLead") && !msg.MESSAGING_EVENTS.includes("Schedule"), "nao existem na API de mensagens comerciais");
  assert.equal(msg.messagingEligibility({ messagingEnabled: true, wabaId: "1", messagingDatasetId: "2", accessTokenEnc: "x" }, { ctwaClid: "c" }, "DisqualifiedLead").ok, false);
});

test("o webhook entrega o ID do anuncio, o clique, o titulo e o texto SEPARADOS (nao mistura ID com nome)", () => {
  const body = { EventType: "messages", message: { chatid: "5511999990001@s.whatsapp.net", messageid: "MSG1", sender: "5511999990001@s.whatsapp.net", fromMe: false, content: { text: "Oi, quero saber", referral: { source_id: "123456789", source_type: "ad", ctwa_clid: "AfXYZ", headline: "Drenagem Outubro", body: "Agende já", source_url: "https://fb.me/x", media_type: "image" } } } };
  const [m] = parseWebhookPayload(body);
  assert.ok(m, "a mensagem foi lida");
  assert.equal(m.referral.sourceId, "123456789");
  assert.equal(m.referral.sourceType, "ad");
  assert.equal(m.referral.ctwaClid, "AfXYZ");
  assert.equal(m.referral.headline, "Drenagem Outubro");
  assert.equal(m.referral.body, "Agende já");
  assert.match(m.referral.rawKeys, /source_id/);
});

// ---------------- banco ----------------
test("1 e 2) lead do anuncio A e lead do anuncio B: cada um com a SUA origem, sem misturar", async () => {
  const a = await mk();
  const b = await mk();
  const ra = await att.captureAdReferral({ clinicId: clinic.id, patientId: a.id, externalId: "wamid.A1", referral: REF_A });
  const rb = await att.captureAdReferral({ clinicId: clinic.id, patientId: b.id, externalId: "wamid.B1", referral: REF_B });
  assert.equal(ra.entryKind, "first");
  assert.equal(rb.entryKind, "first");
  const rowA = await prisma.adAttribution.findFirst({ where: { patientId: a.id } });
  const rowB = await prisma.adAttribution.findFirst({ where: { patientId: b.id } });
  assert.deepEqual([rowA.sourceId, rowA.ctwaClid, rowA.headline, rowA.body, rowA.sourceType, rowA.platform], [REF_A.sourceId, REF_A.ctwaClid, "Anúncio A", "Texto A", "ad", "facebook"]);
  assert.deepEqual([rowB.sourceId, rowB.ctwaClid, rowB.platform], [REF_B.sourceId, REF_B.ctwaClid, "instagram"]);
  assert.equal(await prisma.adAttribution.count({ where: { patientId: a.id } }), 1, "A nao ganhou nada do B");
  await tagsMod.syncLeadTags(clinic.id, a.id);
  await tagsMod.syncLeadTags(clinic.id, b.id);
  assert.deepEqual(await labelsOf(a.id), ["Facebook Ads", "Lead Novo", "Meta Ads"]);
  assert.deepEqual(await labelsOf(b.id), ["Instagram Ads", "Lead Novo", "Meta Ads"]);
});

test("10) reprocessar o webhook (mesma mensagem) ou repetir o mesmo clique NAO cria outra entrada", async () => {
  const p = await mk();
  const r1 = await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.R1", referral: REF_A });
  const r2 = await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.R1", referral: REF_A });
  const r3 = await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.R2", referral: REF_A }); // outra mensagem trazendo o mesmo clique
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r3.created, false);
  assert.equal(await prisma.adAttribution.count({ where: { patientId: p.id } }), 1);
});

test("sem ID de anuncio nem de clique nao existe atribuicao (so titulo/URL/texto padrao nao bastam)", async () => {
  const p = await mk();
  assert.equal(await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, referral: { headline: "Promoção de outubro", sourceUrl: "https://instagram.com/p/1" } }), null);
  assert.equal(await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, referral: null }), null);
  assert.equal(await prisma.adAttribution.count({ where: { patientId: p.id } }), 0);
});

test("3) lead organico / sem dados: Origem Nao Identificada (WhatsApp Organico so quando a API oficial entrega o referral)", async () => {
  const p = await mk();
  await tagsMod.syncLeadTags(clinic.id, p.id);
  assert.deepEqual(await labelsOf(p.id), ["Lead Novo", "Origem Não Identificada"]);
  await prisma.metaConfig.upsert({ where: { clinicId: clinic.id }, update: { wabaId: "555000111" }, create: { clinicId: clinic.id, wabaId: "555000111" } });
  await tagsMod.syncLeadTags(clinic.id, p.id);
  assert.deepEqual(await labelsOf(p.id), ["Lead Novo", "WhatsApp Orgânico"]);
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { wabaId: null } });
});

test("4) qualificacao manual: classificacao + historico (quem/quando/motivo) + etiqueta + QualifiedLead na fila (elegivel)", async () => {
  await configureMessaging();
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.Q1", referral: REF_A });
  const r = await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "qualificado", reason: "Pediu horário", reasonCode: "pediu_agendamento", source: "manual", actorName: "Ana (recepção)" });
  assert.equal(r.changed, true);
  const patient = await prisma.patient.findUnique({ where: { id: p.id } });
  assert.equal(patient.leadClass, "qualificado");
  assert.ok(await labelsOf(p.id).then((l) => l.includes("Lead Qualificado") && !l.includes("Lead Desqualificado") && !l.includes("Lead Novo")));
  const hist = await prisma.leadClassification.findMany({ where: { patientId: p.id } });
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0].actorName, hist[0].reason, hist[0].source, hist[0].confirmed], ["Ana (recepção)", "Pediu horário", "manual", true]);
  const ev = await prisma.metaEvent.findFirst({ where: { leadId: p.id, channel: "business_messaging" } });
  assert.equal(ev.status, "pending");
  assert.equal(ev.eventName, "QualifiedLead");
  const payload = JSON.parse(ev.payload);
  assert.deepEqual(payload.user_data, { whatsapp_business_account_id: "555000111", ctwa_clid: REF_A.ctwaClid });
  assert.equal(payload.action_source, "business_messaging");
  assert.ok(!JSON.stringify(payload).includes(patient.phone), "nenhum dado pessoal no evento");
  assert.equal(hist[0].metaStatus, "enfileirado");
  // repetir a mesma classificacao nao duplica nada
  const again = await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "qualificado", reason: "de novo", source: "manual", actorName: "Ana" });
  assert.equal(again.changed, false);
  assert.equal(await prisma.leadClassification.count({ where: { patientId: p.id } }), 1);
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id, channel: "business_messaging" } }), 1);
});

test("6 e 7) desqualificado: so no CRM (nenhum evento pra Meta); mudar de desqualificado pra qualificado mantem o historico e UMA classificacao atual", async () => {
  await configureMessaging();
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.D1", referral: REF_B });
  const d = await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "desqualificado", reason: "Vaga de emprego", reasonCode: "vaga_emprego", source: "manual", actorName: "Ana" });
  assert.equal(d.metaStatus, cls.DISQUALIFIED_NO_EVENT);
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id } }), 0, "nada foi inventado pra Meta");
  let labels = await labelsOf(p.id);
  assert.ok(labels.includes("Lead Desqualificado") && !labels.includes("Lead Qualificado"));

  await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "qualificado", reason: "Voltou pedindo valor", reasonCode: "pediu_orcamento", source: "manual", actorName: "Bia" });
  labels = await labelsOf(p.id);
  assert.ok(labels.includes("Lead Qualificado") && !labels.includes("Lead Desqualificado"), "nunca os dois ao mesmo tempo");
  const view = await cls.leadClassificationView(p.id);
  assert.equal(view.current, "qualificado");
  assert.equal(view.history.length, 2);
  assert.equal(view.history.filter((h) => h.current).length, 1, "so uma e a atual");
  assert.deepEqual(view.history.map((h) => h.status).sort(), ["desqualificado", "qualificado"]);
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id, eventName: "QualifiedLead" } }), 1);
  // qualificado de novo depois de desqualificar OUTRA vez nao reenvia o mesmo evento (mesmo clique)
  await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "desqualificado", reason: "Mudou de ideia", reasonCode: "sem_interesse", source: "manual", actorName: "Bia" });
  const re = await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "qualificado", reason: "Voltou", reasonCode: "interesse_real", source: "manual", actorName: "Bia" });
  assert.equal(re.metaStatus, "ja_enviado");
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id, eventName: "QualifiedLead" } }), 1, "nunca duplica o mesmo evento");
});

test("5) qualificacao automatica: a IA SUGERE (pendente, sem etiqueta e sem evento); so a confirmacao humana aplica", async () => {
  await configureMessaging();
  await prisma.clinic.update({ where: { id: clinic.id }, data: { qualificationAutoApprove: false } });
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.I1", referral: REF_A });
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Oi, quanto custa a drenagem?" } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Posso te ajudar!" } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Quero agendar para sexta" } });
  const call = async () => '{"status":"qualificado","codigo_motivo":"pediu_agendamento","confianca":"alta"}';
  const r = await sug.suggestForLead(clinic.id, p.id, call);
  assert.equal(r.pending, true);
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).leadClass, null, "sugestao nao muda o lead");
  assert.ok(!(await labelsOf(p.id)).includes("Lead Qualificado"));
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id } }), 0, "nada enviado enquanto nao confirmada");
  const pending = await prisma.leadClassification.findFirst({ where: { patientId: p.id, confirmed: false } });
  assert.equal(pending.source, "ia");
  assert.equal(pending.reason, "Pediu ou aceitou agendar.");

  const ok = await cls.confirmClassification(pending.id, "Carla");
  assert.equal(ok.changed, true);
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).leadClass, "qualificado");
  const row = await prisma.leadClassification.findUnique({ where: { id: pending.id } });
  assert.deepEqual([row.confirmed, row.actorName], [true, "Carla"]);
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id, eventName: "QualifiedLead" } }), 1);

  // rejeitar nao muda nada
  const p2 = await mk();
  const conv2 = await prisma.conversation.create({ data: { patientId: p2.id } });
  await prisma.message.createMany({ data: [{ conversationId: conv2.id, role: "user", content: "oi" }, { conversationId: conv2.id, role: "user", content: "tem vaga de emprego?" }] });
  const r2 = await sug.suggestForLead(clinic.id, p2.id, async () => '{"status":"desqualificado","codigo_motivo":"vaga_emprego"}');
  assert.equal(r2.pending, true);
  const pend2 = await prisma.leadClassification.findFirst({ where: { patientId: p2.id, confirmed: false } });
  assert.equal(await cls.rejectClassification(pend2.id, "Carla"), true);
  assert.equal((await prisma.patient.findUnique({ where: { id: p2.id } })).leadClass, null);
  // poucas mensagens = nada a avaliar
  const p3 = await mk();
  assert.equal((await sug.suggestForLead(clinic.id, p3.id, call)).skipped, "poucas mensagens da pessoa para avaliar");
});

test("aprovacao automatica so existe quando a clinica liga de forma explicita, e fica registrada", async () => {
  await configureMessaging();
  await prisma.clinic.update({ where: { id: clinic.id }, data: { qualificationAutoApprove: true } });
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.AA1", referral: REF_B });
  const r = await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "qualificado", reason: "Pediu valor.", reasonCode: "pediu_orcamento", source: "ia", confirmed: false });
  assert.equal(r.changed, true);
  const row = await prisma.leadClassification.findFirst({ where: { patientId: p.id } });
  assert.match(row.actorName, /aprovação automática/);
  await prisma.clinic.update({ where: { id: clinic.id }, data: { qualificationAutoApprove: false } });
});

test("8) o mesmo contato volta por OUTRO anuncio: a primeira origem fica, a atual muda, e a conversao vai com o clique certo", async () => {
  await configureMessaging();
  const p = await mk();
  const first = await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.V1", referral: REF_A, receivedAt: new Date(Date.now() - 5 * 86_400_000) });
  const second = await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.V2", referral: REF_B });
  assert.equal(first.entryKind, "first");
  assert.equal(second.entryKind, "new_ad");
  const rows = await prisma.adAttribution.findMany({ where: { patientId: p.id }, orderBy: { receivedAt: "asc" } });
  assert.deepEqual(rows.map((r) => r.sourceId), [REF_A.sourceId, REF_B.sourceId], "nada foi sobrescrito");
  await cls.classifyLead({ clinicId: clinic.id, patientId: p.id, status: "qualificado", reason: "Pediu valor", reasonCode: "pediu_orcamento", source: "manual", actorName: "Ana" });
  const ev = await prisma.metaEvent.findFirst({ where: { leadId: p.id, eventName: "QualifiedLead" } });
  assert.equal(JSON.parse(ev.payload).user_data.ctwa_clid, REF_B.ctwaClid, "a conversao vai com o clique da conversa atual");
  const c = await prisma.leadClassification.findFirst({ where: { patientId: p.id } });
  assert.equal(c.attributionId, rows[1].id);
});

test("sem clique, sem WABA ou com o envio desligado: o evento fica 'nao elegivel' (registrado), nunca enviado", async () => {
  await configureMessaging();
  // lead sem ctwa_clid
  const semClique = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: semClique.id, externalId: "wamid.NC1", referral: { sourceId: "999" } });
  const o1 = await msg.enqueueMessagingEvent({ clinicId: clinic.id, patientId: semClique.id, eventName: "QualifiedLead", eventKey: "t1" });
  assert.equal(o1.status, "nao_elegivel");
  assert.match(o1.reason, /ctwa_clid/);
  const row = await prisma.metaEvent.findFirst({ where: { leadId: semClique.id } });
  assert.deepEqual([row.status, row.channel], ["skipped", "business_messaging"]);
  // envio desligado
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { messagingEnabled: false } });
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.OFF", referral: REF_A });
  const o2 = await msg.enqueueMessagingEvent({ clinicId: clinic.id, patientId: p.id, eventName: "QualifiedLead", eventKey: "t2" });
  assert.match(o2.reason, /desligado/);
  // quando passa a ser elegivel, reavaliar recoloca na fila
  await configureMessaging();
  const rq = await msg.requeueSkippedMessagingEvents(clinic.id);
  assert.ok(rq.requeued >= 1);
  assert.equal((await prisma.metaEvent.findFirst({ where: { leadId: p.id } })).status, "pending");
  // LGPD
  const lgpd = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: lgpd.id, externalId: "wamid.LG", referral: REF_A });
  await prisma.patient.update({ where: { id: lgpd.id }, data: { optedOut: true } });
  assert.match((await msg.enqueueMessagingEvent({ clinicId: clinic.id, patientId: lgpd.id, eventName: "QualifiedLead", eventKey: "t3" })).reason, /LGPD/);
});

test("9) o envio usa o dataset do WABA e registra a resposta da Meta; falha fica registrada e o evento nao e perdido nem duplicado", async () => {
  await configureMessaging();
  await prisma.metaEvent.updateMany({ where: { status: "pending" }, data: { status: "dead" } }); // limpa a fila dos testes anteriores
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.S1", referral: REF_A });
  await msg.enqueueMessagingEvent({ clinicId: clinic.id, patientId: p.id, eventName: "QualifiedLead", eventKey: "send-1" });

  // falha temporaria da Meta
  calls.length = 0;
  handler = () => json({ error: { message: "Temporarily unavailable", code: 2, fbtrace_id: "T1" } }, 500);
  await processMetaEventQueue();
  let ev = await prisma.metaEvent.findFirst({ where: { leadId: p.id, eventName: "QualifiedLead" } });
  assert.equal(ev.status, "error");
  assert.equal(ev.attempts, 1);
  assert.match(ev.lastError, /HTTP 500/);
  assert.ok(ev.nextAttemptAt > new Date(), "nova tentativa agendada");
  const sent = calls.find((c) => c.method === "POST");
  assert.match(sent.url.pathname, /\/777888999\/events$/, "dataset do WABA, nao o pixel do site");
  assert.equal(sent.body.data[0].action_source, "business_messaging");
  assert.equal(sent.body.data[0].event_id, ev.eventId, "mesmo event_id em toda tentativa");

  // a proxima tentativa da certo
  await prisma.metaEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  handler = () => json({ events_received: 1, fbtrace_id: "OK1" });
  await processMetaEventQueue();
  ev = await prisma.metaEvent.findUnique({ where: { id: ev.id } });
  assert.equal(ev.status, "processed");
  assert.match(ev.metaResponse, /"eventsReceived":1/);
  assert.ok(!ev.metaResponse.includes("token-meta-de-teste"), "o token nunca e gravado");

  // processar a fila de novo NAO reenvia o que ja foi aceito
  calls.length = 0;
  await processMetaEventQueue();
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("Purchase (venda) tambem vai com o clique do anuncio quando a equipe move o card para 'Venda ganha'", async () => {
  await configureMessaging();
  const stages = await getFunnelStages(clinic.id);
  const won = stages.find((s) => s.kind === "ganho");
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { stageWon: won.stageId } });
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.P1", referral: REF_A });
  await cls.afterStageMove({ clinicId: clinic.id, patientId: p.id, newStageId: won.stageId, newStageName: won.label, transitionId: "t-1", actorName: "Ana", saleValue: 480 });
  const ev = await prisma.metaEvent.findFirst({ where: { leadId: p.id, eventName: "Purchase", channel: "business_messaging" } });
  assert.deepEqual(JSON.parse(ev.payload).custom_data, { currency: "BRL", value: 480 });
  // a Alice (IA) movendo o card NAO gera compra
  const q = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: q.id, externalId: "wamid.P2", referral: REF_A });
  await cls.afterStageMove({ clinicId: clinic.id, patientId: q.id, newStageId: won.stageId, newStageName: won.label, transitionId: "t-2", actorName: null, aiDriven: true });
  assert.equal(await prisma.metaEvent.count({ where: { leadId: q.id, eventName: "Purchase" } }), 0);
  // mesma transicao reprocessada = mesmo evento
  await cls.afterStageMove({ clinicId: clinic.id, patientId: p.id, newStageId: won.stageId, newStageName: won.label, transitionId: "t-1", actorName: "Ana", saleValue: 480 });
  assert.equal(await prisma.metaEvent.count({ where: { leadId: p.id, eventName: "Purchase" } }), 1);
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { stageWon: null } });
});

test("mover o card para a etapa mapeada como qualificado/desqualificado classifica (so quando e uma pessoa)", async () => {
  const stages = await getFunnelStages(clinic.id);
  const [sq, sd] = [stages[1], stages[2]];
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { stageQualified: sq.stageId, stageDisqualified: sd.stageId } });
  const p = await mk();
  await cls.afterStageMove({ clinicId: clinic.id, patientId: p.id, newStageId: sq.stageId, newStageName: sq.label, transitionId: "t-q", actorName: "Ana" });
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).leadClass, "qualificado");
  const h = await prisma.leadClassification.findFirst({ where: { patientId: p.id } });
  assert.deepEqual([h.source, h.actorName], ["etapa", "Ana"]);
  await cls.afterStageMove({ clinicId: clinic.id, patientId: p.id, newStageId: sd.stageId, newStageName: sd.label, transitionId: "t-d", actorName: "Ana" });
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).leadClass, "desqualificado");
  const ia = await mk();
  await cls.afterStageMove({ clinicId: clinic.id, patientId: ia.id, newStageId: sq.stageId, newStageName: sq.label, transitionId: "t-ia", actorName: null, aiDriven: true });
  assert.equal((await prisma.patient.findUnique({ where: { id: ia.id } })).leadClass, null, "movimento da IA nao qualifica");
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { stageQualified: null, stageDisqualified: null } });
});

test("etiqueta 'Agendamento Realizado' e 'Venda Realizada' seguem o estado real", async () => {
  const p = await mk();
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date(Date.now() + 86_400_000), source: "whatsapp" } });
  await tagsMod.syncLeadTags(clinic.id, p.id);
  assert.ok((await labelsOf(p.id)).includes("Agendamento Realizado"));
  await prisma.appointment.update({ where: { id: a.id }, data: { status: "cancelled" } });
  await tagsMod.syncLeadTags(clinic.id, p.id);
  assert.ok(!(await labelsOf(p.id)).includes("Agendamento Realizado"));
});

test("as etiquetas da equipe nunca sao tocadas e etiquetas de uma clinica nao vazam pra outra", async () => {
  const p = await mk();
  const mine = await prisma.tag.create({ data: { clinicId: clinic.id, label: "VIP da Ana", color: "#000000" } });
  await prisma.patientTag.create({ data: { patientId: p.id, tagId: mine.id } });
  await tagsMod.syncLeadTags(clinic.id, p.id);
  assert.ok((await labelsOf(p.id)).includes("VIP da Ana"));
  const o = await mk(other.id);
  await tagsMod.syncLeadTags(other.id, o.id);
  const tagOther = await prisma.tag.findMany({ where: { clinicId: other.id }, select: { label: true } });
  assert.ok(tagOther.every((t) => t.label !== "VIP da Ana"));
  assert.equal(await tagsMod.syncLeadTags(clinic.id, o.id), null, "lead de outra clinica nao e processado");
});

// Espera (ate 15 s) a tarefa em segundo plano deixar o estado "pending" do catalogo; o teste continua falhando se o estado final nao for o esperado.
async function catalogoResolvido(clinicId, sourceId) {
  const t0 = Date.now();
  for (;;) {
    const c = await prisma.adCatalog.findUnique({ where: { clinicId_sourceId: { clinicId, sourceId } } });
    if (c && c.status !== "pending") return c;
    if (Date.now() - t0 > 15_000) return c;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("nomes do anuncio: a Marketing API preenche; sem permissao fica o ID e o aviso (e a mensagem nunca e bloqueada)", async () => {
  await configureMessaging();
  const p = await mk();
  handler = (u) => (u.pathname.endsWith(`/${REF_N1.sourceId}`) ? json({ name: "Drenagem - Outubro", adset: { name: "Mulheres 25-45" }, campaign: { name: "Campanha Outubro Rosa" } }) : json({ error: { code: 200, message: "Missing permissions" } }, 403));
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "wamid.N1", referral: REF_N1 });
  await catalogoResolvido(clinic.id, REF_N1.sourceId); // a busca de nomes roda em segundo plano: espera o estado final, nao um tempo fixo (sob carga levou ~1 s)
  const ok = await prisma.adCatalog.findUnique({ where: { clinicId_sourceId: { clinicId: clinic.id, sourceId: REF_N1.sourceId } } });
  assert.deepEqual([ok.status, ok.adName, ok.adsetName, ok.campaignName], ["resolved", "Drenagem - Outubro", "Mulheres 25-45", "Campanha Outubro Rosa"]);

  const q = await mk();
  const entry = await att.captureAdReferral({ clinicId: clinic.id, patientId: q.id, externalId: "wamid.N2", referral: REF_N2 });
  assert.ok(entry, "a mensagem entrou mesmo com a Marketing API recusando");
  await catalogoResolvido(clinic.id, REF_N2.sourceId);
  const bad = await prisma.adCatalog.findUnique({ where: { clinicId_sourceId: { clinicId: clinic.id, sourceId: REF_N2.sourceId } } });
  assert.equal(bad.status, "unavailable");
  assert.match(bad.error, /403/);
  const d = att.describeAd({ sourceId: REF_N2.sourceId, headline: "Anúncio N2" }, bad);
  assert.equal(d.nameStatus, "indisponivel");
  assert.match(d.note, /ainda não identificado/);
  assert.equal(d.adId, REF_N2.sourceId);
  // sem rede: tambem nao quebra
  handler = () => { throw new Error("rede caiu"); };
  const r = await att.resolveAdName(clinic.id, REF_N2.sourceId, { force: true });
  assert.equal(r.ok, false);
});

test("Desempenho dos Anuncios: dados reais por anuncio, com filtros e taxas; sem misturar leads de anuncios diferentes", async () => {
  const c = await prisma.clinic.create({ data: { name: "Clinica Relatorio", whatsappPhone: "5511900000009" } });
  const stages = await getFunnelStages(c.id);
  const won = stages.find((s) => s.kind === "ganho");
  const pr = await prisma.procedure.create({ data: { clinicId: c.id, name: "Av", durationMin: 30 } });
  const mkLead = async (ref, n, extra = {}) => {
    const p = await prisma.patient.create({ data: { clinicId: c.id, name: `R${n}`, phone: `5511977${String(n).padStart(6, "0")}`, ...extra } });
    if (ref) await att.captureAdReferral({ clinicId: c.id, patientId: p.id, externalId: `r-${n}`, referral: { ...ref, ctwaClid: `${ref.ctwaClid}-${n}` } });
    return p;
  };
  await prisma.adCatalog.upsert({ where: { clinicId_sourceId: { clinicId: c.id, sourceId: REF_A.sourceId } }, update: { status: "resolved", adName: "Anuncio A", adsetName: "Conj 1", campaignName: "Camp X" }, create: { clinicId: c.id, sourceId: REF_A.sourceId, status: "resolved", adName: "Anuncio A", adsetName: "Conj 1", campaignName: "Camp X" } });
  // anuncio A: 4 leads (2 qualificados, 1 desqualificado, 2 agendaram, 1 vendeu). anuncio B: 2 leads (0 qualificado, 2 desqualificados)
  const a = [await mkLead(REF_A, 1, { leadClass: "qualificado" }), await mkLead(REF_A, 2, { leadClass: "qualificado", funnelStage: won.stageId }), await mkLead(REF_A, 3, { leadClass: "desqualificado" }), await mkLead(REF_A, 4)];
  const b = [await mkLead(REF_B, 5, { leadClass: "desqualificado" }), await mkLead(REF_B, 6, { leadClass: "desqualificado" })];
  await mkLead(null, 7, { leadClass: "qualificado" }); // organico: fora do relatorio de anuncios
  for (const p of [a[0], a[1]]) await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: pr.id, scheduledAt: new Date(Date.now() + 86_400_000), source: "whatsapp" } });
  await prisma.appointment.create({ data: { clinicId: c.id, patientId: a[3].id, procedureId: pr.id, scheduledAt: new Date(Date.now() + 86_400_000), source: "whatsapp", status: "cancelled" } }); // cancelado nao conta

  const range = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 3_600_000) };
  const rep = await adsPerformance(c.id, range);
  const rowA = rep.rows.find((r) => r.adId === REF_A.sourceId);
  const rowB = rep.rows.find((r) => r.adId === REF_B.sourceId);
  assert.deepEqual([rowA.leads, rowA.qualified, rowA.disqualified, rowA.scheduled, rowA.sold], [4, 2, 1, 2, 1]);
  assert.deepEqual([rowB.leads, rowB.qualified, rowB.disqualified, rowB.scheduled, rowB.sold], [2, 0, 2, 0, 0]);
  assert.deepEqual([rowA.qualifiedRate, rowA.scheduledRate, rowA.soldRate], [50, 50, 25]);
  assert.equal(rowA.label, "Anuncio A");
  assert.equal(rowA.campaignName, "Camp X");
  assert.equal(rowB.nameStatus, "pendente");
  assert.deepEqual(rep.totals, { leads: 6, qualified: 2, disqualified: 3, scheduled: 2, sold: 1 });
  assert.match(rep.criteria, /Não são as conversões atribuídas pela Meta/);
  assert.equal(rep.rows.some((r) => r.leads === 0 && r.qualified > 0), false);
  // filtros
  assert.deepEqual((await adsPerformance(c.id, { ...range, campaign: "Camp X" })).rows.map((r) => r.adId), [REF_A.sourceId]);
  assert.deepEqual((await adsPerformance(c.id, { ...range, adId: REF_B.sourceId })).totals.leads, 2);
  assert.equal((await adsPerformance(c.id, { ...range, status: "qualificado" })).totals.leads, 2);
  assert.equal((await adsPerformance(c.id, { ...range, start: new Date(Date.now() + 86_400_000), end: new Date(Date.now() + 2 * 86_400_000) })).rows.length, 0, "periodo sem entradas");
  // outra clinica nao enxerga nada
  assert.equal((await adsPerformance(clinic.id, { ...range, adId: "nao-existe" })).rows.length, 0);
});

test("a politica de retencao apaga so o que passou do prazo, e apagar o contato apaga a atribuicao", async () => {
  const jobs = await import("../dist/ads/jobs.js");
  const p = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: p.id, externalId: "old-1", referral: REF_A, receivedAt: new Date(Date.now() - (jobs.RETENTION_DAYS + 10) * 86_400_000) });
  const q = await mk();
  await att.captureAdReferral({ clinicId: clinic.id, patientId: q.id, externalId: "new-1", referral: REF_A });
  const n = await jobs.purgeOldAttributions();
  assert.ok(n >= 1);
  assert.equal(await prisma.adAttribution.count({ where: { patientId: p.id } }), 0);
  assert.equal(await prisma.adAttribution.count({ where: { patientId: q.id } }), 1);
  await prisma.patient.delete({ where: { id: q.id } });
  assert.equal(await prisma.adAttribution.count({ where: { patientId: q.id } }), 0, "cascata");
});

test("historico de eventos antigos intacto: o envio 'website' continua usando o pixel e nao muda", async () => {
  await prisma.metaConfig.update({ where: { clinicId: clinic.id }, data: { pixelId: "424242", capiEnabled: true } });
  await prisma.metaEvent.create({ data: { clinicId: clinic.id, eventId: "legacy:1", eventName: "Lead", payload: JSON.stringify({ event_name: "Lead", event_time: 1, event_id: "legacy:1", action_source: "website", user_data: { external_id: ["x"] } }), status: "pending", nextAttemptAt: new Date() } });
  calls.length = 0;
  handler = () => json({ events_received: 1 });
  await processMetaEventQueue();
  const sent = calls.find((c) => c.method === "POST" && c.body?.data?.[0]?.event_id === "legacy:1");
  assert.ok(sent, "o evento do site foi enviado");
  assert.match(sent.url.pathname, /\/424242\/events$/, "evento do site continua indo pro pixel");
  assert.equal(sent.body.data[0].action_source, "website");
  const row = await prisma.metaEvent.findFirst({ where: { eventId: "legacy:1" } });
  assert.deepEqual([row.channel, row.status], ["website", "processed"]);
});

test("ponta a ponta: a PRIMEIRA mensagem do anuncio ja grava a origem, a conversa e as etiquetas; reprocessar nao duplica; outro anuncio vira nova entrada", async () => {
  process.env.OPENAI_API_KEY ||= "teste";
  const { recordIncomingMessage } = await import("../dist/ai/alice.js");
  const phone = "5511966660001";
  const ref = { sourceId: "120000000000201", sourceType: "ad", ctwaClid: "AfE2E-1", headline: "Drenagem", body: "Agende", sourceUrl: "https://instagram.com/p/z" };
  const r1 = await recordIncomingMessage({ clinicId: clinic.id, patientPhone: phone, patientName: "Maria", text: "Olá, vi o anúncio", referral: ref, externalId: "wamid.E2E1" });
  const patient = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId: clinic.id, phone } } });
  const rows = await prisma.adAttribution.findMany({ where: { patientId: patient.id } });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].sourceId, rows[0].ctwaClid, rows[0].conversationId, rows[0].platform, rows[0].entryKind], [ref.sourceId, ref.ctwaClid, r1.conversationId, "instagram", "first"]);
  for (let i = 0; i < 50 && (await labelsOf(patient.id)).length < 3; i++) await new Promise((r) => setTimeout(r, 100)); // etiquetas rodam em segundo plano
  assert.deepEqual(await labelsOf(patient.id), ["Instagram Ads", "Lead Novo", "Meta Ads"]);
  // webhook reprocessado e mensagem seguinte (sem referral): nada novo
  await recordIncomingMessage({ clinicId: clinic.id, patientPhone: phone, patientName: "Maria", text: "Olá, vi o anúncio", referral: ref, externalId: "wamid.E2E1" });
  await recordIncomingMessage({ clinicId: clinic.id, patientPhone: phone, patientName: "Maria", text: "Quanto custa?", externalId: "wamid.E2E2" });
  assert.equal(await prisma.adAttribution.count({ where: { patientId: patient.id } }), 1);
  // volta por outro anuncio
  await recordIncomingMessage({ clinicId: clinic.id, patientPhone: phone, patientName: "Maria", text: "Oi de novo", referral: { ...ref, sourceId: "120000000000202", ctwaClid: "AfE2E-2" }, externalId: "wamid.E2E3" });
  const all = await prisma.adAttribution.findMany({ where: { patientId: patient.id }, orderBy: { receivedAt: "asc" } });
  assert.deepEqual(all.map((a) => [a.sourceId, a.entryKind]), [["120000000000201", "first"], ["120000000000202", "new_ad"]]);
  // lead sem referral: nenhuma atribuicao
  const org = "5511966660002";
  await recordIncomingMessage({ clinicId: clinic.id, patientPhone: org, patientName: "Joana", text: "Oi", externalId: "wamid.E2E4" });
  const po = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId: clinic.id, phone: org } } });
  assert.equal(await prisma.adAttribution.count({ where: { patientId: po.id } }), 0);
});
