// Lembretes "Antes da visita" da Lisboa: o horario fixo nao se perde ao editar "horas antes", e da pra restaurar o que se perdeu (15/10).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-lembretes-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { apiRouter } = await import("../dist/api/routes.js");
const { classifyReminder, restoreLisboaReminders, REMINDER_WINDOWS } = await import("../dist/maintenance/restoreReminders.js");
const { default: express } = await import("express");

const clinic = await prisma.clinic.create({ data: { name: "Lisboa Beauty Center", whatsappPhone: "5511900000002" } });
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.staff = { role: "admin" }; next(); });
app.use("/api", apiRouter);
const server = http.createServer(app).listen(0);
const port = server.address().port;
const put = (id, body) => fetch(`http://127.0.0.1:${port}/api/reminder-rules/${id}?clinicId=${clinic.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test.after(async () => {
  server.close();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) fs.rmSync(dbFile + ext, { force: true });
});

const ONTEM = "Olá, *{primeiro_nome}*! 💖 Seu momento de autocuidado na Lisboa está chegando.\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}";
const HOJE = "Bom dia, {primeiro_nome}! Tudo bem? ☀️\nEstamos muito felizes em te receber hoje às {hora} 🥰";

test("classifica pelo texto: (amanhã) = dia anterior, 'hoje às' = no dia, ambíguo = não sei", () => {
  assert.equal(classifyReminder(ONTEM), "dia_seguinte");
  assert.equal(classifyReminder(HOJE), "do_dia");
  assert.equal(classifyReminder("Lembrete amanhã e hoje"), null);
  assert.equal(classifyReminder("Olá, {primeiro_nome}!"), null);
});

test("editar 'horas antes' de um lembrete de horario FIXO nao apaga o horario (trava na API)", async () => {
  const fixo = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, message: ONTEM } });
  await put(fixo.id, { hoursBefore: 48, message: ONTEM + "\nnovo texto", active: true });
  const depois = await prisma.reminderRule.findUnique({ where: { id: fixo.id } });
  assert.equal(depois.dayOffset, 1);
  assert.equal(depois.sendHour, 8);
  assert.equal(depois.sendEndHour, 11);
  assert.equal(depois.hoursBefore, 24, "o numero de apoio tambem nao muda");
  assert.match(depois.message, /novo texto/, "o texto continua editavel");
});

test("lembrete SEM horario fixo continua aceitando 'horas antes'", async () => {
  const comum = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 24, message: "Lembrete comum" } });
  await put(comum.id, { hoursBefore: 48 });
  assert.equal((await prisma.reminderRule.findUnique({ where: { id: comum.id } })).hoursBefore, 48);
});

test("restaurar: previa nao grava; aplicar devolve a janela certa, pausa duplicado e nao toca no que nao sabe", async () => {
  await prisma.reminderRule.deleteMany({ where: { clinicId: clinic.id } });
  // o que ficou depois do acidente: tres lembretes "48h antes" sem horario fixo + a reconfirmacao (intacta)
  const a = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 48, message: ONTEM, createdAt: new Date("2026-10-01") } });
  const b = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 48, message: HOJE, createdAt: new Date("2026-10-02") } });
  const c = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 48, message: HOJE.replace("Bom dia, ", "Bom dia, *").replace("{primeiro_nome}!", "{primeiro_nome}*!"), createdAt: new Date("2026-10-03") } });
  const d = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 48, message: "Mensagem sem pista de quando sai", createdAt: new Date("2026-10-04") } });
  const filha = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 24, dayOffset: 1, sendHour: 17, sendEndHour: 18, parentRuleId: a.id, message: "Ainda nao recebemos a sua confirmacao (amanhã)" } });

  const previa = await restoreLisboaReminders(clinic.id, { dryRun: true });
  assert.deepEqual(previa.items.map((i) => i.action), ["restaurar", "restaurar", "pausar_duplicado", "nao_classificado"]);
  assert.equal((await prisma.reminderRule.findUnique({ where: { id: a.id } })).dayOffset, null, "a previa nao grava nada");

  const r = await restoreLisboaReminders(clinic.id, { dryRun: false });
  assert.equal(r.applied, 2);
  assert.equal(r.paused, 1);
  const A = await prisma.reminderRule.findUnique({ where: { id: a.id } });
  assert.deepEqual([A.dayOffset, A.sendHour, A.sendMinute, A.sendEndHour, A.hoursBefore, A.pauseMinSec, A.pauseMaxSec, A.active], [1, 8, 0, 11, 24, 10, 30, true]);
  const B = await prisma.reminderRule.findUnique({ where: { id: b.id } });
  assert.deepEqual([B.dayOffset, B.sendHour, B.sendEndHour, B.hoursBefore, B.active], [0, 7, 8, 3, true]);
  const C = await prisma.reminderRule.findUnique({ where: { id: c.id } });
  assert.equal(C.active, false, "o duplicado do dia fica pausado (nao apagado)");
  assert.equal(C.dayOffset, null);
  const D = await prisma.reminderRule.findUnique({ where: { id: d.id } });
  assert.deepEqual([D.dayOffset, D.active, D.hoursBefore], [null, true, 48], "o que nao da pra classificar nao e tocado");
  const F = await prisma.reminderRule.findUnique({ where: { id: filha.id } });
  assert.deepEqual([F.sendHour, F.sendEndHour], [17, 18], "a reconfirmacao nao e tocada");
  // idempotente: rodar de novo nao muda nada
  const de_novo = await restoreLisboaReminders(clinic.id, { dryRun: false });
  assert.equal(de_novo.applied, 0);
});

test("janelas restauradas sao as aprovadas pela clinica", () => {
  assert.deepEqual([REMINDER_WINDOWS.dia_seguinte.sendHour, REMINDER_WINDOWS.dia_seguinte.sendEndHour], [8, 11]);
  assert.deepEqual([REMINDER_WINDOWS.do_dia.sendHour, REMINDER_WINDOWS.do_dia.sendEndHour], [7, 8]);
});

test("o modal mostra o horario fixo e trava o campo 'horas antes'", () => {
  const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(js, /hoursInput\.disabled = fixed;/);
  assert.match(js, /Este lembrete sai em horário fixo/);
});
