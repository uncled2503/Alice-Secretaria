import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);

const { firstOfDayIds, localDayBounds } = await import("../dist/reminders/firstOfDay.js");
const { isCourtesyOnly, firstUnansweredAt, shouldResume, RESUME_MAX_AGE_MS } = await import("../dist/crm/humanReturn.js");

const TZ = "America/Sao_Paulo";
const at = (iso) => new Date(iso);

test("3 agendamentos no mesmo dia: so o primeiro horario conta", () => {
  const appts = [
    { id: "c", patientId: "p1", scheduledAt: at("2026-10-15T17:00:00Z") }, // 14h
    { id: "a", patientId: "p1", scheduledAt: at("2026-10-15T13:00:00Z") }, // 10h
    { id: "b", patientId: "p1", scheduledAt: at("2026-10-15T14:30:00Z") }, // 11h30
  ];
  assert.deepEqual([...firstOfDayIds(appts, TZ)], ["a"]);
});

test("pessoas diferentes e dias diferentes cada um tem o seu primeiro", () => {
  const appts = [
    { id: "a1", patientId: "p1", scheduledAt: at("2026-10-15T13:00:00Z") },
    { id: "a2", patientId: "p1", scheduledAt: at("2026-10-16T13:00:00Z") }, // outro dia da mesma pessoa
    { id: "b1", patientId: "p2", scheduledAt: at("2026-10-15T13:30:00Z") }, // outra pessoa, mesmo dia
  ];
  assert.deepEqual([...firstOfDayIds(appts, TZ)].sort(), ["a1", "a2", "b1"]);
});

test("o dia e o dia LOCAL da clinica (22h30 e 00h30 de Brasilia sao dias diferentes)", () => {
  const appts = [
    { id: "noite", patientId: "p1", scheduledAt: at("2026-10-16T01:30:00Z") }, // 15/10 22h30 em Brasilia
    { id: "madrugada", patientId: "p1", scheduledAt: at("2026-10-16T03:30:00Z") }, // 16/10 00h30 em Brasilia
  ];
  assert.deepEqual([...firstOfDayIds(appts, TZ)].sort(), ["madrugada", "noite"]);
});

test("empate de horario: desempata pelo id (sempre o mesmo vence)", () => {
  const same = at("2026-10-15T13:00:00Z");
  const appts = [
    { id: "z", patientId: "p1", scheduledAt: same },
    { id: "m", patientId: "p1", scheduledAt: same },
  ];
  assert.deepEqual([...firstOfDayIds(appts, TZ)], ["m"]);
});

test("limites do dia local", () => {
  const { start, end } = localDayBounds(at("2026-10-15T13:00:00Z"), TZ);
  assert.equal(start.toISOString(), "2026-10-15T03:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-16T03:00:00.000Z");
});

test("cortesia nao pede resposta; pergunta e anexo pedem", () => {
  for (const t of ["ok", "Ok!", "obrigada", "Muito obrigada!!", "👍", "blz", "valeu 🙏", "tá bom"]) assert.equal(isCourtesyOnly(t), true, t);
  for (const t of ["tudo bem?", "ok mas qual o horário?", "[imagem]", "[áudio]", "pode ser amanhã?", "quanto custa"]) assert.equal(isCourtesyOnly(t), false, t);
});

test("o relogio conta da primeira mensagem que pede resposta (cortesia nao conta)", () => {
  const msgs = [
    { content: "ok, obrigada", createdAt: at("2026-10-15T13:00:00Z") },
    { content: "e o valor?", createdAt: at("2026-10-15T13:10:00Z") },
  ];
  assert.equal(firstUnansweredAt(msgs).toISOString(), "2026-10-15T13:10:00.000Z");
  assert.equal(firstUnansweredAt([{ content: "👍", createdAt: at("2026-10-15T13:00:00Z") }]), null);
  assert.equal(firstUnansweredAt([]), null);
});

test("volta a atender so depois de N minutos e dentro de 6h", () => {
  const since = at("2026-10-15T13:00:00Z");
  const min = (n) => new Date(since.getTime() + n * 60_000);
  assert.equal(shouldResume(since, 15, min(14)), false); // ainda dentro do prazo da equipe
  assert.equal(shouldResume(since, 15, min(15)), true);
  assert.equal(shouldResume(since, 15, min(120)), true);
  assert.equal(shouldResume(since, 15, new Date(since.getTime() + RESUME_MAX_AGE_MS + 1000)), false); // muito velha: nao responde de repente
  assert.equal(shouldResume(since, 0, min(60)), false); // desligado
  assert.equal(shouldResume(null, 15, min(60)), false); // nada esperando
});
