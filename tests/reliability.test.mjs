import test from "node:test";
import assert from "node:assert/strict";

process.env.UAZAPI_WEBHOOK_SECRET ??= "x".repeat(40);
process.env.SESSION_SECRET ??= "y".repeat(40);

const { isPrivateIp, webhookSignature, verifyWebhookSignature } = await import("../dist/uazapi/client.js");
const { monthKey } = await import("../dist/crm/usage.js");
const { verifyPasswordAsync, hashPassword } = await import("../dist/api/passwords.js");

test("isPrivateIp barra loopback, rede privada, link-local e CGNAT; deixa IP publico passar", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "nao-e-ip"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "52.20.30.40", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("assinatura do webhook: versao 0 mantem a antiga, rotacionar invalida a URL anterior", () => {
  const v0 = webhookSignature("clinica1");
  assert.equal(v0, webhookSignature("clinica1", 0));
  assert.equal(verifyWebhookSignature("clinica1", v0, 0), true);
  const v1 = webhookSignature("clinica1", 1);
  assert.notEqual(v0, v1);
  assert.equal(verifyWebhookSignature("clinica1", v1, 1), true);
  assert.equal(verifyWebhookSignature("clinica1", v0, 1), false); // URL antiga deixou de valer
  assert.equal(verifyWebhookSignature("clinica2", v1, 1), false);
});

test("o mes de uso vira na meia-noite de Brasilia, nao em UTC", () => {
  // 01/10 02:00 UTC = 30/09 23:00 em Brasilia -> ainda e setembro
  assert.equal(monthKey(new Date("2026-10-01T02:00:00Z")), "2026-09");
  assert.equal(monthKey(new Date("2026-10-01T04:00:00Z")), "2026-10");
});

test("verifyPasswordAsync concorda com o hash sincrono", async () => {
  const h = hashPassword("uma-senha-forte-123");
  assert.equal(await verifyPasswordAsync("uma-senha-forte-123", h), true);
  assert.equal(await verifyPasswordAsync("outra", h), false);
  assert.equal(await verifyPasswordAsync("x", "invalido"), false);
});
