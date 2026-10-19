// ATENDIMENTO DE PONTA A PONTA: webhook da UAZAPI -> fila -> gravacao da mensagem -> espera/agrupamento -> geracao (modelo simulado) -> ferramentas ->
// travas -> revisao -> envio (UAZAPI simulada) -> registro do resultado -> retomada. Codigo real entre as etapas; so a rede e simulada.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-integrado-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = []; // o que a UAZAPI aceitou
const mainCalls = []; // chamadas ao modelo da conversa (com ferramentas)
const reviewCalls = [];
let script = []; // respostas do modelo: string = texto; { http: 500 } = falha
let mainDown = false;
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (body.tools) {
      mainCalls.push(body);
      if (mainDown) return jsonRes(500, { error: { message: "modelo fora do ar" } });
      const next = script.shift();
      if (next === undefined) throw new Error("o roteiro do modelo acabou");
      return jsonRes(200, completion(next));
    }
    if (/REVISOR (DE ENVIO|das respostas)/.test(body.messages[0].content)) { reviewCalls.push(body); return jsonRes(200, completion({ decisao: "enviar", confianca: "alta", motivo: "ok" })); }
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { enqueueWebhook, maintainUazapiQueue } = await import("../dist/uazapi/client.js");
const { attendanceHealth } = await import("../dist/crm/attendanceHealth.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const mkClinic = (name, extra = {}) => prisma.clinic.create({
  data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, ...extra },
});
const clinic = await mkClinic("Clinica Integrada");
const loja = await mkClinic("Laleblu Loja", { businessType: "geral" });
const atrasada = await mkClinic("Clinica Com Espera", { replyDelaySeconds: 1 });

let seq = 0;
const novoNumero = () => `551193333${String(1000 + ++seq)}`;
const payload = (phone, text, id = `MSG-${Math.random().toString(36).slice(2)}`) => ({
  EventType: "messages",
  message: { messageid: id, sender_pn: `${phone}@s.whatsapp.net`, senderName: "Maria Teste", fromMe: false, isGroup: false, messageType: "text", text },
});
// A suite inteira roda varios arquivos em paralelo: as esperas sao generosas e os testes de "nao responde" esperam o EVENTO terminar (nao um tempo fixo).
const waitFor = async (cond, ms = 120_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await cond(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };
const settled = (clinicId) => waitFor(async () => (await prisma.uazapiWebhookEvent.count({ where: { clinicId, status: { in: ["pending", "processing"] } } })) === 0);
const reset = () => { posts.length = 0; mainCalls.length = 0; reviewCalls.length = 0; script = []; mainDown = false; };
const eventOf = (clinicId, id) => prisma.uazapiWebhookEvent.findFirst({ where: { clinicId, externalId: { not: "" } }, orderBy: { createdAt: "desc" } });
const convOf = async (clinicId, phone) => {
  const p = await prisma.patient.findFirst({ where: { clinicId, phone } });
  return p ? { patient: p, conv: await prisma.conversation.findFirst({ where: { patientId: p.id } }) } : null;
};

test("do webhook ate o envio: mensagem gravada, uma resposta gerada, revisada, enviada e registrada como 'sent'; evento concluido", async () => {
  reset();
  const phone = novoNumero();
  script = ["Olá, Maria! Sou a Alice. Como posso te ajudar hoje? 😊"];
  assert.equal(await enqueueWebhook(clinic.id, payload(phone, "Oi, tudo bem?")), "queued");
  await waitFor(() => posts.length >= 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "Olá, Maria! Sou a Alice. Como posso te ajudar hoje? 😊");
  assert.ok(await settled(clinic.id));
  assert.equal(posts[0].number, phone);
  const ev = await waitFor(async () => { const e = await prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id, status: "done" } }); return e; });
  assert.ok(ev, "evento concluido");
  const { conv } = await convOf(clinic.id, phone);
  const msgs = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(msgs.map((m) => [m.role, m.deliveryStatus]), [["user", null], ["assistant", "sent"]]);
  assert.ok(msgs[0].externalId, "a mensagem da pessoa guarda o id do WhatsApp (nao duplica no reprocessamento)");
  assert.equal(mainCalls.length, 1, "o modelo foi chamado uma vez");
  assert.equal(reviewCalls.length, 1, "a revisao foi chamada uma vez");
  assert.equal(conv.handoffPending, false);
  // o mesmo webhook de novo (reentrega do provedor) e reconhecido e nao gera outra resposta
  const again = await enqueueWebhook(clinic.id, payload(phone, "Oi, tudo bem?", msgs[0].externalId));
  assert.equal(again, "duplicate");
});

test("silencio INTENCIONAL: 'Ok.' depois de a Alice se despedir nao gera resposta, nao chama o modelo e nao e tratado como falha", async () => {
  reset();
  const phone = novoNumero();
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Joana Silencio", phone } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Obrigada pelas informações", createdAt: new Date(Date.now() - 120_000) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Combinado! Qualquer coisa é só me chamar. 💗", deliveryStatus: "sent", createdAt: new Date(Date.now() - 90_000) } });
  await enqueueWebhook(clinic.id, payload(phone, "Ok."));
  const stored = await waitFor(() => prisma.message.findFirst({ where: { conversationId: conv.id, content: "Ok." } }));
  assert.ok(stored, "a mensagem foi gravada");
  assert.ok(await settled(clinic.id), "o evento terminou"); // passa a espera de agrupamento (2,5 s) + geracao
  assert.equal(mainCalls.length, 0);
  assert.equal(posts.length, 0);
  const after = await prisma.conversation.findUnique({ where: { id: conv.id } });
  assert.equal(after.handoffPending, false, "silencio intencional nao vira pendencia");
  assert.equal(await prisma.activityLog.count({ where: { patientId: patient.id, type: "reply_failed" } }), 0);
});

test("atendimento humano assumido: a mensagem e gravada, a Alice nao responde e nada e chamado", async () => {
  reset();
  const phone = novoNumero();
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Rita Equipe", phone } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, humanTakeover: true, staffTouchedAt: new Date() } });
  await enqueueWebhook(clinic.id, payload(phone, "Pode me ajudar com meu horário?"));
  assert.ok(await waitFor(() => prisma.message.findFirst({ where: { conversationId: conv.id, role: "user" } })));
  assert.ok(await settled(clinic.id), "o evento terminou");
  assert.equal(mainCalls.length, 0);
  assert.equal(posts.length, 0);
});

test("Laleblu (modo loja): atendimento normal, sem agenda, avaliacao nem fluxo de clinica", async () => {
  reset();
  const phone = novoNumero();
  script = ["Temos sim! Qual cor você prefere? Posso te mostrar as opções. 😊"];
  await enqueueWebhook(loja.id, payload(phone, "Vocês têm essa bolsa em outras cores?"));
  await waitFor(() => posts.length >= 1);
  assert.deepEqual(posts.map((p) => p.text), ["Temos sim! Qual cor você prefere? Posso te mostrar as opções. 😊"]);
  const { patient, conv } = await convOf(loja.id, phone);
  assert.equal(conv.handoffPending, false);
  assert.equal(await prisma.appointment.count({ where: { patientId: patient.id } }), 0);
});

test("FALHA DE PROCESSAMENTO: modelo fora do ar -> 3 tentativas, nada e enviado, nenhum sucesso e simulado e a conversa fica SINALIZADA e rastreavel; depois volta a atender", async () => {
  reset();
  mainDown = true;
  const phone = novoNumero();
  await enqueueWebhook(clinic.id, payload(phone, "Quero saber o valor da limpeza de pele"));
  const stored = await waitFor(() => convOf(clinic.id, phone));
  assert.ok(stored, "a mensagem foi gravada mesmo com o modelo fora do ar");
  // 1a tentativa falha; as demais so acontecem depois do intervalo minimo entre tentativas (a manutencao do minuto reprocessa)
  await waitFor(async () => (await prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id, status: "failed" } })) !== null);
  const antes = await prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id, status: "failed" } });
  await maintainUazapiQueue();
  const semEspera = await prisma.uazapiWebhookEvent.findUnique({ where: { id: antes.id } });
  assert.equal(semEspera.attempts, antes.attempts, "ainda dentro do intervalo: nao tenta de novo em seguida");
  for (let i = 0; i < 2; i++) {
    await prisma.uazapiWebhookEvent.updateMany({ where: { clinicId: clinic.id, status: "failed" }, data: { updatedAt: new Date(Date.now() - 2 * 60_000) } });
    await maintainUazapiQueue();
    await waitFor(async () => (await prisma.uazapiWebhookEvent.count({ where: { clinicId: clinic.id, status: "processing" } })) === 0);
  }
  const ev = await waitFor(() => prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id, status: "failed", attempts: { gte: 3 } } }));
  assert.ok(ev, "evento falhou 3 vezes");
  assert.equal(posts.length, 0, "nada saiu");
  const { patient, conv } = await convOf(clinic.id, phone);
  const after = await prisma.conversation.findUnique({ where: { id: conv.id } });
  assert.equal(after.handoffPending, true);
  assert.match(after.handoffReason ?? "", /Alice não conseguiu responder/);
  const log = await prisma.activityLog.findFirst({ where: { patientId: patient.id, type: "reply_failed" } });
  assert.ok(log, "ficou no diario");
  assert.ok(log.description.includes(ev.id), "traz o id do evento");
  assert.ok(log.description.includes(conv.id), "traz o id da conversa");
  assert.match(log.description, /versão 2026-/, "traz a versao da aplicacao");
  assert.ok(!/Quero saber o valor/.test(log.description), "nao despeja o texto da pessoa");
  // o painel mostra o problema (nao so 'conectado')
  const h = await attendanceHealth(clinic.id, new Date(Date.now() + 6 * 60_000));
  assert.equal(h.status, "problema");
  assert.ok(h.falhas.total >= 1);
  assert.ok(h.eventos.falhos >= 1);
  assert.ok(h.motivos.some((m) => /não puderam ser processadas|sem resposta/i.test(m)));
  // recuperavel: o modelo volta e a proxima mensagem da pessoa e atendida normalmente
  mainDown = false;
  script = ["Oi, Maria! A limpeza de pele tem valores a partir da avaliação. Quer que eu veja um horário?"];
  await enqueueWebhook(clinic.id, payload(phone, "Alguém aí?"));
  await waitFor(() => posts.length >= 1);
  assert.equal(posts.length, 1);
});

test("resposta AGRUPADA (clinica com espera): falha ao gerar deixa de ser so log - a conversa fica sinalizada para a equipe", async () => {
  reset();
  mainDown = true;
  const phone = novoNumero();
  await enqueueWebhook(atrasada.id, payload(phone, "Boa tarde, quero agendar"));
  const sinalizada = await waitFor(async () => {
    const s = await convOf(atrasada.id, phone);
    if (!s?.conv) return null;
    const c = await prisma.conversation.findUnique({ where: { id: s.conv.id } });
    return c.handoffPending ? c : null;
  }, 120_000);
  assert.ok(sinalizada, "conversa sinalizada");
  assert.match(sinalizada.handoffReason ?? "", /Alice não conseguiu responder/);
  assert.equal(posts.length, 0);
});

test("saude do atendimento: Alice pausada aparece como pausada; sem problemas aparece ok", async () => {
  reset();
  const limpa = await mkClinic("Clinica Saudavel");
  assert.equal((await attendanceHealth(limpa.id)).status, "ok");
  await prisma.clinic.update({ where: { id: limpa.id }, data: { aliceActive: false } });
  const h = await attendanceHealth(limpa.id);
  assert.equal(h.status, "pausada");
  assert.equal(h.aliceActive, false);
  assert.ok(h.revision.startsWith("2026-"));
});

// ================================================================ NOTA DE SATISFACAO COM A CONVERSA NA MAO DA EQUIPE (item 6 da revisao de 19/10/2026)
// Tres coisas separadas: RECONHECER e REGISTRAR uma resposta valida; PERMISSAO para a Alice responder sozinha; PERMISSAO para mandar Google/indicacao.
// Com atendimento humano ativo so a primeira existe.

const { generateReply } = await import("../dist/ai/alice.js");
const { runNpsCycle } = await import("../dist/reminders/nps.js");
const { runReferralSteps } = await import("../dist/reminders/surveyFlow.js");

const EQUIPE = "5511900002222";
const notaClinic = await mkClinic("Clinica Nota Com Equipe", {
  notifyPhone: EQUIPE, notifyEvents: "human_handoff,automation_failed",
  googleReviewUrl: "https://g.page/r/TESTE-DE-NOTA/review", googleReviewConfirmedAt: new Date(), googleReviewConfirmedBy: "teste", googleReviewPlace: "Clinica de Teste", // link CONFIRMADO: mesmo assim nao vai com a equipe na conversa
});
await prisma.resumeFlowConfig.create({ data: { clinicId: notaClinic.id, flow: "indicacao", enabled: true, message: "Se tiver uma amiga, compartilhe o nosso contato. 💗", delayMinutes: 1 } });

async function pesquisaComEquipe(nome, { humanTakeover = true, equipeFalouDepois = null } = {}) {
  const phone = novoNumero();
  const patient = await prisma.patient.create({ data: { clinicId: notaClinic.id, name: nome, phone } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, status: "active", humanTakeover, staffTouchedAt: humanTakeover ? new Date() : null } });
  const asked = new Date(Date.now() - 3_600_000);
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: `Oi ${nome}! Como foi? De 0 a 10, qual nota voce daria?`, authorName: "Pesquisa de satisfação", deliveryStatus: "sent", createdAt: asked } });
  if (equipeFalouDepois) await prisma.message.create({ data: { conversationId: conv.id, role: "human", content: equipeFalouDepois, authorName: "Recepcao", createdAt: new Date(asked.getTime() + 600_000) } });
  const survey = await prisma.satisfactionSurvey.create({ data: { clinicId: notaClinic.id, patientId: patient.id, askedAt: asked } });
  return { phone, patient, conv, survey };
}
const surveyOf = (c) => prisma.satisfactionSurvey.findUnique({ where: { id: c.survey.id } });
const paraAPessoa = (c) => posts.filter((p) => p.number === c.phone);
const settleNota = async () => { await settled(notaClinic.id); await new Promise((r) => setTimeout(r, 300)); };

test("NOTA com atendimento humano ativo: e REGISTRADA (ligada a pesquisa), a Alice NAO responde, NAO manda link do Google nem convite de indicacao, e a conversa continua com a equipe", async () => {
  reset();
  const c = await pesquisaComEquipe("Nina Nota");
  await enqueueWebhook(notaClinic.id, payload(c.phone, "10"));
  await settleNota();
  const s = await surveyOf(c);
  assert.equal(s.score, 10);
  assert.ok(s.answeredAt);
  assert.equal(s.linkState, "atendimento_humano");
  assert.equal(s.reviewLinkSent, false);
  assert.equal(paraAPessoa(c).length, 0, "nada foi escrito para a pessoa");
  assert.equal(mainCalls.length, 0, "o modelo nao foi chamado");
  assert.equal((await prisma.conversation.findUnique({ where: { id: c.conv.id } })).humanTakeover, true, "a conversa continua com a equipe");
  assert.equal(await prisma.message.count({ where: { conversationId: c.conv.id, role: "assistant", createdAt: { gt: s.askedAt }, NOT: { authorName: "Pesquisa de satisfação" } } }), 0, "nenhuma resposta da Alice gravada");
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: c.patient.id, flow: "indicacao" } }), 0, "nenhum convite de indicacao agendado");
  const log = await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, type: "satisfaction_recorded" } });
  assert.ok(log, "ficou no diario");
  assert.match(log.description, /conversa estava com a equipe/);
});

test("NOTA com atendimento humano: webhook REPETIDO nao registra duas vezes nem avisa a equipe duas vezes", async () => {
  reset();
  const c = await pesquisaComEquipe("Duda Duplicada");
  const p = payload(c.phone, "3");
  assert.equal(await enqueueWebhook(notaClinic.id, p), "queued");
  await settleNota();
  const avisos = posts.filter((x) => x.number === EQUIPE && /Avaliação baixa/.test(x.text)).length;
  assert.equal(avisos, 1, "nota baixa: a equipe foi avisada uma vez");
  assert.equal(await enqueueWebhook(notaClinic.id, p), "duplicate");
  await settleNota();
  assert.equal(posts.filter((x) => x.number === EQUIPE && /Avaliação baixa/.test(x.text)).length, 1);
  assert.equal(await prisma.satisfactionSurvey.count({ where: { patientId: c.patient.id, answeredAt: { not: null } } }), 1);
  // e o reprocessamento do MESMO evento depois de uma queda (a mensagem ja gravada) tambem e idempotente
  const msg = await prisma.message.findFirst({ where: { conversationId: c.conv.id, role: "user" } });
  await prisma.uazapiWebhookEvent.create({ data: { clinicId: notaClinic.id, externalId: `reproc-${Date.now()}`, payload: JSON.stringify(payload(c.phone, "3", msg.externalId)) } });
  await maintainUazapiQueue();
  await settleNota();
  assert.equal(await prisma.satisfactionSurvey.count({ where: { patientId: c.patient.id, answeredAt: { not: null } } }), 1);
  assert.equal(paraAPessoa(c).length, 0);
});

test("NOTA com atendimento humano: numero que representa HORARIO (a equipe perguntou o horario) ou que traz marca de horario NAO vira nota", async () => {
  reset();
  const c = await pesquisaComEquipe("Hora Horario", { equipeFalouDepois: "Oi! Qual horário fica melhor para o seu retorno?" });
  await enqueueWebhook(notaClinic.id, payload(c.phone, "10")); // responde ao horario que a EQUIPE perguntou
  await settleNota();
  assert.equal((await surveyOf(c)).answeredAt, null, "a ultima fala foi da equipe e nao da pesquisa: numero solto e ambiguo");
  await enqueueWebhook(notaClinic.id, payload(c.phone, "pode ser as 10"));
  await settleNota();
  await enqueueWebhook(notaClinic.id, payload(c.phone, "10h"));
  await settleNota();
  assert.equal((await surveyOf(c)).answeredAt, null, "marcas de horario nunca sao nota");
  // mesmo SEM a equipe ter falado: "as 10" e "10h" e "tenho 10 anos" nao sao nota
  const d = await pesquisaComEquipe("Hora Direta");
  for (const t of ["pode ser as 10", "10h", "tenho 10 anos", "dia 10"]) { await enqueueWebhook(notaClinic.id, payload(d.phone, t)); await settleNota(); }
  assert.equal((await surveyOf(d)).answeredAt, null);
  assert.equal(paraAPessoa(c).length + paraAPessoa(d).length, 0, "a Alice continua calada: e conversa da equipe");
  // numero fora de 0-10 nunca e nota
  await enqueueWebhook(notaClinic.id, payload(d.phone, "14"));
  await settleNota();
  assert.equal((await surveyOf(d)).answeredAt, null);
});

test("NOTA com atendimento humano e RECLAMACAO: registrada como reclamacao, a equipe e avisada, e nada e escrito para a pessoa (nem link, nem indicacao)", async () => {
  reset();
  const c = await pesquisaComEquipe("Rita Reclama");
  await enqueueWebhook(notaClinic.id, payload(c.phone, "9, mas esperei muito tempo"));
  await settleNota();
  const s = await surveyOf(c);
  assert.equal(s.score, 9);
  assert.equal(s.hasComplaint, true);
  assert.equal(s.linkState, "atendimento_humano");
  assert.ok(posts.some((x) => x.number === EQUIPE && /reclamação/.test(x.text) && /NÃO mandou o link do Google/.test(x.text)), "a equipe foi avisada da reclamacao");
  assert.equal(paraAPessoa(c).length, 0);
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: c.patient.id, flow: "indicacao" } }), 0);
});

test("LIBERACAO da pausa depois da nota: nenhuma mensagem que perdeu a pertinencia sai (agradecimento, Google, indicacao, nova pesquisa); a proxima fala da pessoa segue normal", async () => {
  reset();
  const c = await pesquisaComEquipe("Lia Liberada");
  await enqueueWebhook(notaClinic.id, payload(c.phone, "10"));
  await settleNota();
  assert.equal((await surveyOf(c)).score, 10);
  // a equipe libera a conversa para a Alice
  await prisma.conversation.update({ where: { id: c.conv.id }, data: { humanTakeover: false, staffTouchedAt: new Date(Date.now() - 5 * 3_600_000) } });
  const antes = posts.length;
  // 1) a Alice e acionada para a conversa (retorno da pausa): a nota ja tratada da silencio, nao agradece nem cita Google
  script = [];
  const r = await generateReply(c.conv.id);
  assert.equal(r, "", "silencio: o agradecimento a uma nota que a equipe ja viu perdeu a pertinencia");
  assert.equal(mainCalls.length, 0);
  // 2) os jobs de pesquisa e de indicacao (com o relogio adiantado) nao produzem nada para ela
  await runNpsCycle();
  await runReferralSteps({ now: new Date(Date.now() + 2 * 3_600_000), sleep: async () => undefined, clinicId: notaClinic.id });
  await maintainUazapiQueue();
  assert.equal(posts.length, antes, "nenhum envio automatico apos a liberacao");
  assert.equal(await prisma.satisfactionSurvey.count({ where: { patientId: c.patient.id } }), 1, "nenhuma pesquisa nova");
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: c.patient.id, flow: "indicacao" } }), 0);
  // 3) a pessoa volta a falar: atendimento normal (nao responde a nota antiga nem repete pesquisa/Google)
  script = ["Claro! Posso ajudar com o quê? 💗"];
  await enqueueWebhook(notaClinic.id, payload(c.phone, "Oi, queria saber de um horario"));
  await waitFor(() => paraAPessoa(c).length >= 1);
  const textos = paraAPessoa(c).map((x) => x.text).join(" | ");
  assert.doesNotMatch(textos, /avalia[çc][ãa]o no Google|g\.page|nota|amiga/i, textos);
});

test("sem pesquisa pendente a Alice nao inventa nota: numero solto com a conversa na equipe e so mensagem da pessoa", async () => {
  reset();
  const phone = novoNumero();
  const patient = await prisma.patient.create({ data: { clinicId: notaClinic.id, name: "Sem Pesquisa", phone } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, status: "active", humanTakeover: true, staffTouchedAt: new Date() } });
  await enqueueWebhook(notaClinic.id, payload(phone, "10"));
  await settleNota();
  assert.equal(await prisma.satisfactionSurvey.count({ where: { patientId: patient.id } }), 0);
  assert.equal(posts.filter((p) => p.number === phone).length, 0);
  assert.equal(await prisma.message.count({ where: { conversationId: conv.id, role: "user" } }), 1, "a mensagem da pessoa foi gravada para a equipe ver");
});
