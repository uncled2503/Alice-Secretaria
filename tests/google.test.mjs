import assert from "node:assert/strict";
import test from "node:test";

// O modulo le as variaveis de ambiente na chamada (nao no import), entao da
// pra configurar aqui antes de usar.
process.env.GOOGLE_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_CLIENT_SECRET = "fake-secret";
process.env.PUBLIC_BASE_URL = "https://painel.exemplo.com/";
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "0".repeat(48);

const google = await import("../dist/google/calendar.js");

test("redirect do Google sai do PUBLIC_BASE_URL, sem barra dupla", () => {
  assert.equal(google.redirectUri(), "https://painel.exemplo.com/api/google/callback");
});

test("URL de consentimento pede acesso offline (senao a conexao morre em 1h)", () => {
  const url = new URL(google.buildAuthUrl("clinica123"));
  assert.equal(`${url.host}${url.pathname}`, "accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("access_type"), "offline");
  // prompt=consent garante refresh_token mesmo quando a conta ja autorizou antes
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("redirect_uri"), google.redirectUri());
});

test("state assinado volta pra clinica certa e rejeita adulteracao", () => {
  const state = new URL(google.buildAuthUrl("clinica123")).searchParams.get("state");
  assert.equal(google.readState(state), "clinica123");

  // Trocar a clinica no state invalida a assinatura - senao daria pra plugar
  // a agenda do Google de uma conta na clinica de outra pessoa.
  assert.equal(google.readState(state.replace("clinica123", "clinicaOUTRA")), null);
  assert.equal(google.readState("aaa.bbb.ccc"), null);
  assert.equal(google.readState(""), null);
  assert.equal(google.readState("clinica123"), null);
});

test("sem chave de criptografia a integracao fica desligada, com motivo claro", () => {
  const key = process.env.META_ENCRYPTION_KEY;
  delete process.env.META_ENCRYPTION_KEY;
  assert.equal(google.googleConfigured(), false);
  assert.match(google.googleConfigHint(), /META_ENCRYPTION_KEY/);
  if (key !== undefined) process.env.META_ENCRYPTION_KEY = key;
});
