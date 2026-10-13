import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";

const { firstInterest, campaignTitle, isReactivationWindow, reactivationStart, monthStartUtc } = await import("../dist/crm/leadReactivation.js");
const { renderTemplate } = await import("../dist/crm/broadcast.js");

const TZ = "America/Sao_Paulo";
const clinicInfo = { name: "Lisboa Beauty Center", primaryLocation: null };

const MESSAGE =
  "Oi, {primeiro_nome}! 💕\nLembrei de você porque estamos com uma condição especial de {procedimento} este mês. ✨\nComo você já tinha demonstrado interesse nesse tratamento, quis te avisar.\nQuer que eu te envie os detalhes?";

test("texto da campanha: nome e procedimento de interesse preenchidos, nada de campo sem preencher", () => {
  const text = renderTemplate(MESSAGE, "Maria Souza", "5511999990001", clinicInfo, "Lavieen, preenchimento");
  assert.ok(text.startsWith("Oi, Maria! 💕"));
  assert.ok(text.includes("condição especial de Lavieen este mês"));
  assert.equal(/[{}]/.test(text), false);
});

test("sem nome cadastrado: 'Oi, !' vira 'Oi!'", () => {
  const text = renderTemplate(MESSAGE, null, "5511999990001", clinicInfo, "Lavieen");
  assert.ok(text.startsWith("Oi! 💕"), text);
});

test("primeiro interesse conhecido", () => {
  assert.equal(firstInterest("botox, preenchimento"), "botox");
  assert.equal(firstInterest("  Lavieen "), "Lavieen");
  assert.equal(firstInterest(null), "");
  assert.equal(firstInterest(""), "");
});

test("a campanha so e criada no dia configurado (ou no dia seguinte, pra recuperar queda do servidor)", () => {
  const at = (iso) => new Date(iso);
  assert.equal(isReactivationWindow(at("2026-10-19T15:00:00Z"), 20, TZ), false);
  assert.equal(isReactivationWindow(at("2026-10-20T15:00:00Z"), 20, TZ), true);
  assert.equal(isReactivationWindow(at("2026-10-21T15:00:00Z"), 20, TZ), true);
  assert.equal(isReactivationWindow(at("2026-10-22T15:00:00Z"), 20, TZ), false);
  // meia-noite de Brasilia (03:00 UTC) ja e dia 20; 02:00 UTC ainda e dia 19
  assert.equal(isReactivationWindow(at("2026-10-20T03:30:00Z"), 20, TZ), true);
  assert.equal(isReactivationWindow(at("2026-10-20T02:30:00Z"), 20, TZ), false);
});

test("a campanha comeca as 10h da clinica (ou agora, se ja passou das 10h)", () => {
  assert.equal(reactivationStart(new Date("2026-10-20T05:00:00Z"), TZ).toISOString(), "2026-10-20T13:00:00.000Z"); // 02h em Brasilia
  const late = new Date("2026-10-20T18:00:00Z"); // 15h em Brasilia
  assert.equal(reactivationStart(late, TZ).getTime(), late.getTime());
});

test("titulo e inicio do mes no fuso da clinica", () => {
  assert.equal(campaignTitle(TZ, new Date("2026-10-20T15:00:00Z")), "Leads do mês — 10/2026");
  assert.equal(monthStartUtc(TZ, new Date("2026-10-20T15:00:00Z")).toISOString(), "2026-10-01T03:00:00.000Z");
  // 01/11 00:30 UTC ainda e outubro em Brasilia
  assert.equal(campaignTitle(TZ, new Date("2026-11-01T00:30:00Z")), "Leads do mês — 10/2026");
});
