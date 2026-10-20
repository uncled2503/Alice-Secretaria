// COMPARACAO DE CUSTO ANTES x DEPOIS com OS MESMOS fixtures e as MESMAS respostas simuladas, rodando o codigo de duas pastas (checkouts separados):
//   ALICE_ROOT=<pasta com dist/ e prisma/> COMPARE_OUT=saida.json node scripts/comparar-custo.mjs
// Nenhuma chamada paga e nenhuma mensagem real: a OpenAI e o WhatsApp sao simulados por um fetch falso. Tokens do simulador = caracteres/4 (APROXIMACAO).
// Saida: JSON com, por cenario, a lista de chamadas (tipo, entrada em caracteres, saida em caracteres) e o resultado de negocio (mensagens enviadas, etapas consumidas).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(process.env.ALICE_ROOT ?? process.cwd());
const dbFile = path.join(os.tmpdir(), `alice-comparar-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
process.env.AI_BRIEFING = "off";
process.env.TZ = "UTC";
execFileSync(process.execPath, [path.join(ROOT, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: ROOT, env: process.env, stdio: "pipe" });

const calls = [];
const posts = [];
let mainScript = [];
let rewriteText = "Parcelamos em até 6 vezes no cartão de crédito, sem juros. Quer saber das formas de pagamento no pix?";
let openaiMode = "ok"; // ok | http500 | quota
let uazapiMode = "ok"; // ok | http500
let judgeAnswer = { recontact: true, reason: "pediu informacao e sumiu", categoria: "outro" };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const chars = (m) => JSON.stringify(m).length;
function completion(message, finish, messages) {
  const p = Math.ceil(chars(messages) / 4);
  return { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: p, completion_tokens: 30, total_tokens: p + 30, prompt_tokens_details: { cached_tokens: 0 } } };
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    const system = String(body.messages?.[0]?.content ?? "");
    const kind = body.tools ? "main" : /Voce reescreve/.test(system) ? "rewrite" : /Voce le a conversa de WhatsApp/.test(system) ? "reading" : /RECONTATO automatico/.test(system) ? "judge" : "other";
    const entry = { kind, inChars: chars(body.messages), outChars: 0, status: 200 };
    calls.push(entry);
    if (openaiMode === "http500") { entry.status = 500; return jsonRes(500, { error: { message: "fora do ar" } }); }
    if (openaiMode === "quota") { entry.status = 429; return jsonRes(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }); }
    let message, finish = "stop";
    if (kind === "main") {
      const next = mainScript.shift();
      if (!next) { entry.status = -1; throw new Error("roteiro do modelo acabou"); }
      if (next.tool) { message = { role: "assistant", content: null, tool_calls: [{ id: "call_" + Math.random().toString(36).slice(2), type: "function", function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }; finish = "tool_calls"; entry.outChars = JSON.stringify(next.tool.args).length; }
      else { message = { role: "assistant", content: next.content }; entry.outChars = next.content.length; }
    } else if (kind === "rewrite") { message = { role: "assistant", content: rewriteText }; entry.outChars = rewriteText.length; }
    else if (kind === "reading") { const t = JSON.stringify({ objetivo: "saber mais", momento: "interesse", perguntas_em_aberto: [], ja_dito: [], evitar: [], proximo_passo: "responder a duvida e perguntar o que ela quer melhorar" }); message = { role: "assistant", content: t }; entry.outChars = t.length; }
    else if (kind === "judge") { const t = JSON.stringify(judgeAnswer); message = { role: "assistant", content: t }; entry.outChars = t.length; }
    else { message = { role: "assistant", content: "{}" }; entry.outChars = 2; }
    return jsonRes(200, completion(message, finish, body.messages));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapiMode === "http500") return jsonRes(500, { error: "fora do ar" });
    posts.push({ number: JSON.parse(init.body).number });
  }
  return jsonRes(200, { id: "msg", data: {} });
};

const imp = (rel) => import(pathToFileURL(path.join(ROOT, "dist", rel)).href);
const { prisma } = await imp("db/client.js");
const { generateReply } = await imp("ai/alice.js");
const { runFollowUpCheck } = await imp("crm/followup.js");

const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
function amanha(h, m = 0) {
  const d = new Date(Date.now() + 24 * HOUR);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const [y, mo, da] = iso.split("-").map(Number);
  return { date: iso, instant: new Date(Date.UTC(y, mo - 1, da, h + 3, m)) };
}

// ----------------------------------------------------------------- fixtures do atendimento (identicos aos do teste)
const clinic = await prisma.clinic.create({ data: { name: "Clinica Custo", whatsappPhone: "5511900000774", timezone: TZ, plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-custo", aliceActive: true } });
const hipro = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Hipro", durationMin: 30, description: "Tecnologia para firmeza da pele." } });
await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30 } });
const longo = (t) => `${t} ${"Informacao detalhada cadastrada pela clinica para este assunto, com orientacoes completas e observacoes importantes. ".repeat(2)}`;
for (const f of [
  ["Tem estacionamento?", "Temos estacionamento conveniado ao lado.", "onde estaciono\ntem vaga para carro"], ["Quais formas de pagamento?", "Aceitamos cartao de credito, debito e pix; parcelamos em ate 6x.", "aceita cartao\naceitam pix\nparcelamento"],
  ["Posso ir acompanhada?", "Pode sim, uma pessoa acompanha.", "levar acompanhante"], ["Qual a idade minima?", "A partir de 18 anos.", "menor de idade"], ["Gestante pode fazer?", "Nao indicamos na gestacao.", "gravida\namamentando"],
  ["Quanto tempo dura o atendimento?", "Em media 40 minutos.", "duracao da sessao"], ["Como cancelar ou remarcar?", "Avise com 24h de antecedencia.", "desmarcar horario"], ["Tem wifi na clinica?", "Sim, a senha esta na recepcao: LISBOA2026.", "senha do wifi"],
  ["Qual o endereco?", "Av. Indico, 294, sala 5.", "como chego\nonde fica"], ["Aceita convenio?", "Nao trabalhamos com convenios.", "plano de saude"], ["Precisa de jejum?", "Nao ha jejum.", "preciso comer antes"], ["Atende aos domingos?", "Atendemos de segunda a sabado.", "domingo"],
]) await prisma.clinicFaq.create({ data: { clinicId: clinic.id, question: f[0], answer: longo(f[1]), alternates: f[2] } });
for (const t of ["Boas-vindas", "Pos-procedimento", "Aviso de atraso", "Promocao do mes", "Indicacao de amiga", "Lembrete de retorno", "Agradecimento"]) await prisma.messageTemplate.create({ data: { clinicId: clinic.id, name: t, whenToUse: `quando for o caso de ${t.toLowerCase()}`, body: longo(`Texto da mensagem ${t}.`), mode: "adapt" } });
for (const [name, scriptType, trig] of [["Primeiro atendimento", "primeiro_atendimento", "contato novo"], ["Agendamento", "agendamento", "quer marcar"], ["Preco", "preco", "pergunta de valor"], ["Objecoes", "objecoes", "acha caro ou tem medo"], ["Remarcacao", "remarcacao", "quer trocar o horario"], ["Procedimento", "procedimento", "duvida sobre um procedimento"]])
  await prisma.playbook.create({ data: { clinicId: clinic.id, name, scriptType, triggerText: trig, goal: `Objetivo do roteiro ${name}`, steps: `Passo um do roteiro ${name}\nPasso dois do roteiro ${name}\nPasso tres do roteiro ${name}` } });

let seq = 0;
async function cenario(nome, mensagens, { appt = null, humano = false } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551196666${String(1000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, humanTakeover: humano } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content, authorName] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 60_000)) } });
  if (appt) await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: appt.procedureId, scheduledAt: appt.when, source: "presencial" } });
  return { patient, conv };
}
const REPETIDA = "Nosso endereço é Av. Índico, 294, sala 5, no centro da cidade.";
const rascunhoRepetido = `${REPETIDA} Parcelamos em até 6 vezes no cartão de crédito, sem juros, e também aceitamos pix com desconto.`;
const base = [["user", "Oi, queria saber do Hipro"], ["assistant", "Oi! O Hipro é para firmeza da pele. O que você gostaria de melhorar?"], ["user", "A flacidez no rosto"], ["assistant", "Entendi. Quer saber mais?"]];
const lembrete = ["assistant", "Olá! Confirmando seu horário amanhã às 14:30. Podemos contar com você?", "Lembrete de consulta"];
// "modo" so muda o horario de remarcar/agendar para os dois lados nao disputarem o mesmo horario da agenda unica
const cenarios = [
  { nome: "pergunta simples", msgs: [...base, ["user", "Qual o endereço de vocês?"]], script: () => [{ content: "Av. Índico, 294, sala 5." }] },
  { nome: "duvida sobre procedimento", msgs: [...base, ["user", "O Hipro dói? Quanto tempo dura? Precisa de preparo?"]], script: () => [{ content: "O desconforto é pequeno, dura cerca de 40 minutos e não precisa de preparo especial." }] },
  { nome: "agendamento com ferramentas", msgs: [...base, ["user", "Quero agendar o Hipro amanhã"]], script: () => [{ tool: { name: "check_availability", args: { procedure_name: "Hipro", date: amanha(9).date } } }, { content: "Encontrei horários amanhã! Prefere manhã ou tarde?" }] },
  { nome: "confirmacao de presenca", msgs: [lembrete, ["user", "Confirmado"]], appt: 14, script: () => [] },
  { nome: "remarcacao", msgs: [["user", "Preciso trocar meu horário amanhã pra mais cedo"]], appt: 15, script: (modo) => [{ tool: { name: "manage_my_appointment", args: { action: "reschedule", new_date: amanha(10, 0).date, new_time: modo === 0 ? "10:00" : "10:30" } } }, { content: "Pronto! Remarquei o seu Hipro para mais cedo. 💗" }] },
  { nome: "recusa", msgs: [...base, ["user", "Não, obrigada. Vou pensar com calma"]], script: () => [{ content: "Claro, sem pressa! Quando quiser é só me chamar. 💗" }] },
  { nome: "agradecimento", msgs: [...base, ["assistant", "Tenho horários amanhã. Quer que eu reserve?"], ["user", "Obrigada!"]], script: () => [{ content: "Por nada! 💗" }] },
  { nome: "atendimento humano", msgs: [...base, ["human", "Oi, aqui é a recepção, já te respondo!", "Recepção"], ["user", "Tudo bem, aguardo"]], humano: true, script: () => [] },
  { nome: "cortesia (ok) - excecao da 2a leitura", msgs: [...base, ["assistant", "Fechado, qualquer coisa me chame!"], ["user", "ok"]], script: () => [{ content: "Combinado! 💗" }] },
  { nome: "ja agendada pergunta - excecao da 2a leitura", msgs: [["assistant", "Seu horário está confirmado."], ["user", "Oi"], ["assistant", "Oi!"], ["user", "Vocês ficam em qual rua mesmo?"]], appt: 16, script: () => [{ content: "Av. Índico, 294, sala 5. Te esperamos!" }] },
  { nome: "resposta repetida (corte)", msgs: [["user", "Oi, onde vocês ficam?"], ["assistant", `${REPETIDA} Atendemos de segunda a sábado. Posso ajudar em mais alguma coisa?`], ["user", "Entendi. Vocês parcelam o pagamento?"]], script: () => [{ content: rascunhoRepetido }] },
];

const resultado = { raiz: ROOT, cenarios: {}, recontato: {} };
let modoIdx = 0;
for (const sc of cenarios) {
  calls.length = 0; posts.length = 0;
  const appt = sc.appt ? { procedureId: hipro.id, when: amanha(sc.appt + modoIdx, 30).instant } : null;
  const c = await cenario(`${sc.nome}`, sc.msgs, { appt, humano: !!sc.humano });
  mainScript = sc.script(modoIdx);
  let erro = null;
  try { await generateReply(c.conv.id); } catch (e) { erro = String(e.message).slice(0, 120); }
  const main = calls.find((x) => x.kind === "main");
  resultado.cenarios[sc.nome] = {
    chamadas: calls.map((x) => ({ tipo: x.kind, entradaChars: x.inChars, saidaChars: x.outChars })),
    n: calls.length,
    primeiraChamadaPrincipalChars: main?.inChars ?? 0,
    somaEntradaChars: calls.reduce((s, x) => s + x.inChars, 0),
    somaSaidaChars: calls.reduce((s, x) => s + x.outChars, 0),
    erro,
  };
}

// ----------------------------------------------------------------- recontato (juiz de IA): candidato elegivel, inelegivel, veredito reaproveitado, servico indisponivel, saldo esgotado
const sp = (iso) => new Date(`${iso}-03:00`);
const noSleep = async () => undefined;
let rseq = 0;
async function clinicaRecontato(nome) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, hoursByDay: JSON.stringify({ 6: [8, 15] }), closedOnHolidays: false } });
  await prisma.followUpRule.create({ data: { clinicId: c.id, order: 1, name: "4 horas", afterDays: 1, afterMinutes: 240, message: "Oi, {primeiro_nome}! Recontato 1.", repeatMode: "once", skipIfHumanTakeover: true, skipIfUpcomingAppt: true, active: true } });
  return c;
}
async function lead(c, nome, { optedOut = false, humano = false, comHorario = false } = {}) {
  rseq++;
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `551198888${String(2000 + rseq)}`, interestNote: "limpeza de pele", optedOut } });
  const userAt = sp("2026-10-15T09:00");
  const conv = await prisma.conversation.create({ data: { patientId: p.id, status: "active", lastMessageAt: new Date(userAt.getTime() + 60_000), humanTakeover: humano } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Quero saber sobre limpeza de pele", createdAt: userAt } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Claro! A limpeza de pele custa a avaliacao gratuita. Quer ver um horario?", createdAt: new Date(userAt.getTime() + 60_000), deliveryStatus: "sent" } });
  if (comHorario) {
    const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza de pele", durationMin: 30 } });
    await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp("2026-10-16T10:00"), source: "presencial", status: "confirmed" } });
  }
  return { p, conv };
}
const estado = async (c, leads) => {
  const out = [];
  for (const l of leads) {
    const conv = await prisma.conversation.findUnique({ where: { id: l.conv.id } });
    const rows = await prisma.followUpDispatch.findMany({ where: { patientId: l.p.id, flow: "recontato" }, orderBy: { createdAt: "asc" } });
    out.push({ ponteiro: conv.lastFollowUpOrder, controle: rows.map((r) => `${r.state}${r.layer ? `/${r.layer}` : ""}`) });
  }
  return out;
};
const rodar = async (c, iso) => runFollowUpCheck({ now: sp(iso), sleep: noSleep, clinicId: c.id });
async function medir(nome, fn) {
  calls.length = 0; posts.length = 0; openaiMode = "ok"; uazapiMode = "ok"; judgeAnswer = { recontact: true, reason: "pediu informacao e sumiu", categoria: "outro" };
  const r = await fn();
  resultado.recontato[nome] = { chamadasOpenAI: calls.filter((x) => x.kind === "judge").length, entradaCharsJuiz: calls.filter((x) => x.kind === "judge").reduce((s, x) => s + x.inChars, 0), mensagensEnviadas: posts.length, ...r };
}
await withEnv({ AI_APP_RETRIES: "1", RECONTACT_AI_GATE: undefined }, async () => {
  await medir("candidato elegivel", async () => { const c = await clinicaRecontato("R1"); const a = await lead(c, "Maria Elegivel"); await rodar(c, "2026-10-15T14:30"); return { estado: await estado(c, [a]) }; });
  await medir("candidatos inelegiveis (com horario, pediu para sair, equipe atendendo)", async () => { const c = await clinicaRecontato("R2"); const L = [await lead(c, "Com Horario", { comHorario: true }), await lead(c, "Pediu Sair", { optedOut: true }), await lead(c, "Com Equipe", { humano: true })]; await rodar(c, "2026-10-15T14:30"); return { estado: await estado(c, L) }; });
  await medir("veredito reaproveitado (envio falha, nova rodada reaproveita o juiz)", async () => { const c = await clinicaRecontato("R3"); const a = await lead(c, "Maria Reaproveita"); uazapiMode = "http500"; await rodar(c, "2026-10-15T14:30"); uazapiMode = "ok"; await rodar(c, "2026-10-15T14:50"); return { estado: await estado(c, [a]) }; });
  await medir("servico indisponivel (OpenAI 500) e depois volta", async () => { const c = await clinicaRecontato("R4"); const a = await lead(c, "Maria Indisponivel"); openaiMode = "http500"; await rodar(c, "2026-10-15T14:30"); const durante = { juiz: calls.filter((x) => x.kind === "judge").length, enviadas: posts.length, estado: await estado(c, [a]) }; openaiMode = "ok"; await rodar(c, "2026-10-15T14:50"); return { durante, estado: await estado(c, [a]) }; });
  await medir("saldo esgotado (OpenAI 429 insufficient_quota), 2 rodadas, 2 candidatas", async () => { const c = await clinicaRecontato("R5"); const L = [await lead(c, "Quota Um"), await lead(c, "Quota Dois")]; openaiMode = "quota"; await rodar(c, "2026-10-15T14:30"); await rodar(c, "2026-10-15T14:50"); return { estado: await estado(c, L) }; });
});

await prisma.$disconnect();
for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
fs.writeFileSync(process.env.COMPARE_OUT ?? "comparacao.json", JSON.stringify(resultado, null, 2)); // (o app escreve logs no stdout: o resultado vai para arquivo)
