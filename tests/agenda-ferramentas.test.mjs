// FERRAMENTAS DA ALICE (check_availability / check_specific_time / book_appointment / manage_my_appointment) ate a efetivacao no Clinica Experts.
// A execucao recusa horario incompativel MESMO quando o modelo chama a ferramenta direto; so confirma depois do CE aceitar; em falha desfaz.
// generateReply de verdade, banco temporario, modelo da OpenAI roteirizado e CE simulado.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-ferramentas-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

let script = [];
const openaiCalls = [];
const ceLog = []; // { method, path, body }
let cePost = () => ({ status: 200, body: { data: { uuid: "ce-novo" } } });
let cePut = () => ({ status: 200, body: { data: {} } });
let ceDetail = () => ({ status: 200, body: { data: [] } }); // GET /bookings/{uuid}
let ceAvailable = () => ({ status: 200, body: { data: cells() } });
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
    if (!body.tools) return jsonRes(200, { ...completion({ content: "{}" }) });
    openaiCalls.push(body);
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (chamada a mais do que o esperado)");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  if (u.hostname.includes("clinicaexperts")) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    ceLog.push({ method, path: u.pathname, body });
    if (u.pathname.endsWith("/available-hours")) { const r = ceAvailable(u); return jsonRes(r.status, r.body); }
    if (method === "GET" && u.pathname.endsWith("/patients")) return jsonRes(200, { data: [] });
    if (method === "POST" && u.pathname.endsWith("/patients")) return jsonRes(200, { data: { uuid: "pac-uuid" } });
    if (method === "POST" && u.pathname.endsWith("/bookings")) { const r = cePost(body); return jsonRes(r.status, r.body); }
    if (method === "PUT") { const r = cePut(body); return jsonRes(r.status, r.body); }
    if (method === "GET" && /\/bookings\/[^/]+$/.test(u.pathname)) { const r = ceDetail(u.pathname.split("/").pop()); return jsonRes(r.status, r.body); }
    return jsonRes(200, { data: [] });
  }
  return jsonRes(200, {});
};

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { generateReply } = await import("../dist/ai/alice.js");
const { invalidateCeCache } = await import("../dist/clinicaexperts/availability.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const TZ = "America/Sao_Paulo";
const isoDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + d * 24 * 3_600_000));
const DIA = isoDay(4);
const [Y, M, D] = DIA.split("-").map(Number);
const localUtc = (h, m = 0) => new Date(Date.UTC(Y, M - 1, D, h + 3, m));
const hhmm = (d) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

const clinic = await prisma.clinic.create({
  data: { name: "Lisboa Ferramentas", whatsappPhone: "5511900000077", timezone: TZ, plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, closedOnHolidays: false, silentHandoff: true },
});
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const suelen = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Suelen", active: true, ceUuid: "pro-suelen", workStartHour: 12, workEndHour: 21 } });
const talita = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Talita", active: true, ceUuid: "pro-talita", workStartHour: 8, workEndHour: 17 } });
const aline = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Aline", active: true, ceUuid: "pro-aline", workStartHour: 8, workEndHour: 21 } }); // nao habilitada em Drenagem
const drenagem = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Drenagem", durationMin: 60, ceId: 201, professionals: { connect: [{ id: suelen.id }, { id: talita.id }] } } });

let seq = 0;
async function cenario(nome, mensagens, { appt = null } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551197888${String(1000 + seq)}`, ceUuid: `pac-${seq}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, createdAt: new Date((t += 60_000)) } });
  const appointment = appt
    ? await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: drenagem.id, professionalId: appt.professionalId, scheduledAt: appt.when, ceBookingUuid: appt.uuid ?? null, source: "whatsapp" } })
    : null;
  return { patient, conv, appointment };
}
const reset = () => { invalidateCeCache(clinic.id); script = []; openaiCalls.length = 0; ceLog.length = 0; cePost = () => ({ status: 200, body: { data: { uuid: "ce-novo" } } }); cePut = () => ({ status: 200, body: { data: {} } }); ceAvailable = () => ({ status: 200, body: { data: cells() } }); ceDetail = () => ({ status: 200, body: { data: [] } }); };
const lastTool = (body) => JSON.parse(body.messages.filter((m) => m.role === "tool").at(-1).content);
const tool = (name, args) => ({ tool: { name, args } });

test("consulta -> efetivacao: so sao oferecidos horarios dentro da jornada de quem faz o procedimento, e a reserva so vale depois do CE aceitar", async () => {
  reset();
  const c = await cenario("Ana Souza", [["user", "Quero uma drenagem, de preferencia no fim do dia"]]);
  let oferta;
  script = [
    tool("check_availability", { procedure_name: "Drenagem", date: DIA }),
    (body) => {
      oferta = lastTool(body);
      const ultimo = oferta.horarios.at(-1);
      return tool("book_appointment", { procedure_name: "Drenagem", start_iso: ultimo.iso, professional_id: ultimo.profissional_id });
    },
    { content: "Pronto! Sua drenagem está agendada. 💗" },
  ];
  await generateReply(c.conv.id);
  // nada fora da jornada: Suelen 12-21 (ultimo inicio 20h) / Talita 8-17 (ultimo inicio 16h); Aline (nao habilitada) nunca aparece
  assert.ok(oferta.horarios.length > 0);
  for (const h of oferta.horarios) {
    const hora = hhmm(new Date(h.iso));
    assert.ok(["Suelen", "Talita"].includes(h.profissional), `profissional habilitada: ${h.profissional}`);
    if (h.profissional === "Suelen") assert.ok(hora >= "12:00" && hora <= "20:00", `Suelen ${hora}`);
    if (h.profissional === "Talita") assert.ok(hora >= "08:00" && hora <= "16:00", `Talita ${hora}`);
  }
  const appt = await prisma.appointment.findFirst({ where: { patientId: c.patient.id } });
  assert.ok(appt, "agendamento criado");
  assert.equal(appt.status, "confirmed");
  assert.equal(appt.ceBookingUuid, "ce-novo", "so confirmado depois que o CE criou a reserva");
  assert.ok([suelen.id, talita.id].includes(appt.professionalId));
  const post = ceLog.find((l) => l.method === "POST" && l.path.endsWith("/bookings"));
  assert.ok(post, "a reserva foi enviada ao CE");
  assert.match(post.body.starts_at, /-03:00$/, "horario com fuso");
  assert.ok(["pro-suelen", "pro-talita"].includes(post.body.professional));
});

test("o MODELO chama book_appointment direto com profissional NAO habilitada: recusado, nada gravado, nada enviado ao CE", async () => {
  reset();
  const c = await cenario("Bia Souza", [["user", "Pode marcar drenagem com a Aline amanha as 14h?"]]);
  let resultado;
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "14:00", professional_id: aline.id }),
    (body) => { resultado = lastTool(body); return { content: "Vou confirmar com a equipe." }; },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultado.agendado, false);
  assert.match(resultado.motivo, /nao realiza esse procedimento|não realiza esse procedimento/);
  assert.match(resultado.instrucao, /NAO diga que agendou/);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0);
  assert.equal(ceLog.filter((l) => l.method === "POST" && l.path.endsWith("/bookings")).length, 0);
});

test("o MODELO chama book_appointment direto FORA da jornada (20h30 + 60 min para quem encerra as 21h) ou antes do inicio: recusado", async () => {
  reset();
  const c = await cenario("Carla Souza", [["user", "Quero drenagem hoje as 20:30 com a Suelen"]]);
  const resultados = [];
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "20:30", professional_id: suelen.id }),
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "11:00", professional_id: suelen.id }); },
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "17:00", professional_id: talita.id }); },
    (body) => { resultados.push(lastTool(body)); return { content: "Vou confirmar com a equipe." }; },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultados.length, 3);
  for (const r of resultados) assert.equal(r.agendado, false);
  assert.match(resultados[0].motivo, /fora do expediente/);
  assert.match(resultados[1].motivo, /fora do expediente/);
  assert.match(resultados[2].motivo, /fora do expediente/, "Talita encerra as 17h");
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0);
});

test("CE nao responde na hora de reservar: NAO agenda, NAO afirma sucesso (equipe assume)", async () => {
  reset();
  const c = await cenario("Dora Souza", [["user", "Quero drenagem amanha as 14h"]]);
  ceAvailable = () => ({ status: 500, body: { message: "fora do ar" } });
  let resultado;
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "14:00", professional_id: suelen.id }),
    (body) => { resultado = lastTool(body); return tool("transfer_to_human", { reason: "agenda sem resposta", summary: "CE nao respondeu" }); },
    { content: "" },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultado.agendado, false);
  assert.match(resultado.instrucao, /NAO diga que agendou/);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0);
});

test("CE recusa a reserva depois de criada aqui: o agendamento e DESFEITO (nada de 'agendado' sem existir no CE)", async () => {
  reset();
  const c = await cenario("Eva Souza", [["user", "Quero drenagem amanha as 14h"]]);
  cePost = () => ({ status: 422, body: { message: "horario ocupado" } });
  let resultado;
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "14:00", professional_id: suelen.id }),
    (body) => { resultado = lastTool(body); return { content: "Esse horário acabou de ser ocupado." }; },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultado.agendado, false);
  const a = await prisma.appointment.findFirst({ where: { patientId: c.patient.id } });
  assert.equal(a?.status, "cancelled", "desfeito");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, type: "ce_mirror_failed" } }), "fica registrado");
});

test("remarcar: fora da jornada e recusado; dentro, preserva procedimento/profissional/duracao, o CE aceita a troca e nao nasce segunda reserva", async () => {
  reset();
  const antigo = localUtc(14, 0);
  const c = await cenario("Fabi Souza", [["user", "Preciso mudar meu horario de drenagem para as 20:30"]], { appt: { professionalId: suelen.id, when: antigo, uuid: "ce-fabi" } });
  // o CE devolve a reserva ATUAL (a Alice a le antes de trocar) e, depois do PUT aceito, a reserva no horario novo
  let ceInicio = antigo;
  ceDetail = (uuid) => ({ status: 200, body: { data: { uuid, starts_at: ceInicio.toISOString(), ends_at: new Date(ceInicio.getTime() + 60 * 60_000).toISOString(), status: "scheduled", professional: { uuid: "pro-suelen" }, patient: { uuid: "x" }, procedures: [{ id: 201 }] } } });
  cePut = (b) => { ceInicio = new Date(b.starts_at); return { status: 200, body: { data: {} } }; };
  const resultados = [];
  script = [
    tool("manage_my_appointment", { action: "reschedule", new_date: DIA, new_time: "20:30" }),
    (body) => { resultados.push(lastTool(body)); return tool("manage_my_appointment", { action: "reschedule", new_date: DIA, new_time: "19:00" }); },
    (body) => { resultados.push(lastTool(body)); return { content: "Pronto, remarquei para as 19h!" }; },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultados[0].ok, false, "20h30 + 60 min passa das 21h");
  assert.match(resultados[0].motivo, /fora do expediente|expediente/);
  assert.equal(resultados[1].ok, true);
  const depois = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.equal(depois.scheduledAt.getTime(), localUtc(19, 0).getTime());
  assert.equal(depois.procedureId, drenagem.id);
  assert.equal(depois.professionalId, suelen.id);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 1);
  const put = ceLog.find((l) => l.method === "PUT");
  assert.ok(put, "o CE recebeu a remarcacao");
  assert.equal(put.body.procedure, "201");
  assert.equal(put.body.professional, "pro-suelen");
  assert.match(put.body.starts_at, /T19:00:00-03:00$/);
});

test("remarcar e o CE RECUSA a troca: volta ao horario antigo, nada de 'remarquei', e fica registrado", async () => {
  reset();
  const antigo = localUtc(14, 0);
  const c = await cenario("Gabi Souza", [["user", "Pode remarcar minha drenagem para as 16h?"]], { appt: { professionalId: suelen.id, when: antigo, uuid: "ce-gabi" } });
  cePut = () => ({ status: 409, body: { message: "conflito na agenda" } });
  let resultado;
  script = [
    tool("manage_my_appointment", { action: "reschedule", new_date: DIA, new_time: "16:00" }),
    (body) => { resultado = lastTool(body); return { content: "Vou verificar com a equipe." }; },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultado.ok, false);
  assert.match(resultado.instrucao, /NAO diga que remarcou/);
  const a = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.equal(a.scheduledAt.getTime(), antigo.getTime(), "o horario antigo continua valendo");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, type: "ce_mirror_failed" } }));
});

test("CE com resultado INCERTO ao criar (rede caiu): nao diz 'agendado', registra o incerto e NAO tenta criar de novo (evita reserva em duplicidade); a equipe confere", async () => {
  reset();
  const c = await cenario("Gabi Souza", [["user", "Quero drenagem amanha as 15h"]]);
  cePost = () => { throw new Error("socket hang up"); };
  const resultados = [];
  script = [
    tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "15:00", professional_id: suelen.id }),
    (body) => { resultados.push(lastTool(body)); return tool("book_appointment", { procedure_name: "Drenagem", date: DIA, time: "15:00", professional_id: suelen.id }); }, // o modelo insiste
    (body) => { resultados.push(lastTool(body)); return tool("transfer_to_human", { reason: "Reserva com resultado incerto no CE", summary: "Drenagem amanha 15h: o CE pode ter criado a reserva" }); },
    { content: "" },
  ];
  await generateReply(c.conv.id);
  assert.equal(resultados[0].agendado, false);
  assert.equal(resultados[0].incerto, true);
  assert.match(resultados[0].instrucao, /NAO diga que agendou e NAO tente de novo/);
  assert.equal(resultados[1].agendado, false);
  assert.match(resultados[1].motivo, /INCERTO/);
  assert.equal(ceLog.filter((l) => l.method === "POST" && l.path.endsWith("/bookings")).length, 1, "so UMA tentativa de criar no CE: sem duplicidade");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, type: "ce_mirror_uncertain" } }), "o incerto fica registrado para a equipe conferir");
});
