// LOTE 2 (22/10/2026): parcelamento em centavos + motor de ofertas por empresa (calendario 2026 da Lisboa como DADO). Banco isolado; nada e enviado.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-ofertas-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });
globalThis.fetch = async () => new Response("{}", { status: 200 });

const { prisma } = await import("../dist/db/client.js");
const inst = await import("../dist/commerce/installments.js");
const of = await import("../dist/crm/offers.js");
const sd = await import("../dist/crm/specialDates.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const POL = { maxInstallments: 10, minInstallmentCents: 10000 };
const at = (iso) => new Date(`${iso}T15:00:00Z`); // meio-dia em SP
let n = 0;
const clinica = (nome, extra = {}) => prisma.clinic.create({ data: { name: `${nome} ${++n}`, whatsappPhone: `55118${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", ...extra } });

test("PARCELAMENTO (puro, centavos): 10x, minimo R$100, limite da oferta so reduz, Pix e R$47 sem parcelas, 397 em 3x com ajuste e 4x proibido", () => {
  const m = (c, extra = {}) => inst.maxInstallmentsFor({ totalCents: c, ...extra }, POL).max;
  assert.equal(m(39700), 3, "R$ 397: floor(397/100) = 3");
  assert.equal(m(19900), 1, "abaixo de R$ 200 nao ha 2x");
  assert.equal(m(20000), 2);
  assert.equal(m(4700, { notInstallable: true }), 1, "experiencia de R$ 47 nao parcela");
  assert.equal(m(8700, { pixOnly: true }), 1, "exclusivo no Pix: sem parcelas");
  assert.equal(m(49700, { offerMax: 3 }), 3, "HIPRO Papada 10/11: ate 3x");
  assert.equal(m(49700), 4, "HIPRO Papada 08/12: regra geral permite 4x");
  assert.equal(m(99700, { offerMax: 9 }), 9);
  assert.equal(m(139700, { offerMax: 10 }), 10);
  assert.equal(m(59700, { offerMax: 5 }), 5, "Lavieen Day ate 5x");
  assert.equal(inst.splitInstallments({ totalCents: 59700, offerMax: 5 }, POL, 6).ok, false, "6x nao");
  assert.equal(m(500000), 10, "teto da clinica");
  assert.equal(m(39700, { offerMax: 12 }), 3, "limite da oferta nunca AUMENTA o maximo");
  const s3 = inst.splitInstallments({ totalCents: 39700 }, POL, 3);
  assert.deepEqual(s3.parcels, [13234, 13233, 13233]);
  assert.equal(s3.parcels.reduce((a, b) => a + b, 0), 39700, "fecha o total exato");
  assert.equal(s3.exact, false);
  assert.match(inst.describeSplit(s3), /ajuste de centavos/);
  assert.doesNotMatch(inst.describeSplit(s3), /3x de R\$ 132,33/, "nao apresenta 3 x 132,33 como exato");
  const s2 = inst.splitInstallments({ totalCents: 39700 }, POL, 2);
  assert.deepEqual(s2.parcels, [19850, 19850]);
  assert.equal(inst.describeSplit(s2), "2x de R$ 198,50 sem juros");
  const s4 = inst.splitInstallments({ totalCents: 39700 }, POL, 4);
  assert.equal(s4.ok, false);
  assert.equal(inst.overLimitText(3, POL), "Consigo fazer em até 3x sem juros para mantermos a parcela mínima de R$ 100. Essa quantidade funciona para você?");
  assert.equal(inst.ASK_INSTALLMENTS_TEXT, "Em quantas vezes ficaria bom para você?");
  assert.equal(inst.formatBRL(139700), "R$ 1.397,00");
  assert.ok(inst.allowedParcelValues({ totalCents: 39700 }, POL).includes(132.34));
});

test("CALENDARIO 2026: substitui o anterior (rascunho antigo vira 'substituida', aprovado nunca e mexido), estruturado e idempotente; nada aprovado sozinho", async () => {
  const c = await clinica("Calendario");
  await sd.prepararDatasEspeciais(c.id, { dryRun: false, seeds: sd.LISBOA_DATAS_2026_ANTIGO });
  const hiproAntigo = await prisma.specialDate.findFirst({ where: { clinicId: c.id, name: "HIPRO Day", startsOn: "2026-12-08" } });
  await prisma.specialDate.update({ where: { id: hiproAntigo.id }, data: { status: "aprovada", conditionText: "condição antiga aprovada", endsOn: "2026-12-08" } });
  const prev = await sd.prepararDatasEspeciais(c.id, { dryRun: true });
  const ac = (nome, data) => prev.linhas.find((l) => l.name === nome && l.startsOn === data)?.acao;
  assert.equal(ac("Lavieen Day", "2026-11-17"), "substituir", "Lavieen de novembro agora e 24/11");
  assert.equal(ac("Lavieen Day", "2026-11-24"), "criar");
  assert.equal(ac("Remoção de tatuagem", "2026-11-24"), "substituir", "Remocao de novembro agora e 26/11");
  assert.equal(ac("Remoção de tatuagem", "2026-11-26"), "criar");
  assert.equal(ac("HIPRO Day", "2026-10-22"), "substituir", "fora do calendario novo");
  assert.equal(ac("HIPRO Day", "2026-11-10"), "atualizar", "rascunho atualizado com os itens");
  assert.equal(ac("HIPRO Day", "2026-12-08"), "divergente", "aprovada: a clinica decide");
  assert.equal(await prisma.specialDate.count({ where: { clinicId: c.id, status: "substituida" } }), 0, "previa nao grava");
  await sd.prepararDatasEspeciais(c.id, { dryRun: false });
  const rows = await prisma.specialDate.findMany({ where: { clinicId: c.id } });
  assert.equal(rows.filter((r) => r.status === "substituida").length, 3);
  assert.ok(rows.filter((r) => r.status === "substituida").every((r) => /substituída pelo calendário 2026/.test(r.notes ?? "")), "historico preservado (nao apagado)");
  assert.equal((await prisma.specialDate.findUnique({ where: { id: hiproAntigo.id } })).conditionText, "condição antiga aprovada", "aprovada intacta");
  assert.equal(rows.filter((r) => r.status === "aprovada").length, 1, "nada novo aprovado sozinho");
  const again = await sd.prepararDatasEspeciais(c.id, { dryRun: false });
  assert.ok(again.linhas.every((l) => l.acao === "manter" || l.acao === "divergente"), "idempotente");
  const blackPeel = rows.find((r) => r.startsOn === "2026-10-27");
  assert.deepEqual(of.parseItems(blackPeel.items).find((i) => i.servico === "Black Peel"), { servico: "Black Peel", precoCentavos: 8700, pagamento: "pix", parcelavel: false, observacao: "somente Pix" });
  const dez = rows.find((r) => r.name === "Remoção de tatuagem + Black Peel");
  assert.equal(of.parseItems(dez.items).find((i) => i.servico === "Black Peel").precoCentavos, null, "o Pix de R$ 87 de outubro NAO e herdado em dezembro");
  const lavDez = rows.find((r) => r.name === "Lavieen Day" && r.startsOn === "2026-12-16");
  assert.ok(of.offerMissing(lavDez).length > 0, "Lavieen de dezembro: so com condicao aprovada para dezembro");
  const vip = rows.find((r) => r.name === "VIP Week / Black November");
  assert.equal(vip.responseMode, "equipe");
  assert.ok(of.offerMissing(vip).length > 0);
  const gift = rows.find((r) => r.name === "Cartão-Presente de Natal");
  assert.ok(of.offerMissing(gift).some((x) => /validade/.test(x)), "cartao-presente sem validade nao aprova");
  assert.deepEqual(of.giftTierFor(of.parseItems(gift.items), 25000), { creditCents: 35000 });
  assert.equal(of.giftTierFor(of.parseItems(gift.items), 30000), null, "faixa nao cadastrada");
});

test("APROVACAO: so com cadastro completo; conflito com outra condicao aprovada do mesmo servico e periodo = 409; versao nova a cada mudanca depois de aprovada", async () => {
  const c = await clinica("Aprovacao", { installmentMax: 10, installmentMinCents: 10000 });
  await sd.prepararDatasEspeciais(c.id, { dryRun: false });
  const hipro = await prisma.specialDate.findFirst({ where: { clinicId: c.id, name: "HIPRO Day", startsOn: "2026-11-10" } });
  const r1 = await of.updateOffer(hipro.id, { status: "aprovada" }, "Aline");
  assert.equal(r1.ok, false);
  assert.ok(r1.faltando.some((x) => /validade/.test(x)), "dia unico sem validade comercial informada: nao aprova (nada presumido)");
  const r2 = await of.updateOffer(hipro.id, { validUntil: "2026-11-10", promoteFrom: "2026-11-01", status: "aprovada" }, "Aline");
  assert.equal(r2.ok, true);
  assert.equal(r2.row.version, 1);
  const vip = await prisma.specialDate.findFirst({ where: { clinicId: c.id, name: "VIP Week / Black November" } });
  assert.equal((await of.updateOffer(vip.id, { status: "aprovada" }, "Aline")).ok, false);
  const outra = await prisma.specialDate.create({ data: { clinicId: c.id, kind: "campanha", name: "HIPRO concorrente", startsOn: "2026-11-05", endsOn: "2026-11-12", items: JSON.stringify([{ servico: "HIPRO Papada", precoCentavos: 45000 }]) } });
  const r3 = await of.updateOffer(outra.id, { status: "aprovada" }, "Aline");
  assert.equal(r3.ok, false);
  assert.ok(r3.conflitos.length > 0, "mesma oferta com preco diferente no mesmo periodo");
  const r4 = await of.updateOffer(hipro.id, { benefits: "Brinde X aprovado" }, "Aline");
  assert.equal(r4.row.version, 2, "mudanca depois de aprovada = nova versao");
  assert.equal(await prisma.specialDateRevision.count({ where: { specialDateId: hipro.id } }) >= 3, true, "historico");
});

test("PROMPT: so aprovada e vigente; itens com parcelas da politica; Pix e R$47 sem parcela; sem brinde/escassez inventados; validade vencida some", async () => {
  const c = await clinica("Prompt", { installmentMax: 10, installmentMinCents: 10000 });
  await sd.prepararDatasEspeciais(c.id, { dryRun: false });
  const hipro = await prisma.specialDate.findFirst({ where: { clinicId: c.id, name: "HIPRO Day", startsOn: "2026-11-10" } });
  await of.updateOffer(hipro.id, { validUntil: "2026-11-10", promoteFrom: "2026-11-01", status: "aprovada" }, "Aline");
  const ritual = await prisma.specialDate.findFirst({ where: { clinicId: c.id, name: "Ritual Mãos & Pés de Seda" } });
  await of.updateOffer(ritual.id, { status: "aprovada" }, "Aline");
  assert.equal(await of.offersLine(c.id, TZ, at("2026-10-31")), (await of.offersLine(c.id, TZ, at("2026-10-31"))));
  const out = await of.offersLine(c.id, TZ, at("2026-11-05"));
  assert.match(out, /HIPRO Papada: R\$ 497,00 \(até 3x sem juros/);
  assert.match(out, /HIPRO Full Face: R\$ 997,00 \(até 9x/);
  assert.match(out, /HIPRO Full Face \+ Papada: R\$ 1\.397,00 \(até 10x/);
  assert.match(out, /4x ou mais NÃO/);
  assert.match(out, /Não há brinde cadastrado/);
  assert.match(out, /Não fale em 'últimas vagas'/);
  assert.doesNotMatch(out, /Ritual/, "ritual (26 a 31/10) ja acabou em 05/11");
  const outRitual = await of.offersLine(c.id, TZ, at("2026-10-28"));
  assert.match(outRitual, /Ritual Mãos & Pés de Seda: R\$ 47,00 \(não parcelável\)/);
  assert.equal(await of.offersLine(c.id, TZ, at("2026-11-11")).then((s) => /HIPRO/.test(s)), false, "depois da validade comercial: nao cita");
  const nums = await of.approvedOfferNumbers(c.id, TZ, at("2026-11-05"));
  assert.ok(nums.includes(497) && nums.includes(165.67) && nums.includes(165.66), "parcelas de 497 em 3x (ajuste de centavos) liberadas na conferencia");
});

test("ORIGEM: oferta de anuncio so para quem veio do anuncio; organica nao aparece para quem veio de anuncio; origem desconhecida = sem condicao restrita", async () => {
  const c = await clinica("Origem", { installmentMax: 10, installmentMinCents: 10000 });
  const anuncio = await prisma.specialDate.create({ data: { clinicId: c.id, kind: "campanha", name: "Oferta do anuncio", startsOn: "2026-11-01", endsOn: "2026-11-30", status: "aprovada", origin: "anuncio", adSourceIds: "AD1", items: JSON.stringify([{ servico: "Limpeza", precoCentavos: 15000 }]) } });
  await prisma.specialDate.create({ data: { clinicId: c.id, kind: "campanha", name: "Oferta organica", startsOn: "2026-11-01", endsOn: "2026-11-30", status: "aprovada", origin: "organico", items: JSON.stringify([{ servico: "Limpeza", precoCentavos: 18000 }]) } });
  const pAd = await prisma.patient.create({ data: { clinicId: c.id, name: "Do Anuncio", phone: "5511911110001" } });
  const pOrg = await prisma.patient.create({ data: { clinicId: c.id, name: "Organica", phone: "5511911110002" } });
  await prisma.adAttribution.create({ data: { clinicId: c.id, patientId: pAd.id, receivedAt: at("2026-11-03"), sourceId: "AD1", messageExternalId: "m1" } });
  const sAd = await of.offersLine(c.id, TZ, at("2026-11-05"), pAd.id);
  assert.match(sAd, /Oferta do anuncio/);
  assert.doesNotMatch(sAd, /Oferta organica/, "nunca mistura preco de anuncio com organico");
  const sOrg = await of.offersLine(c.id, TZ, at("2026-11-05"), pOrg.id);
  assert.match(sOrg, /Oferta organica/);
  assert.doesNotMatch(sOrg, /Oferta do anuncio/);
  const sNone = await of.offersLine(c.id, TZ, at("2026-11-05"));
  assert.doesNotMatch(sNone, /Oferta do anuncio|Oferta organica/, "sem saber quem e: nenhuma condicao restrita");
  void anuncio;
});

test("CONDICAO COMBINADA: gravada na reserva com a versao; oferta vencida ou alterada depois NAO muda o combinado; modo equipe silencia so quem veio do anuncio listado", async () => {
  const c = await clinica("Combinada", { installmentMax: 10, installmentMinCents: 10000 });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Lavieen", durationMin: 60 } });
  const off = await prisma.specialDate.create({ data: { clinicId: c.id, kind: "campanha", name: "Lavieen Day", startsOn: "2026-11-24", validUntil: "2026-11-24", promoteFrom: "2026-11-15", status: "aprovada", items: JSON.stringify([{ servico: "Lavieen 3 sessões", procedimento: "Lavieen", precoCentavos: 59700, parcelasMax: 5, parcelavel: true }]) } });
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: "Combinou", phone: "5511922220001" } });
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: at("2026-11-24"), source: "alice" } });
  const terms = await of.recordAgreedOffer(a.id, at("2026-11-20"));
  assert.match(terms, /Lavieen Day \(v1\): Lavieen 3 sessões: R\$ 597,00 \(até 5x/);
  assert.equal(await of.recordAgreedOffer(a.id, at("2026-11-21")), null, "nunca sobrescreve o combinado");
  await of.updateOffer(off.id, { items: JSON.stringify([{ servico: "Lavieen 3 sessões", procedimento: "Lavieen", precoCentavos: 69700, parcelasMax: 5 }]) }, "Aline");
  const a2 = await prisma.appointment.findUnique({ where: { id: a.id } });
  assert.equal(a2.offerVersion, 1);
  assert.match(a2.offerTerms, /597,00/, "a reserva guarda a versao combinada");
  const b = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: at("2026-12-01"), source: "alice" } });
  assert.equal(await of.recordAgreedOffer(b.id, at("2026-11-25")), null, "depois da validade: nada de condicao");

  const team = await prisma.specialDate.create({ data: { clinicId: c.id, kind: "campanha", name: "VIP Week", startsOn: "2026-11-23", endsOn: "2026-11-28", status: "aprovada", responseMode: "equipe", adSourceIds: "VIP1" } });
  const vip = await prisma.patient.create({ data: { clinicId: c.id, name: "Veio da VIP", phone: "5511922220002" } });
  await prisma.adAttribution.create({ data: { clinicId: c.id, patientId: vip.id, receivedAt: at("2026-11-23"), sourceId: "VIP1", messageExternalId: "v1" } });
  assert.equal((await of.teamOfferFor(c.id, vip.id, TZ, at("2026-11-24")))?.id, team.id);
  assert.equal(await of.teamOfferFor(c.id, p.id, TZ, at("2026-11-24")), null, "quem nao veio do anuncio da campanha segue com a Alice");
  assert.equal(await of.teamOfferFor(c.id, vip.id, TZ, at("2026-11-29")), null, "fora da divulgacao");
});

test("RECESSO: reservas dentro do recesso sao listadas para a clinica decidir; nenhuma e cancelada", async () => {
  const c = await clinica("Recesso");
  await prisma.specialDate.create({ data: { clinicId: c.id, kind: "recesso", name: "Início do recesso", startsOn: "2026-12-23", status: "aprovada" } });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza", durationMin: 60 } });
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: "Dentro", phone: "5511933330001" } });
  const dentro = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: at("2026-12-26"), source: "presencial" } });
  await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: at("2026-12-20"), source: "presencial" } });
  const r = await of.recessConflicts(c.id);
  assert.deepEqual(r.reservas.map((x) => x.id), [dentro.id]);
  assert.match(r.recesso, /retorno não informado/);
  assert.equal((await prisma.appointment.findUnique({ where: { id: dentro.id } })).status, "confirmed");
  const line = await of.offersLine(c.id, TZ, at("2026-12-24"));
  assert.match(line, /não ofereça campanhas/);
  assert.match(line, /NÃO foi informada: não invente/);
});
