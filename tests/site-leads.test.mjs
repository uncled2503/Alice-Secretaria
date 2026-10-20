// CAPTACAO DE LEADS DA LANDING (POST /site/lead) com banco de verdade e servidor HTTP real em porta efemera. Dados SINTETICOS; nada e enviado a ninguem.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-site-leads-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.SESSION_SECRET ??= "y".repeat(40);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { default: express } = await import("express");
const { prisma } = await import("../dist/db/client.js");
const { siteLeadRouter, validateLead, sameOrigin, SEGMENT_IDS } = await import("../dist/site/leads.js");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use("/site", siteLeadRouter);
const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const post = (body, headers = {}) => fetch(`${base}/site/lead`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const good = (over = {}) => ({ name: "Teste Sintetico", phone: "(11) 91234-5678", company: "Empresa Ficticia", segment: "estetica", volume: "100-500", website: "", attribution: { utm_source: "teste", utm_campaign: "camp-sintetica", landing: "/?utm_source=teste", referrer: "https://exemplo.test/pagina" }, ...over });

test("validacao pura: campos obrigatorios, telefone com DDD normalizado, segmento conhecido, volume opcional", () => {
  const bad = validateLead({ name: "A", phone: "123", company: "", segment: "inexistente" });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.fields).sort(), ["company", "name", "phone", "segment"]);
  const v = validateLead(good());
  assert.equal(v.ok, true);
  assert.equal(v.phone, "5511912345678");
  assert.equal(v.phoneKey, "11912345678");
  assert.equal(validateLead(good({ phone: "+55 11 91234-5678" })).phoneKey, "11912345678", "com e sem DDI e a mesma pessoa");
  assert.equal(validateLead(good({ phone: "91234-5678" })).ok, false, "sem DDD nao vale");
  assert.equal(validateLead(good({ volume: "qualquer" })).value.volume, null);
  assert.equal(SEGMENT_IDS.length, 17);
  assert.equal(sameOrigin(undefined, "x.com"), true);
  assert.equal(sameOrigin("https://x.com", "x.com"), true);
  assert.equal(sameOrigin("https://outro.com", "x.com"), false);
  assert.equal(validateLead(good({ name: "  Ana\u0000   Lima  " })).value.name, "Ana Lima", "caracteres de controle e espacos limpos");
});

test("campos invalidos: 422 com a mensagem de cada campo e NADA gravado", async () => {
  const r = await post({ name: "", phone: "1", company: "", segment: "" });
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.ok(j.fields.name && j.fields.phone && j.fields.company && j.fields.segment);
  assert.equal(await prisma.siteLead.count(), 0);
});

test("envio valido: grava o lead com a origem; o IP nao fica em texto aberto", async () => {
  const r = await post(good());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const row = await prisma.siteLead.findUnique({ where: { phoneKey: "11912345678" } });
  assert.equal(row.name, "Teste Sintetico");
  assert.equal(row.phone, "5511912345678");
  assert.equal(row.segment, "estetica");
  assert.equal(row.volume, "100-500");
  assert.equal(row.utmSource, "teste");
  assert.equal(row.utmCampaign, "camp-sintetica");
  assert.equal(row.referrer, "https://exemplo.test/pagina");
  assert.equal(row.status, "novo");
  assert.match(row.ipHash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(row).includes("127.0.0.1"));
});

test("duplicata: o mesmo telefone (em outro formato) nao cria outro registro; so conta o reenvio e completa o que faltava", async () => {
  const r = await post(good({ phone: "+55 11 91234-5678", name: "Outro Nome", attribution: { utm_medium: "cpc" } }));
  assert.equal(r.status, 200);
  assert.equal(await prisma.siteLead.count(), 1);
  const row = await prisma.siteLead.findUnique({ where: { phoneKey: "11912345678" } });
  assert.equal(row.submissions, 2);
  assert.equal(row.name, "Teste Sintetico", "nao sobrescreve o primeiro contato");
  assert.equal(row.utmMedium, "cpc", "completa a origem que faltava");
});

test("campo isca (robo): responde sem gravar nada", async () => {
  const r = await post(good({ phone: "(21) 98888-7777", website: "http://spam.test" }));
  assert.equal(r.status, 200);
  assert.equal(await prisma.siteLead.count({ where: { phoneKey: "21988887777" } }), 0);
});

test("origem de outro site e recusada (403) e nao grava", async () => {
  const r = await post(good({ phone: "(31) 97777-6666" }), { Origin: "https://site-malicioso.test" });
  assert.equal(r.status, 403);
  assert.equal(await prisma.siteLead.count({ where: { phoneKey: "31977776666" } }), 0);
});

test("falha ao gravar: 500 com erro claro, NUNCA 'ok' (nao simula sucesso)", async () => {
  const real = prisma.siteLead.findUnique;
  prisma.siteLead.findUnique = () => { throw new Error("banco fora"); };
  try {
    const r = await post(good({ phone: "(41) 96666-5555" }));
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.equal(j.ok, false);
  } finally { prisma.siteLead.findUnique = real; }
  assert.equal(await prisma.siteLead.count({ where: { phoneKey: "41966665555" } }), 0);
});

test("limite por IP: depois de 6 envios no minuto, 429 (protecao contra abuso)", async () => {
  const r = await post(good({ phone: "(51) 95555-4444" }));
  assert.equal(r.status, 429);
  assert.equal((await r.json()).ok, false);
  assert.equal(await prisma.siteLead.count({ where: { phoneKey: "51955554444" } }), 0);
});
