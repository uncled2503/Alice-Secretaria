// Rota /dashboard/stats de ponta a ponta (banco SQLite temporario): cada periodo devolve os SEUS numeros.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-stats-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { apiRouter } = await import("../dist/api/routes.js");
const { default: express } = await import("express");
const { isoDateInZone } = await import("../dist/scheduling/time.js");

const TZ = "America/Sao_Paulo";
const DAY = 24 * 3_600_000;

const clinic = await prisma.clinic.create({ data: { name: "Clinica Teste Painel", whatsappPhone: "5511900000001", timezone: TZ } });
const proc = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliacao", durationMin: 30 } });
const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Paciente Teste", phone: "5511999991111" } });
const now = new Date();
// Os horarios da agenda de "hoje" ficam ANCORADOS no dia da clinica (12h e 13h em Sao Paulo), nao em "agora + 2h/3h": depois das 21h em SP o "agora + 3h" ja e o dia seguinte.
const hojeSp = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const meioDia = new Date(`${hojeSp}T15:00:00.000Z`); // 12:00 em Sao Paulo (sem horario de verao desde 2019)
// Alice marcou 1 agendamento agora e 1 ha 10 dias; a recepcao lancou 1 (presencial) para daqui a pouco.
await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: proc.id, scheduledAt: meioDia, source: "whatsapp", createdAt: now } });
await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: proc.id, scheduledAt: new Date(now.getTime() - 9 * DAY), source: "whatsapp", createdAt: new Date(now.getTime() - 10 * DAY) } });
await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: proc.id, scheduledAt: new Date(meioDia.getTime() + 3_600_000), source: "presencial", createdAt: now } });

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.staff = { role: "admin" }; next(); });
app.use("/api", apiRouter);
const server = http.createServer(app).listen(0);
const port = server.address().port;
const stats = async (qs) => (await fetch(`http://127.0.0.1:${port}/api/dashboard/stats?clinicId=${clinic.id}&${qs}`)).json();

test.after(async () => {
  server.close();
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* Windows pode segurar o arquivo por um instante: e temporario */ } }
});

test("Hoje, Ontem e 30 dias devolvem numeros DIFERENTES (antes Hoje mostrava os de 30 dias)", async () => {
  const hoje = await stats("period=0");
  const ontem = await stats("period=1");
  const trinta = await stats("period=30");
  assert.equal(hoje.appointmentsTotal, 1, "Alice marcou 1 hoje");
  assert.equal(ontem.appointmentsTotal, 0, "ontem ninguem marcou");
  assert.equal(trinta.appointmentsTotal, 2, "30 dias pega o de hoje e o de 10 dias atras");
  assert.equal(hoje.appointmentsAgenda, 2, "agenda da clinica hoje: o da Alice + o da recepcao (so contexto)");
  assert.notDeepEqual(hoje.daily, trinta.daily);
});

test("o grafico mostra os ultimos dias ate hoje, com a barra de hoje, e o calendario do mes independe do periodo", async () => {
  const hoje = await stats("period=0");
  assert.ok(hoje.daily.length >= 14, "periodo curto ainda mostra 14 dias");
  const hojeKey = isoDateInZone(new Date(), TZ);
  assert.equal(hoje.daily.at(-1).date, hojeKey);
  assert.equal(hoje.daily.at(-1).count, 1);
  const ontem = await stats("period=1");
  assert.ok((hoje.monthDays[hojeKey] ?? 0) >= 2, "os dois agendamentos de hoje aparecem no calendario");
  assert.deepEqual(hoje.monthDays, ontem.monthDays, "o calendario nao muda com o periodo");
});

test("90 dias mostra os dias MAIS RECENTES (nao os 60 primeiros)", async () => {
  const noventa = await stats("period=90");
  assert.equal(noventa.daily.length, 90);
  assert.equal(noventa.daily.at(-1).date, isoDateInZone(new Date(), TZ));
});

test("start/end antigos continuam funcionando e periodo invalido nao quebra", async () => {
  const r = await stats(`start=${new Date(Date.now() - 2 * DAY).toISOString()}&end=${new Date().toISOString()}`);
  assert.equal(typeof r.appointmentsTotal, "number");
  const ruim = await fetch(`http://127.0.0.1:${port}/api/dashboard/stats?clinicId=${clinic.id}&start=lixo&end=lixo`);
  assert.equal(ruim.status, 400);
});
