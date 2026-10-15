// Renovacao visual do painel (nomes dos recursos, menu lateral, diretorio de configuracoes, paleta).
// Garante: nada de id/rota/chave quebrado, contraste AA, nomes novos no lugar e nenhum nome antigo em texto visivel.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("public/index.html");
const js = read("public/app.js");
const css = read("public/styles.css");

// ---------- contraste (WCAG) ----------
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}
const rootBlock = css.slice(css.indexOf(":root"), css.indexOf('[data-theme="dark"]'));
const darkStart = css.indexOf('[data-theme="dark"]');
const darkBlock = css.slice(darkStart, css.indexOf("}", darkStart));
const light = tokens(rootBlock);
const dark = tokens(darkBlock);

test("a cor da marca continua a laranja da Alice (#ea580c) nos dois temas", () => {
  assert.equal(light["--accent"], "#ea580c");
  assert.ok(dark["--accent"], "tema escuro precisa de um --accent proprio");
});

test("texto sobre fundo, no tema claro e no escuro, passa em AA (4,5:1)", () => {
  for (const [nome, t] of [["claro", light], ["escuro", dark]]) {
    for (const [fg, bg] of [["--text", "--bg"], ["--text", "--card"], ["--muted", "--bg"], ["--muted", "--card"], ["--accent-dark", "--accent-100"], ["--accent-dark", "--card"]]) {
      if (!t[fg] || !t[bg]) continue;
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${nome}: ${fg} sobre ${bg} = ${r.toFixed(2)}`);
    }
  }
});

test("botao cheio com texto branco usa o preenchimento AA, nao o laranja puro", () => {
  assert.ok(ratio("#ffffff", light["--accent-fill"]) >= 4.5, "branco sobre --accent-fill");
  assert.ok(ratio("#ffffff", light["--accent"]) < 4.5, "premissa: branco sobre #ea580c nao passa em AA (por isso existe --accent-fill)");
  assert.ok(!/\.btn-save[^{]*\{[^}]*background:\s*var\(--accent\)\s*;/.test(css), ".btn-save nao pode usar o laranja puro");
});

test("o bloco visual novo (fim do styles.css) usa so variaveis, sem cor fixa", () => {
  const i = css.indexOf("Renovacao visual");
  assert.ok(i > 0, "bloco 'Renovacao visual' existe");
  const bloco = css.slice(i);
  const fixas = [...bloco.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(fixas, [], "cores fixas no bloco novo: " + fixas.join(", "));
});

// ---------- estrutura: nada quebrado ----------
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const attr = (a) => [...html.matchAll(new RegExp(`\\b${a}="([^"]*)"`, "g"))].map((m) => m[1]);

test("os 7 menus e as 26 sub-areas continuam apontando para o painel certo", () => {
  const tabs = attr("data-tab");
  assert.equal(tabs.length, 7);
  for (const t of tabs) assert.ok(ids.has(`tab-${t}`), `painel tab-${t} sumiu`);
  const subs = attr("data-sub");
  assert.equal(subs.length, 26);
  assert.equal(new Set(subs).size, 26, "data-sub repetido");
  for (const s of subs) assert.ok(ids.has(`sub-${s}`), `painel sub-${s} sumiu`);
  assert.equal(attr("data-rt").length, 6);
  assert.equal(attr("data-plan-lock").length, 12);
});

test("o diretorio de configuracoes mantem #settings-tabs e tem 5 grupos com todas as sub-areas dentro", () => {
  assert.ok(ids.has("settings-tabs") && ids.has("settings-current-label") && ids.has("settings-current-title"));
  const ini = html.indexOf('id="settings-tabs"');
  const fim = html.indexOf("settings-content", ini);
  const nav = html.slice(ini, fim);
  assert.equal([...nav.matchAll(/data-sub="/g)].length, 26, "toda sub-area esta dentro do diretorio");
  assert.equal([...nav.matchAll(/class="settings-directory-group"/g)].length, 5, "5 grupos");
  assert.ok(/<details class="settings-directory"/.test(html), "diretorio recolhivel em tela estreita");
});

test("o JS do painel compila e a troca de sub-area marca aria-current", () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: "app.js" }));
  assert.ok(js.includes('setAttribute("aria-current", "page")'));
  assert.ok(js.includes("function updateSettingsContext"));
  assert.ok(js.includes("#settings-current-label"), "contexto do diretorio fora da varredura de rotulos");
});

test("o tour so aponta para menus, sub-areas e elementos que existem", () => {
  const a = js.indexOf("const TOUR_STEPS = [");
  const b = js.indexOf("\n];", a);
  const linhas = js.slice(a, b).split("\n").filter((l) => l.trim().startsWith("{ section"));
  assert.ok(linhas.length >= 50);
  const tabs = new Set(attr("data-tab"));
  const subs = new Set(attr("data-sub"));
  for (const l of linhas) {
    const tab = /tab: "([^"]+)"/.exec(l)?.[1];
    const sub = /sub: "([^"]+)"/.exec(l)?.[1];
    const alvo = /target: "#([\w-]+)"/.exec(l)?.[1];
    if (tab) assert.ok(tabs.has(tab), `tour: menu ${tab}`);
    if (sub) assert.ok(subs.has(sub), `tour: sub-area ${sub}`);
    if (alvo) assert.ok(ids.has(alvo), `tour: elemento #${alvo}`);
  }
});

// ---------- nomes ----------
const sidebar = html.slice(html.indexOf('<aside'), html.indexOf("</aside>"));

test("a lateral mostra os nomes novos e o wordmark 'alice.'", () => {
  for (const nome of ["Meu dia", "Pessoas", "Jornada", "Caixa de conversas", "Compromissos", "Resultados", "Meu espaço Alice", "Conheça seu espaço", "Aparência"]) {
    assert.ok(sidebar.includes(nome), `lateral sem "${nome}"`);
  }
  assert.ok(/brand-wordmark[^>]*>alice<span class="brand-dot">\.<\/span>/.test(html));
  assert.ok(html.includes("Seu dia, mais leve"));
});

test("nenhum nome antigo em texto visivel (index.html, app.js, assistente de ajuda, manifest)", () => {
  const antigos = /Personalizar|Canais|Mensagens? [Pp]rogramadas?|Lembrete de Consulta|Bloqueios? de agenda|[Ll]ista de espera|Aprendizado da|Regras globais|[Mm]ensagens prontas|Alice IA|\bGuia\b|\bTema\b|[Pp]ós-procedimento|\b[Ff]unil\b|\bCRM\b|aba Chat|no Chat\b|[Cc]ampanhas?|Alana/;
  // texto visivel do HTML (entre tags e atributos que aparecem na tela)
  const visivel = [];
  html.split("\n").forEach((linha, i) => {
    const partes = [...linha.matchAll(/>([^<>]+)</g)].map((m) => m[1]);
    partes.push(...[...linha.matchAll(/\b(?:title|placeholder|aria-label|alt|data-biz-label)="([^"]*)"/g)].map((m) => m[1]));
    const ini = linha.match(/^\s*([^<>]+)</);
    if (ini) partes.push(ini[1]);
    for (const p of partes) if (antigos.test(p)) visivel.push(`index.html:${i + 1}: ${p.trim().slice(0, 80)}`);
  });
  // literais de texto do JS (ignora comentarios)
  js.split("\n").forEach((linha, i) => {
    const t = linha.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const codigo = linha.replace(/\s\/\/ .*$/, "");
    for (const m of codigo.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const lit = m[1] ?? m[2] ?? m[3] ?? "";
      if (lit.length > 3 && !/^[a-z_]+$/.test(lit) && antigos.test(lit)) visivel.push(`app.js:${i + 1}: ${lit.slice(0, 80)}`);
    }
  });
  // o assistente de ajuda cita o nome antigo so entre parenteses, pra reconhecer como a pessoa chama o recurso
  const assistente = read("src/ai/siteAssistant.ts").replace(/\((?:CRM \/ funil|funil|lista de espera|campanhas)\)/g, "");
  if (antigos.test(assistente)) visivel.push("siteAssistant.ts: " + assistente.match(antigos)[0]);
  const manifesto = read("public/manifest.webmanifest");
  if (antigos.test(manifesto)) visivel.push("manifest: " + manifesto.match(antigos)[0]);
  assert.deepEqual(visivel, []);
});

test("manifest valido e com a cor da marca", () => {
  const m = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(m.theme_color, "#ea580c");
  assert.ok(m.name.includes("Alice"));
  assert.match(html, /<meta name="theme-color" content="#ea580c"/);
});
