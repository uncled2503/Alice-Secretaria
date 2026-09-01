import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStatusResponse, normalizeUazapiBaseUrl, parseWebhookPayload } from "../dist/uazapi/client.js";

test("normaliza status conectado e telefone da UAZAPI", () => {
  const result = normalizeStatusResponse({
    instance: { status: "connected", profileName: "Clinica Alice" },
    status: { connected: true, jid: { user: "5532999999999" } },
  });
  assert.equal(result.connected, true);
  assert.equal(result.phone, "5532999999999");
  assert.equal(result.profileName, "Clinica Alice");
});

test("normaliza QR base64 retornado pela UAZAPI", () => {
  const result = normalizeStatusResponse({ instance: { status: "connecting", qrcode: "YWJj" } });
  assert.equal(result.connecting, true);
  assert.equal(result.qr, "data:image/png;base64,YWJj");
});

test("aceita payload oficial de mensagem e resolve sender_pn", () => {
  const messages = parseWebhookPayload({
    EventType: "messages",
    message: {
      messageid: "ABC123",
      sender: "123456789012345@lid",
      sender_pn: "5532999999999@s.whatsapp.net",
      senderName: "Maria",
      fromMe: false,
      isGroup: false,
      messageType: "text",
      text: "Quero agendar",
    },
  });
  assert.deepEqual(messages, [{ externalId: "ABC123", phone: "5532999999999", text: "Quero agendar", mediaMessageId: undefined, imageMessageId: undefined, pushName: "Maria", referral: undefined }]);
});

test("captura o referral de Click-to-WhatsApp quando presente", () => {
  const m = parseWebhookPayload({
    message: {
      messageid: "R1",
      sender_pn: "5511988887777@s.whatsapp.net",
      messageType: "text",
      text: "vi seu anuncio",
      referral: { source_url: "https://fb.com/ad", ctwa_clid: "CLID123", headline: "Promo de verao" },
    },
  });
  assert.equal(m[0].referral.ctwaClid, "CLID123");
  assert.equal(m[0].referral.sourceUrl, "https://fb.com/ad");
});

test("ignora eco da API e mensagens de grupo", () => {
  assert.equal(parseWebhookPayload({ message: { messageid: "1", sender_pn: "5532999999999@s.whatsapp.net", text: "eco", wasSentByApi: true } }).length, 0);
  assert.equal(parseWebhookPayload({ message: { messageid: "2", sender: "120363000000@g.us", text: "grupo", isGroup: true } }).length, 0);
});

test("marca audio pra transcrever e imagem pra interpretar", () => {
  const audio = parseWebhookPayload({
    message: { messageid: "A1", sender_pn: "5511999999999@s.whatsapp.net", messageType: "audioMessage" },
  });
  assert.equal(audio[0].mediaMessageId, "A1");
  assert.equal(audio[0].imageMessageId, undefined);

  const img = parseWebhookPayload({
    message: { messageid: "I1", sender_pn: "5511999999999@s.whatsapp.net", messageType: "imageMessage", caption: "tem essa peça?" },
  });
  assert.equal(img[0].imageMessageId, "I1");
  assert.equal(img[0].text, "tem essa peça?");
  assert.equal(img[0].mediaMessageId, undefined);
});

test("rejeita URL sem HTTPS e remove barra final", () => {
  assert.equal(normalizeUazapiBaseUrl("https://api.uazapi.com/"), "https://api.uazapi.com");
  assert.throws(() => normalizeUazapiBaseUrl("http://api.uazapi.com"), /HTTPS/);
  // dominio fora da lista permitida e rejeitado (mensagem nao cita o provedor)
  assert.throws(() => normalizeUazapiBaseUrl("https://example.com"), /servidor invalid/i);
});
