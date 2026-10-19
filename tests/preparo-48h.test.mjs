// Preparo da visita (pre-procedimento) da Lisboa: sai SEMPRE 48h antes (antes so saia no dia, logo apos a confirmacao).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const { isPreProcedureDue, toAdvanceIntro, PRE_SEND_FROM_HOUR, PRE_SEND_UNTIL_HOUR } = await import("../dist/reminders/preProcedure.js");
const H = 3_600_000;
const now = new Date("2026-10-15T15:00:00Z");

test("vence quando faltam 48h ou menos, e ate 1h antes", () => {
  assert.equal(isPreProcedureDue(new Date(now.getTime() + 49 * H), now, 48), false, "ainda falta mais de 48h");
  assert.equal(isPreProcedureDue(new Date(now.getTime() + 48 * H), now, 48), true);
  assert.equal(isPreProcedureDue(new Date(now.getTime() + 20 * H), now, 48), true, "marcado de ultima hora: sai assim que possivel");
  assert.equal(isPreProcedureDue(new Date(now.getTime() + 30 * 60_000), now, 48), false, "faltando menos de 1h nao adianta mais");
  assert.equal(isPreProcedureDue(new Date(now.getTime() - H), now, 48), false, "ja passou");
});

test("envia so de 8h as 20h", () => {
  assert.equal(PRE_SEND_FROM_HOUR, 8);
  assert.equal(PRE_SEND_UNTIL_HOUR, 20);
});

test("a abertura 'Obrigada pela confirmacao' vira uma abertura que cita o dia e a hora", () => {
  const texto = "Obrigada pela confirmação, {primeiro_nome}! 💗\nPara se preparar, siga estes cuidados:\n• Beba água.";
  const out = toAdvanceIntro(texto);
  assert.doesNotMatch(out, /Obrigada pela confirma/);
  assert.match(out, /Oi, \{primeiro_nome\}! 💗/);
  assert.match(out, /\{data\} às \{hora\}/);
  assert.match(out, /Para se preparar, siga estes cuidados:/, "o conteudo do preparo fica intacto");
  assert.match(toAdvanceIntro("Cuidados antes do peeling:\n• Sem sol."), /^Oi, \{primeiro_nome\}!/, "texto sem agradecimento ganha a abertura");
});

test("migracao liga as 48h so na Lisboa e o job esta registrado", () => {
  const sql = fs.readFileSync(new URL("../prisma/migrations/20261015100000_pre_procedimento_48h/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN "sendHoursBefore" INTEGER/);
  assert.match(sql, /SET "sendHoursBefore" = 48[\s\S]*'Lisboa Beauty Center'/);
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /startPreProcedureJob\(\);/);
});

test("quem ja recebeu o preparo antecipado nao recebe de novo ao confirmar (mesma reserva PreProcedureSent)", () => {
  const src = fs.readFileSync(new URL("../src/reminders/preProcedure.ts", import.meta.url), "utf8");
  assert.ok(src.includes('prisma.preProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id, state: "reserved", channel: "resposta", reservedAt: new Date() } }); // reserva atomica'), "a reserva atomica continua sendo a criacao unica (appointmentId+ruleId), agora com estado 'reserved'");
  assert.match(src, /alreadyRule\.has\(rule\.id\) \|\| sentKeys\.has/, "a confirmacao na conversa ja pula o que foi enviado");
});
