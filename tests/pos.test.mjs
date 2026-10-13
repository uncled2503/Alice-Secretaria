import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";

const { reportsProcedureReaction, REACTION_HANDOFF_REASON } = await import("../dist/ai/safety.js");
const { appointmentEndedBy } = await import("../dist/reminders/postProcedure.js");

// o texto chega aqui ja normalizado (minusculo, sem acento nem pontuacao), como faz normalizeReply na Alice
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

test("relato de reacao apos procedimento vai pra equipe", () => {
  for (const t of [
    "Estou com muita dor, uma dor intensa na barriga",
    "apareceu uma bolha na região",
    "acho que queimou, está ardendo muito",
    "tem uma secreção saindo",
    "fiquei com febre à noite",
    "estou com alergia, coceira forte e vermelhidão",
    "a pele ficou roxa e escura",
    "tá sangrando",
    "Acho que infeccionou",
  ]) {
    assert.equal(reportsProcedureReaction(norm(t)), true, t);
  }
});

test("conversa normal e historico de alergia nao disparam", () => {
  for (const t of [
    "obrigada pelos cuidados, vou seguir tudo certinho",
    "posso malhar amanhã?",
    "qual o valor do botox?",
    "não tenho alergia a nada",
    "sem alergia, pode fazer",
    "está um pouquinho vermelho, é normal?",
    "",
  ]) {
    assert.equal(reportsProcedureReaction(norm(t)), false, t);
  }
});

test("o motivo da transferencia e o que o job de pos-procedimento procura", () => {
  assert.ok(REACTION_HANDOFF_REASON.startsWith("REAÇÃO"));
});

test("pos-procedimento em horas conta a partir do FIM do atendimento", () => {
  const start = new Date("2026-10-13T13:00:00Z");
  const appt = { scheduledAt: start, procedure: { durationMin: 90 } }; // termina 14:30
  assert.equal(appointmentEndedBy(appt, new Date("2026-10-13T14:00:00Z")), false); // 1h depois do INICIO: ainda na sessao
  assert.equal(appointmentEndedBy(appt, new Date("2026-10-13T15:30:00Z")), true); // 1h depois do fim
});
