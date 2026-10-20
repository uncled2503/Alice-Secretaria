// ESCRITA no Clinica Experts com banco de verdade (SQLite temporario) e o CE simulado por um fetch falso.
// Cobre: validacao das respostas (200 vazio/quebrado nao e sucesso), paginacao, identidade do paciente (sem criar duplicata, sem trocar de pessoa),
// criacao com resultado INCERTO (nunca recria; reconcilia pela reserva que combina em tudo), remarcar, cancelar, acompanhante e confirmacao de presenca.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-ce-escrita-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const client = await import("../dist/clinicaexperts/client.js");
const { ensureCePatient } = await import("../dist/clinicaexperts/identity.js");
const sync = await import("../dist/clinicaexperts/sync.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const clinic = await prisma.clinic.create({ data: { name: "Clinica Escrita CE", whatsappPhone: "5511900000000", timezone: "America/Sao_Paulo" } });
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const procedure = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Lavieen", durationMin: 30, ceId: 1013701 } });
const outraProc = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Peeling", durationMin: 30, ceId: 2222 } });
const amanda = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Amanda", ceUuid: "uuid-amanda" } });
const bia = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Bia", ceUuid: "uuid-bia" } });
let phoneSeq = 0;
async function novaPaciente(over = {}) {
  phoneSeq++;
  return prisma.patient.create({ data: { clinicId: clinic.id, name: "Richard Silva Queiroz", phone: `55119999${String(10000 + phoneSeq)}`, ceUuid: `uuid-pac-${phoneSeq}`, ...over } });
}
const HOUR = 3_600_000;
let slot = 0;
const nextStart = () => new Date(Math.ceil((Date.now() + (48 + slot++ * 2) * HOUR) / 900_000) * 900_000);

let handler;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  calls.push(`${method} ${u.pathname}`);
  if (u.hostname.endsWith("uazapi.com")) return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  return handler({ method, path: u.pathname, query: u.searchParams, body: init.body ? JSON.parse(init.body) : null });
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const count = (re) => calls.filter((c) => re.test(c)).length;
function reset(h) { calls.length = 0; handler = h; client.resetCeRateLimitForTests(); }

const ceBooking = (appt, over = {}) => ({
  uuid: "res-1", starts_at: appt.scheduledAt.toISOString(), ends_at: new Date(appt.scheduledAt.getTime() + 30 * 60_000).toISOString(), status: "scheduled",
  updated_at: new Date().toISOString(), patient: { uuid: "uuid-pac", name: "x", phone: "5511999990000" }, professional: { uuid: "uuid-amanda" }, procedures: [{ id: 1013701, name: "Lavieen", duration: 30 }], ...over,
});
async function agendamento(over = {}) {
  const p = over.patient ?? (await novaPaciente());
  const a = await prisma.appointment.create({
    data: { clinicId: clinic.id, patientId: p.id, procedureId: procedure.id, professionalId: amanda.id, scheduledAt: over.start ?? nextStart(), source: "whatsapp", ...(over.data ?? {}) },
  });
  return { a, p };
}
const reload = (id) => prisma.appointment.findUnique({ where: { id } });

// ---------------------------------------------------------------- cliente
test("cliente: HTTP 200 com corpo vazio ou quebrado NAO e sucesso; cada falha tem a sua natureza", async () => {
  const cases = [
    [() => new Response("", { status: 200 }), "invalid_response"],
    [() => new Response("{nao e json", { status: 200 }), "invalid_response"],
    [() => new Response("[]", { status: 200 }), "ok"], // lista vazia valida
    [() => json(401, { message: "Unauthenticated" }), "auth"],
    [() => json(403, { message: "Forbidden" }), "forbidden"],
    [() => json(422, { errors: { professional: ["invalido"] } }), "validation"],
    [() => json(404, {}), "not_found"],
    [() => json(503, {}), "server"],
  ];
  for (const [mk, kind] of cases) {
    reset(() => mk());
    const r = await client.ceRequest(clinic.id, "/qualquer");
    if (kind === "ok") assert.equal(r.ok, true);
    else { assert.equal(r.ok, false, kind); assert.equal(r.kind, kind); }
  }
  reset(() => { throw new Error("socket hang up"); });
  const net = await client.ceRequest(clinic.id, "/qualquer");
  assert.equal(net.kind, "network");
  assert.equal(client.isUncertain(net), true);
  assert.equal(client.isUncertain({ ok: false, kind: "validation" }), false);
  assert.equal(client.isUncertain({ ok: false, kind: "auth" }), false);
  reset(() => new Response(null, { status: 204 }));
  assert.equal((await client.ceRequest(clinic.id, "/x", { method: "PATCH" })).ok, true);
});

test("cliente: 429 pausa a conta (nenhuma chamada nova vai ao CE ate passar o tempo)", async () => {
  reset(() => json(429, { message: "Too Many Requests" }, { "retry-after": "30" }));
  const r1 = await client.ceRequest(clinic.id, "/a");
  assert.equal(r1.kind, "rate_limit");
  const before = calls.length;
  const r2 = await client.ceRequest(clinic.id, "/b");
  assert.equal(r2.kind, "rate_limit");
  assert.equal(calls.length, before, "a segunda chamada nem sai");
  client.resetCeRateLimitForTests();
});

test("paginacao: segue meta.last_page (texto), confere o total e NAO confia em per_page", async () => {
  const pages = { 1: [1, 2], 2: [3, 4], 3: [5] };
  reset(({ query }) => {
    const p = Number(query.get("page"));
    return json(200, { data: pages[p].map((n) => ({ n })), meta: { page: String(p), last_page: "3", of: "5", per_page: "2" } });
  });
  const ok = await client.ceListAll(clinic.id, "/lista", {}, { perPage: 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.items.length, 5);
  assert.equal(ok.complete, true);
  assert.equal(ok.pages, 3);
  assert.equal(count(/GET .*\/lista/), 3);
  // o CE diz que ha 9 e entrega 5: lista INCOMPLETA (quem chama nao conclui "nao existe")
  reset(({ query }) => { const p = Number(query.get("page")); return json(200, { data: pages[p].map((n) => ({ n })), meta: { page: String(p), last_page: "3", of: "9" } }); });
  const inc = await client.ceListAll(clinic.id, "/lista");
  assert.equal(inc.complete, false);
  // sem meta: continua enquanto a pagina vier cheia
  reset(({ query }) => { const p = Number(query.get("page")); return json(200, { data: p === 1 ? [{}, {}] : [{}] }); });
  const semMeta = await client.ceListAll(clinic.id, "/lista", {}, { perPage: 2 });
  assert.equal(semMeta.items.length, 3);
  // corpo sem `data` = invalido, nunca "lista vazia"
  reset(() => json(200, { foo: 1 }));
  const bad = await client.ceListAll(clinic.id, "/lista");
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "invalid_response");
});

// ---------------------------------------------------------------- identidade
test("paciente novo: busca OK sem candidatos -> cria UMA vez e guarda o uuid", async () => {
  const p = await novaPaciente({ ceUuid: null, name: "Joana Prado" });
  reset(({ method, path, body }) => {
    if (method === "GET" && path.endsWith("/patients")) return json(200, { data: [] });
    if (method === "POST" && path.endsWith("/patients")) { assert.equal(body.name, "Joana Prado"); return json(200, { data: { uuid: "novo-uuid" } }); }
    return json(404, {});
  });
  const r = await ensureCePatient(clinic.id, { kind: "patient", id: p.id, name: p.name, phone: p.phone, ceUuid: null });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(count(/POST .*\/patients/), 1);
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).ceUuid, "novo-uuid");
});

test("paciente existente no CE: liga sem criar; busca que FALHOU nao cria cadastro", async () => {
  const p = await novaPaciente({ ceUuid: null, name: "Joana Prado" });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/patients") ? json(200, { data: [{ uuid: "ja-existe", name: "Joana Prado", phone: `+${p.phone}` }] }) : json(404, {})));
  const r = await ensureCePatient(clinic.id, { kind: "patient", id: p.id, name: p.name, phone: p.phone, ceUuid: null });
  assert.equal(r.uuid, "ja-existe");
  assert.equal(count(/POST/), 0);

  const q = await novaPaciente({ ceUuid: null });
  reset(() => json(503, {}));
  const f = await ensureCePatient(clinic.id, { kind: "patient", id: q.id, name: q.name, phone: q.phone, ceUuid: null });
  assert.equal(f.ok, false);
  assert.equal(count(/POST/), 0, "busca que falhou NAO e paciente inexistente: nada e criado");
  assert.equal((await prisma.patient.findUnique({ where: { id: q.id } })).ceUuid, null);
});

test("telefone compartilhado: o nome completo desempata; sem desempate e ambiguo e nada e criado nem ligado", async () => {
  const p = await novaPaciente({ ceUuid: null, name: "Carlos Souza" });
  const lista = [{ uuid: "u-maria", name: "Maria Souza", phone: p.phone }, { uuid: "u-carlos", name: "Carlos Souza", phone: p.phone }];
  reset(({ method, path }) => (method === "GET" && path.endsWith("/patients") ? json(200, { data: lista }) : json(404, {})));
  const r = await ensureCePatient(clinic.id, { kind: "patient", id: p.id, name: "Carlos Souza", phone: p.phone, ceUuid: null });
  assert.equal(r.uuid, "u-carlos");
  const q = await novaPaciente({ ceUuid: null, name: "Carlos" });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/patients") ? json(200, { data: lista.map((x) => ({ ...x, phone: q.phone })) }) : json(404, {})));
  const amb = await ensureCePatient(clinic.id, { kind: "patient", id: q.id, name: "Carlos", phone: q.phone, ceUuid: null });
  assert.equal(amb.ok, false);
  assert.equal(amb.ambiguous.length, 2);
  assert.equal(count(/POST/), 0);
  assert.equal((await prisma.patient.findUnique({ where: { id: q.id } })).ceUuid, null);
});

test("o uuid do CE ja usado por OUTRA pessoa daqui nao e ligado (nunca duas pessoas no mesmo cadastro)", async () => {
  const dono = await novaPaciente({ ceUuid: "uuid-do-dono" });
  const p = await novaPaciente({ ceUuid: null, name: "Outra Pessoa" });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/patients") ? json(200, { data: [{ uuid: "uuid-do-dono", name: "Outra Pessoa", phone: p.phone }] }) : json(404, {})));
  const r = await ensureCePatient(clinic.id, { kind: "patient", id: p.id, name: "Outra Pessoa", phone: p.phone, ceUuid: null });
  assert.equal(r.ok, false);
  assert.equal((await prisma.patient.findUnique({ where: { id: dono.id } })).ceUuid, "uuid-do-dono");
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).ceUuid, null);
});

test("mesmo final de telefone com DDD diferente NAO e o mesmo paciente (nao liga; cria)", async () => {
  const p = await novaPaciente({ ceUuid: null, name: "Pessoa Nova" });
  const outroDdd = `5521${p.phone.slice(4)}`;
  reset(({ method, path }) => {
    if (method === "GET" && path.endsWith("/patients")) return json(200, { data: [{ uuid: "outro-ddd", name: "Pessoa Nova", phone: outroDdd }] });
    if (method === "POST" && path.endsWith("/patients")) return json(200, { data: { uuid: "criado" } });
    return json(404, {});
  });
  const r = await ensureCePatient(clinic.id, { kind: "patient", id: p.id, name: "Pessoa Nova", phone: p.phone, ceUuid: null });
  assert.equal(r.uuid, "criado");
});

test("criacao do paciente com timeout: reconcilia pela busca e NAO cria de novo", async () => {
  const p = await novaPaciente({ ceUuid: null, name: "Tempo Esgotado" });
  let postou = false;
  reset(({ method, path }) => {
    if (method === "GET" && path.endsWith("/patients")) return postou ? json(200, { data: [{ uuid: "criado-no-timeout", name: "Tempo Esgotado", phone: p.phone }] }) : json(200, { data: [] });
    if (method === "POST" && path.endsWith("/patients")) { postou = true; throw new Error("timeout"); } // o CE criou, mas a resposta nao chegou
    return json(404, {});
  });
  const r = await ensureCePatient(clinic.id, { kind: "patient", id: p.id, name: "Tempo Esgotado", phone: p.phone, ceUuid: null });
  assert.equal(r.uuid, "criado-no-timeout");
  assert.equal(count(/POST/), 1);
});

// ---------------------------------------------------------------- criar reserva
test("criar: o CE aceita, a reserva e CONFERIDA (GET) e a tentativa fecha como criada; o fim fica gravado", async () => {
  const { a } = await agendamento();
  reset(({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) return json(200, { data: { uuid: "res-ok" } });
    if (method === "GET" && path.endsWith("/bookings/res-ok")) return json(200, { data: ceBooking(a, { uuid: "res-ok" }) });
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.deepEqual(r, { ok: true });
  const row = await reload(a.id);
  assert.equal(row.ceBookingUuid, "res-ok");
  assert.equal(row.ceStatus, "scheduled");
  assert.equal(row.endsAt.getTime(), a.scheduledAt.getTime() + 30 * 60_000);
  const att = await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: a.id, kind: "create" } });
  assert.equal(att.state, "created");
});

test("criar: horario ocupado no momento (422) e recusa DEFINITIVA; nada fica em aberto", async () => {
  const { a } = await agendamento();
  reset(({ method, path }) => (method === "POST" && path.endsWith("/bookings") ? json(422, { errors: { starts_at: ["Horario indisponivel"] } }) : json(404, {})));
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal(r.definitive, true);
  assert.match(r.error, /indispon/i);
  assert.equal((await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: a.id } })).state, "failed");
  assert.equal(await sync.hasOpenCreateAttempt(clinic.id, a.patientId, null, a.scheduledAt), false);
});

test("criar: timeout SEM reserva no CE -> incerto; uma segunda tentativa NAO dispara outro POST (nunca recria as cegas)", async () => {
  const { a } = await agendamento();
  reset(({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [] });
    return json(404, {});
  });
  const r1 = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r1.ok, false);
  assert.equal(r1.definitive, false);
  assert.equal(r1.uncertain, true);
  assert.equal(count(/POST .*\/bookings$/), 1);
  assert.equal(await sync.hasOpenCreateAttempt(clinic.id, a.patientId, null, a.scheduledAt), true);
  const r2 = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.uncertain, true);
  assert.equal(count(/POST .*\/bookings$/), 1, "continua em UM so POST");
});

test("criar: timeout e o CE criou depois -> o reconciliador liga a reserva que combina em TUDO", async () => {
  const { a } = await agendamento();
  reset(({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [] });
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.uncertain, true);
  const p = await prisma.patient.findUnique({ where: { id: a.patientId } });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/bookings") ? json(200, { data: [ceBooking(a, { uuid: "res-tardia", patient: { uuid: p.ceUuid, name: p.name, phone: p.phone } })] }) : json(404, {})));
  const rec = await sync.reconcileOpenAttempts(clinic.id, new Date(Date.now() + 3 * 60_000));
  assert.equal(rec.linked >= 1, true);
  assert.equal((await reload(a.id)).ceBookingUuid, "res-tardia");
  assert.equal((await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: a.id, kind: "create" } })).state, "linked_existing");
  assert.equal(count(/POST/), 0);
});

test("criar: timeout e existe reserva no MESMO horario de OUTRO profissional/procedimento/pessoa -> NAO liga", async () => {
  for (const over of [{ professional: { uuid: "uuid-bia" } }, { procedures: [{ id: 2222 }] }, { patient: { uuid: "outra-pessoa", name: "Outra", phone: "5511999990000" } }]) {
    const { a } = await agendamento();
    const p = await prisma.patient.findUnique({ where: { id: a.patientId } });
    reset(({ method, path }) => {
      if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
      if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [ceBooking(a, { uuid: "res-de-outro", patient: { uuid: p.ceUuid, name: p.name, phone: p.phone }, ...over })] });
      return json(404, {});
    });
    const r = await sync.syncAppointment(a.id, { quiet: true });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal((await reload(a.id)).ceBookingUuid, null);
  }
});

test("criar: duas reservas candidatas iguais -> ambiguo, nao liga nenhuma", async () => {
  const { a } = await agendamento();
  const p = await prisma.patient.findUnique({ where: { id: a.patientId } });
  const igual = (u) => ceBooking(a, { uuid: u, patient: { uuid: p.ceUuid, name: p.name, phone: p.phone } });
  reset(({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [igual("dup-1"), igual("dup-2")] });
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal((await reload(a.id)).ceBookingUuid, null);
});

test("criar: sem prova por 6 h a tentativa vira 'nao resolvida' e a equipe e avisada (nada e recriado)", async () => {
  const { a } = await agendamento();
  reset(({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [] });
    return json(404, {});
  });
  await sync.syncAppointment(a.id, { quiet: true });
  const rec = await sync.reconcileOpenAttempts(clinic.id, new Date(Date.now() + 7 * HOUR));
  assert.equal(rec.unresolved >= 1, true);
  assert.equal((await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: a.id, kind: "create" } })).state, "unresolved");
  assert.equal(count(/POST .*\/bookings$/), 1);
});

test("200 sem o codigo da reserva e RESULTADO INCERTO (nao sucesso, nao falha definitiva)", async () => {
  const { a } = await agendamento();
  reset(({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) return json(200, { data: {} });
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [] });
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal(r.definitive, false);
});

// ---------------------------------------------------------------- acompanhante
test("acompanhante que divide o telefone: o CE recebe a reserva no nome DELE; o cadastro de quem conversa nao muda", async () => {
  const contato = await novaPaciente({ name: "Maria Souza" });
  const att = await prisma.attendee.create({ data: { clinicId: clinic.id, contactPatientId: contato.id, name: "Carlos Souza", relation: "marido" } });
  const { a } = await agendamento({ patient: contato, data: { attendeeId: att.id, bookedByPatientId: contato.id } });
  let criado = null;
  reset(({ method, path, body }) => {
    if (method === "GET" && path.endsWith("/patients")) return json(200, { data: [{ uuid: "uuid-maria", name: "Maria Souza", phone: contato.phone }] }); // so a esposa existe no CE
    if (method === "POST" && path.endsWith("/patients")) { criado = body; return json(200, { data: { uuid: "uuid-carlos" } }); }
    if (method === "POST" && path.endsWith("/bookings")) { assert.equal(body.patient, "uuid-carlos"); return json(200, { data: { uuid: "res-carlos" } }); }
    if (method === "GET" && path.endsWith("/bookings/res-carlos")) return json(200, { data: ceBooking(a, { uuid: "res-carlos", patient: { uuid: "uuid-carlos", name: "Carlos Souza", phone: contato.phone } }) });
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, true);
  assert.equal(criado.name, "Carlos Souza");
  assert.equal((await prisma.attendee.findUnique({ where: { id: att.id } })).ceUuid, "uuid-carlos");
  assert.equal((await prisma.patient.findUnique({ where: { id: contato.id } })).ceUuid, contato.ceUuid, "o cadastro de quem conversa nao foi tocado");
});

test("casal: duas reservas independentes; uma falha e a outra continua valendo (sucesso parcial)", async () => {
  const contato = await novaPaciente({ name: "Ana Prado" });
  const att = await prisma.attendee.create({ data: { clinicId: clinic.id, contactPatientId: contato.id, name: "Pedro Prado" } });
  const start = nextStart();
  const { a: dela } = await agendamento({ patient: contato, start });
  const { a: dele } = await agendamento({ patient: contato, start: new Date(start.getTime() + 30 * 60_000), data: { attendeeId: att.id, bookedByPatientId: contato.id } });
  reset(({ method, path, body }) => {
    if (method === "GET" && path.endsWith("/patients")) return json(200, { data: [] });
    if (method === "POST" && path.endsWith("/patients")) return json(200, { data: { uuid: "uuid-pedro" } });
    if (method === "POST" && path.endsWith("/bookings")) {
      if (body.patient === "uuid-pedro") return json(422, { errors: { starts_at: ["Horario ocupado"] } });
      return json(200, { data: { uuid: "res-dela" } });
    }
    if (method === "GET" && path.endsWith("/bookings/res-dela")) return json(200, { data: ceBooking(dela, { uuid: "res-dela", patient: { uuid: contato.ceUuid, name: contato.name, phone: contato.phone } }) });
    return json(404, {});
  });
  const r1 = await sync.syncAppointment(dela.id, { quiet: true });
  const r2 = await sync.syncAppointment(dele.id, { quiet: true });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.definitive, true);
  assert.equal((await reload(dela.id)).ceBookingUuid, "res-dela", "a reserva valida e preservada");
  assert.equal((await reload(dele.id)).ceBookingUuid, null);
});

// ---------------------------------------------------------------- remarcar
async function reservaLigada(uuid = "res-r") {
  const { a, p } = await agendamento();
  const row = await prisma.appointment.update({ where: { id: a.id }, data: { ceBookingUuid: uuid, endsAt: new Date(a.scheduledAt.getTime() + 30 * 60_000), ceStatus: "scheduled" } });
  return { a: row, p };
}

test("remarcar: confere a reserva atual, faz PUT (nunca cancela a antiga antes) e confere o resultado", async () => {
  const { a } = await reservaLigada("res-mover");
  const antigo = a.scheduledAt;
  const novo = new Date(antigo.getTime() + 2 * HOUR);
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: novo, endsAt: new Date(novo.getTime() + 30 * 60_000) } });
  let movido = false;
  reset(({ method, path, body }) => {
    if (method === "GET" && path.endsWith("/bookings/res-mover")) return json(200, { data: movido ? ceBooking({ scheduledAt: novo }, { uuid: "res-mover" }) : ceBooking({ scheduledAt: antigo }, { uuid: "res-mover" }) });
    if (method === "PUT" && path.endsWith("/bookings/res-mover")) { assert.equal(new Date(body.starts_at).getTime(), novo.getTime()); movido = true; return json(200, { data: { uuid: "res-mover" } }); }
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, true);
  assert.equal(count(/PUT/), 1);
  assert.equal(count(/cancel/), 0);
  assert.equal(count(/POST/), 0);
});

test("remarcar para o MESMO horario: nada e escrito (idempotente)", async () => {
  const { a } = await reservaLigada("res-igual");
  reset(({ method, path }) => (method === "GET" && path.endsWith("/bookings/res-igual") ? json(200, { data: ceBooking(a, { uuid: "res-igual" }) }) : json(404, {})));
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, true);
  assert.equal(count(/PUT|POST|PATCH/), 0);
});

test("remarcar: o CE recusa (422) -> falha definitiva, nada escrito alem do PUT recusado", async () => {
  const { a } = await reservaLigada("res-recusa");
  const novo = new Date(a.scheduledAt.getTime() + HOUR);
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: novo, endsAt: new Date(novo.getTime() + 30 * 60_000) } });
  reset(({ method, path }) => {
    if (method === "GET" && path.endsWith("/bookings/res-recusa")) return json(200, { data: ceBooking({ scheduledAt: a.scheduledAt }, { uuid: "res-recusa" }) });
    if (method === "PUT") return json(422, { errors: { starts_at: ["ocupado"] } });
    return json(404, {});
  });
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal(r.definitive, true);
  assert.equal(count(/PATCH/), 0);
});

test("remarcar com timeout: se o CE aplicou, vira sucesso; se nao aplicou, falha definitiva; sem leitura, fica incerto", async () => {
  for (const modo of ["aplicou", "nao_aplicou", "sem_leitura"]) {
    const { a } = await reservaLigada(`res-${modo}`);
    const antigo = a.scheduledAt;
    const novo = new Date(antigo.getTime() + HOUR);
    await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: novo, endsAt: new Date(novo.getTime() + 30 * 60_000) } });
    let leituras = 0;
    reset(({ method, path }) => {
      if (method === "GET" && path.endsWith(`/bookings/res-${modo}`)) {
        leituras++;
        if (leituras === 1) return json(200, { data: ceBooking({ scheduledAt: antigo }, { uuid: `res-${modo}` }) });
        if (modo === "sem_leitura") return json(503, {});
        return json(200, { data: ceBooking({ scheduledAt: modo === "aplicou" ? novo : antigo }, { uuid: `res-${modo}` }) });
      }
      if (method === "PUT") throw new Error("timeout");
      return json(404, {});
    });
    const r = await sync.syncAppointment(a.id, { quiet: true });
    if (modo === "aplicou") assert.equal(r.ok, true);
    else { assert.equal(r.ok, false); assert.equal(r.definitive, modo === "nao_aplicou", modo); }
  }
});

test("remarcar reserva com VARIOS procedimentos ou ja cancelada no CE: recusa sem escrever", async () => {
  const { a } = await reservaLigada("res-multi");
  const novo = new Date(a.scheduledAt.getTime() + HOUR);
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: novo } });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/bookings/res-multi") ? json(200, { data: ceBooking({ scheduledAt: a.scheduledAt }, { uuid: "res-multi", procedures: [{ id: 1013701 }, { id: 2222 }] }) }) : json(404, {})));
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /mais de um procedimento/);
  assert.equal(count(/PUT/), 0);

  const { a: b } = await reservaLigada("res-cancelada-la");
  await prisma.appointment.update({ where: { id: b.id }, data: { scheduledAt: new Date(b.scheduledAt.getTime() + HOUR) } });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/bookings/res-cancelada-la") ? json(200, { data: ceBooking(b, { uuid: "res-cancelada-la", status: "canceled" }) }) : json(404, {})));
  const r2 = await sync.syncAppointment(b.id, { quiet: true });
  assert.equal(r2.ok, false);
  assert.equal(count(/PUT/), 0);
});

// ---------------------------------------------------------------- cancelar
test("cancelar: o CE confirma, o uuid FICA e o estado do cancelamento vira 'confirmed'; repetir nao chama o CE de novo", async () => {
  const { a } = await reservaLigada("res-cancel");
  await prisma.appointment.update({ where: { id: a.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelSource: "paciente_whatsapp" } });
  reset(({ method, path }) => (method === "PATCH" && path.endsWith("/bookings/res-cancel/cancel") ? json(200, { data: { uuid: "res-cancel" } }) : json(404, {})));
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, true);
  const row = await reload(a.id);
  assert.equal(row.ceBookingUuid, "res-cancel");
  assert.equal(row.ceCancelState, "confirmed");
  const r2 = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r2.ok, true);
  assert.equal(count(/PATCH/), 1);
});

test("cancelar: o CE falha -> fica PENDENTE (visivel) e nova tentativa e possivel; reserva que ja nao existe la conta como cancelada", async () => {
  const { a } = await reservaLigada("res-pend");
  await prisma.appointment.update({ where: { id: a.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelSource: "paciente_whatsapp", ceCancelState: "pending" } });
  reset(() => json(503, {}));
  const r = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal((await reload(a.id)).ceCancelState, "pending");
  reset(({ method, path }) => (method === "PATCH" && path.endsWith("/cancel") ? json(404, {}) : json(404, {})));
  const r2 = await sync.syncAppointment(a.id, { quiet: true });
  assert.equal(r2.ok, true);
  assert.equal((await reload(a.id)).ceCancelState, "confirmed");
});

// ---------------------------------------------------------------- confirmacao de presenca
test("presenca: a confirmacao do paciente vale mesmo com o CE fora do ar (pendente e visivel) e sincroniza depois com PATCH /confirm", async () => {
  const { a } = await reservaLigada("res-presenca");
  reset(() => json(503, {}));
  await sync.markPatientConfirmed([a.id]);
  await (await import("../dist/jobs/background.js")).drainBackground();
  let row = await reload(a.id);
  assert.equal(row.patientConfirmed, true, "a confirmacao do paciente esta registrada");
  assert.equal(row.cePresenceState, "pending");
  assert.equal(count(/PATCH/), 0);
  // o CE volta
  reset(({ method, path }) => {
    if (method === "GET" && path.endsWith("/bookings/res-presenca")) return json(200, { data: ceBooking(a, { uuid: "res-presenca" }) });
    if (method === "PATCH" && path.endsWith("/bookings/res-presenca/confirm")) return json(200, { data: { uuid: "res-presenca" } });
    return json(404, {});
  });
  const rec = await sync.reconcileOpenAttempts(clinic.id);
  assert.equal(rec.presence, 1);
  row = await reload(a.id);
  assert.equal(row.cePresenceState, "synced");
  assert.ok(row.cePresenceAt);
  assert.equal(count(/\/confirm/), 1);
});

test("presenca: reserva cancelada ou em OUTRO horario no CE nao e confirmada la", async () => {
  const { a } = await reservaLigada("res-p-cancel");
  await prisma.appointment.update({ where: { id: a.id }, data: { patientConfirmed: true, confirmedAt: new Date(), cePresenceState: "pending" } });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/bookings/res-p-cancel") ? json(200, { data: ceBooking(a, { uuid: "res-p-cancel", status: "canceled" }) }) : json(404, {})));
  const r = await sync.syncPresence(a.id);
  assert.equal(r.state, "skipped");
  assert.equal(count(/confirm/), 0);

  const { a: b } = await reservaLigada("res-p-outro-horario");
  await prisma.appointment.update({ where: { id: b.id }, data: { patientConfirmed: true, confirmedAt: new Date(), cePresenceState: "pending" } });
  reset(({ method, path }) => (method === "GET" && path.endsWith("/bookings/res-p-outro-horario") ? json(200, { data: ceBooking({ scheduledAt: new Date(b.scheduledAt.getTime() + HOUR) }, { uuid: "res-p-outro-horario" }) }) : json(404, {})));
  const r2 = await sync.syncPresence(b.id);
  assert.equal(r2.state, "pending");
  assert.equal(count(/confirm/), 0);
});

test("presenca: sem Clinica Experts ligado a confirmacao do paciente e so local (nao fica 'pendente' para sempre)", async () => {
  const outra = await prisma.clinic.create({ data: { name: "Sem CE", whatsappPhone: "5511900000009", timezone: "America/Sao_Paulo" } });
  const pr = await prisma.procedure.create({ data: { clinicId: outra.id, name: "X", durationMin: 30 } });
  const pa = await prisma.patient.create({ data: { clinicId: outra.id, name: "Local", phone: "5511988880000" } });
  const ap = await prisma.appointment.create({ data: { clinicId: outra.id, patientId: pa.id, procedureId: pr.id, scheduledAt: nextStart() } });
  await sync.markPatientConfirmed([ap.id]);
  const row = await reload(ap.id);
  assert.equal(row.patientConfirmed, true);
  assert.equal(row.cePresenceState, null);
});

// ---------------------------------------------------------------- disponibilidade
test("disponibilidade: parametros do contrato (sem procedure_id), horarios em OBJETOS aceitos, forma desconhecida = nao verificado (fecha, nunca 'dia livre')", async () => {
  const { ceGateFor, invalidateCeCache } = await import("../dist/clinicaexperts/availability.js");
  const dia = new Date(Date.now() + 5 * 24 * HOUR);
  const wc = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(dia);
  const at = (hh) => new Date(`${wc}T${hh}:00-03:00`).getTime();
  const consultas = [];
  invalidateCeCache(clinic.id);
  reset(({ method, path, query }) => {
    if (method === "GET" && path.endsWith("/available-hours")) {
      consultas.push(Object.fromEntries(query.entries()));
      return json(200, { data: [{ starts_at: `${wc}T10:00:00-03:00` }, { starts_at: `${wc}T10:15:00-03:00` }, { available: false, starts_at: `${wc}T10:30:00-03:00` }] });
    }
    return json(404, {});
  });
  const gate = await ceGateFor(clinic.id, amanda, dia, 0, "America/Sao_Paulo");
  assert.ok(consultas.length >= 1);
  const q = consultas[0];
  assert.equal(q.professional_uuid, "uuid-amanda");
  assert.match(q.date, /-03:00$/);
  assert.equal(q.interval, "15");
  assert.equal("procedure_id" in q, false, "procedure_id/procedure_from_event nao tem semantica documentada: nao sao enviados");
  assert.equal("procedure_from_event" in q, false);
  assert.equal(gate(at("10:00"), 30), true, "10:00 e 10:15 livres cobrem 30 min");
  assert.equal(gate(at("10:00"), 45), false, "10:30 esta marcado como ocupado");
  assert.equal(gate(at("11:00"), 15), false);
  assert.equal(gate.covers(at("11:00")), true);

  invalidateCeCache(clinic.id);
  reset(({ method, path }) => (method === "GET" && path.endsWith("/available-hours") ? json(200, { data: [{ foo: "bar" }] }) : json(404, {})));
  const fechado = await ceGateFor(clinic.id, amanda, dia, 0, "America/Sao_Paulo");
  assert.equal(fechado.unverified(at("10:00")), true, "forma desconhecida = disponibilidade NAO verificada");
  assert.equal(fechado(at("10:00"), 15), false);
  invalidateCeCache(clinic.id);
});

test("desconectar o CE NAO apaga o uuid das reservas; trocar de conta e uma acao explicita (resetCeLinks)", async () => {
  const outra = await prisma.clinic.create({ data: { name: "Troca de conta", whatsappPhone: "5511900000008", timezone: "America/Sao_Paulo" } });
  await prisma.clinicaExpertsAccount.create({ data: { clinicId: outra.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••x" } });
  const pr = await prisma.procedure.create({ data: { clinicId: outra.id, name: "X", durationMin: 30, ceId: 9 } });
  const pa = await prisma.patient.create({ data: { clinicId: outra.id, name: "P", phone: "5511988887777", ceUuid: "pac-x" } });
  const ap = await prisma.appointment.create({ data: { clinicId: outra.id, patientId: pa.id, procedureId: pr.id, scheduledAt: nextStart(), ceBookingUuid: "res-x" } });
  await client.disconnectAccount(outra.id);
  assert.equal((await reload(ap.id)).ceBookingUuid, "res-x");
  assert.equal((await prisma.patient.findUnique({ where: { id: pa.id } })).ceUuid, "pac-x");
  const r = await client.resetCeLinks(outra.id);
  assert.equal(r.appointments, 1);
  assert.equal((await reload(ap.id)).ceBookingUuid, null);
  assert.equal((await prisma.patient.findUnique({ where: { id: pa.id } })).ceUuid, null);
});
