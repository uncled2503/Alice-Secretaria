// LANDING COMERCIAL (public/site): verificacoes estaticas do que NAO pode regredir - ondas e luz preservadas, uma unica H1, links validos, sem promessas sem prova, sem inline script (CSP),
// botoes comerciais nunca levam ao login, formulario acessivel e WhatsApp sem envio automatico. O comportamento no navegador e conferido a parte (capturas e CDP).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const site = (f) => new URL(`../public/site/${f}`, import.meta.url);
const html = fs.readFileSync(site("index.html"), "utf8");
const css = fs.readFileSync(site("site.css"), "utf8");
const js = fs.readFileSync(site("site.js"), "utf8");
const priv = fs.readFileSync(site("privacidade.html"), "utf8");
const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a unica coisa preservada da pagina antiga: as ondas entre as secoes e a luz que corre nelas", () => {
  const waves = (html.match(/class="wsep(?: over[^"]*)?"/g) ?? []).length;
  assert.ok(waves >= 9, `ondas: ${waves}`);
  assert.equal((html.match(/class="wsep-light/g) ?? []).length, waves, "cada onda tem a sua luz");
  assert.equal((html.match(/class="wsep-glow"/g) ?? []).length, waves);
  assert.equal((html.match(/class="wsep-rail"/g) ?? []).length, waves);
  assert.match(css, /@keyframes snake-dash/);
  assert.match(css, /stroke-dasharray: var\(--wl-dash, 16\) calc\(100 - var\(--wl-dash, 16\)\)/);
  assert.match(css, /vector-effect: non-scaling-stroke/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.wsep-rail, \.wsep-glow \{ animation: none; \}/);
});

test("estrutura semantica: um H1, skip link, secoes com ids, cabecalho e rodape", () => {
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.match(html, /<h1[^>]*>Seu próximo cliente não pode ficar <span class="hl">esperando\.<\/span><\/h1>/);
  assert.match(html, /class="skip-link"/);
  for (const id of ["como-funciona", "recursos", "para-quem", "duvidas", "demonstracao", "demonstracao-produto", "planos", "implantacao", "controle"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<title>[^<]{10,70}<\/title>/);
  assert.match(html, /<link rel="canonical" href="%%BASE_URL%%\/" \/>/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="description" content="[^"]{60,200}"/);
});

test("textos obrigatorios do briefing e nenhuma promessa sem prova", () => {
  for (const t of ["Seu próximo cliente não pode ficar", "Quero conhecer a Alice", "Ver como funciona", "Já sou cliente", "Você investe para atrair clientes.", "Sua empresa.", "Dê ao seu próximo cliente um atendimento que", "Encontre a configuração ideal para sua operação"]) assert.ok(html.includes(t), t);
  for (const proibido of [/100% das conversas/i, /\+\s?40\s?%/, /30 minutos/i, /garantia/i, /a melhor/i, /depoimento/i, /24 horas por dia/i, /sem fidelidade/i, /devolvemos/i, /ilimitad/i, /\bR\$\s?1\.\d{3}/, /multa/i, /dobr(a|e)/i, /agenda cheia/i, /sem erro/i]) assert.doesNotMatch(text, proibido, String(proibido));
  const precos = text.match(/R\$\s?\d+/g) ?? [];
  assert.deepEqual(precos, [], "nenhum preco na pagina");
  assert.ok(html.includes("Demonstração ilustrativa"));
  assert.doesNotMatch(html, /aggregateRating|"Review"|"Offer"|ratingValue/, "sem avaliacao/oferta estruturada inventada");
});

test("botoes comerciais nunca vao para o login; 'Ja sou cliente' e link secundario para o painel", () => {
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  const admin = anchors.filter((a) => /href="\/admin"/.test(a));
  assert.ok(admin.length >= 2);
  for (const a of admin) assert.match(a, /client-link|link-quiet|data-track="client_link"/, a);
  for (const a of anchors.filter((x) => /btn-primary/.test(x))) assert.doesNotMatch(a, /href="\/admin"/, a);
  assert.ok((html.match(/Já sou cliente/g) ?? []).length >= 2);
});

test("links internos validos: ancoras existentes, arquivos que existem, sem javascript: nem inline script", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), `ancora #${m[1]}`);
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)) {
    const p = m[1];
    if (["/", "/admin", "/sitemap.xml", "/manifest.webmanifest", "/site/lead"].includes(p)) continue;
    const onDisk = p.startsWith("/assets/") ? new URL(`../public${p}`, import.meta.url) : site(p.slice(1));
    assert.ok(fs.existsSync(onDisk), `arquivo ${p}`);
  }
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /\son[a-z]+="/i, "sem handlers inline (a CSP bloqueia)");
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /src="|type="application\/(ld\+)?json"/, `script inline: ${m[0]}`);
  assert.ok(fs.existsSync(site("boot.js")));
});

test("whatsapp: contato comercial ja publicado no projeto, abre a conversa (sem envio automatico) e a segmentacao vai no texto", () => {
  const was = [...html.matchAll(/href="(https:\/\/wa\.me\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(was.length >= 2);
  for (const u of was) { assert.match(u, /^https:\/\/wa\.me\/553298095202\?text=/); assert.doesNotMatch(u, /api\.whatsapp|send/i); }
  assert.match(html, /rel="noopener"/);
  assert.match(js, /Meu segmento é/);
  assert.doesNotMatch(js, /wa\.me|api\.whatsapp/, "o numero fica no HTML (nada inventado no JS)");
});

test("formulario: labels reais, erros associados, sem checkbox pre-marcado, honeypot, privacidade com link valido", () => {
  const form = html.slice(html.indexOf('<form class="form"'), html.indexOf("</form>"));
  for (const id of ["f-nome", "f-whats", "f-empresa", "f-seg", "f-vol"]) assert.match(form, new RegExp(`<label for="${id}"`), id);
  for (const id of ["e-nome", "e-whats", "e-empresa", "e-seg"]) assert.match(form, new RegExp(`id="${id}"[^>]*role="alert"`), id);
  assert.match(form, /autocomplete="name"/); assert.match(form, /autocomplete="tel"/); assert.match(form, /autocomplete="organization"/);
  assert.match(form, /name="website"[^>]*tabindex="-1"/);
  assert.doesNotMatch(form, /type="checkbox"/);
  assert.match(form, /href="\/privacidade\.html"/);
  assert.match(form, /id="formStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(js, /fetch\("\/site\/lead"/);
  assert.match(js, /Seus dados continuam aqui/, "em caso de erro os dados preenchidos ficam");
  assert.doesNotMatch(js, /form\.reset\(\)[\s\S]{0,60}falh/i);
  assert.match(priv, /<h1[^>]*>Política de Privacidade<\/h1>/);
});

test("16 segmentos com dor, uso e nota; selecao tambem existe sem JavaScript; segmento do formulario e preenchido sem apagar o resto", () => {
  const data = JSON.parse(html.match(/<script type="application\/json" id="segData">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.length, 16);
  for (const s of data) { assert.ok(s.id && s.name && s.list && s.pain && s.use && s.note, s.id); }
  assert.match(html, /<option value="outro">Outro<\/option>/);
  assert.equal((html.match(/<option value="(estetica|clinicas|saude-bem-estar|pet|varejo|casa|tecnicos|automotivo|educacao|profissionais|imoveis|eventos|turismo|alimentacao|b2b|financeiro)"/g) ?? []).length, 16);
  assert.equal((html.match(/class="seg-static"/g) ?? []).length, 1);
  assert.match(js, /function setFormSegment\(id\) \{ if \(formSeg && !segTouchedByUser\) formSeg\.value = id; \}/);
  // reguladas: foco administrativo/comercial
  const clin = data.find((s) => s.id === "clinicas"), fin = data.find((s) => s.id === "financeiro"), prof = data.find((s) => s.id === "profissionais");
  assert.match(clin.note, /não faz diagnóstico, prescrição/i);
  assert.match(fin.note, /não recomenda|não faz cotação/i);
  assert.match(prof.note, /administrativo e comercial/i);
  assert.ok(data.some((s) => /dependem de integra/i.test(s.note)), "integracao externa dita claramente");
});

test("movimento: reduced-motion respeitado, controle para pausar, nada essencial invisivel sem JS, sem parallax/scroll controlado", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.js \.reveal \{ opacity: 0;/, "so esconde conteudo quando o JS esta ativo");
  assert.match(js, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(html, /id="motionToggle"[^>]*aria-pressed="false"/);
  assert.match(js, /setTimeout\(function \(\) \{ reveals\.forEach/, "rede de seguranca: nada fica invisivel");
  assert.doesNotMatch(js, /wheel|preventDefault\(\);\s*window\.scrollTo|parallax|cursor/i);
  assert.match(css, /\.js \.wsep:not\(\.is-visible\) \.wsep-glow/, "a luz pausa fora da tela");
  assert.match(css, /html:not\(\.js\) \.tabpanel/, "demonstracao legivel sem JS");
});

test("mensuracao: eventos sem dados pessoais, sem IDs de terceiros, sem duplicar; origem preservada", () => {
  for (const ev of ["cta_click", "whatsapp_click", "form_start", "lead_submitted", "segment_select", "demo_interaction"]) assert.ok(js.includes(`"${ev}"`), ev);
  assert.doesNotMatch(js, /fbq\(|gtag\(|ga\(|_paq|G-[A-Z0-9]{6,}|UA-\d|GTM-/);
  assert.match(js, /lastEvent\[key\] && now - lastEvent\[key\] < 800/);
  const trackCalls = [...js.matchAll(/track(?:Once)?\("([a-z_]+)",\s*(\{[^}]*\})\)/g)].map((m) => m[2]);
  for (const props of trackCalls) assert.doesNotMatch(props, /name|phone|company|whats|email/i, props);
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"]) assert.ok(js.includes(`"${k}"`), k);
});

test("imagens: dimensoes definidas, logo oficial preservado (copia reduzida do MESMO arquivo), abaixo da dobra sob demanda", () => {
  for (const m of html.matchAll(/<img\b[^>]*>/g)) { assert.match(m[0], /width="\d+"/, m[0]); assert.match(m[0], /height="\d+"/, m[0]); assert.match(m[0], /alt="/, m[0]); }
  for (const f of ["logo-site.png", "logotipo-branca-site.png"]) assert.ok(fs.existsSync(new URL(`../public/assets/${f}`, import.meta.url)));
  assert.ok(fs.existsSync(new URL("../public/assets/logo.webp", import.meta.url)), "o arquivo oficial original segue intacto");
  assert.match(html, /<img class="hero-bg" src="\/assets\/hero-1672\.jpg"[^>]*width="1672" height="941" fetchpriority="high"/);
});

test("jornada em S: palco fixo (sticky) so no desktop com JS e sem reduzir movimento; 6 checkpoints; fallback vertical preservado", () => {
  assert.equal((html.match(/class="sj-cp (left|right)"/g) ?? []).length, 6);
  const xs = [...html.matchAll(/class="sj-cp (left|right)" data-x="(\d+)" data-y="(\d+)"/g)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
  assert.deepEqual(xs.map((x) => x[0]), ["left", "right", "left", "right", "left", "right"], "esquerda, direita, esquerda...");
  assert.ok(xs.every((x, i) => i === 0 || x[2] > xs[i - 1][2]), "cada checkpoint um pouco mais abaixo");
  assert.match(css, /\.s-journey \{ display: none; \}/);
  assert.match(css, /html\.sj-on \.s-journey \{ display: block;/);
  assert.match(css, /\.sj-stage \{ position: sticky; top: 0; height: 100vh;/);
  assert.match(js, /window\.innerWidth >= 960 && !reduced\(\)/);
  assert.match(html, /class="journey" id="journey"/, "a versao vertical continua para celular, sem JS e movimento reduzido");
  assert.match(css, /html\.sj-on \.journey \{ display: none; \}/);
});

test("7 dias gratis aparece no hero, nos planos, no formulario, no CTA fixo, no FAQ e na mensagem do WhatsApp - sem inventar condicoes", () => {
  assert.ok((html.match(/7 dias grátis/g) ?? []).length >= 6);
  assert.match(html, /wa\.me\/553298095202\?text=[^"]*7%20dias%20gr/);
  assert.match(html, /Os detalhes e as condições do período de teste são apresentados nesse contato/);
  assert.doesNotMatch(text, /sem cartão|cancele quando|sem compromisso de pagamento/i);
});

test("Meta Ads: secao propria, sem prometer numero, com condicao explicita e CTA para a demonstracao", () => {
  assert.match(html, /<section class="meta-blue" id="meta-ads"/);
  assert.match(text, /Alice \+ Meta Ads/);
  assert.match(text, /kanban/i);
  assert.match(text, /não prometemos um número/);
  assert.match(text, /depende da sua conta no Meta/);
  assert.match(html, /data-cta="meta-ads"/);
  assert.doesNotMatch(text, /reduz(imos|e)? o custo|custo (por lead )?menor garantido|\d+% (menos|mais)/i);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.mb-orb/);
});

test("carrossel de segmentos: card da frente = selecionado, clique pausa o giro, painel com altura fixa; sem JS segue a lista", () => {
  assert.match(html, /id="segRing"/);
  assert.match(js, /function setPaused\(p\)/);
  assert.match(js, /select\(f, false, true\)/);
  assert.match(js, /function fixHeight\(\)/);
  assert.match(html, /class="seg-static"/);
});

test("alice. acompanha o menu depois do hero e a imagem do hero e leve", () => {
  assert.match(html, /id="brandDock"/);
  assert.match(js, /classList\.toggle\("dock-on"/);
  assert.match(css, /\.header\.dock-on \.brand-dock/);
  assert.ok(fs.statSync(new URL("../public/assets/hero-1672.jpg", import.meta.url)).size < 300 * 1024, "hero abaixo de 300 KB");
  assert.match(js, /paintIO|is-off/);
  assert.match(css, /\.is-off, \.is-off \*/);
});
