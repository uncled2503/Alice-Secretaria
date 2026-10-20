// IMPORTACAO do Clinica Experts (pullClinicBookings) com banco de verdade e o CE simulado: paginacao, reservas ilegiveis, estados desconhecidos, atualizacao de profissional/fim/
// procedimentos, identidade (telefone compartilhado vira acompanhante, sem sobrescrever o uuid), mesmo horario com profissionais diferentes, cancelamento x reativacao pela VERSAO,
// atendimentos registrados tarde e horario sem fuso lido no fuso da clinica.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-ce-importacao-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const client = await import("../dist/clinicaexperts/client.js");
const { pullClinicBookings } = await import("../dist/clinicaexperts/pull.js");
const { recoverLateStatuses } = await import("../dist/clinicaexperts/liveCheck.js");
const { reservationEndMs } = await import("../dist/scheduling/reservation.js");
const { drainBackground } = await import("../dist/jobs/background.js");

test.after(async () => {
  await drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const HOUR = 3_600_000;
const clinic = await prisma.clinic.create({ data: { name: "Clinica Importacao", whatsappPhone: "5511900000001", timezone: "America/Sao_Paulo" } });
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const botox = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Botox", durationMin: 30, ceId: 11 } });
const peeling = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Peeling", durationMin: 45, ceId: 22 } });
const amanda = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Amanda", ceUuid: "pro-amanda" } });
const bia = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Bia", ceUuid: "pro-bia" } });

// ---- CE simulado ----
let store = [];
let pageSize = 1000;
const patches = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  if (u.hostname.endsWith("uazapi.com")) return jsonRes(200, {});
  const m = /\/bookings\/([^/]+)(\/cancel|\/confirm)?$/.exec(u.pathname);
  if (m) {
    const b = store.find((x) => x.uuid === m[1]);
    if (!b) return jsonRes(404, {});
    if (method === "PATCH") { patches.push(`${method} ${m[2]}`); if (m[2] === "/cancel") b.status = "canceled"; return jsonRes(200, { data: b }); }
    return jsonRes(200, { data: b });
  }
  if (u.pathname.endsWith("/bookings") && method === "GET") {
    const from = Date.parse(u.searchParams.get("starts_at")), to = Date.parse(u.searchParams.get("ends_at"));
    const inDay = store.filter((b) => b.__inList !== false && Date.parse(b.starts_at) >= from && Date.parse(b.starts_at) <= to);
    const page = Number(u.searchParams.get("page") ?? 1);
    const pages = Math.max(1, Math.ceil(inDay.length / pageSize));
    return jsonRes(200, { data: inDay.slice((page - 1) * pageSize, page * pageSize).map(({ __inList, ...r }) => r), meta: { page: String(page), last_page: String(pages), of: String(inDay.length), per_page: String(pageSize) } });
  }
  return jsonRes(404, {});
};
let seq = 0;
const base = new Date(Math.ceil((Date.now() + 30 * HOUR) / 900_000) * 900_000); // amanha, dentro da janela de importacao e no futuro
function cb(over = {}) {
  seq++;
  const start = over.start ?? new Date(base.getTime() + seq * 15 * 60_000);
  const { start: _s, ...rest } = over;
  return {
    uuid: `ce-${seq}`, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(), status: "scheduled", updated_at: new Date().toISOString(),
    patient: { uuid: `ce-pac-${seq}`, name: `Paciente ${seq} Silva`, phone: `+55 11 9${String(70000000 + seq)}` }, professional: { uuid: "pro-amanda" }, procedures: [{ id: 11, name: "Botox", duration: 30 }], ...rest,
  };
}
async function pull(rows) { store = rows; patches.length = 0; client.resetCeRateLimitForTests(); const r = await pullClinicBookings(clinic.id); await drainBackground(); return r; }
const byUuid = (uuid) => prisma.appointment.findFirst({ where: { clinicId: clinic.id, ceBookingUuid: uuid }, include: { procedures: { orderBy: { position: "asc" } }, patient: true, attendee: true } });

test("paginacao: reservas do mesmo dia em varias paginas sao TODAS importadas (nao confia em per_page)", async () => {
  pageSize = 2;
  const rows = [cb(), cb(), cb(), cb(), cb()];
  const r = await pull(rows);
  pageSize = 1000;
  assert.equal(r.error, undefined);
  assert.equal(r.created, 5);
  assert.equal(r.incompleteDays, 0);
  for (const b of rows) assert.ok(await byUuid(b.uuid), b.uuid);
});

test("reserva ilegivel (200 sem campos essenciais) e ignorada: nada criado, nada cancelado; tudo ilegivel = erro sem alterar", async () => {
  const bom = cb();
  const r = await pull([bom, { uuid: "so-uuid", starts_at: bom.starts_at }, { starts_at: bom.starts_at, status: "scheduled" }]);
  assert.equal(r.invalid, 2);
  assert.equal(r.created, 1);
  assert.ok(await byUuid(bom.uuid));
  const antes = await prisma.appointment.count({ where: { clinicId: clinic.id } });
  const r2 = await pull([{ uuid: "x", starts_at: bom.starts_at }, { foo: 1, starts_at: bom.starts_at }]);
  assert.match(r2.error ?? "", /formato nao reconhecido/);
  assert.equal(await prisma.appointment.count({ where: { clinicId: clinic.id } }), antes);
  assert.equal((await byUuid(bom.uuid)).status, "confirmed", "a reserva boa nao foi cancelada por sumir da lista");
});

test("estado desconhecido: nao importa como confirmado; no que ja existe, preserva o estado daqui e guarda o bruto", async () => {
  const novo = cb({ status: "pending_review" });
  const r = await pull([novo]);
  assert.equal(r.created, 0);
  assert.deepEqual(r.unknownStates, ["pending_review"]);
  assert.equal(await byUuid(novo.uuid), null);
  assert.equal(r.skipDetails[0].reason, "estado_desconhecido");

  const ok = cb();
  await pull([ok]);
  const r2 = await pull([{ ...ok, status: "estranho_novo" }]);
  const row = await byUuid(ok.uuid);
  assert.equal(row.status, "confirmed");
  assert.equal(row.ceStatus, "estranho_novo");
  assert.ok(r2.unknownStates.includes("estranho_novo"));
});

test("atualiza profissional, fim, procedimentos (varios) e a versao; a duracao vem do FIM da reserva", async () => {
  const b = cb();
  await pull([b]);
  const novoFim = new Date(Date.parse(b.starts_at) + 90 * 60_000).toISOString();
  await pull([{ ...b, professional: { uuid: "pro-bia" }, ends_at: novoFim, procedures: [{ id: 11, name: "Botox", duration: 30 }, { id: 22, name: "Peeling", duration: 45 }], status: "waiting" }]);
  const row = await byUuid(b.uuid);
  assert.equal(row.professionalId, bia.id);
  assert.equal(row.endsAt.toISOString(), novoFim);
  assert.equal(row.procedures.length, 2);
  assert.deepEqual(row.procedures.map((p) => p.ceProcedureId), [11, 22]);
  assert.equal(row.status, "confirmed");
  assert.equal(row.ceStatus, "waiting");
  assert.equal(reservationEndMs({ scheduledAt: row.scheduledAt, endsAt: row.endsAt, procedure: { durationMin: 30 }, procedures: row.procedures }), Date.parse(novoFim), "ocupa a agenda ate o fim da reserva, nao so a duracao do 1o procedimento");
});

test("sem fim gravado a duracao e a SOMA dos procedimentos da reserva (nao a do primeiro)", () => {
  const start = new Date("2026-10-20T14:00:00Z");
  assert.equal(reservationEndMs({ scheduledAt: start, endsAt: null, procedure: { durationMin: 30 }, procedures: [{ durationMin: 30 }, { durationMin: 45 }] }), start.getTime() + 75 * 60_000);
  assert.equal(reservationEndMs({ scheduledAt: start, endsAt: null, procedure: { durationMin: 30 }, procedures: [] }), start.getTime() + 30 * 60_000);
  assert.equal(reservationEndMs({ scheduledAt: start, endsAt: new Date(start.getTime() - 1), procedure: { durationMin: 30 } }), start.getTime() + 30 * 60_000, "fim invalido (antes do inicio) e ignorado");
});

test("troca de horario no CE: a confirmacao do horario antigo cai e o fim acompanha (mantem a duracao)", async () => {
  const b = cb();
  await pull([b]);
  const row0 = await byUuid(b.uuid);
  await prisma.appointment.update({ where: { id: row0.id }, data: { patientConfirmed: true, confirmedAt: new Date(), cePresenceState: "synced" } });
  const novo = new Date(Date.parse(b.starts_at) + 2 * HOUR);
  await pull([{ ...b, starts_at: novo.toISOString(), ends_at: new Date(novo.getTime() + 30 * 60_000).toISOString() }]);
  const row = await byUuid(b.uuid);
  assert.equal(row.scheduledAt.getTime(), novo.getTime());
  assert.equal(row.patientConfirmed, false);
  assert.equal(row.cePresenceState, null);
  assert.equal(row.endsAt.getTime(), novo.getTime() + 30 * 60_000);
});

test("horario SEM fuso e lido no fuso da clinica (nunca no do servidor), inclusive perto da meia-noite", async () => {
  const start = new Date(base.getTime() + 20 * HOUR); // um instante futuro dentro da janela
  const naive = new Date(start.getTime() - 3 * HOUR).toISOString().slice(0, 19); // parede de Sao Paulo (UTC-3, sem horario de verao)
  const b = cb({ start, starts_at: naive, ends_at: new Date(start.getTime() - 3 * HOUR + 30 * 60_000).toISOString().slice(0, 19) });
  b.starts_at = naive;
  await pull([b]);
  const row = await byUuid(b.uuid);
  assert.equal(row.scheduledAt.getTime(), start.getTime());
});

test("telefone compartilhado, pessoa DIFERENTE: vira acompanhante do contato; o uuid do cadastro existente nunca e sobrescrito", async () => {
  const contato = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Maria Souza", phone: "5511966661111", ceUuid: "ce-maria" } });
  const marido = cb({ patient: { uuid: "ce-carlos", name: "Carlos Souza", phone: "+55 11 96666-1111" } });
  const dela = cb({ patient: { uuid: "ce-maria", name: "Maria Souza", phone: "+55 11 96666-1111" } });
  const r = await pull([marido, dela]);
  assert.equal(r.created, 2);
  const a1 = await byUuid(marido.uuid);
  const a2 = await byUuid(dela.uuid);
  assert.equal(a1.patientId, contato.id);
  assert.ok(a1.attendeeId, "o marido e uma pessoa propria");
  assert.equal(a1.attendee.name, "Carlos Souza");
  assert.equal(a1.attendee.ceUuid, "ce-carlos");
  assert.equal(a2.attendeeId, null);
  assert.equal((await prisma.patient.findUnique({ where: { id: contato.id } })).ceUuid, "ce-maria");
  await pull([marido, dela]);
  assert.equal(await prisma.attendee.count({ where: { clinicId: clinic.id, ceUuid: "ce-carlos" } }), 1, "a segunda importacao nao cria outro acompanhante");
});

test("mesmo telefone em outro formato (com/sem DDI e 9o digito) e a MESMA pessoa: nao duplica o cadastro", async () => {
  const existente = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Joana Prado", phone: "5511988885555", ceUuid: null } });
  const b = cb({ patient: { uuid: "ce-joana", name: "Joana Prado", phone: "11 8888-5555" } }); // sem DDI e sem o 9: o mesmo numero
  await pull([b]);
  const row = await byUuid(b.uuid);
  assert.equal(row.patientId, existente.id);
  assert.equal(await prisma.patient.count({ where: { clinicId: clinic.id, name: "Joana Prado" } }), 1);
  assert.equal((await prisma.patient.findUnique({ where: { id: existente.id } })).ceUuid, "ce-joana");
});

test("mesmo horario com profissionais DIFERENTES sao reservas diferentes (nunca fundidas); a local sem vinculo so liga se combinar em tudo", async () => {
  const pac = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Rita Lopes", phone: "5511977772222", ceUuid: "ce-rita" } });
  const start = new Date(base.getTime() + 22 * HOUR);
  const local = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: pac.id, procedureId: botox.id, professionalId: amanda.id, scheduledAt: start, endsAt: new Date(start.getTime() + 30 * 60_000), source: "whatsapp" } });
  const comBia = cb({ start, patient: { uuid: "ce-rita", name: "Rita Lopes", phone: "+55 11 97777-2222" }, professional: { uuid: "pro-bia" } });
  const r1 = await pull([comBia]);
  assert.equal(r1.created, 1, "profissional diferente = outra reserva");
  assert.equal((await prisma.appointment.findUnique({ where: { id: local.id } })).ceBookingUuid, null);
  const igual = cb({ start, patient: { uuid: "ce-rita", name: "Rita Lopes", phone: "+55 11 97777-2222" }, professional: { uuid: "pro-amanda" } });
  const r2 = await pull([comBia, igual]);
  assert.equal(r2.created, 0);
  assert.equal((await prisma.appointment.findUnique({ where: { id: local.id } })).ceBookingUuid, igual.uuid, "a que combina em tudo e adotada");
});

test("cancelada no CE: cancela aqui com a origem 'ce_cancelada' e o estado do cancelamento confirmado", async () => {
  const b = cb();
  await pull([b]);
  await pull([{ ...b, status: "canceled" }]);
  const row = await byUuid(b.uuid);
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancelSource, "ce_cancelada");
  assert.equal(row.ceCancelState, "confirmed");
});

test("cancelamento NOSSO ainda nao recebido pelo CE: nao reativa, reenvia o cancelamento; se a recepcao mexeu DEPOIS (versao mais nova), reativa", async () => {
  const b = cb();
  await pull([b]);
  const row = await byUuid(b.uuid);
  const quando = new Date(Date.now() - 10 * 60_000);
  await prisma.appointment.update({ where: { id: row.id }, data: { status: "cancelled", cancelledAt: quando, cancelSource: "paciente_whatsapp", ceCancelState: "pending" } });
  // CE ainda ativo e a versao dele e ANTERIOR ao nosso cancelamento
  const r1 = await pull([{ ...b, updated_at: new Date(quando.getTime() - HOUR).toISOString() }]);
  assert.equal(r1.cancelRetried, 1);
  assert.equal(r1.reactivated, 0);
  assert.ok(patches.some((p) => p.includes("/cancel")), "o cancelamento foi reenviado");
  assert.equal((await byUuid(b.uuid)).status, "cancelled");
  // a recepcao reativou/alterou DEPOIS: a versao e mais nova -> vale o CE
  await prisma.appointment.update({ where: { id: row.id }, data: { ceCancelState: "pending" } });
  const r2 = await pull([{ ...b, status: "scheduled", updated_at: new Date(quando.getTime() + 30 * 60_000).toISOString() }]);
  assert.equal(r2.reactivated, 1);
  assert.equal(patches.filter((p) => p.includes("/cancel")).length, 0, "nao recancela o que a recepcao reativou");
  const back = await byUuid(b.uuid);
  assert.equal(back.status, "confirmed");
  assert.equal(back.patientConfirmed, false);
  assert.equal(back.ceCancelState, null);
});

test("cancelada pelo CE e reativada la: volta a valer aqui (reativacao legitima)", async () => {
  const b = cb();
  await pull([b]);
  await pull([{ ...b, status: "canceled" }]);
  const r = await pull([{ ...b, status: "scheduled", updated_at: new Date(Date.now() + 60_000).toISOString() }]);
  assert.equal(r.reactivated, 1);
  assert.equal((await byUuid(b.uuid)).status, "confirmed");
});

test("agendamento que a Alice DESFEZ por falta de resposta do CE e depois aparece la: volta a valer (liga a reserva)", async () => {
  const pac = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Teresa Gomes", phone: "5511955553333", ceUuid: "ce-teresa" } });
  const start = new Date(base.getTime() + 24 * HOUR);
  const desfeito = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: pac.id, procedureId: botox.id, professionalId: amanda.id, scheduledAt: start, endsAt: new Date(start.getTime() + 30 * 60_000), status: "cancelled", cancelSource: "sistema_desfeito", cancelledAt: new Date() } });
  const b = cb({ start, patient: { uuid: "ce-teresa", name: "Teresa Gomes", phone: "+55 11 95555-3333" } });
  const r = await pull([b]);
  assert.equal(r.created, 0);
  const row = await prisma.appointment.findUnique({ where: { id: desfeito.id } });
  assert.equal(row.status, "confirmed");
  assert.equal(row.ceBookingUuid, b.uuid);
});

test("atendimento registrado como concluido DEPOIS da janela: recuperacao limitada, auditavel e sem criar historico", async () => {
  const pac = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Lia Torres", phone: "5511944447777", ceUuid: "ce-lia" } });
  const antigo = new Date(Date.now() - 5 * 24 * HOUR);
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: pac.id, procedureId: botox.id, professionalId: amanda.id, scheduledAt: antigo, endsAt: new Date(antigo.getTime() + 30 * 60_000), ceBookingUuid: "ce-tarde", status: "confirmed" } });
  const muitoAntigo = new Date(Date.now() - 20 * 24 * HOUR);
  const b = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: pac.id, procedureId: botox.id, professionalId: amanda.id, scheduledAt: muitoAntigo, ceBookingUuid: "ce-antigo", status: "confirmed" } });
  store = [
    { uuid: "ce-tarde", starts_at: antigo.toISOString(), ends_at: new Date(antigo.getTime() + 30 * 60_000).toISOString(), status: "done", patient: { uuid: "ce-lia" }, professional: { uuid: "pro-amanda" }, procedures: [{ id: 11 }], __inList: false },
    { uuid: "ce-antigo", starts_at: muitoAntigo.toISOString(), status: "done", __inList: false },
  ];
  client.resetCeRateLimitForTests();
  const r = await recoverLateStatuses(clinic.id, "America/Sao_Paulo");
  assert.equal(r.updated, 1);
  assert.equal((await prisma.appointment.findUnique({ where: { id: a.id } })).status, "completed");
  assert.equal((await prisma.appointment.findUnique({ where: { id: b.id } })).status, "confirmed", "fora do limite de 7 dias: nao varre o historico");
  const log = await prisma.activityLog.findFirst({ where: { clinicId: clinic.id, type: "appointment_completed", patientId: pac.id } });
  assert.match(log?.title ?? "", /registrado depois/);
  const again = await recoverLateStatuses(clinic.id, "America/Sao_Paulo");
  assert.equal(again.updated, 0);
});

test("reserva JA PASSADA que nunca foi importada nao e criada (so serviria para disparar pos/recontato retroativo)", async () => {
  const passada = cb({ start: new Date(Date.now() - 3 * HOUR) });
  const r = await pull([passada]);
  assert.equal(r.created, 0);
  assert.equal(await byUuid(passada.uuid), null);
});
