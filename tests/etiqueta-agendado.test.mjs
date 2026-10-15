// Etiqueta interna "Agendado: <data>" / "Nao agendado" (so a Alice ve), sempre calculada pela agenda: vale pra qualquer procedimento e pra quem marcou
// (Alice, equipe, Clinica Experts). Agendado = a Alice nao tenta agendar de novo.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-etiqueta-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { getBookingTag, renderBookingTag, bookingTagPrompt } = await import("../dist/crm/bookingTag.js");

const TZ = "America/Sao_Paulo";
const clinic = await prisma.clinic.create({ data: { name: "Clinica Etiqueta", whatsappPhone: "5511900000004", timezone: TZ } });
const botox = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Botox facial", durationMin: 30 } });
const lavieen = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Lavieen", durationMin: 30 } });
const sabrina = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Sabrina" } });
const mk = (phone) => prisma.patient.create({ data: { clinicId: clinic.id, name: "Lead " + phone, phone } });
const H = 3_600_000;

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

test("sem agendamento futuro = Nao agendado", async () => {
  const p = await mk("5511911110001");
  const tag = await getBookingTag(p.id, TZ);
  assert.equal(tag.status, "nao_agendado");
  assert.equal(tag.text, "Nao agendado");
});

test("qualquer procedimento, marcado por quem for, vira Agendado com a data", async () => {
  const p = await mk("5511911110002");
  const quando = new Date(Date.now() + 5 * 24 * H);
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: lavieen.id, professionalId: sabrina.id, scheduledAt: quando, source: "presencial" } }); // equipe/CE
  const tag = await getBookingTag(p.id, TZ);
  assert.equal(tag.status, "agendado");
  assert.match(tag.text, /^Agendado: \d{2}\/\d{2}\/\d{4}.* - Lavieen com Sabrina$/);
  // a Alice marca outro procedimento depois: a etiqueta mostra o mais proximo e cita o resto
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: botox.id, scheduledAt: new Date(quando.getTime() + 2 * 24 * H), source: "whatsapp" } });
  const tag2 = await getBookingTag(p.id, TZ);
  assert.match(tag2.text, /Lavieen com Sabrina \(\+1 horario\(s\): .*Botox facial\)/);
});

test("a etiqueta acompanha a agenda: cancelou ou ja passou = Nao agendado; remarcou = nova data", async () => {
  const p = await mk("5511911110003");
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: botox.id, scheduledAt: new Date(Date.now() + 3 * 24 * H), source: "whatsapp" } });
  assert.equal((await getBookingTag(p.id, TZ)).status, "agendado");
  const nova = new Date(Date.now() + 6 * 24 * H);
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: nova } });
  assert.equal((await getBookingTag(p.id, TZ)).items[0].when.getTime(), nova.getTime());
  await prisma.appointment.update({ where: { id: a.id }, data: { status: "cancelled" } });
  assert.equal((await getBookingTag(p.id, TZ)).status, "nao_agendado");
  await prisma.appointment.update({ where: { id: a.id }, data: { status: "confirmed", scheduledAt: new Date(Date.now() - 5 * 24 * H) } });
  assert.equal((await getBookingTag(p.id, TZ)).status, "nao_agendado", "horario que ja passou nao conta");
});

test("o que a Alice le: Agendado = nao tenta agendar de novo; Nao agendado = fluxo normal; a etiqueta nunca e citada ao cliente", () => {
  const ag = { status: "agendado", items: [{ when: new Date(), label: "20/10/2026 09:30", procedure: "Lavieen", professional: "Sabrina" }], text: "Agendado: 20/10/2026 09:30 - Lavieen com Sabrina" };
  const p1 = bookingTagPrompt(ag, false);
  assert.match(p1, /JA ESTA AGENDADO/);
  assert.match(p1, /NAO tente agendar de novo/);
  assert.match(p1, /nunca mencione a etiqueta/);
  assert.match(p1, /EXPLICITAMENTE outro procedimento, mais um horario ou remarcar/);
  assert.match(bookingTagPrompt({ status: "nao_agendado", items: [], text: "Nao agendado" }, true), /JA ESTA AGENDADO/, "a equipe disse que marcou (ainda nao na agenda da Alice)");
  assert.match(bookingTagPrompt({ status: "nao_agendado", items: [], text: "Nao agendado" }, false), /Nao agendado\. Siga o fluxo normal/);
  assert.equal(renderBookingTag([]), "Nao agendado");
});

test("integracao: a etiqueta alimenta o fluxo e corta oferta de agendamento de quem ja esta agendado", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /const bookingTag = await getBookingTag\(patient\.id, tagTz\);/);
  assert.match(src, /const hasBooking = bookingTag\.status === "agendado" \|\| staffSaidBooked;/);
  assert.match(src, /bookingTagLine \? bookingTagLine \+ "\\n\\n" : ""/);
  assert.match(src, /\[ja-agendado\] oferta de agendamento removida/);
  // a etiqueta nao vai pro painel nem pro paciente: nao existe campo nem rota publica pra ela
  const routes = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  assert.ok(!/bookingTag/.test(routes));
  assert.ok(!/bookingTag/.test(fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8")));
});
