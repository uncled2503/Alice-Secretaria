// AJUSTE CADASTRAL DA LISBOA (formacao da Sabrina, 50 UI da oferta, criolipolise de placas): previa por padrao, aplicacao idempotente, so campos estruturados vazios / FAQ nova,
// texto manual NUNCA editado (so relatado), outra clinica intacta. Banco temporario, dados FICTICIOS.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-fatos-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { ajustarFatosLisboa, FAQ_CRIO_MARCADOR } = await import("../dist/maintenance/lisboaFatos.js");
const { splitSentences } = await import("../dist/ai/repetition.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const mkClinic = (name) => prisma.clinic.create({ data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime" } });
async function cenario(nome) {
  const c = await mkClinic(nome);
  const sab = await prisma.professional.create({ data: { clinicId: c.id, name: "Sabrina Alves", title: "Dra." } });
  const tox = await prisma.procedure.create({ data: { clinicId: c.id, name: "Toxina Botulínica", durationMin: 30, description: "Aplicação de toxina. Costuma levar de 20 a 50 UI." } });
  const outra = await prisma.procedure.create({ data: { clinicId: c.id, name: "Preenchimento", durationMin: 30, description: "Ácido hialurônico." } });
  const faq = await prisma.clinicFaq.create({ data: { clinicId: c.id, question: "Quem faz a aplicação?", answer: "A médica Dra. Sabrina faz a aplicação." } });
  const crio = await prisma.clinicFaq.create({ data: { clinicId: c.id, question: "Como é a criolipólise?", answer: "Criolipólise por sucção, 90 minutos." } });
  return { c, sab, tox, outra, faq, crio };
}

test("PREVIA: nada e gravado; formacao e FAQ aparecem como 'aplicar'; quantidade fica pendente ate a clinica indicar a oferta; conflitos de texto sao relatados; pendencias da clinica listadas", async () => {
  const s = await cenario("Lisboa Fatos Previa");
  const antes = { pros: await prisma.professional.findMany({ where: { clinicId: s.c.id } }), faqs: await prisma.clinicFaq.count({ where: { clinicId: s.c.id } }), procs: await prisma.procedure.findMany({ where: { clinicId: s.c.id } }) };
  const r = await ajustarFatosLisboa(s.c.id, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.itens.find((i) => i.tipo === "formacao").acao, "aplicar");
  assert.equal(r.itens.find((i) => i.tipo === "faq_criolipolise").acao, "aplicar");
  assert.equal(r.itens.find((i) => i.tipo === "quantidade_da_oferta").acao, "pendente");
  assert.ok(r.candidatosDaOferta.some((c) => c.nome === "Toxina Botulínica" && c.numerosDeUiNosTextos.includes(20) && c.numerosDeUiNosTextos.includes(50)));
  assert.ok(!r.candidatosDaOferta.some((c) => c.nome === "Preenchimento"), "so candidatos plausiveis");
  const onde = r.conflitos.map((x) => x.onde).join(" | ");
  assert.match(onde, /FAQ "Quem faz a aplicação/);
  assert.match(onde, /Procedimento "Toxina Botulínica"/);
  assert.match(onde, /FAQ "Como é a criolipólise/);
  assert.ok(r.pendenciasDaClinica.some((p) => /sessões/.test(p)) && r.pendenciasDaClinica.some((p) => /radiofrequência/.test(p)) && r.pendenciasDaClinica.some((p) => /responsável técnica/.test(p)));
  const depois = { pros: await prisma.professional.findMany({ where: { clinicId: s.c.id } }), faqs: await prisma.clinicFaq.count({ where: { clinicId: s.c.id } }), procs: await prisma.procedure.findMany({ where: { clinicId: s.c.id } }) };
  assert.deepEqual(depois, antes, "a previa nao gravou nada");
});

test("APLICAR: cadastra so a formacao, a quantidade do procedimento INDICADO e a FAQ nova; texto manual existente nao muda; idempotente; outra clinica intacta", async () => {
  const s = await cenario("Lisboa Fatos Aplicar");
  const outra = await cenario("Outra Clinica Fatos");
  const textos = async () => (await prisma.clinicFaq.findMany({ where: { clinicId: s.c.id, NOT: { question: FAQ_CRIO_MARCADOR } }, orderBy: { id: "asc" } })).map((f) => f.answer).join("|") + (await prisma.procedure.findMany({ where: { clinicId: s.c.id }, orderBy: { id: "asc" } })).map((p) => p.description).join("|");
  const antesTextos = await textos();
  const r = await ajustarFatosLisboa(s.c.id, { dryRun: false, ofertaProcedimentoId: s.tox.id });
  assert.deepEqual(r.aplicado, { formacao: true, quantidade: true, faq: true });
  assert.equal((await prisma.professional.findUnique({ where: { id: s.sab.id } })).qualification, "Biomédica");
  assert.equal((await prisma.professional.findUnique({ where: { id: s.sab.id } })).title, "Dra.", "o tratamento continua; so a formacao e cadastrada");
  assert.equal((await prisma.procedure.findUnique({ where: { id: s.tox.id } })).includedQuantity, "50 UI");
  assert.equal((await prisma.procedure.findUnique({ where: { id: s.outra.id } })).includedQuantity, null, "50 UI nao vale para outra oferta");
  assert.equal(await prisma.clinicFaq.count({ where: { clinicId: s.c.id, question: FAQ_CRIO_MARCADOR } }), 1);
  assert.equal(await textos(), antesTextos, "nenhum texto manual foi alterado");
  // idempotente
  const r2 = await ajustarFatosLisboa(s.c.id, { dryRun: false, ofertaProcedimentoId: s.tox.id });
  assert.deepEqual(r2.aplicado, { formacao: false, quantidade: false, faq: false });
  assert.ok(r2.itens.filter((i) => i.tipo !== "quantidade_da_oferta" || i.alvo).every((i) => i.acao === "ja_aplicado"));
  assert.equal(await prisma.clinicFaq.count({ where: { clinicId: s.c.id, question: FAQ_CRIO_MARCADOR } }), 1);
  // outra clinica: nada mudou
  assert.equal((await prisma.professional.findUnique({ where: { id: outra.sab.id } })).qualification, null);
  assert.equal((await prisma.procedure.findUnique({ where: { id: outra.tox.id } })).includedQuantity, null);
  assert.equal(await prisma.clinicFaq.count({ where: { clinicId: outra.c.id, question: FAQ_CRIO_MARCADOR } }), 0);
});

test("CONFLITO: formacao ou quantidade diferentes ja cadastradas NAO sao sobrescritas; duas 'Sabrina' viram pendencia", async () => {
  const s = await cenario("Lisboa Fatos Conflito");
  await prisma.professional.update({ where: { id: s.sab.id }, data: { qualification: "Esteticista" } });
  await prisma.procedure.update({ where: { id: s.tox.id }, data: { includedQuantity: "100 UI" } });
  const r = await ajustarFatosLisboa(s.c.id, { dryRun: false, ofertaProcedimentoId: s.tox.id });
  assert.equal(r.itens.find((i) => i.tipo === "formacao").acao, "conflito");
  assert.equal(r.itens.find((i) => i.tipo === "quantidade_da_oferta").acao, "conflito");
  assert.equal((await prisma.professional.findUnique({ where: { id: s.sab.id } })).qualification, "Esteticista");
  assert.equal((await prisma.procedure.findUnique({ where: { id: s.tox.id } })).includedQuantity, "100 UI");
  const d = await cenario("Lisboa Fatos Duas");
  await prisma.professional.create({ data: { clinicId: d.c.id, name: "Sabrina Costa" } });
  const r2 = await ajustarFatosLisboa(d.c.id, { dryRun: false });
  const f = r2.itens.find((i) => i.tipo === "formacao");
  assert.equal(f.acao, "pendente");
  assert.match(f.motivo, /2 profissionais ativas/);
  assert.equal(r2.aplicado.formacao, false);
});

test("divisao de frases nao quebra 'Dra. Sabrina' ao meio", () => {
  assert.deepEqual(splitSentences("Quem faz é a Dra. Sabrina. Ela atende amanhã."), ["Quem faz é a Dra. Sabrina.", "Ela atende amanhã."]);
});
