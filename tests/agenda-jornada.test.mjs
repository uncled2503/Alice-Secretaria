// AGENDA: jornada real da profissional x procedimento x habilitacao x duracao inteira x intervalos/bloqueios x disponibilidade do Clinica Experts.
// Banco de verdade (SQLite temporario), relogio por data futura fixa, CE simulado. Pedido da Lisboa de 16/10/2026: Suelen 12-21h, Adriana 12-21h, Talita 8-17h.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-jornada-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ---- CE simulado: /available-hours devolve as celulas de 15 min livres do dia, por profissional ----
let ceMode = "livre"; // livre | sem15h | erro500
const ceCalls = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const cells = (skip = () => false) => {
  const out = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const hh = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (!skip(m)) out.push(hh);
  }
  return out;
};
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname.includes("clinicaexperts")) {
    ceCalls.push(u.pathname);
    if (u.pathname.endsWith("/available-hours")) {
      if (ceMode === "erro500") return jsonRes(500, { message: "indisponivel" });
      if (ceMode === "sem15h") return jsonRes(200, { data: cells((m) => m >= 15 * 60 && m < 16 * 60) });
      return jsonRes(200, { data: cells() });
    }
    return jsonRes(200, { data: [] });
  }
  return jsonRes(200, {});
};

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { findAvailableSlotsOnDay, checkSpecificTime, createBooking, rescheduleBooking, findAvailableDays, findNearestSlots } = await import("../dist/scheduling/slots.js");
const { invalidateCeCache } = await import("../dist/clinicaexperts/availability.js");
const { ajustarJornadasLisboa } = await import("../dist/maintenance/lisboaJornadas.js");
const { syncCatalog } = await import("../dist/clinicaexperts/sync.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

// Dia futuro fixo (4 dias a frente, no fuso de SP). America/Sao_Paulo = UTC-3, sem horario de verao.
const TZ = "America/Sao_Paulo";
const dayIso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 4 * 24 * 3_600_000));
const [Y, M, D] = dayIso.split("-").map(Number);
const DAY = { year: Y, month: M, day: D };
const localUtc = (h, m = 0, dayOffset = 0) => new Date(Date.UTC(Y, M - 1, D + dayOffset, h + 3, m));
const hhmmSP = (d) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const wdOfDay = new Date(Date.UTC(Y, M - 1, D, 12)).getUTCDay();

async function mkClinic(name, extra = {}) {
  return prisma.clinic.create({
    data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, closedOnHolidays: false, ...extra },
  });
}
async function mkPro(clinic, name, data = {}) {
  return prisma.professional.create({ data: { clinicId: clinic.id, name, active: true, ...data } });
}
async function mkProc(clinic, name, durationMin, pros = []) {
  return prisma.procedure.create({ data: { clinicId: clinic.id, name, durationMin, professionals: { connect: pros.map((p) => ({ id: p.id })) } } });
}
let n = 0;
const mkPatient = (clinic) => prisma.patient.create({ data: { clinicId: clinic.id, name: `Pessoa ${++n}`, phone: `5511977${String(70000 + n)}` } });
const startsOf = (slots, name) => slots.filter((s) => s.professionalName === name).map((s) => hhmmSP(s.start)).sort();

// ============ Lisboa-like: Suelen 12-21, Adriana 12-21, Talita 8-17 ============
const lisboa = await mkClinic("Lisboa Teste Jornada");
const suelen = await mkPro(lisboa, "Suelen", { workStartHour: 12, workEndHour: 21 });
const adriana = await mkPro(lisboa, "Adriana", { workStartHour: 12, workEndHour: 21 });
const talita = await mkPro(lisboa, "Talita", { workStartHour: 8, workEndHour: 17 });
const aline = await mkPro(lisboa, "Aline", { workStartHour: 8, workEndHour: 21 }); // ativa, mas NAO habilitada nos procedimentos abaixo
const drenagem = await mkProc(lisboa, "Drenagem", 60, [suelen, adriana, talita]);
const massagem = await mkProc(lisboa, "Massagem 90", 90, [suelen, adriana, talita]);

test("jornadas: ninguem recebe oferta antes do inicio nem com o atendimento passando do fim (60 min)", async () => {
  const slots = await findAvailableSlotsOnDay(lisboa.id, drenagem.id, DAY, { professionalIds: [suelen.id, adriana.id, talita.id] });
  const horas = (nome) => startsOf(slots, nome);
  assert.deepEqual(horas("Suelen"), ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"], "Suelen: 12h-21h, ultimo inicio 20h (termina 21h)");
  assert.deepEqual(horas("Adriana"), horas("Suelen"));
  assert.deepEqual(horas("Talita"), ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"], "Talita: 8h-17h, ultimo inicio 16h");
  assert.ok(!slots.some((s) => s.professionalName === "Aline"), "profissional nao habilitada nao aparece");
});

test("jornadas: a DURACAO INTEIRA tem que caber (90 min) e 20h30 + 60 min nao e oferecido a quem encerra as 21h", async () => {
  const slots = await findAvailableSlotsOnDay(lisboa.id, massagem.id, DAY, { professionalIds: [suelen.id, talita.id] });
  assert.deepEqual(startsOf(slots, "Suelen").at(-1), "19:00", "19h + 90 min = 20h30 cabe; 20h + 90 min = 21h30 nao");
  assert.deepEqual(startsOf(slots, "Talita").at(-1), "15:00");
  const c = await checkSpecificTime(lisboa.id, drenagem.id, { ...DAY, hour: 20, minute: 30 }, { professionalIds: [suelen.id] });
  assert.equal(c.available, false);
  assert.equal(c.reason, "outside_hours");
  const ok = await checkSpecificTime(lisboa.id, drenagem.id, { ...DAY, hour: 20, minute: 0 }, { professionalIds: [suelen.id] });
  assert.equal(ok.available, true);
  const talita1630 = await checkSpecificTime(lisboa.id, drenagem.id, { ...DAY, hour: 16, minute: 30 }, { professionalIds: [talita.id] });
  assert.equal(talita1630.available, false);
  assert.equal(talita1630.reason, "outside_hours");
  const antes = await checkSpecificTime(lisboa.id, drenagem.id, { ...DAY, hour: 11, minute: 0 }, { professionalIds: [suelen.id, adriana.id, talita.id] });
  assert.deepEqual(antes.availableProfessionals.map((p) => p.name), ["Talita"], "as 11h so a Talita (as outras comecam as 12h)");
});

test("createBooking e rescheduleBooking recusam fora da jornada MESMO chamados direto (o texto nao e a unica barreira)", async () => {
  const p = await mkPatient(lisboa);
  const fora = await createBooking({ clinicId: lisboa.id, patientId: p.id, procedureId: drenagem.id, professionalId: suelen.id, startUtc: localUtc(20, 30) });
  assert.deepEqual(fora, { ok: false, error: "outside_hours" });
  const antes = await createBooking({ clinicId: lisboa.id, patientId: p.id, procedureId: drenagem.id, professionalId: suelen.id, startUtc: localUtc(11, 0) });
  assert.deepEqual(antes, { ok: false, error: "outside_hours" });
  const dentro = await createBooking({ clinicId: lisboa.id, patientId: p.id, procedureId: drenagem.id, professionalId: suelen.id, startUtc: localUtc(20, 0) });
  assert.equal(dentro.ok, true);
  // remarcar: preserva procedimento, profissional e duracao; recusa o que termina depois das 21h; nao cria segunda reserva
  const total = () => prisma.appointment.count({ where: { clinicId: lisboa.id, patientId: p.id } });
  assert.equal(await total(), 1);
  const r1 = await rescheduleBooking({ clinicId: lisboa.id, appointmentId: dentro.appointmentId, startUtc: localUtc(20, 30) });
  assert.deepEqual(r1, { ok: false, error: "outside_hours" });
  const r2 = await rescheduleBooking({ clinicId: lisboa.id, appointmentId: dentro.appointmentId, startUtc: localUtc(14, 0) });
  assert.equal(r2.ok, true);
  assert.equal(r2.before.scheduledAt.getTime(), localUtc(20, 0).getTime(), "devolve o horario anterior (para desfazer se o CE recusar)");
  const depois = await prisma.appointment.findUnique({ where: { id: dentro.appointmentId } });
  assert.equal(depois.scheduledAt.getTime(), localUtc(14, 0).getTime());
  assert.equal(depois.procedureId, drenagem.id);
  assert.equal(depois.professionalId, suelen.id);
  assert.equal(await total(), 1, "nao criou uma segunda reserva");
});

test("remarcar para horario que outra pessoa pegou depois da consulta: a gravacao revalida e recusa (conflict)", async () => {
  const a = await mkPatient(lisboa);
  const b = await mkPatient(lisboa);
  const dentro = await createBooking({ clinicId: lisboa.id, patientId: a.id, procedureId: drenagem.id, professionalId: adriana.id, startUtc: localUtc(13, 0) });
  assert.equal(dentro.ok, true);
  // a consulta de disponibilidade disse que 15h estava livre ...
  assert.equal((await checkSpecificTime(lisboa.id, drenagem.id, { ...DAY, hour: 15 }, { professionalIds: [adriana.id], ignoreAppointmentId: dentro.appointmentId })).available, true);
  // ... mas ate a gravacao outra pessoa ocupou
  const outra = await createBooking({ clinicId: lisboa.id, patientId: b.id, procedureId: drenagem.id, professionalId: adriana.id, startUtc: localUtc(15, 0) });
  assert.equal(outra.ok, true);
  const r = await rescheduleBooking({ clinicId: lisboa.id, appointmentId: dentro.appointmentId, startUtc: localUtc(15, 0) });
  assert.deepEqual(r, { ok: false, error: "conflict" });
  assert.equal((await prisma.appointment.findUnique({ where: { id: dentro.appointmentId } })).scheduledAt.getTime(), localUtc(13, 0).getTime(), "continua no horario antigo");
});

test("intervalo, dia nao trabalhado e bloqueio sao respeitados", async () => {
  const c = await mkClinic("Clinica Intervalos");
  const pro = await mkPro(c, "Bia", { workStartHour: 8, workEndHour: 17, lunchStartHour: 12, lunchEndHour: 13 });
  const proc = await mkProc(c, "Limpeza", 60, [pro]);
  const slots = await findAvailableSlotsOnDay(c.id, proc.id, DAY, { professionalIds: [pro.id] });
  const horas = startsOf(slots, "Bia");
  assert.ok(!horas.includes("12:00"), "almoco 12-13 fora");
  assert.ok(horas.includes("11:00") && horas.includes("13:00"));
  assert.equal((await checkSpecificTime(c.id, proc.id, { ...DAY, hour: 11, minute: 30 }, { professionalIds: [pro.id] })).reason, "lunch_break");
  // bloqueio de agenda dela
  await prisma.scheduleBlock.create({ data: { clinicId: c.id, professionalId: pro.id, startsAt: localUtc(14, 0), endsAt: localUtc(16, 0), reason: "folga" } });
  const comBloqueio = startsOf(await findAvailableSlotsOnDay(c.id, proc.id, DAY, { professionalIds: [pro.id] }), "Bia");
  assert.ok(!comBloqueio.includes("14:00") && !comBloqueio.includes("15:00") && comBloqueio.includes("16:00"));
  assert.equal((await checkSpecificTime(c.id, proc.id, { ...DAY, hour: 14 }, { professionalIds: [pro.id] })).reason, "blocked");
  // dia da semana que ela nao trabalha
  const semDia = await mkPro(c, "Carol", { workStartHour: 8, workEndHour: 17, workDays: [0, 1, 2, 3, 4, 5, 6].filter((x) => x !== wdOfDay).join(",") });
  const proc2 = await mkProc(c, "Peeling", 60, [semDia]);
  assert.deepEqual(await findAvailableSlotsOnDay(c.id, proc2.id, DAY, { professionalIds: [semDia.id] }), []);
  assert.equal((await checkSpecificTime(c.id, proc2.id, { ...DAY, hour: 10 }, { professionalIds: [semDia.id] })).reason, "closed_day");
});

test("PROFISSIONAL NAO HABILITADA: nenhuma oferta, nenhuma checagem positiva e nenhuma reserva (mesmo com o id escolhido pelo modelo)", async () => {
  assert.deepEqual(await findAvailableSlotsOnDay(lisboa.id, drenagem.id, DAY, { professionalIds: [aline.id] }), []);
  const c = await checkSpecificTime(lisboa.id, drenagem.id, { ...DAY, hour: 14 }, { professionalIds: [aline.id] });
  assert.equal(c.available, false);
  assert.equal(c.reason, "professional_not_eligible");
  const p = await mkPatient(lisboa);
  assert.deepEqual(await createBooking({ clinicId: lisboa.id, patientId: p.id, procedureId: drenagem.id, professionalId: aline.id, startUtc: localUtc(14) }), { ok: false, error: "professional_not_eligible" });
  // sem profissional nenhuma, num procedimento que tem habilitadas: tambem recusa (nao cai na agenda da clinica inteira)
  assert.deepEqual(await createBooking({ clinicId: lisboa.id, patientId: p.id, procedureId: drenagem.id, professionalId: null, startUtc: localUtc(14) }), { ok: false, error: "professional_required" });
  assert.equal(await prisma.appointment.count({ where: { clinicId: lisboa.id, patientId: p.id } }), 0);
});

test("clinica com agenda no CE e procedimento SEM profissional habilitada: sem oferta (ausencia de vinculo nao autoriza qualquer profissional); clinica sem CE segue como antes", async () => {
  const ceClinic = await mkClinic("Clinica Com CE");
  await prisma.clinicaExpertsAccount.create({ data: { clinicId: ceClinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
  await mkPro(ceClinic, "Fabiola", { ceUuid: "pro-fab", workStartHour: 8, workEndHour: 18 });
  const semVinculo = await mkProc(ceClinic, "Laser", 60, []);
  assert.deepEqual(await findAvailableSlotsOnDay(ceClinic.id, semVinculo.id, DAY, {}), []);
  assert.deepEqual(await findNearestSlots(ceClinic.id, semVinculo.id, {}), []);
  assert.deepEqual(await findAvailableDays(ceClinic.id, semVinculo.id, {}), []);
  const p = await mkPatient(ceClinic);
  assert.deepEqual(await createBooking({ clinicId: ceClinic.id, patientId: p.id, procedureId: semVinculo.id, professionalId: null, startUtc: localUtc(10) }), { ok: false, error: "no_professional" });
  assert.equal((await checkSpecificTime(ceClinic.id, semVinculo.id, { ...DAY, hour: 10 }, {})).reason, "no_professional");

  // clinica sem CE e sem profissionais cadastradas: agenda unica da clinica (comportamento anterior preservado)
  const pequena = await mkClinic("Clinica Pequena", { workStartHour: 9, workEndHour: 18 });
  const proc = await mkProc(pequena, "Consulta", 60, []);
  const slots = await findAvailableSlotsOnDay(pequena.id, proc.id, DAY, {});
  assert.deepEqual(slots.map((s) => hhmmSP(s.start)), ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
  const q = await mkPatient(pequena);
  assert.equal((await createBooking({ clinicId: pequena.id, patientId: q.id, procedureId: proc.id, professionalId: null, startUtc: localUtc(17) })).ok, true);
  assert.equal((await createBooking({ clinicId: pequena.id, patientId: q.id, procedureId: proc.id, professionalId: null, startUtc: localUtc(18) })).error, "outside_hours");

  // clinica sem CE com profissionais, mas procedimento sem vinculo: segue permissiva (nada muda para quem nao usa CE)
  const mista = await mkClinic("Clinica Mista", { workStartHour: 9, workEndHour: 12 });
  await mkPro(mista, "Dani", { workStartHour: 9, workEndHour: 12 });
  const procM = await mkProc(mista, "Avaliacao", 30, []);
  assert.ok((await findAvailableSlotsOnDay(mista.id, procM.id, DAY, {})).length > 0);
});

test("cadastro CONFLITANTE bloqueia so aquela profissional (e o motivo fica no diario); as demais seguem", async () => {
  const c = await mkClinic("Clinica Conflito");
  const boa = await mkPro(c, "Boa", { workStartHour: 9, workEndHour: 18 });
  const invertida = await mkPro(c, "Invertida", { workStartHour: 18, workEndHour: 9 });
  const intervalo = await mkPro(c, "IntervaloRuim", { workStartHour: 9, workEndHour: 18, lunchStartHour: 14, lunchEndHour: 12 });
  const proc = await mkProc(c, "Facial", 60, [boa, invertida, intervalo]);
  const slots = await findAvailableSlotsOnDay(c.id, proc.id, DAY, {});
  assert.deepEqual([...new Set(slots.map((s) => s.professionalName))], ["Boa"]);
  const p = await mkPatient(c);
  assert.deepEqual(await createBooking({ clinicId: c.id, patientId: p.id, procedureId: proc.id, professionalId: invertida.id, startUtc: localUtc(10) }), { ok: false, error: "professional_not_eligible" });
  assert.equal((await createBooking({ clinicId: c.id, patientId: p.id, procedureId: proc.id, professionalId: boa.id, startUtc: localUtc(10) })).ok, true);
  for (let i = 0; i < 30 && (await prisma.activityLog.count({ where: { clinicId: c.id, type: "agenda_conflict" } })) < 2; i++) await new Promise((r) => setTimeout(r, 100));
  const logs = await prisma.activityLog.findMany({ where: { clinicId: c.id, type: "agenda_conflict" } });
  assert.ok(logs.some((l) => /Invertida/.test(l.description ?? "")) && logs.some((l) => /IntervaloRuim/.test(l.description ?? "")));
});

// ============ Clinica Experts: a jornada e a verdade do cadastro; o CE confirma disponibilidade ============
const ceClin = await mkClinic("Lisboa Teste CE");
await prisma.clinicaExpertsAccount.create({ data: { clinicId: ceClin.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const sueC = await mkPro(ceClin, "Suelen", { ceUuid: "pro-suelen", workStartHour: 12, workEndHour: 21 });
const procC = await mkProc(ceClin, "Drenagem", 60, [sueC]);

test("CE LIVRE mas FORA da jornada: recusa; jornada livre mas CE OCUPADO: recusa; os dois livres: oferece", async () => {
  invalidateCeCache(ceClin.id);
  ceMode = "livre";
  const cedo = await checkSpecificTime(ceClin.id, procC.id, { ...DAY, hour: 11 }, { professionalIds: [sueC.id] });
  assert.equal(cedo.available, false, "CE diz livre as 11h, mas a jornada dela comeca as 12h");
  assert.equal(cedo.reason, "outside_hours");
  const tarde = await checkSpecificTime(ceClin.id, procC.id, { ...DAY, hour: 20, minute: 30 }, { professionalIds: [sueC.id] });
  assert.equal(tarde.available, false);
  assert.equal(tarde.reason, "outside_hours");
  assert.equal((await checkSpecificTime(ceClin.id, procC.id, { ...DAY, hour: 14 }, { professionalIds: [sueC.id] })).available, true);
  invalidateCeCache(ceClin.id);
  ceMode = "sem15h";
  const ocupado = await checkSpecificTime(ceClin.id, procC.id, { ...DAY, hour: 15 }, { professionalIds: [sueC.id] });
  assert.equal(ocupado.available, false, "jornada livre as 15h, mas o CE nao tem a celula");
  assert.equal(ocupado.reason, "conflict");
  const p = await mkPatient(ceClin);
  assert.deepEqual(await createBooking({ clinicId: ceClin.id, patientId: p.id, procedureId: procC.id, professionalId: sueC.id, startUtc: localUtc(15) }), { ok: false, error: "conflict" });
  const oferta = startsOf(await findAvailableSlotsOnDay(ceClin.id, procC.id, DAY, {}), "Suelen");
  assert.ok(!oferta.includes("15:00") && !oferta.includes("15:30") && !oferta.includes("14:30"), "nenhuma celula de 60 min que encosta nas 15h-16h");
  assert.ok(oferta.every((h) => h >= "12:00" && h <= "20:00"));
});

test("CE sem resposta: NAO oferece e NAO reserva (antes oferecia sem conferir); o escape CE_GATE_FAIL_OPEN volta ao comportamento antigo", async () => {
  invalidateCeCache(ceClin.id);
  ceMode = "erro500";
  const slots = await findAvailableSlotsOnDay(ceClin.id, procC.id, DAY, {});
  assert.deepEqual(slots, []);
  const c = await checkSpecificTime(ceClin.id, procC.id, { ...DAY, hour: 14 }, { professionalIds: [sueC.id] });
  assert.equal(c.available, false);
  assert.equal(c.reason, "ce_unavailable");
  const p = await mkPatient(ceClin);
  assert.deepEqual(await createBooking({ clinicId: ceClin.id, patientId: p.id, procedureId: procC.id, professionalId: sueC.id, startUtc: localUtc(14) }), { ok: false, error: "ce_unavailable" });
  assert.equal(await prisma.appointment.count({ where: { patientId: p.id } }), 0);
  // o CE volta: oferece de novo (a falha nao fica "grudada")
  ceMode = "livre";
  await new Promise((r) => setTimeout(r, 10_100)); // a falha so e lembrada por 10 s
  invalidateCeCache(ceClin.id);
  assert.ok((await findAvailableSlotsOnDay(ceClin.id, procC.id, DAY, {})).length > 0);
  // escape
  invalidateCeCache(ceClin.id);
  ceMode = "erro500";
  process.env.CE_GATE_FAIL_OPEN = "on";
  try {
    assert.ok((await findAvailableSlotsOnDay(ceClin.id, procC.id, DAY, {})).length > 0, "com o escape ligado, volta a nao bloquear");
  } finally {
    delete process.env.CE_GATE_FAIL_OPEN;
    invalidateCeCache(ceClin.id);
    ceMode = "livre";
  }
});

test("clinica A nao herda a jornada da clinica B (cada uma com a sua)", async () => {
  const a = await mkClinic("Outra Clinica A");
  const b = await mkClinic("Outra Clinica B");
  const pa = await mkPro(a, "Suelen", { workStartHour: 9, workEndHour: 14 }); // mesmo nome da Lisboa, jornada propria
  const pb = await mkPro(b, "Suelen", { workStartHour: 15, workEndHour: 20 });
  const procA = await mkProc(a, "X", 60, [pa]);
  const procB = await mkProc(b, "X", 60, [pb]);
  assert.equal(startsOf(await findAvailableSlotsOnDay(a.id, procA.id, DAY, {}), "Suelen")[0], "09:00");
  assert.equal(startsOf(await findAvailableSlotsOnDay(b.id, procB.id, DAY, {}), "Suelen")[0], "15:00");
  assert.equal(startsOf(await findAvailableSlotsOnDay(lisboa.id, drenagem.id, DAY, {}), "Suelen")[0], "12:00");
});

// ============ Atualizacao cadastral da Lisboa (previa, identidade, idempotencia) ============
test("Lisboa: a PREVIA mostra o que muda sem gravar; aplicar atualiza so inicio/fim e e idempotente; dias e intervalo ficam como estao", async () => {
  const c = await mkClinic("Lisboa Beauty Center", { lunchStartHour: 12, lunchEndHour: 13 });
  const s = await mkPro(c, "Suelen", { workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5" });
  const ad = await mkPro(c, "Adriana");
  const t = await mkPro(c, "Dra. Talita Souza", { workStartHour: 10, workEndHour: 19, lunchStartHour: 13, lunchEndHour: 14 });
  const outra = await mkPro(c, "Aline", { workStartHour: 9, workEndHour: 18 });
  const outraClinica = await mkClinic("Outra Clinica Qualquer");
  const sOutra = await mkPro(outraClinica, "Suelen", { workStartHour: 7, workEndHour: 11 });

  const previa = await ajustarJornadasLisboa(c.id, { dryRun: true });
  assert.equal(previa.dryRun, true);
  assert.deepEqual(previa.itens.map((i) => [i.alvo, i.status]), [["Suelen", "atualizar"], ["Adriana", "atualizar"], ["Talita", "atualizar"]]);
  assert.equal(previa.itens[0].antes, "09:00-18:00");
  assert.equal(previa.itens[0].jornadaNova, "12:00-21:00");
  assert.equal(previa.itens[1].antes, "herda da clínica");
  assert.equal(previa.itens[2].profissional, "Dra. Talita Souza", "acha por primeiro nome sem o tratamento");
  assert.ok(previa.itens[0].conflitos.some((x) => /Intervalo herdado da clínica 12:00-13:00 cobre o INÍCIO/.test(x)), "o almoco da clinica cobre o inicio da jornada: sinalizado");
  assert.ok(previa.itens[2].conflitos.some((x) => /Não alterado: dias herdados da clínica e intervalo próprio/.test(x)));
  assert.equal((await prisma.professional.findUnique({ where: { id: s.id } })).workStartHour, 9, "previa nao grava");

  const aplicada = await ajustarJornadasLisboa(c.id, { dryRun: false, actorName: "Admin" });
  assert.equal(aplicada.atualizadas, 3);
  const depois = async (p) => prisma.professional.findUnique({ where: { id: p.id } });
  assert.deepEqual([(await depois(s)).workStartHour, (await depois(s)).workEndHour], [12, 21]);
  assert.equal((await depois(s)).workDays, "1,2,3,4,5", "dias trabalhados preservados");
  assert.deepEqual([(await depois(ad)).workStartHour, (await depois(ad)).workEndHour], [12, 21]);
  assert.deepEqual([(await depois(t)).workStartHour, (await depois(t)).workEndHour, (await depois(t)).lunchStartHour], [8, 17, 13], "intervalo proprio preservado");
  assert.equal((await depois(outra)).workStartHour, 9, "outra profissional intocada");
  assert.equal((await prisma.professional.findUnique({ where: { id: sOutra.id } })).workStartHour, 7, "profissional de OUTRA clinica intocada");
  assert.ok(await prisma.activityLog.findFirst({ where: { clinicId: c.id, type: "professional_hours_updated" } }));

  const de_novo = await ajustarJornadasLisboa(c.id, { dryRun: false });
  assert.equal(de_novo.atualizadas, 0);
  assert.ok(de_novo.itens.every((i) => i.status === "sem_mudanca"), "idempotente");
});

test("Lisboa: identidade AMBIGUA nao e adivinhada (duas Suelen ativas = pendencia com os dados); so inativa = pendencia; escolha explicita resolve; id de outra clinica e recusado", async () => {
  const c = await mkClinic("Lisboa Beauty Center");
  const s1 = await mkPro(c, "Suelen", { ceUuid: "ce-s1", workStartHour: 9, workEndHour: 18 });
  const s2 = await mkPro(c, "Suelen Oliveira", { workStartHour: 10, workEndHour: 19 });
  await mkPro(c, "Adriana", { active: false });
  const t = await mkPro(c, "Talita");
  const previa = await ajustarJornadasLisboa(c.id, { dryRun: false });
  const suelenItem = previa.itens.find((i) => i.alvo === "Suelen");
  assert.equal(suelenItem.status, "pendente");
  assert.match(suelenItem.pendencia, /Mais de uma profissional ATIVA chamada Suelen/);
  assert.equal(suelenItem.candidatas.length, 2);
  assert.ok(suelenItem.candidatas.some((x) => x.id === s1.id && x.vinculadaAoCE) && suelenItem.candidatas.some((x) => x.id === s2.id && !x.vinculadaAoCE));
  assert.equal(previa.itens.find((i) => i.alvo === "Adriana").status, "pendente");
  assert.match(previa.itens.find((i) => i.alvo === "Adriana").pendencia, /INATIVO/);
  assert.equal(previa.itens.find((i) => i.alvo === "Talita").status, "atualizar");
  assert.equal(previa.atualizadas, 1, "so a Talita (sem ambiguidade) foi alterada");
  assert.equal((await prisma.professional.findUnique({ where: { id: s1.id } })).workStartHour, 9, "nenhuma das duas Suelen foi alterada");
  assert.equal((await prisma.professional.findUnique({ where: { id: s2.id } })).workStartHour, 10);
  assert.equal((await prisma.professional.findUnique({ where: { id: t.id } })).workStartHour, 8);
  // escolha explicita
  const escolhida = await ajustarJornadasLisboa(c.id, { dryRun: false, escolhas: { suelen: s1.id } });
  assert.equal(escolhida.itens.find((i) => i.alvo === "Suelen").status, "atualizar");
  assert.equal((await prisma.professional.findUnique({ where: { id: s1.id } })).workStartHour, 12);
  assert.equal((await prisma.professional.findUnique({ where: { id: s2.id } })).workStartHour, 10, "a outra continua intacta");
  // id de outra clinica ou de outro nome: recusado
  const outra = await mkClinic("Outra");
  const estranha = await mkPro(outra, "Suelen");
  const recusada = await ajustarJornadasLisboa(c.id, { dryRun: false, escolhas: { suelen: estranha.id } });
  assert.equal(recusada.itens.find((i) => i.alvo === "Suelen").status, "pendente");
  assert.equal((await prisma.professional.findUnique({ where: { id: estranha.id } })).workStartHour, null);
});

test("Lisboa: agendamentos futuros que ficam fora da nova jornada sao SINALIZADOS (nao alterados)", async () => {
  const c = await mkClinic("Lisboa Beauty Center");
  const s = await mkPro(c, "Suelen", { workStartHour: 8, workEndHour: 18 });
  await mkPro(c, "Adriana");
  await mkPro(c, "Talita");
  const proc = await mkProc(c, "Facial", 60, [s]);
  const p = await mkPatient(c);
  const manha = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, professionalId: s.id, scheduledAt: localUtc(9, 0), status: "confirmed" } });
  const previa = await ajustarJornadasLisboa(c.id, { dryRun: true });
  const it = previa.itens.find((i) => i.alvo === "Suelen");
  assert.ok(it.conflitos.some((x) => /1 agendamento\(s\) futuro\(s\) dela ficam FORA da nova jornada/.test(x)), JSON.stringify(it.conflitos));
  await ajustarJornadasLisboa(c.id, { dryRun: false });
  assert.equal((await prisma.appointment.findUnique({ where: { id: manha.id } })).scheduledAt.getTime(), localUtc(9, 0).getTime(), "o agendamento nao foi mexido");
});

test("a importacao do catalogo do Clinica Experts NAO restaura jornada antiga (so cria/vincula profissional)", async () => {
  const c = await mkClinic("Lisboa Beauty Center");
  await prisma.clinicaExpertsAccount.create({ data: { clinicId: c.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
  const s = await mkPro(c, "Suelen", { workStartHour: 12, workEndHour: 21 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/professionals")) return jsonRes(200, { data: [{ uuid: "ce-suelen", name: "Suelen Souza", first_name: "Suelen", active: true, color: null }], meta: { last_page: 1 } });
    if (u.pathname.endsWith("/procedures")) return jsonRes(200, { data: [], meta: { last_page: 1 } });
    return jsonRes(200, { data: [] });
  };
  try {
    await syncCatalog(c.id);
  } finally {
    globalThis.fetch = realFetch;
  }
  const depois = await prisma.professional.findUnique({ where: { id: s.id } });
  assert.deepEqual([depois.workStartHour, depois.workEndHour], [12, 21]);
  assert.equal(depois.ceUuid, "ce-suelen", "vinculou sem recriar nem mexer na jornada");
  assert.equal(await prisma.professional.count({ where: { clinicId: c.id } }), 1, "sem duplicata");
});
