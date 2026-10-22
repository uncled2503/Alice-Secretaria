// FLUXOS DA LISBOA (relatos de 19/10/2026): aniversarios, pausa por atendimento humano por TIPO de mensagem, telefones dos leads no resumo diario e a previa das jornadas.
// Banco de verdade (SQLite temporario), OpenAI e provedor de WhatsApp simulados, dados FICTICIOS. Nada e enviado de verdade.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-lisboa-fluxos-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = []; // { token, number, text }
const reviews = [];
let providerMode = "ok"; // ok | http500
let reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (/REVISOR (DE ENVIO|das respostas)/.test(String(body.messages?.[0]?.content))) { reviews.push(body); return jsonRes(200, completion(reviewAnswer(body))); }
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") {
      if (providerMode === "http500") return jsonRes(500, { error: "fora do ar" });
      const b = JSON.parse(init.body);
      posts.push({ token: init.headers?.token, number: b.number, text: b.text });
      return jsonRes(200, { id: "msg" });
    }
    return jsonRes(200, { instance: { status: "connected" }, status: { connected: true } });
  }
  return jsonRes(404, {});
};

const { prisma } = await import("../dist/db/client.js");
const gate = await import("../dist/ai/sendGate.js");
const { runBirthdayCycle, BIRTHDAY_LAST_HOUR } = await import("../dist/reminders/birthday.js");
const { runPostProcedureCycle } = await import("../dist/reminders/postProcedure.js");
const { auditarEnviosLisboa, classificarRegistro } = await import("../dist/maintenance/lisboaAuditoriaEnvios.js");
const { runDailyReport } = await import("../dist/crm/dailyReport.js");
const leadPhones = await import("../dist/crm/leadPhones.js");
const { ajustarJornadasLisboa } = await import("../dist/maintenance/lisboaJornadas.js");
const { zonedWallClockToUtc, wallClockInZone } = await import("../dist/scheduling/time.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
let tokenSeq = 0;
const mkClinic = (name, extra = {}) => prisma.clinic.create({
  data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", active: true, aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${++tokenSeq}`, ...extra },
});
let n = 0;
const phone = () => `5511966${String(30000 + ++n)}`;
const mkPatient = (clinic, extra = {}) => prisma.patient.create({ data: { clinicId: clinic.id, name: `Pessoa ${n + 1}`, phone: phone(), ...extra } });
const today = () => wallClockInZone(new Date(), TZ);
// instante de hoje (dia da clinica) na hora local informada
const hojeAs = (h, min = 0) => { const w = today(); return zonedWallClockToUtc(TZ, w.year, w.month, w.day, h, min); };
const humanSays = async (patient, minutesAgo, content = "Oi, tudo bem? Aqui é a recepção.") => {
  const conv = (await prisma.conversation.findFirst({ where: { patientId: patient.id } })) ?? (await prisma.conversation.create({ data: { patientId: patient.id } }));
  await prisma.message.create({ data: { conversationId: conv.id, role: "human", content, authorName: "Recepção", createdAt: new Date(Date.now() - minutesAgo * 60_000) } });
  return conv;
};
const birthdayOf = () => { const w = today(); return new Date(Date.UTC(1990, w.month - 1, w.day)); };

// ===================================================================== ANIVERSARIOS
test("ANIVERSARIO: o dia e o da clinica; a mensagem espera a hora cadastrada e o fim do dia; sem nome a saudacao e neutra; nao repete", async () => {
  const c = await mkClinic("Clinica Aniversario");
  await prisma.dispatchPolicy.create({ data: { clinicId: c.id, kind: "aniversario", extendEnabled: false } }); // decisao da clinica: sem ampliacao (a ampliacao tem teste proprio)
  const regra = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário, {primeiro_nome}! 🎀 A equipe te deseja um dia especial." } });
  const semNome = await mkPatient(c, { name: null, birthDate: birthdayOf() });
  const naoFaz = await mkPatient(c, { name: "Outra Pessoa", birthDate: new Date(Date.UTC(1990, (today().month % 12), 1)) }); // outro mes
  posts.length = 0;
  await runBirthdayCycle(hojeAs(9, 5), { clinicId: c.id });
  assert.equal(posts.length, 0, "antes da hora cadastrada nao envia");
  await runBirthdayCycle(hojeAs(BIRTHDAY_LAST_HOUR, 5), { clinicId: c.id });
  assert.equal(posts.length, 0, "depois do fim do dia de comunicacao nao envia (perdeu a pertinencia)");
  await runBirthdayCycle(hojeAs(10, 5), { clinicId: c.id });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].number, semNome.phone);
  assert.ok(!/, !|,!|\s!/.test(posts[0].text), `saudacao neutra, sem 'Oi, !': ${posts[0].text}`);
  assert.match(posts[0].text, /^Feliz aniversário!/);
  assert.equal(posts.filter((p) => p.number === naoFaz.phone).length, 0);
  assert.equal(await prisma.birthdaySent.count({ where: { ruleId: regra.id } }), 1);
  await runBirthdayCycle(hojeAs(11, 5), { clinicId: c.id });
  assert.equal(posts.length, 1, "uma vez por ano");
  // o dia seguinte nao recupera quem ficou para tras
  const amanha = new Date(hojeAs(10, 5).getTime() + 24 * 3_600_000);
  const atrasada = await mkPatient(c, { name: "Atrasada", birthDate: birthdayOf() });
  void atrasada; void amanha; // (a hora 'amanha' tem outro dia/mes: a pessoa de hoje ja nao e candidata)
  const antes = posts.length;
  await runBirthdayCycle(amanha, { clinicId: c.id });
  assert.equal(posts.filter((p) => p.number === atrasada.phone).length, 0, "aniversario de ontem nao e recuperado hoje");
  assert.ok(antes >= 1);
});

test("ANIVERSARIO: barrado, adiado ou com falha NAO e gravado como enviado e tenta de novo na proxima hora do mesmo dia; resumo da rodada prova que o job rodou", async () => {
  const c = await mkClinic("Clinica Aniversario Estados");
  const regra = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário, {primeiro_nome}! 🎀" } });
  const p = await mkPatient(c, { name: "Bianca Souza", birthDate: birthdayOf() });
  const sent = () => prisma.birthdaySent.count({ where: { patientId: p.id, ruleId: regra.id, state: { in: ["sent", "unconfirmed", "duplicate"] } } }); // adiado/barrado/falha ficam REGISTRADOS (visiveis na aba Disparos) mas nao contam como enviado
  posts.length = 0;

  // 1) a equipe estava conversando com ela (pausa humana de relacionamento): ADIADO, nao consumido
  await humanSays(p, 10);
  await runBirthdayCycle(hojeAs(11, 5), { clinicId: c.id });
  assert.equal(posts.length, 0);
  assert.equal(await sent(), 0, "pausa humana nao consome o aniversario");

  // 2) a conversa com a equipe acabou. O veredito da revisao vale por tempo para o MESMO contexto; cada cenario abaixo parte de um contexto novo (a pessoa escreveu de novo).
  await prisma.message.updateMany({ where: { role: "human", conversation: { patientId: p.id } }, data: { createdAt: new Date(Date.now() - 3 * 3_600_000) } });
  const conv = await prisma.conversation.findFirst({ where: { patientId: p.id } });
  const novoContexto = () => prisma.message.create({ data: { conversationId: conv.id, role: "user", content: `Oi, obrigada pelo carinho de sempre! ${Math.random()}` } });
  // 3) o provedor falha: nada gravado como enviado
  await novoContexto();
  gate.resetBreakerForTests();
  providerMode = "http500";
  await runBirthdayCycle(hojeAs(12, 5), { clinicId: c.id });
  providerMode = "ok";
  assert.equal(posts.length, 0);
  assert.equal(await sent(), 0, "falha do provedor nao vira 'enviado'");
  // 4) a IA barra com motivo legitimo: nao e gravado como enviado
  await novoContexto();
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "a pessoa reclamou ontem do atendimento", categoria: "reclamacao" });
  await runBirthdayCycle(hojeAs(13, 5), { clinicId: c.id });
  assert.equal(posts.length, 0);
  assert.equal(await sent(), 0, "barrado pela revisao nao vira 'enviado'");
  // 5) contexto novo e tudo normal: sai UMA vez
  await novoContexto();
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
  await runBirthdayCycle(hojeAs(14, 5), { clinicId: c.id });
  assert.equal(posts.length, 1);
  assert.equal(await sent(), 1);
  await runBirthdayCycle(hojeAs(15, 5), { clinicId: c.id });
  assert.equal(posts.length, 1);

  // resumo das rodadas: o job deixou rastro (uma linha por rodada) com os motivos
  const runs = await prisma.automationRun.findMany({ where: { job: "aniversario", clinicId: c.id }, orderBy: { startedAt: "asc" } });
  assert.ok(runs.length >= 5, `rodadas registradas: ${runs.length}`);
  const motivos = runs.map((r) => Object.keys(JSON.parse(r.reasons ?? "{}")).join("|")).join(" ");
  assert.match(motivos, /adiado:equipe_atendendo/);
  assert.match(motivos, /vetado:/);
  assert.match(motivos, /falha:envio_falhou_tentara_de_novo/);
  assert.match(motivos, /enviado:aniversario/);
});

// ===================================================================== PAUSA POR ATENDIMENTO HUMANO, POR TIPO
test("PAUSA HUMANA por tipo: relacionamento espera (retida, nao e veto); mensagem ligada a reserva/atendimento NAO e pausada; vale com a revisao por IA ligada ou desligada", async () => {
  const c = await mkClinic("Clinica Pausa");
  const p = await mkPatient(c, { name: "Carla Dias" });
  await humanSays(p, 5);
  reviews.length = 0;
  const review = (kind, text, now) => gate.reviewOutbound({ clinicId: c.id, phone: p.phone, text, kind }, { now });

  for (const kind of ["recontato", "retomada", "indicacao", "pesquisa", "aniversario", "renovacao", "campanha", "outra"]) {
    const v = await review(kind, `Mensagem de teste do tipo ${kind}`);
    assert.equal(v.send, false, kind);
    assert.equal(v.held, true, `${kind}: retida, nao vetada`);
    assert.equal(v.heldWhy, "equipe", kind);
  }
  assert.equal(reviews.length, 0, "a pausa e decidida pelo codigo: nenhuma chamada a IA");
  // sem a revisao por IA a pausa continua valendo
  process.env.AI_SEND_REVIEW = "off";
  assert.equal((await review("recontato", "Oi, tudo bem?")).held, true);
  process.env.AI_SEND_REVIEW = "on";

  // ligadas a reserva/atendimento: a conversa com a equipe NAO pausa
  for (const kind of ["lembrete", "preparo", "agendamento", "pos", "lista_espera"]) {
    const v = await review(kind, `Mensagem de teste do tipo ${kind} com texto diferente`);
    assert.equal(v.send, true, `${kind} nao e pausado pela conversa com a equipe`);
  }
  // mesmo que a IA tente barrar por 'equipe conversando', o veto nao vale para esses tipos
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "a equipe está conversando com a pessoa agora", categoria: "atendimento_humano" });
  const preparo = await review("preparo", "Orientações de preparo para o seu procedimento de amanhã, com um texto novo");
  assert.equal(preparo.send, true);
  assert.match(preparo.reason, /veto ignorado/);
  // ...e para relacionamento o veto da IA por outro motivo legitimo continua valendo
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "pediu para não receber", categoria: "opt_out" });
  const lembrete = await review("lembrete", "Confirmando seu horário de amanhã às 14:30, com um texto novo");
  assert.equal(lembrete.send, false, "veto por outro motivo legitimo (opt-out) continua valendo");
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
  // equipe falou ha 2 h: a pausa de relacionamento terminou
  await prisma.message.updateMany({ where: { role: "human", conversation: { patientId: p.id } }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
  assert.equal((await review("recontato", "Oi, tudo bem? Conseguiu pensar com calma?")).send, true);
});

test("DUPLICIDADE COM A EQUIPE: confirmacao do mesmo horario ou preparo que a equipe ja mandou nao e repetido; outro horario / sem relacao sai normalmente", async () => {
  const c = await mkClinic("Clinica Duplicidade");
  const p = await mkPatient(c, { name: "Diana Alves" });
  await humanSays(p, 60, "Oi Diana! Passando para confirmar sua consulta de amanhã às 14:30. Pode confirmar?");
  const review = (kind, text) => gate.reviewOutbound({ clinicId: c.id, phone: p.phone, text, kind });
  const igual = await review("lembrete", "Olá, Diana! Confirmando seu horário amanhã às 14:30 - Limpeza de pele. Podemos contar com você?");
  assert.equal(igual.send, false);
  assert.match(igual.reason, /equipe ja enviou o equivalente/);
  const outro = await review("lembrete", "Olá, Diana! Confirmando seu horário de sexta às 09:00 - Peeling. Podemos contar com você?");
  assert.equal(outro.send, true, "outro horario nao e duplicidade");
  // preparo
  await humanSays(p, 120, "Diana, lembre de evitar sol e usar protetor solar antes do procedimento, combinado?");
  const prep = await review("preparo", "Obrigada pela confirmação, Diana! Para o seu Lavieen: evite sol 5 dias antes.");
  assert.equal(prep.send, false);
  // PURO
  const now = new Date();
  const h = (m, minAgo) => ({ content: m, createdAt: new Date(now.getTime() - minAgo * 60_000) });
  assert.equal(gate.teamAlreadyCovered("lembrete", "Confirmando sua consulta em 20/10 às 09:00", [h("Confirma pra mim? 20/10 às 9h", 30)], now), true);
  assert.equal(gate.teamAlreadyCovered("lembrete", "Confirmando sua consulta em 20/10 às 09:00", [h("Oi! Tudo bem? Confirma pra mim sexta?", 30)], now), false);
  assert.equal(gate.teamAlreadyCovered("lembrete", "Confirmando às 09:00", [h("confirmo 09:00", 13 * 60)], now), false, "mais de 12 h atras nao conta");
  assert.equal(gate.teamAlreadyCovered("preparo", "x", [h("bom dia!", 10)], now), false);
  assert.equal(gate.teamAlreadyCovered("recontato", "x", [h("evite sol e confirme", 10)], now), false, "so lembrete e preparo");
});

// ===================================================================== TELEFONES DOS LEADS NO RESUMO DIARIO
test("RELATORIO DIARIO: telefones dos leads so na clinica que ligou; uma linha por lead (varias mensagens), telefone ausente/fora do padrao sem inventar; mesmo destino; logs sem telefone", async () => {
  const lis = await mkClinic("Lisboa Fictícia", { notifyPhone: "5511900000111", notifyEvents: "daily_report,daily_report_phones,hot_lead" });
  const outra = await mkClinic("Outra Clínica Fictícia", { notifyPhone: "5511900000222", notifyEvents: "daily_report" });
  const mkLead = async (clinic, name, ph, msgs = 0) => {
    const p = await prisma.patient.create({ data: { clinicId: clinic.id, name, phone: ph } });
    if (msgs) {
      const conv = await prisma.conversation.create({ data: { patientId: p.id } });
      for (let i = 0; i < msgs; i++) await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: `mensagem ${i + 1}`, createdAt: new Date(Date.now() - (msgs - i) * 60_000) } });
    }
    return p;
  };
  const maria = await mkLead(lis, "Maria Fictícia Souza", "5511987654321", 3); // varias interacoes
  const ana = await mkLead(lis, "Ana Teste", "551133334444", 1); // fixo
  const semFone = await mkLead(lis, "Sem Telefone", "", 0); // telefone ausente
  const estranho = await mkLead(lis, "Formato Estranho", "12345", 2); // fora do padrao: aparece como esta
  const parou = await prisma.patient.create({ data: { clinicId: lis.id, name: "Pediu Para Parar", phone: "5511977770001", optedOut: true } });
  const velho = await prisma.patient.create({ data: { clinicId: lis.id, name: "Contato Antigo", phone: "5511977770002", createdAt: new Date(Date.now() - 3 * 24 * 3_600_000) } });
  const deOutra = await mkLead(outra, "Lead De Outra", "5511955550000", 1);
  void parou; void velho;

  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" "));
  posts.length = 0;
  try { await runDailyReport(); } finally { Object.assign(console, orig); }

  const paraLis = posts.filter((x) => x.number === "5511900000111");
  const paraOutra = posts.filter((x) => x.number === "5511900000222");
  assert.ok(paraLis.length >= 2, "relatorio + lista de leads, para o MESMO numero interno de sempre");
  assert.equal(paraOutra.length, 1, "a outra clinica continua recebendo SO o relatorio de antes (sem lista de telefones)");
  assert.ok(!paraOutra.some((x) => /Leads do dia/.test(x.text)));
  assert.ok(!posts.some((x) => x.text.includes("5511955550000") || x.text.includes("Lead De Outra")), "lead de outra clinica nunca aparece");
  assert.deepEqual([...new Set(posts.map((x) => x.number))].sort(), ["5511900000111", "5511900000222"], "nenhum destinatario novo");

  const lista = paraLis.filter((x) => /Leads do dia/.test(x.text)).map((x) => x.text).join("\n");
  assert.match(lista, /📞 \*Leads do dia \d{2}\/\d{2}\* — 5 lead\(s\)/);
  assert.match(lista, /Maria Fictícia Souza — \+55 \(11\) 98765-4321 — 3 mensagem\(ns\) hoje/);
  assert.equal((lista.match(/Maria Fictícia Souza/g) ?? []).length, 1, "uma linha por lead, mesmo com 3 mensagens");
  assert.match(lista, /Ana Teste — \+55 \(11\) 3333-4444/);
  assert.match(lista, /Sem Telefone — telefone não cadastrado/);
  assert.match(lista, /Formato Estranho — 12345 \(formato fora do padrão, como cadastrado\) — 2 mensagem/);
  assert.match(lista, /Pediu Para Parar — .* pediu para não receber mensagens/);
  assert.ok(!/Contato Antigo/.test(lista), "contato de 3 dias atras nao e lead de hoje");
  assert.match(lista, /Sem telefone cadastrado: 1\./);
  // o telefone de ninguem aparece nos logs tecnicos
  const todosOsLogs = logs.join("\n");
  for (const ph of ["5511987654321", "551133334444", "5511977770001", "98765-4321"]) assert.ok(!todosOsLogs.includes(ph), `telefone ${ph} vazou para o log`);
  assert.match(todosOsLogs, /leads=5 partes=1/, "o log leva so as contagens");
  void maria; void ana; void semFone; void estranho; void deOutra;
});

test("RELATORIO DIARIO: lista longa e dividida em partes numeradas SEM perder nem duplicar ninguem; total e cabecalho em todas; sem leads -> uma linha", () => {
  const leads = Array.from({ length: 120 }, (_, i) => ({ patientId: `p${i}`, name: `Lead Numero ${i + 1} Sobrenome Comprido`, phone: `55119${String(10000000 + i)}`, messages: (i % 4) + 1, firstAt: new Date(Date.UTC(2026, 9, 19, 12, i % 60)), optedOut: i % 17 === 0 }));
  const partes = leadPhones.buildLeadPhoneMessages(leads, { dateLabel: "19/10", timeZone: TZ });
  assert.ok(partes.length > 1, `lista longa vira varias partes (${partes.length})`);
  assert.ok(partes.every((p) => p.length <= 3200), "cada parte cabe numa mensagem");
  partes.forEach((p, i) => assert.match(p.split("\n")[0], new RegExp(`120 lead\\(s\\) \\(parte ${i + 1}/${partes.length}\\)`)));
  const todas = partes.join("\n");
  for (let i = 0; i < leads.length; i++) assert.equal((todas.match(new RegExp(`Lead Numero ${i + 1} Sobrenome`, "g")) ?? []).length, 1, `lead ${i + 1} exatamente uma vez`);
  assert.ok(!/^\S*$/.test(partes[0].split("\n")[1]), "a segunda linha e o aviso interno (nao e telefone)");
  assert.deepEqual(leadPhones.buildLeadPhoneMessages([], { dateLabel: "19/10", timeZone: TZ }), ["📞 *Leads do dia 19/10* — nenhum lead novo hoje."]);
  assert.equal(leadPhones.maskPhone("5511987654321"), "...4321");
  assert.equal(leadPhones.maskPhone(null), "(sem telefone)");
  assert.equal(leadPhones.leadPhoneReportEnabled("daily_report,daily_report_phones"), true);
  assert.equal(leadPhones.leadPhoneReportEnabled("daily_report"), false);
  // o texto que o servidor registra em log de envio duplicado (primeiros 60 caracteres) nao chega a um telefone
  assert.ok(!/\d{10,}/.test(partes[0].slice(0, 60)));
});

test("a tela de configuracoes nao apaga avisos ja ligados (resumo do dia, lead quente) ao salvar e tem a caixa dos telefones", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(html.includes('value="daily_report_phones"') && html.includes('value="daily_report"'));
  assert.ok(js.includes("state.notifyExtra") && js.includes("...(state.notifyExtra ?? [])"), "avisos sem caixa na tela (ex.: hot_lead) sao preservados ao salvar");
  const sql = fs.readFileSync(new URL("../prisma/migrations/20261019200000_lisboa_telefones_no_resumo_diario/migration.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("WHERE \"name\" = 'Lisboa Beauty Center'") && !/DELETE|DROP/i.test(sql), "so a Lisboa, so acrescenta");
});

// ===================================================================== JORNADAS (PREVIA)
test("JORNADAS: a previa mostra cadastro atual, valor pretendido e a ORIGEM do valor antigo; 'ajustado' so quando o cadastro ja e igual; dias e almoco intocados", async () => {
  const c = await mkClinic("Lisboa Jornadas Fictícia", { workStartHour: 8, workEndHour: 21 });
  const suelen = await prisma.professional.create({ data: { clinicId: c.id, name: "Suelen Fictícia", active: true, workDays: "1,2,3,4,5", lunchStartHour: 13, lunchStartMinute: 0, lunchEndHour: 14, lunchEndMinute: 0 } }); // herda 8-21
  const adriana = await prisma.professional.create({ data: { clinicId: c.id, name: "Adriana Fictícia", active: true, workStartHour: 9, workEndHour: 18, workDays: "2,3,4,5,6" } }); // cadastro proprio antigo
  const talita = await prisma.professional.create({ data: { clinicId: c.id, name: "Talita Fictícia", active: true, workStartHour: 8, workEndHour: 17 } }); // ja igual
  const previa = await ajustarJornadasLisboa(c.id, { dryRun: true });
  const por = Object.fromEntries(previa.itens.map((i) => [i.alvo, i]));
  assert.equal(por.Suelen.jornadaNova, "12:00-21:00");
  assert.equal(por.Suelen.antes, "herda da clínica");
  assert.match(por.Suelen.origemAntes, /herdado do expediente da clínica/);
  assert.equal(por.Suelen.situacao, "cadastro_preparado_nao_aplicado");
  assert.equal(por.Adriana.antes, "09:00-18:00");
  assert.match(por.Adriana.origemAntes, /cadastro da própria profissional/);
  assert.equal(por.Adriana.jornadaNova, "12:00-21:00");
  assert.equal(por.Talita.jornadaNova, "08:00-17:00");
  assert.equal(por.Talita.status, "sem_mudanca");
  assert.equal(por.Talita.situacao, "cadastro_aplicado");
  // previa nao grava
  assert.equal((await prisma.professional.findUnique({ where: { id: suelen.id } })).workStartHour, null);
  assert.equal((await prisma.professional.findUnique({ where: { id: adriana.id } })).workStartHour, 9);
  // aplicar muda so inicio/fim; dias e almoco ficam
  await ajustarJornadasLisboa(c.id, { dryRun: false, actorName: "Admin (teste)" });
  const s = await prisma.professional.findUnique({ where: { id: suelen.id } });
  assert.deepEqual([s.workStartHour, s.workEndHour, s.workDays, s.lunchStartHour, s.lunchEndHour], [12, 21, "1,2,3,4,5", 13, 14]);
  const a = await prisma.professional.findUnique({ where: { id: adriana.id } });
  assert.deepEqual([a.workStartHour, a.workEndHour, a.workDays], [12, 21, "2,3,4,5,6"]);
  assert.equal((await prisma.professional.findUnique({ where: { id: talita.id } })).workEndHour, 17);
  // e depois de aplicado nenhuma rotina automatica desfaz: a fonte da execucao e sempre o cadastro da profissional (resolveHours), sem cache
  const again = await ajustarJornadasLisboa(c.id, { dryRun: true });
  assert.deepEqual(again.itens.map((i) => i.situacao), ["cadastro_aplicado", "cadastro_aplicado", "cadastro_aplicado"]);
});

test("JORNADAS: nada alem do painel, do ajuste da Lisboa e da criacao inicial escreve horas de profissional (sincronizacao do CE e seeds nao sobrescrevem)", () => {
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const sync = src("clinicaexperts/sync.ts");
  const criacao = sync.slice(sync.indexOf("professional.create("), sync.indexOf("professional.create(") + 400);
  assert.ok(!/workStartHour|workEndHour/.test(criacao), "a importacao do CE cria a profissional sem jornada propria");
  assert.ok(!/workStartHour|workEndHour/.test(src("clinicaexperts/removeCopies.ts")) && !/workStartHour|workEndHour/.test(src("clinicaexperts/undo.ts")));
  assert.ok(!/professional\.(create|update|upsert|updateMany|createMany)\(/.test(src("maintenance/seedLisboa.ts")), "o seed da Lisboa nao escreve profissional");
  const elig = src("scheduling/eligibility.ts");
  assert.ok(elig.includes("resolveHours(clinic as Parameters<typeof resolveHours>[0], p)"), "a execucao le o cadastro a cada consulta (sem copia em cache)");
});

// ===================================================================== POS-PROCEDIMENTO
test("POS: so depois de atendimento CONCLUIDO; avaliacao e cancelado nao recebem; barrado nao vira envio; nao repete; resumo da rodada diz o desfecho", async () => {
  const c = await mkClinic("Clinica Pos");
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza de pele", durationMin: 60 } });
  const aval = await prisma.procedure.create({ data: { clinicId: c.id, name: "Avaliação gratuita", durationMin: 30 } });
  await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos 1 dia", message: "Oi, {primeiro_nome}! Como você está depois da {procedimento}?", intervalValue: 1, intervalUnit: "days", onlyIfCompleted: true } });
  const ontem = new Date(Date.now() - 26 * 3_600_000);
  const mk = async (nome, status, procedureId = proc.id, extra = {}) => {
    const p = await mkPatient(c, { name: nome, ...extra });
    const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId, scheduledAt: ontem, status } });
    return { p, a };
  };
  const concluido = await mk("Concluida Silva", "completed");
  const semConcluir = await mk("Confirmada Nao Concluida", "confirmed"); // ninguem marcou como concluido
  const avaliacao = await mk("Avaliada Souza", "completed", aval.id);
  const cancelado = await mk("Cancelada Lima", "cancelled");
  const pediuParar = await mk("Pediu Parar", "completed", proc.id, { optedOut: true });
  const reclamou = await mk("Reclamou Dias", "completed");
  reviewAnswer = (body) => (/Reclamou/.test(JSON.stringify(body.messages)) ? { decisao: "nao_enviar", confianca: "alta", motivo: "relatou problema no procedimento", categoria: "reclamacao" } : { decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
  posts.length = 0;
  const horaLocal = wallClockInZone(new Date(), TZ).hour;
  const dentro = horaLocal >= 7 && horaLocal < 21;
  await runPostProcedureCycle();
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" });
  const run = (await prisma.automationRun.findMany({ where: { job: "pos-procedimento", clinicId: c.id }, orderBy: { startedAt: "desc" }, take: 1 }))[0];
  assert.ok(run, "a rodada deixou rastro mesmo que nada tenha saido");
  if (!dentro) { assert.equal(posts.length, 0, "fora de 7h-21h nada sai"); assert.match(run.reasons, /fora_do_horario_de_envio/); return; }
  const para = (x) => posts.filter((m) => m.number === x.p.phone).length;
  assert.equal(para(concluido), 1);
  assert.match(posts.find((m) => m.number === concluido.p.phone).text, /Limpeza de pele/);
  assert.equal(para(semConcluir), 0, "atendimento nao concluido: a regra so vale depois de concluido");
  assert.equal(para(avaliacao), 0, "avaliacao nao recebe pos-procedimento");
  assert.equal(para(cancelado), 0);
  assert.equal(para(pediuParar), 0);
  assert.equal(para(reclamou), 0, "barrado pela revisao");
  const reasons = JSON.parse(run.reasons);
  assert.equal(reasons["enviado:pos"], 1);
  assert.ok(reasons["vetado:revisao_de_envio_barrou"] >= 1, JSON.stringify(reasons));
  posts.length = 0;
  await runPostProcedureCycle();
  assert.equal(posts.length, 0, "nao repete na rodada seguinte");
  assert.ok(await prisma.activityLog.findFirst({ where: { clinicId: c.id, patientId: reclamou.p.id, type: "message_blocked_ai" } }), "o motivo do bloqueio esta no Diario");
});

test("POS: falha do provedor deixa a etapa em nova tentativa (retry) e o pos sai quando o provedor volta, uma vez", async () => {
  const horaLocal = wallClockInZone(new Date(), TZ).hour;
  if (horaLocal < 7 || horaLocal >= 21) return; // o pos so roda de 7h as 21h
  const c = await mkClinic("Clinica Pos Falhas");
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Peeling", durationMin: 60 } });
  await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos", message: "Oi, {primeiro_nome}! Tudo certo depois do {procedimento}?", intervalValue: 1, intervalUnit: "days" } });
  const p = await mkPatient(c, { name: "Adiada Souza" });
  await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date(Date.now() - 26 * 3_600_000), status: "completed" } });
  posts.length = 0;
  providerMode = "http500";
  await runPostProcedureCycle();
  providerMode = "ok";
  assert.equal(posts.length, 0);
  const linhas = await prisma.postProcedureSent.findMany({ where: { appointment: { patientId: p.id } } });
  assert.deepEqual(linhas.map((l) => l.state), ["retry"], "falha comum: a etapa fica em nova tentativa (nao em 'enviada'), tenta na proxima rodada");
  await runPostProcedureCycle();
  assert.equal(posts.length, 1, "voltou: sai uma vez");
  await runPostProcedureCycle();
  assert.equal(posts.length, 1);
});

// ===================================================================== AUDITORIA (somente leitura)
test("AUDITORIA: classifica cada registro sem declarar que tudo falhou nem que todo bloqueio foi correto; so leitura; telefones mascarados", async () => {
  assert.equal(classificarRegistro({ state: "sent" }).categoria, "aceito_pelo_provedor", "aceito pelo provedor NAO e entrega confirmada");
  assert.equal(classificarRegistro({ state: "legacy" }).categoria, "sem_evidencia");
  assert.equal(classificarRegistro({ state: "retry" }).categoria, "adiado");
  assert.equal(classificarRegistro({ state: "sending" }).categoria, "a_conferir");
  assert.equal(classificarRegistro({ state: "superseded", reason: "horario remarcado" }).categoria, "bloqueio_correto");
  assert.equal(classificarRegistro({ state: "unconfirmed" }).categoria, "aceito_sem_confirmacao");
  assert.equal(classificarRegistro({ state: "failed", reason: "HTTP 500" }).categoria, "falha_do_provedor");
  assert.equal(classificarRegistro({ state: "deferred", layer: "equipe_atendendo", reason: "pausa humana" }).categoria, "adiado");
  assert.equal(classificarRegistro({ state: "vetoed", reason: "juiz de IA [opt_out]: pediu para parar" }).categoria, "bloqueio_correto");
  assert.equal(classificarRegistro({ state: "vetoed", reason: "juiz de IA [outro]: A pessoa não tem horário agendado" }).categoria, "bloqueio_indevido");
  assert.equal(classificarRegistro({ state: "vetoed", reason: "juiz de IA: motivo qualquer sem categoria" }).categoria, "a_conferir");
  assert.equal(classificarRegistro({ state: "expired", reason: "a janela passou" }).categoria, "nao_selecionada");

  const c = await mkClinic("Lisboa Auditoria Fictícia");
  await prisma.followUpRule.create({ data: { clinicId: c.id, order: 1, name: "Recontato - 4 horas", afterDays: 1, afterMinutes: 240, message: "Oi, {primeiro_nome}!", repeatMode: "once", skipIfHumanTakeover: true, skipIfUpcomingAppt: true, active: false } });
  await prisma.followUpRule.create({ data: { clinicId: c.id, order: 2, name: "Recontato - 1 dia", afterDays: 1, afterMinutes: 1440, nextDayHour: 8, sendWindowStart: 8, sendWindowEnd: 12, message: "Oi!", repeatMode: "once", skipIfHumanTakeover: true, skipIfUpcomingAppt: true, active: true } });
  const p = await mkPatient(c, { name: "Fulana Fictícia", birthDate: birthdayOf() });
  await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário!" } });
  const contar = async () => ({ patients: await prisma.patient.count(), disp: await prisma.followUpDispatch.count(), runs: await prisma.automationRun.count(), logs: await prisma.activityLog.count() });
  const antes = await contar();
  const rel = await auditarEnviosLisboa(c.id);
  assert.equal(rel.somenteLeitura, true);
  assert.deepEqual(rel.fluxos.map((f) => f.fluxo.split(" ")[0]), ["Recontato", "Confirmacoes", "Confirmacao", "Pos-procedimento", "Aniversarios"]);
  const rec = rel.fluxos[0];
  assert.ok(rec.observacoes.some((o) => /4 horas.*DESLIGADA/.test(o)), "diz que a regra de 4 h esta desligada no cadastro");
  assert.ok(rec.regras.some((r) => /etapa 1.*DESLIGADA/.test(r)) && rec.regras.some((r) => /etapa 2.*LIGADA/.test(r)));
  const aniv = rel.fluxos[4];
  assert.equal(aniv.candidatos.length, 1);
  assert.match(aniv.candidatos[0].pessoa, /^Fulana \(\.\.\.\d{4}\)$/, "so primeiro nome e final do telefone");
  assert.ok(!JSON.stringify(rel).includes(p.phone), "telefone completo nunca aparece");
  assert.ok(rel.faltaParaConcluir.length >= 2);
  assert.deepEqual(await contar(), antes, "a auditoria nao gravou nada");
});
