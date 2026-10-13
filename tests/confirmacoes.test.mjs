import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);

const { isLateCatchUp, CHILD_MIN_GAP_MS } = await import("../dist/reminders/cron.js");
const { alternateBrazilianMobile } = await import("../dist/uazapi/client.js");
const { leadTagLabel } = await import("../dist/crm/leadTag.js");

const TZ = "America/Sao_Paulo";
// Consulta amanha (13/10) as 10h em Brasilia = 13:00 UTC. A confirmacao do dia seguinte sai de hoje (12/10), 8h-11h.
const scheduledAt = new Date("2026-10-13T13:00:00Z");
const window = { dayOffset: 1, sendEndHour: 11 };

test("agendado DEPOIS da janela de confirmacao entra na reposicao (antes nunca recebia nada)", () => {
  const createdAt = new Date("2026-10-12T18:00:00Z"); // 15h em Brasilia, janela fechou as 11h
  const now = new Date("2026-10-12T18:10:00Z"); // 15h10
  assert.equal(isLateCatchUp({ scheduledAt, createdAt }, window, now, TZ), true);
});

test("agendado ANTES da janela segue so a janela normal (sem reposicao)", () => {
  const createdAt = new Date("2026-10-10T15:00:00Z");
  const now = new Date("2026-10-12T18:10:00Z");
  assert.equal(isLateCatchUp({ scheduledAt, createdAt }, window, now, TZ), false);
});

test("reposicao so entre 8h e 20h e com 2h de folga antes do atendimento", () => {
  const createdAt = new Date("2026-10-12T18:00:00Z");
  assert.equal(isLateCatchUp({ scheduledAt, createdAt }, window, new Date("2026-10-13T01:30:00Z"), TZ), false); // 22h30: tarde demais
  assert.equal(isLateCatchUp({ scheduledAt, createdAt }, window, new Date("2026-10-13T09:00:00Z"), TZ), false); // 6h: cedo demais
  assert.equal(isLateCatchUp({ scheduledAt, createdAt }, window, new Date("2026-10-13T11:30:00Z"), TZ), false); // 8h30 mas falta menos de 2h
});

test("confirmacao do proprio dia (dayOffset 0) nao tem reposicao", () => {
  const createdAt = new Date("2026-10-13T12:00:00Z");
  assert.equal(isLateCatchUp({ scheduledAt, createdAt }, { dayOffset: 0, sendEndHour: 8 }, new Date("2026-10-13T12:30:00Z"), TZ), false);
});

test("cobranca de quem nao confirmou so depois de 3h da mensagem-mae", () => {
  assert.equal(CHILD_MIN_GAP_MS, 3 * 3_600_000);
});

test("celular com/sem o 9o digito: tenta a outra forma", () => {
  assert.equal(alternateBrazilianMobile("5511988887777"), "551188887777"); // com 9 -> sem
  assert.equal(alternateBrazilianMobile("551188887777"), "5511988887777"); // sem 9 -> com (numero antigo comecava com 6-9)
  assert.equal(alternateBrazilianMobile("551133334444"), null); // fixo (comeca com 3): nao mexe
  assert.equal(alternateBrazilianMobile("5511"), null);
  assert.equal(alternateBrazilianMobile("14155550100"), null); // nao e brasileiro
});

test("etiqueta de origem do lead: campanha + data, no limite de 40 caracteres", () => {
  assert.equal(leadTagLabel({ adName: "Lavieen", fromAd: true }, "2026-10-12"), "Lead Lavieen | 12/10/2026");
  assert.equal(leadTagLabel({ fromAd: false }, "2026-10-12"), "Lead Orgânico | 12/10/2026");
  assert.equal(leadTagLabel({ fromAd: true }, "2026-10-12"), "Lead Anúncio | 12/10/2026");
  const long = leadTagLabel({ adName: "Campanha de Criolipólise Verão Promoção Especial", fromAd: true }, "2026-10-12");
  assert.ok(long.length <= 40, long);
  assert.ok(long.endsWith(" | 12/10/2026"));
});
