// FERRAMENTAS DA ALICE para MAIS DE UMA PESSOA e para presenca/cancelamento/remarcacao com o Clinica Experts (CE), de ponta a ponta:
// generateReply de verdade, banco temporario, modelo da OpenAI roteirizado e CE simulado. Revisao integrada 21/10/2026.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-casal-presenca-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

let script = [];
const ceLog = [];
const reservas = []; // o que o CE simulado ja reservou (some do horario livre)
let cePost = () => ({ status: 200, body: { data: { uuid: "ce-novo" } } });
let ceDetail = () => ({ status: 200, body: { data: [] } }); // GET /bookings/{uuid}
let cePatch = () => ({ status: 200, body: { data: {} } });
let cePut = () => ({ status: 200, body: { data: {} } });
const cells = () => { const out = []; for (let m = 0; m < 24 * 60; m += 15) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return out; };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = ({ content = null, tool = null }) => ({
  id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content, ...(tool ? { tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (!body.tools) return jsonRes(200, completion({ content: "{}" }));
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  if (u.hostname.includes("clinicaexperts")) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    ceLog.push({ method, path: u.pathname, body });
    if (u.pathname.endsWith("/available-hours")) {
      const midnight = Date.parse(u.searchParams.get("date"));
      const pro = u.searchParams.get("professional_uuid");
      const livres = cells().filter((hhmm) => {
        const [h, m] = hhmm.split(":").map(Number);
        const t = midnight + (h * 60 + m) * 60_000;
        return !reservas.some((r) => r.pro === pro && t >= r.start && t < r.end);
      });
      return jsonRes(200, { data: livres });
    }
    if (method === "GET" && u.pathname.endsWith("/patients")) return jsonRes(200, { data: [] });
    if (method === "POST" && u.pathname.endsWith("/patients")) return jsonRes(200, { data: { uuid: `pac-${ceLog.length}` } });
    if (method === "POST" && u.pathname.endsWith("/bookings")) {
      const r = cePost(body);
      if (r instanceof Error) throw r;
      if (r.status === 200) reservas.push({ pro: body.professional, start: Date.parse(body.starts_at), end: Date.parse(body.ends_at) });
      return jsonRes(r.status, r.body);
    }
    if (method === "PUT") { const r = cePut(body); if (r instanceof Error) throw r; return jsonRes(r.status, r.body); }
    if (method === "PATCH") { const r = cePatch(u.pathname); if (r instanceof Error) throw r; return jsonRes(r.status, r.body); }
    if (method === "GET" && /\/bookings\/[^/]+$/.test(u.pathname)) { const r = ceDetail(u.pathname.split("/").pop()); if (r instanceof Error) throw r; return jsonRes(r.status, r.body); }
    return jsonRes(200, { data: [] });
  }
  return jsonRes(200, {});
};

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { generateReply } = await import("../dist/ai/alice.js");
const { invalidateCeCache } = await import("../dist/clinicaexperts/availability.js");
const client = await import("../dist/clinicaexperts/client.js");
const { drainBackground } = await import("../dist/jobs/background.js");

test.after(async () => {
  await drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const isoDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + d * 24 * 3_600_000));
const DIA = isoDay(4);
const [Y, M, D] = DIA.split("-").map(Number);
const localUtc = (h, m = 0) => new Date(Date.UTC(Y, M - 1, D, h + 3, m));

const clinic = await prisma.clinic.create({
  data: { name: "Casal Presenca", whatsappPhone: "5511900000066", timezone: TZ, plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, closedOnHolidays: false, silentHandoff: true },
});
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const suelen = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Suelen", active: true, ceUuid: "pro-suelen", workStartHour: 12, workEndHour: 21 } });
const talita = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Talita", active: true, ceUuid: "pro-talita", workStartHour: 12, workEndHour: 21 } });
const drenagem = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Drenagem", durationMin: 60, ceId: 201, professionals: { connect: [{ id: suelen.id }, { id: talita.id }] } } });

let seq = 0;
async function cenario(nome, mensagens) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551197999${String(1000 + seq)}`, ceUuid: `pac-fixo-${seq}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, createdAt: new Date((t += 60_000)) } });
  return { patient, conv };
}
const reset = () => {
  invalidateCeCache(clinic.id); client.resetCeRateLimitForTests(); script = []; ceLog.length = 0; reservas.length = 0;
  cePost = () => ({ status: 200, body: { data: { uuid: `ce-${Math.random().toString(36).slice(2, 8)}` } } });
  ceDetail = () => ({ status: 200, body: { data: [] } }); cePatch = () => ({ status: 200, body: { data: {} } }); cePut = () => ({ status: 200, body: { data: {} } });
};
const lastTool = (body) => JSON.parse(body.messages.filter((m) => m.role === "tool").at(-1).content);
const tool = (name, args) => ({ tool: { name, args } });
const agenda = (patientId) => prisma.appointment.findMany({ where: { patientId }, include: { attendee: true }, orderBy: { scheduledAt: "asc" } });
const ceBooking = (a, over = {}) => ({
  uuid: a.ceBookingUuid, starts_at: a.scheduledAt.toISOString(), ends_at: new Date(a.scheduledAt.getTime() + 60 * 60_000).toISOString(), status: "scheduled",
  patient: { uuid: "x", name: "x", phone: "5511999990000" }, professional: { uuid: "pro-suelen" }, procedures: [{ id: 201 }], ...over,
});

test("'para mim e meu marido': duas reservas separadas, cada uma no nome certo; o cadastro de quem conversa nao muda; so diz 'os dois' depois das duas", async () => {
  reset();
  const c = await cenario("Ana Prado", [["user", "Quero marcar uma drenagem para mim e para o meu marido"]]);
  const resultados = [];
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "13:00", professional_id: suelen.id, patient_full_name: "Ana Prado" }),
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "14:00", professional_id: suelen.id, attendee_full_name: "Pedro Prado", attendee_relation: "marido", attendee_shares_phone: true }); },
    (body) => { resultados.push(lastTool(body)); return { content: "Prontinho! Os dois horários ficaram agendados 💗" }; },
  ];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(resultados[0].agendado, true);
  assert.equal(resultados[1].agendado, true);
  assert.equal(resultados[1].pessoa, "Pedro Prado");
  assert.match(resultados[1].instrucao, /DUAS/);
  const appts = await agenda(c.patient.id);
  assert.equal(appts.length, 2);
  assert.equal(appts[0].attendeeId, null);
  assert.equal(appts[1].attendee.name, "Pedro Prado");
  assert.equal(appts[1].bookedByPatientId, c.patient.id);
  assert.ok(appts.every((a) => a.ceBookingUuid), "as duas existem no CE");
  const posts = ceLog.filter((l) => l.method === "POST" && l.path.endsWith("/bookings"));
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].body.patient, posts[1].body.patient, "o marido nao e o cadastro da esposa no CE");
  assert.equal(posts[0].body.patient, c.patient.ceUuid);
  assert.equal((await prisma.patient.findUnique({ where: { id: c.patient.id } })).name, "Ana Prado");
  assert.equal(await prisma.attendee.count({ where: { clinicId: clinic.id, contactPatientId: c.patient.id } }), 1);
});

test("sucesso parcial: a segunda reserva e recusada pelo CE - a primeira continua valendo e a segunda NAO fica agendada", async () => {
  reset();
  const c = await cenario("Bia Prado", [["user", "Quero drenagem para mim e para minha filha"]]);
  let n = 0;
  cePost = () => (++n === 1 ? { status: 200, body: { data: { uuid: "ce-bia" } } } : { status: 422, body: { errors: { starts_at: ["horario ocupado"] } } });
  const resultados = [];
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "13:00", professional_id: suelen.id, patient_full_name: "Bia Prado" }),
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "14:00", professional_id: suelen.id, attendee_full_name: "Lia Prado", attendee_shares_phone: true }); },
    (body) => { resultados.push(lastTool(body)); return { content: "Só o seu horário ficou agendado; vou ver o dela." }; },
    { content: "Só o seu horário ficou agendado; vou ver o dela com a equipe." },
    { content: "Só o seu horário ficou agendado; a equipe vai ver o dela." },
  ];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(resultados[0].agendado, true);
  assert.equal(resultados[1].agendado, false);
  const appts = await agenda(c.patient.id);
  assert.equal(appts.length, 2);
  assert.equal(appts[0].status, "confirmed");
  assert.equal(appts[0].ceBookingUuid, "ce-bia");
  assert.equal(appts[1].status, "cancelled");
  assert.equal(appts[1].cancelSource, "sistema_desfeito");
});

test("outra pessoa sem dizer como falar com ela: nada e cadastrado nem agendado; nao ha simultaneidade com a MESMA profissional", async () => {
  reset();
  const c = await cenario("Carla Prado", [["user", "Quero drenagem para mim e para meu marido"]]);
  const resultados = [];
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "13:00", professional_id: suelen.id, attendee_full_name: "Caio Prado" }),
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "13:00", professional_id: suelen.id, patient_full_name: "Carla Prado" }); },
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "13:00", professional_id: suelen.id, attendee_full_name: "Caio Prado", attendee_shares_phone: true }); },
    (body) => { resultados.push(lastTool(body)); return { content: "Esse horário não está livre para os dois." }; },
  ];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(resultados[0].agendado, false);
  assert.match(resultados[0].motivo, /como falar/);
  assert.equal(resultados[1].agendado, true);
  assert.equal(resultados[2].agendado, false, "a Suelen ja esta ocupada neste horario: sem capacidade real nao ha simultaneidade");
  assert.match(resultados[2].motivo, /ocupado/);
  assert.equal((await agenda(c.patient.id)).length, 1);
});

test("confirmar presenca com duas pessoas no dia: pergunta de quem; com o nome, confirma so aquela e fica pendente de sincronizar com o CE (CE inconclusivo)", async () => {
  reset();
  const c = await cenario("Dora Prado", [["user", "Confirmado!"]]);
  const att = await prisma.attendee.create({ data: { clinicId: clinic.id, contactPatientId: c.patient.id, name: "Davi Prado" } });
  const dela = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c.patient.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(13), endsAt: localUtc(14), ceBookingUuid: "ce-dora", source: "whatsapp" } });
  const dele = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c.patient.id, attendeeId: att.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(14), endsAt: localUtc(15), ceBookingUuid: "ce-davi", source: "whatsapp" } });
  ceDetail = (uuid) => { if (uuid === "ce-dora") return { status: 200, body: { data: ceBooking(dela, { uuid }) } }; if (uuid === "ce-davi") return { status: 200, body: { data: ceBooking(dele, { uuid }) } }; return { status: 404, body: {} }; };
  cePatch = () => ({ status: 503, body: {} }); // o CE nao confirma agora
  const resultados = [];
  script = [
    tool("manage_my_appointment", { action: "confirm" }),
    (body) => { resultados.push(lastTool(body)); return tool("manage_my_appointment", { action: "confirm", person_name: "Davi" }); },
    (body) => { resultados.push(lastTool(body)); return { content: "Confirmado!" }; },
  ];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(resultados[0].ok, false);
  assert.match(resultados[0].motivo, /mais de uma pessoa/);
  assert.equal(resultados[1].ok, true);
  const d1 = await prisma.appointment.findUnique({ where: { id: dela.id } });
  const d2 = await prisma.appointment.findUnique({ where: { id: dele.id } });
  assert.equal(d1.patientConfirmed, false, "a esposa nao foi confirmada por engano");
  assert.equal(d2.patientConfirmed, true);
  assert.equal(d2.cePresenceState, "pending", "a confirmacao do paciente vale; a do CE fica pendente e visivel");
});

test("confirmar presenca de reserva que a recepcao CANCELOU no CE: nao confirma, cancela aqui e o paciente e avisado", async () => {
  reset();
  const c = await cenario("Eli Prado", [["user", "Confirmo!"]]);
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c.patient.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(15), endsAt: localUtc(16), ceBookingUuid: "ce-eli", source: "whatsapp" } });
  ceDetail = () => ({ status: 200, body: { data: ceBooking(a, { uuid: "ce-eli", status: "canceled" }) } });
  let resultado;
  script = [tool("manage_my_appointment", { action: "confirm" }), (body) => { resultado = lastTool(body); return { content: "Vou verificar com a equipe." }; }];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(resultado.ok, false);
  assert.match(resultado.instrucao, /Nunca diga 'confirmado'/);
  const row = await prisma.appointment.findUnique({ where: { id: a.id } });
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancelSource, "ce_cancelada");
  assert.equal(row.patientConfirmed, false);
});

test("cancelar: o CE confirma a baixa; se o CE falha o cancelamento fica PENDENTE e o paciente nao recebe promessa sobre a agenda da recepcao", async () => {
  reset();
  const c = await cenario("Fabi Prado", [["user", "Preciso cancelar"]]);
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c.patient.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(16), endsAt: localUtc(17), ceBookingUuid: "ce-fabi", source: "whatsapp" } });
  let r1;
  script = [tool("manage_my_appointment", { action: "cancel" }), (body) => { r1 = lastTool(body); return { content: "Cancelado." }; }];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(r1.ok, true);
  assert.equal(r1.removido_da_agenda, true);
  assert.equal((await prisma.appointment.findUnique({ where: { id: a.id } })).ceCancelState, "confirmed");

  const c2 = await cenario("Gabi Prado", [["user", "Preciso cancelar"]]);
  const b = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c2.patient.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(17), endsAt: localUtc(18), ceBookingUuid: "ce-gabi", source: "whatsapp" } });
  cePatch = () => ({ status: 503, body: {} });
  let r2;
  script = [tool("manage_my_appointment", { action: "cancel" }), (body) => { r2 = lastTool(body); return { content: "Cancelado." }; }];
  await generateReply(c2.conv.id);
  await drainBackground();
  assert.equal(r2.ok, true, "o cancelamento do paciente vale aqui");
  assert.equal(r2.removido_da_agenda, false);
  assert.ok(r2.agenda_da_clinica_pendente?.length === 1);
  const row = await prisma.appointment.findUnique({ where: { id: b.id } });
  assert.equal(row.status, "cancelled");
  assert.equal(row.ceCancelState, "pending");
  assert.equal(row.ceBookingUuid, "ce-gabi");
});

test("remarcar: timeout no PUT e o CE segue com o horario ANTIGO -> troca nao aplicada (recusa clara), horario antigo vale e a reserva antiga nunca e cancelada", async () => {
  reset();
  const c = await cenario("Helo Prado", [["user", "Pode remarcar para as 15h?"]]);
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c.patient.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(13), endsAt: localUtc(14), ceBookingUuid: "ce-helo", source: "whatsapp" } });
  ceDetail = () => ({ status: 200, body: { data: ceBooking(a, { uuid: "ce-helo" }) } }); // o CE continua com o horario antigo
  cePut = () => new Error("timeout");
  let r;
  script = [
    tool("manage_my_appointment", { action: "reschedule", new_date: DIA, new_time: "15:00" }),
    (body) => { r = lastTool(body); return tool("transfer_to_human", { reason: "remarcacao incerta", summary: "CE nao respondeu a troca" }); },
    { content: "" },
  ];
  await generateReply(c.conv.id);
  await drainBackground();
  // com a leitura mostrando o horario ANTIGO, a troca e definitivamente "nao aplicada" -> recusa clara (nao incerto)
  assert.equal(r.ok, false);
  const row = await prisma.appointment.findUnique({ where: { id: a.id } });
  assert.equal(row.scheduledAt.getTime(), localUtc(13).getTime(), "o horario antigo segue valendo");
  assert.equal(ceLog.filter((l) => l.method === "PUT").length, 1);
  assert.equal(ceLog.filter((l) => l.method === "PATCH" && /cancel/.test(l.path)).length, 0, "nunca cancela a antiga");
});

test("remarcar com resultado INCERTO no CE (nao da para reler): nao afirma nem nega; o horario antigo volta ate a equipe confirmar", async () => {
  reset();
  const c = await cenario("Ivo Prado", [["user", "Pode remarcar para as 15h?"]]);
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: c.patient.id, procedureId: drenagem.id, professionalId: suelen.id, scheduledAt: localUtc(13), endsAt: localUtc(14), ceBookingUuid: "ce-ivo", source: "whatsapp" } });
  let leituras = 0;
  ceDetail = () => (++leituras === 1 ? { status: 200, body: { data: ceBooking(a, { uuid: "ce-ivo" }) } } : { status: 503, body: {} });
  cePut = () => new Error("timeout");
  let r;
  script = [
    tool("manage_my_appointment", { action: "reschedule", new_date: DIA, new_time: "15:00" }),
    (body) => { r = lastTool(body); return tool("transfer_to_human", { reason: "remarcacao incerta", summary: "CE nao respondeu a troca" }); },
    { content: "" },
  ];
  await generateReply(c.conv.id);
  await drainBackground();
  assert.equal(r.ok, false);
  assert.equal(r.incerto, true);
  assert.match(r.instrucao, /NAO diga que remarcou NEM que nao conseguiu/);
  assert.equal((await prisma.appointment.findUnique({ where: { id: a.id } })).scheduledAt.getTime(), localUtc(13).getTime());
  const tent = await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: a.id, kind: "reschedule" } });
  assert.equal(tent.state, "uncertain", "a tentativa fica aberta para o reconciliador");
});
