// FASES 2 e 3 do checklist mestre (22/10/2026), lote 2: Central de Disparos com adaptadores, lista de espera estruturada, preferencias, motivos, propostas, pacotes (fonte interna),
// relatorios de gestao com denominadores e previa de configuracao da Lisboa. Banco isolado, WhatsApp simulado. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-fases23-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
let sendOk = true;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (!sendOk) return new Response(JSON.stringify({ error: "fora do ar" }), { status: 500, headers: { "Content-Type": "application/json" } });
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
    return new Response(JSON.stringify({ id: `owner:MID${String(posts.length).padStart(6, "0")}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ instance: { status: "connected" }, status: { connected: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { prisma } = await import("../dist/db/client.js");
const wl = await import("../dist/scheduling/waitlistMatch.js");
const waitlist = await import("../dist/scheduling/waitlist.js");
const client = await import("../dist/uazapi/client.js");
const loss = await import("../dist/crm/lossReasons.js");
const prop = await import("../dist/crm/proposals.js");
const pkg = await import("../dist/crm/packages.js");
const rep = await import("../dist/crm/managementReports.js");
const diff = await import("../dist/maintenance/lisboaConfigDiff.js");
const model = await import("../dist/dispatch/model.js");
const actions = await import("../dist/dispatch/actions.js");
const delivery = await import("../dist/dispatch/delivery.js");
actions.setDispatchAutoKick(false);

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
let seq = 0;
async function clinica(nome, extra = {}) {
  return prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", workStartHour: 0, workEndHour: 24, workDays: "0,1,2,3,4,5,6", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${++seq}`, ...extra } });
}
const pessoa = (c, nome, extra = {}) => prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119222${String(10000 + ++seq)}`, ...extra } });
const proc = async (c, name = "Botox") => (await prisma.procedure.findFirst({ where: { clinicId: c.id, name } })) ?? prisma.procedure.create({ data: { clinicId: c.id, name, durationMin: 30 } });
const texto = (s) => `${s} — mensagem de teste com tamanho suficiente para o controle de duplicidade.`;

// ============================================================ LISTA DE ESPERA
test("LISTA DE ESPERA: compatibilidade real (dia, turno, antecedencia, validade, profissional) e ordem por prioridade; fuso da clinica", () => {
  const base = { id: "e", procedureId: "p1", professionalId: null, days: null, shifts: null, minLeadHours: 0, priority: 0, validUntil: null, createdAt: new Date("2026-10-01"), status: "waiting" };
  const slot = { procedureId: "p1", professionalId: "prof1", start: sp("2026-10-23T09:30") }; // sexta, manha em SP
  const now = sp("2026-10-22T12:00");
  const prob = (e, s = slot) => wl.waitEntryProblem({ ...base, ...e }, s, now, TZ);
  assert.equal(prob({}), null, "sem criterios = qualquer");
  assert.equal(prob({ procedureId: "outro" }), "outro procedimento");
  assert.equal(prob({ professionalId: "outra" }), "outro profissional");
  assert.equal(prob({ days: "1,2" }), "dia da semana fora do pedido");
  assert.equal(prob({ days: "5" }), null, "sexta");
  assert.equal(prob({ shifts: "tarde,noite" }), "turno fora do pedido");
  assert.equal(prob({ shifts: "manha" }), null);
  assert.match(prob({ minLeadHours: 48 }), /antecedencia/);
  assert.equal(prob({ minLeadHours: 12 }), null);
  assert.equal(prob({ validUntil: sp("2026-10-22T11:00") }), "entrada vencida");
  assert.equal(prob({ status: "notified" }), "entrada nao esta aguardando");
  assert.equal(prob({}, { ...slot, start: sp("2026-10-21T09:00") }), "a vaga ja passou");
  // fuso: 23h de quinta em SP e sexta em UTC: o dia e o LOCAL (quinta = 4)
  const lateThu = { ...slot, start: sp("2026-10-22T23:00") };
  assert.equal(wl.waitEntryProblem({ ...base, days: "4", shifts: "noite" }, lateThu, sp("2026-10-22T12:00"), TZ), null);
  assert.equal(wl.waitEntryProblem({ ...base, days: "5" }, lateThu, sp("2026-10-22T12:00"), TZ), "dia da semana fora do pedido");
  const ranked = wl.rankWaitlist([
    { ...base, id: "antiga", createdAt: new Date("2026-09-01") },
    { ...base, id: "prioritaria", priority: 5, createdAt: new Date("2026-10-10") },
    { ...base, id: "incompat", days: "1" },
    { ...base, id: "nova", createdAt: new Date("2026-10-15") },
  ], slot, now, TZ).map((e) => e.id);
  assert.deepEqual(ranked, ["prioritaria", "antiga", "nova"]);
});

test("LISTA DE ESPERA: a oferta vai para a entrada COMPATIVEL; nao reserva nada; vencida sai da fila; incompativel nao recebe", async () => {
  posts.length = 0; sendOk = true;
  const c = await clinica("Espera Real");
  const p = await proc(c);
  const manha = await pessoa(c, "Quer Manha");
  const tarde = await pessoa(c, "Quer Tarde");
  const velha = await pessoa(c, "Entrada Vencida");
  const mk = (pt, extra) => prisma.waitlistEntry.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, ...extra } });
  await mk(velha, { validUntil: new Date(Date.now() - 3_600_000), createdAt: new Date("2026-01-01") });
  await mk(tarde, { shifts: "tarde", createdAt: new Date("2026-02-01") });
  const eManha = await mk(manha, { shifts: "manha", createdAt: new Date("2026-03-01") });
  const apptsBefore = await prisma.appointment.count({ where: { clinicId: c.id } });
  const freed = new Date(Date.now() + 3 * 24 * 3_600_000);
  freed.setUTCHours(12, 0, 0, 0); // 09h em SP
  await waitlist.offerFreedSlotToWaitlist({ clinicId: c.id, procedureId: p.id, professionalId: null, freedAt: freed });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].number, manha.phone, "so a entrada de manha e compativel com 09h");
  assert.match(posts[0].text, /Quer que eu reserve/, "pergunta, nao afirma reserva");
  const after = await prisma.waitlistEntry.findUnique({ where: { id: eManha.id } });
  assert.equal(after.status, "notified");
  assert.ok(after.offeredSlotAt, "a vaga oferecida fica registrada");
  assert.equal(await prisma.appointment.count({ where: { clinicId: c.id } }), apptsBefore, "oferta NAO cria reserva");
  assert.equal((await prisma.waitlistEntry.findFirst({ where: { patientId: velha.id } })).status, "cancelled", "vencida sai da fila");
  assert.equal((await prisma.waitlistEntry.findFirst({ where: { patientId: tarde.id } })).status, "waiting", "incompativel continua esperando");
});

// ============================================================ PREFERENCIAS
test("PREFERENCIAS: 'sem promocoes' bloqueia so as promocionais; operacionais continuam; bloqueio TOTAL continua valendo para tudo", async () => {
  posts.length = 0; sendOk = true;
  const c = await clinica("Preferencias");
  const p = await pessoa(c, "Sem Promo", { promoOptOut: true });
  for (const kind of ["campanha", "aniversario", "renovacao", "indicacao", "retomada"]) assert.equal(await client.sendText(c.id, p.phone, texto(kind), { kind }), "blocked", kind);
  assert.equal(posts.length, 0);
  for (const kind of ["lembrete", "pos", "preparo", "agendamento"]) assert.equal(await client.sendText(c.id, p.phone, texto(`operacional ${kind}`), { kind }), "sent", kind);
  assert.equal(posts.length, 4);
  // quem nao marcou promoOptOut recebe promocao
  const q = await pessoa(c, "Aceita Promo");
  assert.equal(await client.sendText(c.id, q.phone, texto("campanha normal"), { kind: "campanha" }), "sent");
  // campanha: o destinatario com promoOptOut e ignorado, sem sentAt, mesmo que o envio direto fosse permitido
  const broadcast = await import("../dist/crm/broadcast.js");
  await prisma.broadcastCampaign.updateMany({ where: { status: "sending" }, data: { status: "cancelled" } });
  const camp = await prisma.broadcastCampaign.create({ data: { clinicId: c.id, title: "Promo X", message: "Oi {primeiro_nome}! Promoção especial da clínica para você aproveitar.", scheduledFor: new Date(Date.now() - 60_000), status: "sending", targetMode: "contacts" } });
  const rec = await prisma.broadcastRecipient.create({ data: { campaignId: camp.id, patientId: p.id } });
  const before = posts.length;
  await broadcast.runBroadcastTick();
  const r = await prisma.broadcastRecipient.findUnique({ where: { id: rec.id } });
  assert.equal(r.status, "skipped");
  assert.equal(r.sentAt, null);
  assert.match(r.detail, /promocoes/);
  assert.equal(posts.length, before);
});

test("PREFERENCIAS: autorizacao de imagem so existe REGISTRADA com procedencia (coluna e campos)", async () => {
  const c = await clinica("Imagem");
  const p = await pessoa(c, "Sem Registro");
  const row = await prisma.patient.findUnique({ where: { id: p.id } });
  assert.equal(row.imageConsent, null, "sem registro = nada autorizado");
  await prisma.patient.update({ where: { id: p.id }, data: { imageConsent: "concedido", imageConsentScope: "antes_depois", imageConsentSource: "termo assinado 20/10/2026", imageConsentAt: new Date() } });
  const row2 = await prisma.patient.findUnique({ where: { id: p.id } });
  assert.deepEqual([row2.imageConsent, row2.imageConsentScope, row2.imageConsentSource], ["concedido", "antes_depois", "termo assinado 20/10/2026"]);
});

// ============================================================ MOTIVOS
test("MOTIVOS: lista fechada, 'nao informado' explicito nos relatorios, cancelamento/falta so em agendamento cancelado/faltou", async () => {
  const c = await clinica("Motivos");
  const p = await proc(c);
  const a = await pessoa(c, "Perdeu Preco");
  const b = await pessoa(c, "Perdeu Sem Motivo");
  assert.equal((await loss.setLossReason(c.id, a.id, "inventado", null, "Aline")).ok, false);
  assert.equal((await loss.setLossReason(c.id, a.id, "preco", "achou caro", "Aline")).ok, true);
  assert.equal((await loss.setLossReason("outra-clinica", a.id, "preco", null, "X")).ok, false, "isolamento por clinica");
  await prisma.patient.update({ where: { id: b.id }, data: { lossReasonAt: new Date() } }); // perdido, sem motivo
  const mk = (patientId, status, extra = {}) => prisma.appointment.create({ data: { clinicId: c.id, patientId, procedureId: p.id, scheduledAt: new Date(), status, ...extra } });
  const canc = await mk(a.id, "cancelled", { cancelledAt: new Date() });
  const canc2 = await mk(b.id, "cancelled", { cancelledAt: new Date() });
  const falta = await mk(a.id, "no_show");
  const ok = await mk(a.id, "confirmed");
  assert.equal((await loss.setCancelReason(c.id, ok.id, "horario", "Aline")).ok, false, "confirmado nao tem motivo de cancelamento");
  assert.equal((await loss.setCancelReason(c.id, canc.id, "horario", "Aline")).ok, true);
  assert.equal((await loss.setCancelReason(c.id, falta.id, "medo", "Aline")).ok, true);
  void canc2;
  const rr = await loss.reasonReport(c.id, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
  assert.equal(rr.perdas.total, 2);
  assert.deepEqual(rr.perdas.porMotivo.map((x) => [x.code, x.n]).sort(), [["nao_informado", 1], ["preco", 1]]);
  assert.equal(rr.cancelamentos.total, 2);
  assert.ok(rr.cancelamentos.porMotivo.some((x) => x.code === "nao_informado" && x.n === 1), "o denominador inclui quem nao tem motivo");
  assert.equal(rr.faltas.porMotivo[0].code, "medo");
});

// ============================================================ PROPOSTAS
test("PROPOSTAS: valor so quando informado (nunca estimado), validade, duplicidade, fechamento atomico, vencida sai do 'dinheiro parado'", async () => {
  const c = await clinica("Propostas");
  const p = await pessoa(c, "Proposta Pessoa");
  const items = [{ name: "Botox", qty: 1, unitValue: 800 }, { name: "Limpeza", qty: 2, unitValue: 150 }];
  assert.equal(prop.totalOf(items), 1100);
  assert.equal(prop.totalOf([{ name: "Botox", qty: 1, unitValue: 800 }, { name: "Peeling", qty: 1, unitValue: null }]), null, "sem valor em um item = valor NAO informado (sem estimar)");
  assert.equal((await prop.createProposal(c.id, { patientId: p.id, title: "", items }, "A")).ok, false);
  assert.equal((await prop.createProposal(c.id, { patientId: p.id, title: "X", items: [] }, "A")).ok, false);
  assert.equal((await prop.createProposal(c.id, { patientId: p.id, title: "X", items: [{ name: "a", qty: 0 }] }, "A")).ok, false);
  assert.equal((await prop.createProposal("outra", { patientId: p.id, title: "X", items }, "A")).ok, false, "isolamento por clinica");
  const venc = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const r1 = await prop.createProposal(c.id, { patientId: p.id, title: "Protocolo A", items, validUntil: venc }, "Aline");
  assert.equal(r1.ok, true);
  assert.equal((await prop.createProposal(c.id, { patientId: p.id, title: "Protocolo A", items }, "Aline")).ok, false, "mesmo titulo aberto: duplicidade");
  const r2 = await prop.createProposal(c.id, { patientId: p.id, title: "Sem valor", items: [{ name: "Avaliacao", qty: 1, unitValue: null }] }, "Aline");
  const velha = await prisma.proposal.create({ data: { clinicId: c.id, patientId: p.id, title: "Vencida", itemsJson: "[]", totalValue: 999, validUntil: new Date(Date.now() - 86_400_000) } });
  const rep1 = await prop.openProposalsReport(c.id);
  assert.equal(rep1.abertasVigentes, 2);
  assert.equal(rep1.valorEmAberto, 1100, "soma so as vigentes com valor informado");
  assert.equal(rep1.propostasSemValor, 1);
  assert.equal(rep1.semValidade, 1);
  assert.equal(rep1.vencendoEm7Dias, 1);
  assert.equal((await prisma.proposal.findUnique({ where: { id: velha.id } })).status, "expirada");
  // fechamento atomico: duas ao mesmo tempo, uma vale
  const [a, b] = await Promise.all([prop.closeProposal(c.id, r1.id, "aceita", null, "Aline"), prop.closeProposal(c.id, r1.id, "recusada", "preco", "Outra")]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal((await prop.closeProposal(c.id, r2.id, "recusada", "inventado", "A")).ok, false);
  assert.equal((await prop.closeProposal("outra", r2.id, "cancelada", null, "A")).ok, false);
});

// ============================================================ PACOTES
test("PACOTES (fonte interna): saldo = contratado - registrado; nunca negativo; concorrencia na ultima sessao; avisos 2/1/ultima/parado >10 dias/vencendo", async () => {
  const c = await clinica("Pacotes");
  const p = await pessoa(c, "Pacote Pessoa");
  assert.equal((await pkg.createPackage(c.id, { patientId: p.id, name: "Protocolo", totalSessions: 0 }, "A")).ok, false);
  assert.equal((await pkg.createPackage("outra", { patientId: p.id, name: "Protocolo", totalSessions: 4 }, "A")).ok, false);
  const created = await pkg.createPackage(c.id, { patientId: p.id, name: "Protocolo 4 sessões", totalSessions: 4 }, "Aline");
  assert.equal(created.ok, true);
  const NOW = new Date("2026-10-22T15:00:00Z");
  const row = () => prisma.patientPackage.findUnique({ where: { id: created.id }, include: { usages: { select: { usedAt: true } } } });
  const day = (n) => new Date(NOW.getTime() - n * 86_400_000);
  assert.equal((await pkg.registerUsage(c.id, created.id, {}, "A", day(20))).restantes, 3);
  assert.equal((await pkg.registerUsage(c.id, created.id, {}, "A", day(15))).restantes, 2);
  let r = await row();
  assert.deepEqual(pkg.balanceOf(r), { usadas: 2, restantes: 2 });
  let al = pkg.packageAlerts(r, false, NOW).map((x) => x.kind).sort();
  assert.deepEqual(al, ["parado_10_dias", "restam_2"], "restam 2 e parado ha mais de 10 dias sem agendamento futuro");
  assert.deepEqual(pkg.packageAlerts(r, true, NOW).map((x) => x.kind), ["restam_2"], "com agendamento futuro nao esta parado");
  assert.equal((await pkg.registerUsage(c.id, created.id, {}, "A", day(2))).restantes, 1);
  r = await row();
  assert.ok(pkg.packageAlerts(r, true, NOW).some((x) => x.kind === "restam_1"));
  // ultima sessao: duas pessoas ao mesmo tempo, so uma vale
  const [x, y] = await Promise.all([pkg.registerUsage(c.id, created.id, {}, "A", NOW), pkg.registerUsage(c.id, created.id, {}, "B", NOW)]);
  assert.equal([x, y].filter((z) => z.ok).length, 1, JSON.stringify([x, y]));
  r = await row();
  assert.equal(r.status, "concluido");
  assert.equal(pkg.balanceOf(r).restantes, 0);
  assert.ok(pkg.packageAlerts(r, false, NOW).some((a) => a.kind === "ultima_sessao"));
  assert.equal((await pkg.registerUsage(c.id, created.id, {}, "A", NOW)).ok, false, "saldo nunca negativo");
  // mesmo atendimento nao conta duas vezes
  const c2 = await pkg.createPackage(c.id, { patientId: p.id, name: "Outro", totalSessions: 5 }, "A");
  assert.equal((await pkg.registerUsage(c.id, c2.id, { appointmentId: "ap-1" }, "A", NOW)).ok, true);
  assert.equal((await pkg.registerUsage(c.id, c2.id, { appointmentId: "ap-1" }, "A", NOW)).ok, false);
  // pacote vencendo
  const c3 = await prisma.patientPackage.create({ data: { clinicId: c.id, patientId: p.id, name: "Vence", totalSessions: 6, expiresAt: new Date(NOW.getTime() + 5 * 86_400_000) } });
  const r3 = await prisma.patientPackage.findUnique({ where: { id: c3.id }, include: { usages: { select: { usedAt: true } } } });
  assert.ok(pkg.packageAlerts(r3, true, NOW).some((a) => a.kind === "vencendo"));
});

test("PACOTES: o job avisa a EQUIPE uma vez por alerta e so marca como avisado quando o aviso foi ACEITO pelo provedor", async () => {
  posts.length = 0; sendOk = true;
  const c = await clinica("Pacotes Job", { notifyPhone: "5511977001122", notifyEvents: "automation_failed" });
  const p = await pessoa(c, "Pacote Job");
  const created = await pkg.createPackage(c.id, { patientId: p.id, name: "Pacote Job", totalSessions: 3 }, "A");
  const NOW = new Date();
  await pkg.registerUsage(c.id, created.id, {}, "A", NOW);
  sendOk = false;
  assert.equal(await pkg.runPackageAlertJob(NOW, { clinicId: c.id }), 0, "aviso nao aceito: nao marca como avisado");
  sendOk = true;
  assert.equal(await pkg.runPackageAlertJob(NOW, { clinicId: c.id }), 1);
  assert.match(posts.at(-1).text, /Pacote "Pacote Job"/);
  assert.equal(await pkg.runPackageAlertJob(NOW, { clinicId: c.id }), 0, "uma vez por alerta");
  assert.ok(!posts.some((x) => x.number === p.phone), "nada foi escrito para o paciente");
});

// ============================================================ RELATORIOS
test("RELATORIOS: taxas com denominador explicito (pct nulo sem denominador), motivos, resolucao da Alice, segmentacao por dados; prioridade explicavel e sem apresentar probabilidade", async () => {
  const c = await clinica("Relatorio");
  const ev = await proc(c, "Avaliação");
  const bt = await proc(c, "Botox");
  const prof = await prisma.professional.create({ data: { clinicId: c.id, name: "Dra. Teste" } });
  const NOW = new Date();
  const novo1 = await pessoa(c, "Lead Agendou");
  const novo2 = await pessoa(c, "Lead Nao Agendou");
  const antigo = await pessoa(c, "Cliente Antiga");
  await prisma.patient.update({ where: { id: antigo.id }, data: { createdAt: new Date(NOW.getTime() - 400 * 86_400_000) } });
  const mk = (pt, procedure, status, when) => prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: procedure.id, professionalId: prof.id, scheduledAt: when, status } });
  const t = (h) => new Date(NOW.getTime() - h * 3_600_000);
  const e1 = await mk(novo1, ev, "completed", t(30)); void e1;
  await mk(novo1, bt, "completed", t(10));
  await mk(antigo, bt, "no_show", t(5));
  const conv1 = await prisma.conversation.create({ data: { patientId: novo1.id, lastMessageAt: t(1) } });
  await prisma.message.create({ data: { conversationId: conv1.id, role: "user", content: "oi" } });
  const conv2 = await prisma.conversation.create({ data: { patientId: novo2.id, lastMessageAt: t(1), humanTakeover: true, handoffReason: "Preço fora da regra" } });
  await prisma.message.create({ data: { conversationId: conv2.id, role: "user", content: "quanto?" } });
  const r = await rep.managementReport(c.id, "mensal", NOW);
  assert.equal(r.funil.contatosNovos, 2);
  assert.equal(r.funil.contatoParaAgendamento.n, 1);
  assert.equal(r.funil.contatoParaAgendamento.d, 2);
  assert.equal(r.funil.contatoParaAgendamento.pct, 50);
  assert.match(r.funil.contatoParaAgendamento.definicao, /contatos novos/);
  assert.equal(r.funil.avaliacoesConcluidas, 1);
  assert.equal(r.funil.avaliacaoParaProcedimento.n, 1);
  assert.deepEqual([r.funil.taxaFalta.n, r.funil.taxaFalta.d, r.funil.taxaFalta.pct], [1, 3, 33.3], "faltas / (concluidos + faltas) = 1 / (2 + 1)");
  assert.equal(r.resolucaoDaAlice.d, 2);
  assert.equal(r.resolucaoDaAlice.n, 1);
  assert.ok(r.resolucaoDaAlice.transferenciasPorMotivo.some((x) => /Preço fora da regra/.test(x.motivo)));
  assert.match(r.resolucaoDaAlice.criterio, /não mede satisfação/);
  assert.equal(r.porProfissional[0].nome, "Dra. Teste");
  // sem dados: pct nulo (nunca 0% inventado)
  const vazia = await clinica("Relatorio Vazio");
  const rv = await rep.managementReport(vazia.id, "semanal", NOW);
  assert.equal(rv.funil.contatoParaAgendamento.pct, null);
  assert.equal(rv.resolucaoDaAlice.pct, null);
  // segmentacao por dados + prioridade explicavel
  assert.deepEqual([0, 1, 3, 6].map(rep.segmentOf), ["novo", "ocasional", "recorrente", "vip"]);
  const pr = rep.commercialPriority({ temperature: "quente", askedPrice: true, askedSchedule: true, hasOpenProposal: true, daysSilent: 3 });
  assert.equal(pr.pontos, 10);
  assert.ok(pr.motivos.every((m) => /^[+-]\d/.test(m)), "cada ponto tem o seu motivo");
  assert.match(pr.aviso, /NÃO é probabilidade/);
  assert.equal(rep.commercialPriority({ temperature: "quente", hasFutureBooking: true }).pontos, 0);
});

// ============================================================ PREVIA DA LISBOA
test("LISBOA: previa de configuracao atual x desejada e SOMENTE LEITURA, nao inventa jornada nem texto, e marca o que depende da clinica", async () => {
  const c = await clinica("Lisboa Previa", { googleReviewUrl: null });
  await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, message: "Confirma?", purpose: "confirmacao", active: true } });
  await prisma.professional.create({ data: { clinicId: c.id, name: "Dra. Suelen Souza", workStartHour: 8, workEndHour: 21 } });
  await prisma.professional.create({ data: { clinicId: c.id, name: "Talita Lima" } });
  const counts = async () => JSON.stringify([await prisma.reminderRule.count(), await prisma.professional.count(), await prisma.postProcedureRule.count(), await prisma.followUpRule.count(), await prisma.activityLog.count()]);
  const antes = await counts();
  const d = await diff.conferirRegrasLisboa(c.id);
  assert.equal(d.somenteLeitura, true);
  assert.equal(await counts(), antes, "nada foi gravado");
  const by = (t) => d.linhas.find((l) => l.tema.startsWith(t));
  // regra final de 22/10 (8h-10h) pelo planejador geral de politica
  assert.equal(by("Confirmações: Confirmação dos atendimentos do dia seguinte").estado, "diverge");
  assert.match(by("Confirmações: Confirmação dos atendimentos do dia seguinte").atual, /08:00–11:00/);
  assert.equal(by("Confirmações: Sábado: lembrete na sexta").estado, "depende_da_clinica", "hora do lembrete de sexta nao informada");
  assert.equal(by("Jornada de Suelen").estado, "diverge", "cadastrada 8-21; o checklist pede 12-21");
  assert.equal(by("Jornada de Talita").estado, "diverge");
  assert.match(by("Jornada de Talita").atual, /herda o expediente/);
  assert.equal(by("Jornada de Adriana").estado, "indeterminado", "profissional ausente: nao inventa");
  assert.equal(by("Link do Google").estado, "depende_da_clinica");
  assert.equal(by("Datas especiais").estado, "depende_da_clinica");
  assert.equal(by("Pesquisa").estado, "conforme");
  assert.equal(by("Pré-procedimento").estado, "diverge");
  assert.equal(by("Pós-procedimento").estado, "diverge");
  assert.ok(d.resumo.diverge >= 5);
});

// ============================================================ CENTRAL: ADAPTADORES
test("CENTRAL: renovacao, retorno combinado, campanha, pos, pre e recontato aparecem pelos SEUS controles (sem fila duplicada), com estado real, texto exato, id do provedor e entrega so por evidencia", async () => {
  posts.length = 0; sendOk = true;
  const c = await clinica("Central Adaptadores");
  const NOW = new Date();
  const dia = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(NOW);
  const p = await proc(c);
  const pt = await pessoa(c, "Pessoa Adaptadores");
  const appt = await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: new Date(NOW.getTime() - 5 * 86_400_000), status: "completed" } });
  const rr = await prisma.renewalRule.create({ data: { clinicId: c.id, name: "Botox 4m", message: "m", intervalValue: 4, intervalUnit: "months" } });
  const rn = await prisma.renewalSent.create({ data: { appointmentId: appt.id, ruleId: rr.id, state: "sent", attempts: 1, acceptedAt: NOW, providerId: "owner:RENOVA12345", destination: pt.phone, messageText: "Texto exato da renovacao", updatedAt: NOW } });
  const cb = await prisma.callbackDispatch.create({ data: { clinicId: c.id, patientId: pt.id, dueAt: NOW, state: "forwarded", detail: "equipe avisada", updatedAt: NOW } });
  const camp = await prisma.broadcastCampaign.create({ data: { clinicId: c.id, title: "Black November", message: "m", scheduledFor: NOW, status: "completed" } });
  const bc = await prisma.broadcastRecipient.create({ data: { campaignId: camp.id, patientId: pt.id, status: "sent", sentAt: NOW, attemptedAt: NOW, providerId: "owner:CAMPANHA9999", messageText: "Texto exato da campanha", updatedAt: NOW } });
  const bc2 = await prisma.broadcastRecipient.create({ data: { campaignId: camp.id, patientId: (await pessoa(c, "Vetada")).id, status: "vetoed", detail: "revisao barrou", attemptedAt: NOW, updatedAt: NOW } });
  const pr = await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos", message: "m", intervalValue: 1, intervalUnit: "hours" } });
  const ps = await prisma.postProcedureSent.create({ data: { appointmentId: appt.id, ruleId: pr.id, state: "unconfirmed", attempts: 1, attemptedAt: NOW, finalAt: NOW } });
  const fu = await prisma.followUpDispatch.create({ data: { clinicId: c.id, patientId: pt.id, flow: "recontato", step: 2, cycleKey: "k", dueAt: NOW, state: "vetoed", layer: "revisao_envio", reason: "reclamacao", decidedAt: NOW } });
  const v = await model.buildDispatchView(c.id, { from: dia, to: dia, view: "historico", pageSize: 200 }, NOW);
  const byId = (id) => v.items.find((i) => i.id === id);
  const iRn = byId(`rn:${rn.id}`), iCb = byId(`cb:${cb.id}`), iBc = byId(`bc:${bc.id}`), iBc2 = byId(`bc:${bc2.id}`), iPs = byId(`ps:${ps.id}`), iFu = byId(`fu:${fu.id}`);
  assert.ok(iRn && iCb && iBc && iBc2 && iPs && iFu, `itens: ${v.items.map((i) => i.id).join(", ")}`);
  assert.equal(iRn.kind, "renovacao"); assert.equal(iRn.status, "aceito"); assert.equal(iRn.messageText, "Texto exato da renovacao"); assert.equal(iRn.providerIdFull, "owner:RENOVA12345");
  assert.equal(iCb.kind, "retorno_combinado"); assert.equal(iCb.status, "encaminhado", "encaminhar a equipe NAO e mensagem enviada");
  assert.equal(iBc.kind, "campanha"); assert.equal(iBc.campaignTitle, "Black November"); assert.equal(iBc.status, "aceito");
  assert.equal(iBc2.status, "barrado"); assert.equal(iBc2.sentAt, undefined);
  assert.equal(iPs.kind, "pos"); assert.equal(iPs.status, "incerto"); assert.equal(iPs.messageText, null, "o pos nao guarda o texto: aparece como nao registrado");
  assert.equal(iFu.kind, "recontato"); assert.equal(iFu.status, "barrado");
  // entrega so com evidencia do provedor (webhook), tambem para a campanha
  assert.equal(await delivery.ingestDeliveryStatus(c.id, { EventType: "messages_update", data: { id: "owner:CAMPANHA9999", status: "Delivered" } }), "applied");
  assert.equal((await model.buildDispatchView(c.id, { from: dia, to: dia, view: "historico", pageSize: 200 }, NOW)).items.find((i) => i.id === `bc:${bc.id}`).status, "entregue");
  assert.equal(await delivery.ingestDeliveryStatus(c.id, { EventType: "messages_update", data: { id: "owner:RENOVA12345", status: "Read" } }), "applied");
  // filtros por tipo e por campanha
  const soCamp = await model.buildDispatchView(c.id, { from: dia, to: dia, view: "historico", kinds: ["campanha"], campaignId: camp.id }, NOW);
  assert.equal(soCamp.items.length, 2);
  assert.ok(soCamp.items.every((i) => i.kind === "campanha"));
  // detalhe por identidade e acoes que a Central NAO oferece por fora do fluxo
  const det = await actions.dispatchDetail(c.id, `bc:${bc.id}`, NOW);
  assert.equal(det.text, "Texto exato da campanha");
  assert.equal(det.providerMessageId, "owner:CAMPANHA9999");
  assert.equal((await actions.cancelPending(c.id, `bc:${bc.id}`, { name: "A" })).ok, false);
  assert.equal((await actions.reconcileItem(c.id, `ps:${ps.id}`, { name: "A" }, "enviado", "", NOW)).ok, false);
  assert.equal(iPs.recoverable, false);
  assert.match(iPs.recoverableWhy, /incerto/);
  // outra clinica nao ve
  const outra = await clinica("Central Outra");
  assert.equal(await actions.loadItem(outra.id, `bc:${bc.id}`, NOW), null);
  assert.equal((await model.buildDispatchView(outra.id, { from: dia, to: dia, view: "historico" }, NOW)).items.length, 0);
  // cobertura: esses tipos nao tem "esperado" reconstruido: sem percentual
  assert.equal(v.cobertura.find((k) => k.kind === "campanha").cobertura, null);
  void pr;
});

test("CENTRAL: 'programado' (ainda nao e hora) e 'cancelado pela equipe' sao estados proprios, distintos de 'nao tentado' e 'bloqueado'", async () => {
  const c = await clinica("Central Estados");
  const NOW = sp("2026-10-20T10:30");
  const p = await proc(c);
  const regra = await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 9, message: "x", purpose: "confirmacao", active: true } });
  void regra;
  const pt = await pessoa(c, "Futura");
  await prisma.appointment.create({ data: { clinicId: c.id, patientId: pt.id, procedureId: p.id, scheduledAt: sp("2026-10-22T14:00"), source: "presencial" } });
  const v = await model.buildDispatchView(c.id, { view: "proximos", from: "2026-10-21", to: "2026-10-21" }, NOW);
  const it = v.items.find((i) => i.patientName === "Futura");
  assert.equal(it.status, "programado", "a janela de amanha ainda nao abriu");
  assert.equal(v.counters.programados, 1);
  assert.equal(v.counters.nao_tentados, 0);
});

// ============================================================ MIGRACAO 28 (SQL real sobre banco com dados)
test("MIGRACAO 20261028: aplica sobre banco COM DADOS do estado anterior, preserva linhas e defaults; schema sem divergencia", async () => {
  const { spawnSync } = await import("node:child_process");
  const { cachedPreDb, makeProject, migrationsBefore, cli, urlOf } = await import("./helpers-migracao.mjs");
  const NEW = "20261028100000_funil_pacotes_preferencias";
  const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alice-mig-f23-"));
  const dbPath = path.join(tmp, "pre.db");
  fs.copyFileSync(await cachedPreDb(NEW), dbPath); // estado imediatamente ANTERIOR (migracoes reais, cacheado)
  const url = urlOf(dbPath);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: `${url}?connection_limit=1` } } });
  try {
    const ins = async (table, values) => {
      const info = await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
      const row = { ...values };
      for (const c of info) { if (c.name in row || Number(c.notnull) !== 1 || c.dflt_value != null) continue; const ty = String(c.type).toUpperCase(); row[c.name] = ty === "TEXT" ? `${table}-${c.name}-${Math.random()}` : ty === "DATETIME" ? new Date().toISOString() : 0; }
      const cols = Object.keys(row);
      await db.$executeRawUnsafe(`INSERT INTO "${table}" (${cols.map((x) => `"${x}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...Object.values(row));
    };
    await ins("Clinic", { id: "c1", name: "C", whatsappPhone: "5511900000001" });
    await ins("Patient", { id: "p1", clinicId: "c1", phone: "5511900000002", optedOut: 1 });
    await ins("Procedure", { id: "pr1", clinicId: "c1", name: "Botox", durationMin: 30 });
    await ins("Appointment", { id: "ap1", clinicId: "c1", patientId: "p1", procedureId: "pr1", scheduledAt: "2026-06-18 14:00:00", status: "cancelled" });
    await ins("WaitlistEntry", { id: "w1", clinicId: "c1", patientId: "p1", preferredNote: "quinta de manha" });
  } finally { await db.$disconnect(); }
  // aplica a 28 e as POSTERIORES (o schema de comparacao e o atual)
  const later = fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name > NEW).map((d) => d.name).sort();
  const schema = makeProject(path.join(tmp, "proj"), migrationsBefore(NEW), [NEW, ...later]);
  const up = cli(["migrate", "deploy"], dbPath, schema);
  assert.equal(up.status, 0, up.out.slice(-600));
  const db2 = new PrismaClient({ datasources: { db: { url: `${url}?connection_limit=1` } } });
  try {
    const p = (await db2.$queryRawUnsafe(`SELECT optedOut, promoOptOut, imageConsent, lossReasonCode, contactKind FROM "Patient"`))[0];
    assert.deepEqual([Number(p.optedOut), Number(p.promoOptOut), p.imageConsent, p.lossReasonCode, p.contactKind], [1, 0, null, null, "paciente"], "bloqueio total preservado; novas preferencias com default seguro");
    const w = (await db2.$queryRawUnsafe(`SELECT preferredNote, days, shifts, minLeadHours, priority FROM "WaitlistEntry"`))[0];
    assert.deepEqual([w.preferredNote, w.days, w.shifts, Number(w.minLeadHours), Number(w.priority)], ["quinta de manha", null, null, 0, 0]);
    assert.equal((await db2.$queryRawUnsafe(`SELECT cancelReasonCode FROM "Appointment"`))[0].cancelReasonCode, null);
    for (const t of ["Proposal", "PatientPackage", "PackageUsage", "PaymentProof"]) assert.equal(Number((await db2.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n), 0, t);
    assert.equal((await db2.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check, "ok");
  } finally { await db2.$disconnect(); }
  assert.match(cli(["migrate", "status"], dbPath, schema).out, /up to date/i);
  const dd = spawnSync(process.execPath, [prismaCli, "migrate", "diff", "--from-url", url, "--to-schema-datamodel", schema, "--script"], { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  for (const t of ["Proposal", "PatientPackage", "PackageUsage", "PaymentProof", "CallbackDispatch", "SpecialDate"]) assert.ok(!new RegExp(`(CREATE|ALTER|DROP) TABLE "${t}"`).test(dd.stdout), `divergencia em ${t}:\n${dd.stdout.slice(0, 400)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
