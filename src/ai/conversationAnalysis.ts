// ---------------------------------------------------------------------------
// SEGUNDA LEITURA: uma chamada curta ao modelo (so com a ficha e as ultimas mensagens, sem o catalogo gigante) que devolve o CAMINHO da
// melhor resposta: o que a pessoa quer, em que momento esta, o que ficou em aberto, o que NAO repetir e qual o proximo passo. O resultado vai
// junto da "JOGADA AGORA" no prompt principal. Falha ou demora = segue sem (nunca atrasa nem derruba o atendimento).
// ---------------------------------------------------------------------------

export const MOMENTS = ["descoberta", "interesse", "decisao", "agendamento", "pos_agendamento", "objecao", "encerrando", "duvida_pontual", "outro"] as const;
export type Moment = (typeof MOMENTS)[number];

export interface Analysis {
  goal: string; // o que a pessoa quer
  moment: Moment;
  openQuestions: string[];
  alreadySaid: string[];
  avoid: string[];
  nextStep: string;
}

export const ANALYSIS_SYSTEM = `Voce le a conversa de WhatsApp entre uma pessoa e a secretaria de uma clinica de estetica e decide o MELHOR CAMINHO para a proxima resposta. Voce NAO escreve a resposta. Receba a FICHA (fatos ja levantados) e as ultimas mensagens (P = pessoa, A = secretaria Alice, E = equipe humana). Responda SOMENTE um JSON com estes campos:
{
 "objetivo": "o que a pessoa quer, em uma frase, com as palavras dela",
 "momento": "descoberta | interesse | decisao | agendamento | pos_agendamento | objecao | encerrando | duvida_pontual | outro",
 "perguntas_em_aberto": ["perguntas da pessoa que ainda NAO foram respondidas (inclusive antigas)"],
 "ja_dito": ["informacoes que a secretaria JA deu e nao deve repetir"],
 "evitar": ["erros a evitar agora: oferecer avaliacao de novo, perguntar o que ela ja contou, citar procedimento de outra regiao, falar de valor sem ser perguntada etc."],
 "proximo_passo": "UMA frase com a melhor acao agora (ex.: responder o endereco e perguntar o turno; explicar o procedimento que ela citou; agradecer e encerrar)"
}
Regras: use SO o que esta na conversa e na ficha (nunca invente fatos, valores ou horarios); se a pessoa ja tem horario marcado, o momento e pos_agendamento e o passo e responder o que ela perguntou e parar; se a avaliacao ja foi oferecida e ela nao aceitou, o passo e conversar sobre o interesse dela, nao oferecer de novo; se ela aceitou uma oferta ("sim", "pode"), o momento e agendamento. Listas com no maximo 4 itens curtos.`;

const asList = (v: unknown, n = 4): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 140)).slice(0, n) : [];

// PURO: valida o JSON do modelo.
export function parseAnalysis(text: string | null | undefined): Analysis | null {
  if (!text) return null;
  let data: any;
  try {
    data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const moment = MOMENTS.includes(data.momento) ? (data.momento as Moment) : "outro";
  const nextStep = typeof data.proximo_passo === "string" ? data.proximo_passo.trim().slice(0, 240) : "";
  if (!nextStep) return null;
  return {
    goal: typeof data.objetivo === "string" ? data.objetivo.trim().slice(0, 200) : "",
    moment,
    openQuestions: asList(data.perguntas_em_aberto),
    alreadySaid: asList(data.ja_dito),
    avoid: asList(data.evitar),
    nextStep,
  };
}

// PURO: texto para o prompt principal.
export function renderAnalysis(a: Analysis): string {
  const parts = [
    a.goal ? `- Ela quer: ${a.goal}` : "",
    `- Momento: ${a.moment.replace("_", " ")}`,
    a.openQuestions.length ? `- Perguntas em aberto (responda): ${a.openQuestions.join(" ; ")}` : "",
    a.alreadySaid.length ? `- Ja dito (nao repita): ${a.alreadySaid.join(" ; ")}` : "",
    a.avoid.length ? `- Evite agora: ${a.avoid.join(" ; ")}` : "",
    `- Melhor proximo passo: ${a.nextStep}`,
  ].filter(Boolean);
  return `ANALISE DO CAMINHO (segunda leitura da conversa; se conflitar com a JOGADA AGORA, a JOGADA AGORA vence):\n${parts.join("\n")}`;
}

// PURO: as ultimas mensagens em formato compacto para a analise.
export function compactTranscript(history: { role: string; content: string }[], max = 40): string {
  return history
    .filter((m) => ["user", "assistant", "human"].includes(m.role))
    .slice(-max)
    .map((m) => `${m.role === "user" ? "P" : m.role === "human" ? "E" : "A"}: ${m.content.replace(/\s+/g, " ").trim().slice(0, 280)}`)
    .join("\n");
}

export type AnalysisCall = (system: string, user: string) => Promise<string | null>;

// Faz a leitura. `call` faz a chamada ao modelo (injetada: testavel e sem acoplamento). Limite de tempo proprio.
export async function analyzeConversation(call: AnalysisCall, input: { brief: string; history: { role: string; content: string }[]; trailing: string[] }, timeoutMs = 7000): Promise<Analysis | null> {
  const user = `${input.brief}\n\nULTIMAS MENSAGENS (a ultima e a mais recente):\n${compactTranscript(input.history)}\n\nMENSAGENS NOVAS DA PESSOA (ainda sem resposta):\n${input.trailing.map((t) => `P: ${t.slice(0, 280)}`).join("\n")}`;
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const text = await Promise.race([call(ANALYSIS_SYSTEM, user), timeout]);
    return parseAnalysis(text);
  } catch (err) {
    console.error("[analise] falha na segunda leitura:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// QUANDO FAZER A SEGUNDA LEITURA (uma chamada paga a mais por resposta). Antes bastava a conversa ter 4 mensagens. Agora o RESUMO DETERMINISTICO (ficha, historico, o que ja foi dito,
// procedimento escolhido, reserva) responde sozinho a maior parte dos casos; a segunda leitura so entra quando a mensagem NOVA tem ambiguidade ou complexidade que esse resumo nao
// resolve. Os criterios sao explicitos, deterministicos e cada decisao (executada ou dispensada) e registrada com o motivo.
//   AI_SECOND_READING=off      desliga (como sempre)
//   AI_SECOND_READING=always   volta ao comportamento antigo: toda conversa com 4+ mensagens
//   (padrao)                   seletivo, pelos criterios abaixo
// ---------------------------------------------------------------------------
export interface ReadingDecision { run: boolean; reasons: string[]; skip: string | null }

const rdFold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const SCHEDULING_WORDS = /\b(agend|marc|horario|vaga|disponib|encaixe|remarc)/;
const PRICE_OR_OBJECTION_WORDS = /(quanto|valor|preco|caro|parcel|desconto|medo|dor\b|doi|risco|seguro|vou pensar|nao sei|sera que|e se )/;
const ANAPHORA = /\b(esse|essa|esses|essas|isso|aquele|aquela|aquilo|o outro|a outra|de novo|como (eu )?(falei|disse)|que (eu )?(falei|disse)|antes|tambem|mesmo|naquele)\b/;

export function decideSecondReading(i: { history: { role: string; content: string }[]; trailing: string[]; catalog?: { name: string; aliases?: string | null }[]; mode?: string | null }): ReadingDecision {
  const mode = (i.mode ?? "").trim().toLowerCase();
  const messages = i.history.filter((m) => m.role !== "system").length;
  if (mode === "off") return { run: false, reasons: [], skip: "desligada_por_configuracao" };
  if (messages < 4) return { run: false, reasons: [], skip: "conversa_curta" };
  if (mode === "always") return { run: true, reasons: ["modo_sempre"], skip: null };

  const text = i.trailing.join(" ").trim();
  const folded = rdFold(text);
  const reasons: string[] = [];
  if (i.trailing.length >= 3) reasons.push("varias_mensagens_novas");
  if (text.length >= 180) reasons.push("mensagem_longa");
  if ((text.match(/\?/g) ?? []).length >= 2) reasons.push("varias_perguntas");
  if (i.catalog && i.catalog.length) {
    const mentioned = i.catalog.filter((p) => {
      const names = [p.name, ...(p.aliases ?? "").split(/[\n,;]+/)].map((x) => rdFold(x).trim()).filter((x) => x.length >= 4);
      return names.some((n) => folded.includes(n));
    });
    if (mentioned.length >= 2) reasons.push("varios_procedimentos");
  }
  if (messages >= 6 && ANAPHORA.test(folded)) reasons.push("referencia_ao_que_foi_dito");
  if (SCHEDULING_WORDS.test(folded) && PRICE_OR_OBJECTION_WORDS.test(folded)) reasons.push("intencoes_misturadas");
  if (messages >= 14 && text.length >= 40) reasons.push("conversa_longa_com_novidade");
  return reasons.length ? { run: true, reasons, skip: null } : { run: false, reasons: [], skip: "sem_ambiguidade_resumo_deterministico_basta" };
}
