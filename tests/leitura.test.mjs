import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { buildConversationBrief } = await import("../dist/ai/conversationBrief.js");
const { parseAnalysis, renderAnalysis, compactTranscript, analyzeConversation } = await import("../dist/ai/conversationAnalysis.js");

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-10-14T20:00:00Z"); // 17h em Sao Paulo
const at = (min) => new Date(NOW.getTime() - min * 60_000);
const CATALOGO = [{ name: "Enzima de Papada" }, { name: "Peeling Químico" }, { name: "Drenagem Corporal" }];

function msg(role, content, minAgo, authorName = null) {
  return { role, content, authorName, createdAt: at(minAgo) };
}

test("a ficha le a conversa: queixa, o que ja foi dito, o que ela perguntou e o que nao repetir (caso Emy/Liana)", () => {
  const history = [
    msg("user", "Por enquanto o que mais encomoda é a papada", 40),
    msg("assistant", "Para tratar a papada, temos a Enzima de Papada. O valor é R$ 189,90. Posso verificar um horário para sua avaliação gratuita?", 38),
    msg("user", "Bom o meu caso acredito que seja mais flacidez", 5),
    msg("user", "Qual o endereço?", 4),
  ];
  const brief = buildConversationBrief({
    history,
    trailing: ["Bom o meu caso acredito que seja mais flacidez", "Qual o endereço?"],
    now: NOW, tz: TZ,
    patient: { name: "Liana Souza", adName: "Protocolo do Olhar" },
    upcoming: [], pastVisits: 0, catalog: CATALOGO,
  });
  assert.match(brief, /LEITURA DA CONVERSA/);
  assert.match(brief, /Liana \(nome completo conhecido\)/);
  assert.match(brief, /lead \(nunca foi atendida\)/);
  assert.match(brief, /anuncio "Protocolo do Olhar"/);
  assert.match(brief, /a papada/);
  assert.match(brief, /avaliacao gratuita citada 1x/);
  assert.match(brief, /valor ja informado \(R\$ 189,90\)/);
  assert.match(brief, /ja falou de: Enzima de Papada/);
  assert.match(brief, /perguntas dela AGORA \(responda TODAS\): "Qual o endereço\?"/);
  assert.doesNotMatch(brief, /perguntas dela AGORA[^\n]*Bom o meu caso/); // afirmacao nao e pergunta
  assert.match(brief, /sem horario marcado/);
  assert.match(brief, /NAO REPITA[^\n]*o valor[^\n]*a oferta de avaliacao/);
});

test("a ficha destaca paciente ja atendida, horario marcado, equipe na conversa e horarios oferecidos", () => {
  const history = [
    msg("assistant", "Oi, Neide! Passando para saber como você está após o Botox facial.", 300, "Pós-procedimento automático"),
    msg("human", "Oi Neide, aqui é a Aline, qualquer coisa me chama", 200),
    msg("assistant", "Tenho terça, 20/10 às 14:30 ou 18:30. Qual prefere?", 100),
    msg("user", "pode ser o primeiro", 2),
  ];
  const brief = buildConversationBrief({
    history, trailing: ["pode ser o primeiro"], now: NOW, tz: TZ,
    patient: { name: "Neide Alves", preferredPeriod: "tarde" },
    upcoming: [{ when: new Date("2026-10-20T17:30:00Z"), procedure: "Avaliação Estética", professional: "Sabrina" }],
    pastVisits: 2, catalog: CATALOGO,
  });
  assert.match(brief, /PACIENTE JA ATENDIDA \(2 visita\(s\)\)/);
  assert.match(brief, /TEM HORARIO MARCADO: Avaliação Estética em terça-feira, 20\/10 às 14:30 com Sabrina/);
  assert.match(brief, /EQUIPE: uma pessoa da equipe falou/);
  assert.match(brief, /horarios oferecidos[^\n]*20\/10[^\n]*14:30/);
  assert.match(brief, /preferencias conhecidas: turno tarde/);
});

test("segunda leitura: valida o JSON do modelo e monta o texto", () => {
  const ok = parseAnalysis(JSON.stringify({
    objetivo: "melhorar flacidez na papada", momento: "interesse",
    perguntas_em_aberto: ["qual o endereço?"], ja_dito: ["valor R$ 189,90", "avaliação gratuita"], evitar: ["oferecer avaliação de novo"],
    proximo_passo: "responder o endereço e explicar como a Enzima de Papada age na flacidez",
  }));
  assert.ok(ok);
  assert.equal(ok.moment, "interesse");
  const txt = renderAnalysis(ok);
  assert.match(txt, /Perguntas em aberto \(responda\): qual o endereço\?/);
  assert.match(txt, /Melhor proximo passo: responder o endereço/);
  assert.match(txt, /a JOGADA AGORA vence/);
  assert.equal(parseAnalysis("isso nao e json"), null);
  assert.equal(parseAnalysis(JSON.stringify({ objetivo: "x" })), null); // sem proximo passo
  assert.equal(parseAnalysis(JSON.stringify({ momento: "invalido", proximo_passo: "ok" })).moment, "outro");
  assert.equal(parseAnalysis("```json\n{\"proximo_passo\":\"agradecer\"}\n```").nextStep, "agradecer");
});

test("a analise recebe as ultimas 40 mensagens e nunca derruba o atendimento (erro e demora viram null)", async () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `mensagem ${i}` }));
  const t = compactTranscript(history);
  assert.equal(t.split("\n").length, 40);
  assert.match(t, /P: mensagem 20/);
  assert.doesNotMatch(t, /mensagem 19\b/);
  let recebido = "";
  const a = await analyzeConversation(async (_s, u) => { recebido = u; return JSON.stringify({ proximo_passo: "responder" }); }, { brief: "FICHA", history, trailing: ["oi?"] });
  assert.equal(a.nextStep, "responder");
  assert.match(recebido, /FICHA/);
  assert.match(recebido, /P: oi\?/);
  assert.equal(await analyzeConversation(async () => { throw new Error("api fora"); }, { brief: "", history, trailing: [] }), null);
  assert.equal(await analyzeConversation(() => new Promise((r) => setTimeout(() => r("{}"), 200)), { brief: "", history, trailing: [] }, 20), null);
});

test("o motor le 50 mensagens e injeta a leitura junto da JOGADA AGORA", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /export const HISTORY_LIMIT = 50;/);
  assert.match(src, /take: HISTORY_LIMIT/);
  assert.match(src, /const reading = await readConversation\(/);
  // a leitura vai na ultima instrucao, antes da JOGADA AGORA (depois dela podem vir outros blocos: horarios da clinica, etiqueta do lead)
  assert.match(src, /\$\{reading \? reading \+ "\\n\\n" : ""\}[^`]*JOGADA AGORA \(siga isto\)/);
});
