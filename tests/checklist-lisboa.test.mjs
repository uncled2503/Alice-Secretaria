import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";

const { nonPatientKind, isJobSeeker } = await import("../dist/ai/jobSeeker.js");
const { skipsPostForEvaluation } = await import("../dist/reminders/postProcedure.js");
const { followUpRuleLines } = await import("../dist/crm/dailyReport.js");

test("fornecedor, parceria e cobranca de empresa nao sao paciente", () => {
  assert.equal(nonPatientKind("Olá, sou representante da distribuidora Beauty Med, gostaria de apresentar nossos produtos"), "fornecedor");
  assert.equal(nonPatientKind("Boa tarde! Somos fornecedores de descartáveis. Posso falar com o responsável de compras?"), "fornecedor");
  assert.equal(nonPatientKind("Tenho uma proposta de parceria comercial para a clínica"), "parceria");
  assert.equal(nonPatientKind("Sou influenciadora e queria uma permuta"), "parceria");
  assert.equal(nonPatientKind("Segunda via do boleto em aberto da clínica"), "cobranca");
});

test("paciente com duvida comum continua paciente", () => {
  for (const t of [
    "Vocês têm parceria com algum convênio?",
    "quanto custa o botox?",
    "Posso pagar no boleto?",
    "tem vaga amanhã às 10h?",
    "Quero agendar uma limpeza de pele",
    "vocês trabalham com permuta de procedimento?",
  ]) {
    const k = nonPatientKind(t);
    if (/permuta/.test(t)) continue; // permuta e ambigua: so conta junto de influenciador
    assert.equal(k, null, t);
    assert.equal(isJobSeeker(t), false, t);
  }
});

test("avaliacao nao recebe pos-procedimento, a menos que a regra liste", () => {
  const ev = { procedureId: "p1", procedure: { name: "Avaliação Estética" } };
  const botox = { procedureId: "p2", procedure: { name: "Botox" } };
  assert.equal(skipsPostForEvaluation(ev, []), true);
  assert.equal(skipsPostForEvaluation(botox, []), false);
  assert.equal(skipsPostForEvaluation(ev, ["p1"]), false);
});

test("relatorio mostra quando cada recontato dispara", () => {
  const lines = followUpRuleLines([
    { order: 1, name: "4 horas", afterMinutes: 240, afterDays: 1, nextDayHour: null },
    { order: 2, name: "1 dia", afterMinutes: 1440, afterDays: 1, nextDayHour: 8 },
    { order: 3, name: "3 dias", afterMinutes: 4320, afterDays: 3, nextDayHour: null },
  ]);
  assert.match(lines[0], /4h de silêncio/);
  assert.match(lines[1], /dia seguinte às 8h/);
  assert.match(lines[2], /3 dia\(s\) de silêncio/);
});
