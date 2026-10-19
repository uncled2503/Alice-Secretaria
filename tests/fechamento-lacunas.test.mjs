// Lacunas de cobertura apontadas na revisao de 19/10/2026: (1) vetos que apenas descrevem o PUBLICO do recontato; (2) de onde vem a jornada de uma profissional (fallback para o
// expediente da clinica); (3) backup verificado (restaura num temporario e abre; corrompido e reprovado); (4) o retorno para a Alice depois da demora da equipe NAO devolve contato
// nao comercial, retorno combinado futuro nem clinica com o WhatsApp fora. Banco de verdade para (3) e (4).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-fechamento-${process.pid}-${Date.now()}.db`);
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alice-fechamento-bkp-"));
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.BACKUP_DIR = backupRoot;
delete process.env.BACKUP_ENCRYPTION_KEY;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.hostname.includes("openai.com")) return ok({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Oi! Já te respondo por aqui." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return ok({ id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const veto = await import("../dist/crm/vetoReasons.js");
const { decide } = await import("../dist/ai/sendGate.js");
const { journeySource } = await import("../dist/scheduling/eligibility.js");
const backup = await import("../dist/maintenance/backupCore.js");
const { resumeStalledConversations } = await import("../dist/crm/humanReturn.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* temporario */ }
});

// ============================================================ 1) bloqueios indevidos de recontato
test("VETO que so descreve o publico do recontato NAO vale (os 4 motivos reais do log de producao de 19/10)", () => {
  for (const motivo of [
    "A pessoa não tem horário agendado",
    "A pessoa não respondeu a mensagem anterior",
    "A pessoa é um novo lead",
    "A pessoa parou de responder após solicitar agendamento",
  ]) {
    assert.equal(veto.isEligibilityRestatement(motivo), true, motivo);
    assert.equal(veto.vetoStands(null, motivo).stands, false, motivo);
    assert.equal(veto.vetoStands("outro", motivo).stands, false, `${motivo} (categoria outro)`);
  }
});

test("VETO com motivo REAL continua valendo (nada aqui obriga o envio): pediu para parar, equipe falando, retorno combinado, reclamacao, ja tem horario, categoria legitima", () => {
  for (const motivo of [
    "A pessoa pediu para não receber mais mensagens",
    "A equipe está conversando com ela agora",
    "Retorno combinado para a semana que vem",
    "A pessoa reclamou do atendimento",
    "A pessoa já tem horário marcado para amanhã",
    "A pessoa não tem horário agendado, mas pediu para parar de receber mensagens", // publico + motivo real na mesma frase
  ]) assert.equal(veto.vetoStands(null, motivo).stands, true, motivo);
  assert.equal(veto.vetoStands("opt_out", "A pessoa não tem horário agendado").stands, true, "categoria legitima manda");
  assert.equal(veto.vetoStands(null, "").stands, true, "sem motivo reconhecivel o veto vale");
});

test("decide() de ponta a ponta: o revisor barra recontato so por 'nao tem horario' -> o recontato SAI; barra por opt-out -> NAO sai", () => {
  const raw = (motivo, categoria) => JSON.stringify({ decisao: "nao_enviar", confianca: "alta", motivo, categoria });
  const texto = "Oi, Maria! Conseguiu pensar com calma?";
  const indevido = decide(raw("A pessoa não tem horário agendado", "outro"), "recontato", texto);
  assert.equal(indevido.send, true);
  assert.match(indevido.reason, /veto ignorado/);
  const indevido2 = decide(raw("A pessoa parou de responder após solicitar agendamento"), "retomada", texto);
  assert.equal(indevido2.send, true);
  const legitimo = decide(raw("A pessoa pediu para não receber mais mensagens", "opt_out"), "recontato", texto);
  assert.equal(legitimo.send, false);
  // confianca media nunca barra automacao
  assert.equal(decide(JSON.stringify({ decisao: "nao_enviar", confianca: "media", motivo: "talvez", categoria: "outro" }), "recontato", texto).send, true);
});

// ============================================================ 2) fallback de jornada
test("JORNADA: de onde vem o horario da profissional (cadastro proprio x herdado do expediente da clinica x cadastro incompleto)", () => {
  assert.equal(journeySource({ workStartHour: 9, workEndHour: 18 }), "cadastro");
  assert.equal(journeySource({ workStartHour: null, workEndHour: null }), "heranca_da_clinica");
  assert.equal(journeySource({ workStartHour: 9, workEndHour: null }), "cadastro_incompleto");
  assert.equal(journeySource({ workStartHour: null, workEndHour: 18 }), "cadastro_incompleto");
  // 0h e jornada propria (nao confundir com ausente)
  assert.equal(journeySource({ workStartHour: 0, workEndHour: 24 }), "cadastro");
});

// ============================================================ 3) backup
test("BACKUP: o arquivo gravado e restaurado num temporario, abre, passa no integrity_check e traz as tabelas; o manifest guarda a verificacao", async () => {
  await prisma.clinic.create({ data: { name: "Clinica Backup", whatsappPhone: "5511900000099" } });
  const dir = await backup.createBackup();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.verification.ok, true);
  assert.equal(manifest.verification.integrity, "ok");
  assert.ok(manifest.verification.tables > 20, `tabelas: ${manifest.verification.tables}`);
  assert.equal(manifest.verification.clinics, 1);
  assert.match(manifest.verification.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.encrypted, false);
  const again = await backup.verifyBackupDir(dir);
  assert.equal(again.ok, true);
  assert.equal(again.sha256, manifest.verification.sha256, "o hash confere com o que foi gravado");
});

test("BACKUP: arquivo corrompido/truncado e REPROVADO (nao conta como backup); criptografado exige a chave", async () => {
  const dir = await backup.createBackup();
  const ruim = fs.mkdtempSync(path.join(os.tmpdir(), "alice-bkp-ruim-"));
  try {
    fs.copyFileSync(path.join(dir, "manifest.json"), path.join(ruim, "manifest.json"));
    const bytes = fs.readFileSync(path.join(dir, "database.db"));
    fs.writeFileSync(path.join(ruim, "database.db"), Buffer.concat([bytes.subarray(0, 100), Buffer.alloc(4000, 7)])); // cabecalho valido do SQLite + lixo
    const r = await backup.verifyBackupDir(ruim);
    assert.equal(r.ok, false);
    assert.ok(r.problem, "diz por que reprovou");
    // manifest dizendo criptografado, sem a chave configurada: nao restaura
    fs.writeFileSync(path.join(ruim, "manifest.json"), JSON.stringify({ databaseFile: "database.db", encrypted: true }));
    const semChave = await backup.verifyBackupDir(ruim);
    assert.equal(semChave.ok, false);
    assert.match(semChave.problem, /BACKUP_ENCRYPTION_KEY/);
  } finally { fs.rmSync(ruim, { recursive: true, force: true }); }
  // storageKind decide por EVIDENCIA (tabela de montagens), nao por suposicao
  const info = "36 25 0:32 / / rw - overlay overlay rw\n40 36 8:1 / /data rw - ext4 /dev/sda1 rw\n";
  assert.equal(backup.storageKind("/qualquer", ""), "desconhecido");
  if (process.platform !== "win32") { // a tabela de montagens e do Linux (a VPS): caminhos POSIX so se resolvem como tal fora do Windows
    assert.equal(backup.storageKind("/data/backups", info), "volume");
    assert.equal(backup.storageKind("/app/backups", info), "raiz_do_container");
  }
});

// ============================================================ 4) retorno para a Alice depois da demora da equipe
async function conversaEsperando(clinic, nome, { handoffReason = null, callbackAt = null } = {}) {
  const now = new Date();
  const p = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `5511955${Math.floor(Math.random() * 1e6)}`, callbackAt } });
  const c = await prisma.conversation.create({ data: { patientId: p.id, humanTakeover: true, handoffPending: true, staffTouchedAt: new Date(now.getTime() - 40 * 60_000), handoffReason, lastMessageAt: new Date(now.getTime() - 25 * 60_000) } });
  await prisma.message.create({ data: { conversationId: c.id, role: "human", content: "Oi, ja te respondo!", authorName: "Recepcao", createdAt: new Date(now.getTime() - 35 * 60_000) } });
  await prisma.message.create({ data: { conversationId: c.id, role: "user", content: "Quanto custa a limpeza de pele?", createdAt: new Date(now.getTime() - 25 * 60_000) } });
  return { p, c };
}
const voltou = async (x) => !(await prisma.conversation.findUnique({ where: { id: x.c.id } })).humanTakeover;
const mkClinic = (nome, extra = {}) => prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime", aliceActive: true, humanReturnMinutes: 15, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, ...extra } });

test("RETORNO HUMANO: volta para a Alice quem esperou; NAO volta contato nao comercial, quem tem retorno combinado futuro, nem clinica com o WhatsApp fora; cada clinica por si", async () => {
  const ok = await mkClinic("Clinica Retorno");
  const fora = await mkClinic("Clinica Retorno Desconectada", { uazapiDownSince: new Date(Date.now() - 60 * 60_000), uazapiDownReason: "WhatsApp disconnected", uazapiDownCheckedAt: new Date() });
  const normal = await conversaEsperando(ok, "Normal");
  const vaga = await conversaEsperando(ok, "Candidata", { handoffReason: "Contato não comercial: candidata a vaga de emprego" });
  const naoPaciente = await conversaEsperando(ok, "Fornecedor", { handoffReason: "Fornecedor (não é paciente)" });
  const retorno = await conversaEsperando(ok, "Retorno", { callbackAt: new Date(Date.now() + 3 * 24 * 3_600_000) });
  const retornoVencido = await conversaEsperando(ok, "RetornoVencido", { callbackAt: new Date(Date.now() - 3_600_000) });
  const emClinicaFora = await conversaEsperando(fora, "ClinicaFora");

  await resumeStalledConversations(new Date());

  assert.equal(await voltou(normal), true, "controle: quem esperou volta para a Alice");
  assert.equal(await voltou(retornoVencido), true, "retorno combinado JA vencido nao segura");
  assert.equal(await voltou(vaga), false, "candidata a vaga fica com a equipe");
  assert.equal(await voltou(naoPaciente), false, "contato que nao e paciente fica com a equipe");
  assert.equal(await voltou(retorno), false, "retorno combinado no futuro: a data combinada manda");
  assert.equal(await voltou(emClinicaFora), false, "WhatsApp fora: a Alice nao conseguiria responder, a conversa fica com a equipe");
});
