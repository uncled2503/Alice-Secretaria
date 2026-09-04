import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const { FREE_PLAN, isFreePlan, freePlanBlocksPath } = await import("../dist/crm/plan.js");

test("isFreePlan so reconhece o plano gratis", () => {
  assert.equal(FREE_PLAN, "free");
  assert.equal(isFreePlan("free"), true);
  assert.equal(isFreePlan("prime"), false);
  assert.equal(isFreePlan("prestige"), false);
  assert.equal(isFreePlan(null), false);
  assert.equal(isFreePlan(undefined), false);
});

test("freePlanBlocksPath bloqueia automacoes e devolver-pra-Alice", () => {
  // "Devolver a conversa para a Alice" nao existe no plano gratis
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/resume"), true);
  // Automacoes: o que a Alice faria sozinha
  assert.equal(freePlanBlocksPath("PUT", "/reminder-rules/r1"), true);
  assert.equal(freePlanBlocksPath("POST", "/followup-rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/post-procedure-rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/renewal-rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/birthday-rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/waitlist"), true);
  assert.equal(freePlanBlocksPath("POST", "/broadcasts"), true);
  assert.equal(freePlanBlocksPath("PATCH", "/rules/x"), true);
  assert.equal(freePlanBlocksPath("POST", "/faqs"), true);
  assert.equal(freePlanBlocksPath("POST", "/briefing/apply"), true);
  assert.equal(freePlanBlocksPath("POST", "/learning-insights/x"), true);
  assert.equal(freePlanBlocksPath("POST", "/nps"), true);
  assert.equal(freePlanBlocksPath("POST", "/api-keys"), true);
});

test("freePlanBlocksPath NAO bloqueia a agenda manual e o catalogo", () => {
  // A clinica marca horario na mao no plano gratis
  assert.equal(freePlanBlocksPath("POST", "/appointments"), false);
  assert.equal(freePlanBlocksPath("PUT", "/appointments/a1"), false);
  assert.equal(freePlanBlocksPath("DELETE", "/appointments/a1"), false);
  assert.equal(freePlanBlocksPath("POST", "/schedule-blocks"), false);
  // Precisa de servico/profissional pra poder agendar
  assert.equal(freePlanBlocksPath("POST", "/procedures"), false);
  assert.equal(freePlanBlocksPath("DELETE", "/procedures/p1"), false);
  assert.equal(freePlanBlocksPath("POST", "/professionals"), false);
  assert.equal(freePlanBlocksPath("POST", "/products"), false);
});

test("freePlanBlocksPath NAO bloqueia o chat humano", () => {
  // O plano gratis atende na mao: ler e responder conversa tem que passar
  assert.equal(freePlanBlocksPath("GET", "/conversations"), false);
  assert.equal(freePlanBlocksPath("GET", "/conversations?archived=1"), false);
  assert.equal(freePlanBlocksPath("GET", "/conversations/abc/messages"), false);
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/send"), false);
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/send-media"), false);
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/takeover"), false);
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/seen"), false);
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/archive"), false);
});

test("freePlanBlocksPath NAO bloqueia CRM, Meta e leitura", () => {
  // CRM / funil / contatos - o coracao do plano gratis
  assert.equal(freePlanBlocksPath("PUT", "/patients/abc/stage"), false);
  assert.equal(freePlanBlocksPath("GET", "/crm/board"), false);
  assert.equal(freePlanBlocksPath("POST", "/patients"), false);
  assert.equal(freePlanBlocksPath("POST", "/funnel-stages"), false);
  assert.equal(freePlanBlocksPath("POST", "/tags"), false);
  // Meta
  assert.equal(freePlanBlocksPath("PUT", "/meta/config"), false);
  assert.equal(freePlanBlocksPath("POST", "/meta/test-event"), false);
  // Canais (conexao do WhatsApp - pipe de captacao)
  assert.equal(freePlanBlocksPath("POST", "/uazapi/connect"), false);
  // Leitura das areas trancadas fica liberada (devolve lista vazia)
  assert.equal(freePlanBlocksPath("GET", "/reminder-rules"), false);
  assert.equal(freePlanBlocksPath("GET", "/broadcasts"), false);
});

test("freePlanBlocksPath nao confunde prefixo parecido", () => {
  // "/rules-foo" nao e "/rules"
  assert.equal(freePlanBlocksPath("POST", "/rules-export"), false);
  assert.equal(freePlanBlocksPath("POST", "/rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/rules/123"), true);
});

// Regressao: a venda da Alice ja vazou pros planos pagos porque .upsell-strip e
// .unlock-cta declaravam `display` e, com a mesma especificidade do gate
// [data-plan-free], ganhavam por virem depois no arquivo. Quem carrega o
// atributo nao pode declarar display: so o gate manda nisso.
test("blocos de venda nao declaram display proprio (senao vazam pro plano pago)", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  // Classes dos elementos que carregam data-plan-free no HTML
  const carriers = new Set();
  for (const m of html.matchAll(/<[^>]*\bdata-plan-free\b[^>]*>/g)) {
    const cls = m[0].match(/class="([^"]*)"/);
    if (cls) for (const c of cls[1].trim().split(/\s+/)) carriers.add(c);
  }
  assert.ok(carriers.size > 0, "esperava achar elementos com data-plan-free no index.html");

  for (const cls of carriers) {
    // regra que casa exatamente `.classe {` (nao pega descendentes tipo `.classe strong {`)
    const rule = new RegExp(`(^|\\})\\s*\\.${cls}\\s*\\{([^}]*)\\}`, "m");
    const found = css.match(rule);
    if (!found) continue;
    assert.ok(
      !/(^|;)\s*display\s*:/.test(found[2]),
      `.${cls} declara display proprio - isso faz o bloco de venda aparecer em plano pago`,
    );
  }

  // E o gate precisa continuar sendo !important nos dois sentidos
  assert.match(css, /\[data-plan-free\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /body\[data-plan="free"\]\s*\[data-plan-free\]\s*\{\s*display:\s*block\s*!important/);
});
