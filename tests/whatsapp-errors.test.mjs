import assert from "node:assert/strict";
import test from "node:test";
import { describeWhatsAppConnectionError } from "../dist/whatsapp/errors.js";

test("erro 428 sem proxy explica o bloqueio do IP da VPS", () => {
  const message = describeWhatsAppConnectionError(428, "Connection Terminated", false);
  assert.match(message, /IP da VPS/);
  assert.match(message, /WHATSAPP_PROXY_URL/);
});

test("erro 428 com proxy aponta falha da propria proxy", () => {
  const message = describeWhatsAppConnectionError(428, "Connection Terminated", true);
  assert.match(message, /pela proxy/);
  assert.doesNotMatch(message, /Configure WHATSAPP_PROXY_URL/);
});

test("erro desconhecido preserva codigo e detalhe", () => {
  const message = describeWhatsAppConnectionError(503, "indisponivel", false);
  assert.match(message, /erro 503/);
  assert.match(message, /indisponivel/);
});
