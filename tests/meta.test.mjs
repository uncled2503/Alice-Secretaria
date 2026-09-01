import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

// chave de teste ANTES de importar o secretBox
process.env.META_ENCRYPTION_KEY = process.env.META_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");

const { metaEventId, backoffMs, META_MAX_ATTEMPTS } = await import("../dist/meta/events.js");
const { sha256Hex, normalizeEmail, normalizePhone, buildUserData, ctwaClidToFbc } = await import("../dist/meta/userData.js");
const { encryptSecret, decryptSecret, maskToken, encryptionAvailable } = await import("../dist/meta/secretBox.js");

test("event_id e estavel e no formato acordado", () => {
  assert.equal(metaEventId.lead("abc"), "lead:abc");
  assert.equal(metaEventId.schedule("ap1"), "schedule:ap1");
  assert.equal(metaEventId.disqualified("l1", "t1"), "disqualified:l1:t1");
  assert.equal(metaEventId.qualified("l1", "t1"), "qualified:l1:t1");
  assert.equal(metaEventId.crmStage("l1", "t1"), "crmstage:l1:t1");
});

test("backoff cresce com as tentativas e tem teto de 6h", () => {
  assert.ok(backoffMs(1) < backoffMs(2));
  assert.ok(backoffMs(2) < backoffMs(5));
  assert.equal(backoffMs(20), 6 * 60 * 60 * 1000);
  assert.ok(META_MAX_ATTEMPTS >= 3);
});

test("normalizacao: email minusculo/sem espaco, telefone so digitos", () => {
  assert.equal(normalizeEmail("  Joao.Silva@Email.COM "), "joao.silva@email.com");
  assert.equal(normalizePhone("+55 (11) 98765-4321"), "5511987654321");
});

test("user_data: email/telefone/external_id com SHA-256; fbc/fbp SEM hash", () => {
  const ud = buildUserData({
    id: "lead1",
    phone: "5511987654321",
    email: "Cliente@Exemplo.com",
    metaFbc: "fb.1.123.abc",
    metaFbp: "fb.1.999.xyz",
  });
  assert.deepEqual(ud.em, [sha256Hex("cliente@exemplo.com")]);
  assert.deepEqual(ud.ph, [sha256Hex("5511987654321")]);
  assert.deepEqual(ud.external_id, [sha256Hex("5511987654321")]);
  assert.equal(ud.fbc, "fb.1.123.abc"); // NAO criptografado
  assert.equal(ud.fbp, "fb.1.999.xyz");
  // nenhum valor cru de email/telefone aparece
  assert.ok(!JSON.stringify(ud).includes("cliente@exemplo.com"));
  assert.ok(!JSON.stringify(ud).includes("5511987654321".slice(0, 6) + "0"));
});

test("user_data sem email/fbc omite os campos", () => {
  const ud = buildUserData({ id: "l2", phone: "5521999998888" });
  assert.equal(ud.em, undefined);
  assert.equal(ud.fbc, undefined);
  assert.ok(Array.isArray(ud.external_id));
});

test("ctwaClidToFbc formata no padrao fb.1.<ts>.<clid>", () => {
  assert.equal(ctwaClidToFbc("XYZ", 1700000000000), "fb.1.1700000000000.XYZ");
});

test("token: criptografa/descriptografa e mascara sem vazar", () => {
  assert.equal(encryptionAvailable(), true);
  const token = "EAAG1234567890secretpart";
  const enc = encryptSecret(token);
  assert.ok(enc.startsWith("v1:"));
  assert.ok(!enc.includes(token));
  assert.equal(decryptSecret(enc), token);
  const masked = maskToken(token);
  assert.ok(masked.endsWith("part"));
  assert.ok(masked.startsWith("••••"));
  assert.ok(!masked.includes("secret"));
});
