// CHECKLIST 22/10/2026: (a) nao-pacientes com classificacao PERSISTENTE compartilhada, (b) campanha com atendimento humano apos a resposta, (c) datas especiais/recesso sem inventar nada.
// Banco isolado, provedor simulado, nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-checklist-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") { const b = JSON.parse(init.body); posts.push({ number: b.number, text: b.text }); return new Response(JSON.stringify({ id: `owner:MID${posts.length}ABCDEF` }), { status: 200, headers: { "Content-Type": "application/json" } }); }
  return new Response(JSON.stringify({ instance: { status: "connected" }, status: { connected: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { prisma } = await import("../dist/db/client.js");
const ck = await import("../dist/crm/contactKind.js");
const camp = await import("../dist/crm/campaignReply.js");
const sd = await import("../dist/crm/specialDates.js");
const client = await import("../dist/uazapi/client.js");
const bday = await import("../dist/reminders/birthday.js");
const jobSeeker = await import("../dist/ai/jobSeeker.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

let seq = 0;
const TZ = "America/Sao_Paulo";
async function clinica(nome) {
  return prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${++seq}` } });
}
const pessoa = (c, nome, extra = {}) => prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119555${String(10000 + ++seq)}`, ...extra } });
const texto = (s) => `${s} — mensagem de teste com tamanho suficiente para o controle de duplicidade.`;

test("NAO-PACIENTE: detecta por frase forte (nunca palavra isolada); classificacao persiste, tem evidencia e a equipe prevalece; reverte so por mudanca de contexto da Alice", async () => {
  assert.equal(jobSeeker.nonPatientKind("vcs tem parceria com convenio?"), null, "palavra isolada nao classifica");
  assert.equal(jobSeeker.nonPatientKind("Quanto custa a limpeza de pele?"), null);
  assert.equal(jobSeeker.nonPatientKind("Olá, sou influenciadora e tenho uma proposta de parceria com a clínica"), "parceria");
  const c = await clinica("Nao Pacientes");
  const p = await pessoa(c, "Parceiro Bot");
  assert.equal(await ck.classifyByAlice(p.id, "parceria", "Olá, tenho uma proposta de parceria comercial para a clínica"), true);
  const row = await prisma.patient.findUnique({ where: { id: p.id } });
  assert.deepEqual([row.contactKind, row.contactKindDetail, row.contactKindSource], ["nao_paciente", "parceria", "alice"]);
  assert.match(row.contactKindEvidence, /proposta de parceria/, "evidencia guardada para revisao");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: p.id, type: "contact_classified" } }), "fica no Diario");
  // sem pedido clinico: nao reverte; com pedido clinico claro (mudanca de contexto): volta a paciente (so fonte alice)
  assert.equal(await ck.revertByClinicalContext(p.id, false), false);
  assert.equal(await ck.revertByClinicalContext(p.id, true), true);
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).contactKind, "paciente");
  // a equipe decide: a Alice nao sobrescreve nem reverte
  await ck.setByStaff(p.id, "nao_paciente", "fornecedor", "Aline");
  assert.equal(await ck.classifyByAlice(p.id, "parceria", "outra coisa"), false, "decisao humana prevalece");
  assert.equal(await ck.revertByClinicalContext(p.id, true), false, "so a equipe desfaz a decisao da equipe");
  const staff = await prisma.patient.findUnique({ where: { id: p.id } });
  assert.deepEqual([staff.contactKind, staff.contactKindDetail, staff.contactKindSource], ["nao_paciente", "fornecedor", "equipe"]);
  await ck.setByStaff(p.id, "paciente", null, "Aline");
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).contactKind, "paciente");
});

test("NAO-PACIENTE: excluido das automacoes comerciais no envio (recontato, aniversario, campanha, pesquisa, indicacao) e do aniversario; lembrete de quem tem agendamento continua", async () => {
  posts.length = 0;
  const c = await clinica("Nao Pacientes Envio");
  const np = await pessoa(c, "Fornecedor X");
  await ck.setByStaff(np.id, "nao_paciente", "fornecedor", "Aline");
  for (const kind of ["recontato", "aniversario", "campanha", "pesquisa", "indicacao", "retomada", "renovacao"]) {
    assert.equal(await client.sendText(c.id, np.phone, texto(`msg ${kind}`), { kind }), "blocked", kind);
  }
  assert.equal(posts.length, 0, "nada saiu para o nao-paciente");
  assert.equal(await client.sendText(c.id, np.phone, texto("lembrete de agendamento real"), { kind: "lembrete" }), "sent", "lembrete de agendamento nao e prospeccao");
  assert.equal(await client.sendText(c.id, np.phone, texto("resposta da equipe"), { manual: true }), "sent", "a equipe sempre pode escrever");
  // paciente normal recebe
  const ok = await pessoa(c, "Paciente Normal");
  assert.equal(await client.sendText(c.id, ok.phone, texto("recontato normal"), { kind: "recontato" }), "sent");
  // aniversario: nao-paciente fica fora (selecao e revalidacao no envio)
  const hoje = new Date();
  const nasc = new Date(Date.UTC(1990, hoje.getUTCMonth(), hoje.getUTCDate()));
  const aniv = await pessoa(c, "Aniversariante Fornecedor", { birthDate: nasc });
  await ck.setByStaff(aniv.id, "nao_paciente", "parceria", "Aline");
  const rule = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabens", sendHour: 0, active: true, message: "Feliz aniversario, {primeiro_nome}! A equipe te deseja um dia muito especial." } });
  const before = posts.length;
  const res = await bday.deliverBirthday(rule, aniv, TZ, () => new Date());
  assert.equal(res.state, "skipped");
  assert.equal(posts.length, before);
  const { candidates } = await bday.birthdayCandidatesToday(c.id, new Date(), TZ);
  assert.ok(!candidates.some((x) => x.patient.id === aniv.id), "nao entra nem na lista de candidatos");
});

test("CAMPANHA COM HUMANO: resposta dentro da janela vai para a equipe ANTES da Alice, com evidencia; ambiguidade nao inventa atribuicao; fora da janela/campanha comum nao muda; retorno automatico nao desfaz", async () => {
  const c = await clinica("Campanha Humana");
  const mk = (title, extra = {}) => prisma.broadcastCampaign.create({ data: { clinicId: c.id, title, message: "Promo", scheduledFor: new Date(), status: "completed", ...extra } });
  const agora = new Date();
  const horasAtras = (h) => new Date(agora.getTime() - h * 3_600_000);
  const conversa = async (p) => prisma.conversation.create({ data: { patientId: p.id } });

  // 1) campanha com humano, enviada ha 2h, resposta agora
  const camp1 = await mk("HIPRO Day", { humanAfterReply: true });
  const p1 = await pessoa(c, "Responde Campanha");
  await prisma.broadcastRecipient.create({ data: { campaignId: camp1.id, patientId: p1.id, status: "sent", sentAt: horasAtras(2) } });
  const cv1 = await conversa(p1);
  const r1 = await camp.applyCampaignHumanReply(c.id, p1.id, cv1.id, "Oi, quanto está o valor?", agora);
  assert.equal(r1.took, true);
  assert.equal(r1.ambiguous, false);
  const after = await prisma.conversation.findUnique({ where: { id: cv1.id } });
  assert.equal(after.humanTakeover, true);
  assert.equal(after.handoffPending, true);
  assert.match(after.handoffReason, /^Resposta a campanha "HIPRO Day"/);
  assert.equal(camp.isCampaignHumanHandoff(after.handoffReason), true, "o retorno por inatividade reconhece e nao devolve");
  assert.ok((await prisma.broadcastRecipient.findFirst({ where: { campaignId: camp1.id, patientId: p1.id } })).repliedAt, "resposta ligada a campanha (evidencia)");
  assert.ok(await prisma.message.findFirst({ where: { conversationId: cv1.id, role: "system", content: { contains: "A Alice NÃO responde" } } }));
  // segunda mensagem: a conversa ja e da equipe, nada muda
  assert.equal((await camp.applyCampaignHumanReply(c.id, p1.id, cv1.id, "e ai?", agora)).took, false);

  // 2) ambiguidade: duas campanhas recentes, uma com humano -> equipe, SEM atribuir a nenhuma condicao
  const camp2 = await mk("Lavieen Day", { humanAfterReply: true });
  const camp3 = await mk("Black Peel", { humanAfterReply: false });
  const p2 = await pessoa(c, "Duas Campanhas");
  await prisma.broadcastRecipient.createMany({ data: [{ campaignId: camp2.id, patientId: p2.id, status: "sent", sentAt: horasAtras(5) }, { campaignId: camp3.id, patientId: p2.id, status: "sent", sentAt: horasAtras(1) }] });
  const cv2 = await conversa(p2);
  const r2 = await camp.applyCampaignHumanReply(c.id, p2.id, cv2.id, "quero saber", agora);
  assert.equal(r2.took, true);
  assert.equal(r2.ambiguous, true);
  assert.match((await prisma.conversation.findUnique({ where: { id: cv2.id } })).handoffReason, /atribuição ambígua/);

  // 3) campanha SEM humano: a Alice segue normal
  const p3 = await pessoa(c, "Campanha Comum");
  await prisma.broadcastRecipient.create({ data: { campaignId: camp3.id, patientId: p3.id, status: "sent", sentAt: horasAtras(1) } });
  const cv3 = await conversa(p3);
  assert.equal((await camp.applyCampaignHumanReply(c.id, p3.id, cv3.id, "oi", agora)).took, false);
  assert.equal((await prisma.conversation.findUnique({ where: { id: cv3.id } })).humanTakeover, false);

  // 4) fora da janela (72h): nao liga a resposta a campanha
  const p4 = await pessoa(c, "Respondeu Tarde");
  await prisma.broadcastRecipient.create({ data: { campaignId: camp1.id, patientId: p4.id, status: "sent", sentAt: horasAtras(100) } });
  const cv4 = await conversa(p4);
  assert.equal((await camp.applyCampaignHumanReply(c.id, p4.id, cv4.id, "oi", agora)).took, false);
  // janela configuravel por campanha
  const camp5 = await mk("Janela longa", { humanAfterReply: true, humanReplyWindowHours: 200 });
  await prisma.broadcastRecipient.create({ data: { campaignId: camp5.id, patientId: p4.id, status: "sent", sentAt: horasAtras(100) } });
  assert.equal((await camp.applyCampaignHumanReply(c.id, p4.id, cv4.id, "oi", agora)).took, true);

  // 5) envio que nao foi feito (pending/failed) nao conta; outra clinica nao interfere
  const outra = await clinica("Outra Clinica");
  const p5 = await pessoa(c, "Nunca Recebeu");
  await prisma.broadcastRecipient.create({ data: { campaignId: camp1.id, patientId: p5.id, status: "pending" } });
  const cv5 = await conversa(p5);
  assert.equal((await camp.applyCampaignHumanReply(c.id, p5.id, cv5.id, "oi", agora)).took, false);
  assert.equal((await camp.applyCampaignHumanReply(outra.id, p1.id, cv1.id, "oi", agora)).took, false, "escopo por clinica");
});

test("DATAS ESPECIAIS: previa nao grava; rascunho idempotente com dependencias explicitas; so aprovada e vigente chega a Alice; sem condicao nao inventa; vencida some; recesso sem retorno nao inventa", async () => {
  const c = await clinica("Datas Especiais");
  const prev = await sd.prepararDatasEspeciais(c.id, { dryRun: true, seeds: sd.LISBOA_DATAS_2026_ANTIGO }); // mecanica generica com o calendario ANTIGO (o novo tem teste proprio em ofertas-parcelamento)
  assert.equal(prev.somentePrevia, true);
  assert.equal(prev.linhas.length, 9, "as 9 datas da secao 14");
  assert.equal(await prisma.specialDate.count({ where: { clinicId: c.id } }), 0);
  assert.ok(prev.linhas.every((l) => l.acao === "criar" && l.faltando.length > 0), "tudo depende da clinica");
  const real = await sd.prepararDatasEspeciais(c.id, { dryRun: false, seeds: sd.LISBOA_DATAS_2026_ANTIGO });
  assert.equal(await prisma.specialDate.count({ where: { clinicId: c.id } }), 9);
  const again = await sd.prepararDatasEspeciais(c.id, { dryRun: false, seeds: sd.LISBOA_DATAS_2026_ANTIGO });
  assert.ok(again.linhas.every((l) => l.acao === "manter"));
  assert.equal(await prisma.specialDate.count({ where: { clinicId: c.id } }), 9, "idempotente");
  const rows = await prisma.specialDate.findMany({ where: { clinicId: c.id } });
  assert.ok(rows.every((r) => r.status === "rascunho" && r.conditionText === null && r.endsOn === null), "nada inventado: sem condicao, validade nem retorno");
  assert.deepEqual(rows.filter((r) => r.kind === "recesso").map((r) => r.startsOn), ["2026-12-23"]);
  assert.deepEqual(rows.filter((r) => r.kind === "campanha").map((r) => r.startsOn).sort(), ["2026-10-22", "2026-10-27", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-08", "2026-12-16", "2026-12-17"]);
  void real;

  const hipro = rows.find((r) => r.name === "HIPRO Day" && r.startsOn === "2026-10-22");
  // rascunho: a Alice nao conhece
  assert.equal(await sd.specialDatesLine(c.id, TZ, new Date("2026-10-22T15:00:00Z")), "");
  // aprovada SEM condicao: reconhece a data mas diz que nao ha condicao cadastrada (nao inventa)
  await prisma.specialDate.update({ where: { id: hipro.id }, data: { status: "aprovada", approvedBy: "Aline" } });
  const semCond = await sd.specialDatesLine(c.id, TZ, new Date("2026-10-22T15:00:00Z"));
  assert.match(semCond, /HIPRO Day/);
  assert.match(semCond, /NÃO está cadastrada/);
  assert.match(semCond, /NÃO cite preço, desconto, vaga, brinde/);
  // com condicao informada pela clinica: usa SOMENTE ela
  await prisma.specialDate.update({ where: { id: hipro.id }, data: { conditionText: "Condição X informada pela clínica", endsOn: "2026-10-23" } });
  const comCond = await sd.specialDatesLine(c.id, TZ, new Date("2026-10-23T15:00:00Z"));
  assert.match(comCond, /Condição X informada pela clínica/);
  assert.match(comCond, /SOMENTE esta/);
  // antes da data e depois da validade: nada (sem urgencia de campanha vencida)
  assert.equal(await sd.specialDatesLine(c.id, TZ, new Date("2026-10-21T15:00:00Z")), "");
  assert.equal(await sd.specialDatesLine(c.id, TZ, new Date("2026-10-24T15:00:00Z")), "");
  // data local da clinica (23h de 22/10 em SP ja e 23/10 em UTC): vale a data LOCAL
  assert.match(await sd.specialDatesLine(c.id, TZ, new Date("2026-10-23T01:30:00Z")), /HIPRO Day/, "01h30 UTC de 23/10 ainda e 22/10 em Sao Paulo");
  // recesso aprovado sem retorno: nao inventa a data
  const rec = rows.find((r) => r.kind === "recesso");
  await prisma.specialDate.update({ where: { id: rec.id }, data: { status: "aprovada" } });
  assert.equal(await sd.specialDatesLine(c.id, TZ, new Date("2026-12-22T15:00:00Z")), "");
  const noRecesso = await sd.specialDatesLine(c.id, TZ, new Date("2026-12-24T15:00:00Z"));
  assert.match(noRecesso, /RECESSO DA CLÍNICA/);
  assert.match(noRecesso, /NÃO foi informada: não invente/);
  assert.match(noRecesso, /registre o interesse/);
  await prisma.specialDate.update({ where: { id: rec.id }, data: { endsOn: "2027-01-05" } });
  assert.match(await sd.specialDatesLine(c.id, TZ, new Date("2026-12-30T15:00:00Z")), /até 05\/01\/2027/);
  assert.equal(await sd.specialDatesLine(c.id, TZ, new Date("2027-01-06T15:00:00Z")), "", "recesso acabou");
  // outra clinica nao ve
  const outra = await clinica("Sem Datas");
  assert.equal(await sd.specialDatesLine(outra.id, TZ, new Date("2026-10-22T15:00:00Z")), "");
});

test("COMERCIAL/REVISOR: aviso de agendamento NAO e vetado por 'ja tem horario'; recontato com horario marcado continua vetavel; convite contextual para avaliacao nao e erro quando pediu preco/informacao", async () => {
  const gate = await import("../dist/ai/sendGate.js");
  const veto = await import("../dist/crm/vetoReasons.js");
  const raw = JSON.stringify({ decisao: "nao_enviar", confianca: "alta", categoria: "ja_tem_horario", motivo: "A pessoa já tem horário marcado" });
  for (const kind of ["agendamento", "lembrete", "preparo"]) {
    const v = gate.decide(raw, kind, "Seu horário foi confirmado para quinta às 14h.");
    assert.equal(v.send, true, `${kind}: ter horario e a razao do envio`);
    assert.match(v.reason, /veto ignorado/);
  }
  assert.equal(gate.decide(raw, "recontato", "Oi, vamos marcar sua avaliação?").send, false, "recontato para quem ja tem horario continua barrado");
  assert.equal(gate.decide(raw, "campanha", "Promoção!").send, false);
  assert.equal(veto.vetoStands("ja_tem_horario", "x", "agendamento").stands, false);
  assert.equal(veto.vetoStands("ja_tem_horario", "x").stands, true, "sem tipo: comportamento anterior");
  // outros motivos continuam valendo para o aviso de agendamento (divergencia, opt-out, equipe falando)
  for (const categoria of ["opt_out", "conteudo_incorreto", "atendimento_humano"]) {
    const r = JSON.stringify({ decisao: "nao_enviar", confianca: "alta", categoria, motivo: "motivo real" });
    assert.equal(gate.decide(r, "agendamento", "Seu horário foi confirmado.").send, false, categoria);
  }
  // o revisor da resposta e o das automacoes dizem que pedir preco/informacao NAO proibe o convite contextual (sem horarios, sem reserva)
  assert.match(gate.REPLY_REVIEW_SYSTEM, /CONVITE contextual para avaliacao[^.]*NAO e problema/i);
  assert.match(gate.GATE_SYSTEM, /pedir informacao ou preco NAO proibe o convite/i);
  assert.ok(!/NAO pediu agenda/.test(gate.GATE_SYSTEM) && !/NAO pediu agenda/.test(gate.REPLY_REVIEW_SYSTEM), "a formulacao antiga (barrar convite so porque nao pediu agenda) saiu");
  // a finalidade dos avisos ligados a horario diz isso ao revisor
  assert.match(veto.AUTOMATION_PURPOSE.agendamento, /Ter horario e a razao do envio/);
});
