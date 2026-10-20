// ---------------------------------------------------------------------------
// LEITURA DO TURNO (funcoes PURAS, sem banco e sem IA). O que as mensagens novas da pessoa SIGNIFICAM em relacao ao que a Alice acabou de perguntar ou oferecer:
//  - "nao" depois de "ja fez antes?" e AUSENCIA DE EXPERIENCIA, nao recusa da compra;
//  - "sim" depois de "quer que eu explique como funciona?" aceita a EXPLICACAO, nao autoriza agendamento;
//  - "nao quero tratar gordura, quero clarear" CORRIGE o objetivo, nao e "vou pensar";
//  - perguntas feitas na mesma mensagem (inclusive junto de "obrigada" ou "vou pensar") precisam ser respondidas;
//  - a OBJECAO identificavel (preco, tempo, distancia, medo, comparacao, terceiro, experiencia ruim) e o impedimento real a responder primeiro.
// Estas leituras alimentam o fluxo de venda (salesFlow), a conducao (conduct) e o contrato de decisao do turno (turnDecision): nao ha maquina de estados paralela.
// Inferencia fraca nunca vira fato: sem sinal claro o resultado e null / "desconhecido".
// ---------------------------------------------------------------------------

export function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
const norm = (s: string) => fold(s).replace(/[^a-z0-9?% ]/g, " ").replace(/\s+/g, " ").trim();

// ---------- perguntas na mensagem ----------

const INTERROGATIVE_START = /^(qual|quais|quanto|quantos|quantas|como|onde|quando|quem|por ?que|porque|o que|que horas|tem|teria|aceita|aceitam|fazem|faz|pode|posso|podem|da pra|dá pra|existe|ha|e |será|sera|vocês|voces|voce|vc)\b/;

// PURO: as frases que sao PERGUNTA (terminam em ? ou comecam com palavra interrogativa), de todas as mensagens novas, na ordem. Limita a 5.
export function extractQuestions(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const parts = t.replace(/\s+/g, " ").split(/(?<=[?.!])\s+|\s+(?=\b(?:e|mas)\b\s+(?:qual|quanto|quantos|como|onde|quando|tem|aceita|pode)\b)/i);
    for (const raw of parts) {
      const s = raw.trim();
      if (s.length < 4) continue;
      if (/\?\s*$/.test(s) || INTERROGATIVE_START.test(norm(s))) out.push(s.replace(/[.!]+$/, ""));
    }
  }
  // uma pergunta que so repete a outra nao conta duas vezes
  const seen = new Set<string>();
  return out.filter((q) => { const k = norm(q); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
}

// ---------- a pergunta/oferta anterior da Alice ----------

export type PrevQuestionKind = "experience" | "info_offer" | "schedule_offer" | "name" | "preference" | "need" | "other" | "none";

const EXPERIENCE_Q = /(ja fez|ja realizou|fez antes|fez algum|primeira vez|ja conhece|ja experimentou|ja usou|experiencia (anterior|com)|ja tratou|ja passou por)/;
const INFO_OFFER_Q = /(quer (que eu )?(te )?(explique|explicar|entender|saber mais|conhecer|detalhar|contar)|posso (te )?(explicar|contar|detalhar)|quer saber (como|mais)|gostaria de saber (como|mais)|te explico|quer que eu te conte|ficou alguma duvida|quer entender)/;
const SCHEDULE_Q = /(avalia|horario|agend|marcar|disponibilidade|vaga|qual dia|que dia|que horas|ver (um )?horario)/;
const NAME_Q = /(nome completo|sobrenome|qual (e )?(o )?seu nome|como (voce )?(se )?chama|me (passa|diz|informa|manda) (o )?seu nome)/;
const PREFERENCE_Q = /(manha ou tarde|tarde ou noite|manha, tarde|qual (periodo|turno)|prefere (de )?(manha|tarde|noite)|qual (dia|horario) (fica|prefere)|melhor pra voce)/;
const NEED_Q = /(o que (voce )?(gostaria|quer|deseja|esta buscando|procura) (de )?(melhorar|tratar|resolver)|qual (regiao|queixa)|o que (mais )?(te )?incomoda|qual (e )?(a )?sua (principal )?(queixa|duvida))/;

// PURO: a ULTIMA pergunta que a Alice fez (a frase com ?), classificada. Sem pergunta = "none".
export function classifyPrevQuestion(lastAssistant: string): { kind: PrevQuestionKind; text: string } {
  const sentences = lastAssistant.replace(/\s+/g, " ").split(/(?<=[?.!])\s+/).map((s) => s.trim()).filter(Boolean);
  const q = [...sentences].reverse().find((s) => /\?\s*$/.test(s));
  if (!q) return { kind: "none", text: "" };
  const f = norm(q);
  if (NAME_Q.test(f)) return { kind: "name", text: q };
  if (EXPERIENCE_Q.test(f)) return { kind: "experience", text: q };
  if (INFO_OFFER_Q.test(f)) return { kind: "info_offer", text: q }; // antes da agenda: "quer que eu explique como funciona a avaliacao?" e oferta de INFORMACAO
  if (PREFERENCE_Q.test(f)) return { kind: "preference", text: q };
  if (NEED_Q.test(f)) return { kind: "need", text: q };
  if (SCHEDULE_Q.test(f)) return { kind: "schedule_offer", text: q };
  return { kind: "other", text: q };
}

// ---------- resposta curta ----------

export type ShortAnswer = "yes" | "no" | null;
const YES_RE = /^(sim|pode|pode sim|pode ser|quero|quero sim|claro|com certeza|por favor|bora|vamos|ok|isso|isso mesmo|aceito|topo|blz|beleza|gostaria|tenho interesse|tenho sim|fechado|combinado|perfeito|otimo|ja|ja fiz|ja fez|fiz sim|fiz|uhum|aham)\b/;
const NO_RE = /^(nao|nao obrigad[oa]|nunca|nunca fiz|primeira vez|e a primeira|e minha primeira|ainda nao|jamais|nada|nenhum[a]?)\b/;

// PURO: "sim"/"nao" curtos (ate 7 palavras). Frase longa nao e resposta curta.
export function shortAnswerOf(text: string): ShortAnswer {
  const t = norm(text);
  if (!t || t.split(" ").length > 7) return null;
  if (YES_RE.test(t) && !NO_RE.test(t)) return "yes";
  if (NO_RE.test(t)) return "no";
  return null;
}

export type AnswerMeaning = "experience_none" | "experience_yes" | "accepts_info" | "declines_info" | "accepts_schedule" | "refuses_offer" | "gives_name" | "gives_preference" | "gives_need" | null;

export interface AnswerReading {
  prev: { kind: PrevQuestionKind; text: string };
  answer: ShortAnswer;
  meaning: AnswerMeaning;
}

// PURO: o que a fala nova significa em relacao a pergunta anterior da Alice. Sem sinal claro = meaning null (nada de inferencia fraca).
export function interpretAnswer(lastAssistant: string, trailing: string[]): AnswerReading {
  const prev = classifyPrevQuestion(lastAssistant);
  const text = trailing.join(" ").trim();
  const answer = shortAnswerOf(trailing.length === 1 ? text : trailing.at(-1) ?? "");
  let meaning: AnswerMeaning = null;
  if (prev.kind === "experience") {
    const t = norm(text);
    if (answer === "no" || /\b(nunca|primeira vez|ainda nao|e minha primeira|nao fiz|nunca fiz)\b/.test(t)) meaning = "experience_none";
    else if (answer === "yes" || /\b(ja fiz|ja fez|fiz sim|fiz ha|fiz uma vez|fiz uns)\b/.test(t)) meaning = "experience_yes";
  } else if (prev.kind === "info_offer") {
    if (answer === "yes") meaning = "accepts_info";
    else if (answer === "no") meaning = "declines_info";
  } else if (prev.kind === "schedule_offer") {
    if (answer === "yes") meaning = "accepts_schedule";
    else if (answer === "no") meaning = "refuses_offer";
  } else if (prev.kind === "name" && text && !/\?/.test(text) && norm(text).split(" ").length <= 6) {
    meaning = "gives_name";
  } else if (prev.kind === "preference" && /\b(manha|tarde|noite|segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)\b/.test(norm(text))) {
    meaning = "gives_preference";
  } else if (prev.kind === "need" && text.length >= 3 && answer === null) {
    meaning = "gives_need";
  }
  return { prev, answer, meaning };
}

// ---------- correcao de objetivo ("nao quero X, quero Y") ----------

// "Nao quero tratar gordura, quero clarear" / "nao e gordura, e mancha" / "gordura nao, quero clarear": CORRECAO do que ela quer tratar, nao recusa do atendimento.
const CORRECTION_RE = /\b(nao (quero|preciso|e|era|estou (buscando|procurando)|busco|procuro)|nada de)\b[^,;.!?]{1,60}[,;.]?\s*(mas |e sim |sim |agora )?\b(quero|prefiro|preciso|busco|procuro|e|era|me interessa)\b/;
const NEGATIVE_THEN_WANT_RE = /\b\w+(?: \w+){0,3} nao[,;]? (mas |e sim )?\b(quero|prefiro|preciso|busco)\b/;
export function isGoalCorrection(text: string): boolean {
  const f = norm(text);
  return CORRECTION_RE.test(f) || NEGATIVE_THEN_WANT_RE.test(f);
}

// ---------- objecoes ----------

export type ObjectionKind = "price" | "time" | "distance" | "fear" | "compare" | "third_party" | "bad_experience";

const OBJECTIONS: [ObjectionKind, RegExp][] = [
  ["price", /\b(achei caro|muito caro|ta caro|esta caro|tao caro|caro demais|puxado|salgado|fora do (meu )?orcamento|nao (tenho|to com) (dinheiro|grana|condicoes)|sem condicoes|nao cabe no (meu )?bolso|pesa no bolso|valor alto|preco alto)\b/],
  ["time", /\b(sem tempo|nao tenho tempo|falta de tempo|corrida|corrido|muito ocupad[ao]|agenda cheia|trabalho muito|nao consigo (sair|me ausentar)|nao tenho horario livre)\b/],
  ["distance", /\b(moro longe|fica longe|muito longe|longe demais|outra cidade|outro bairro|distante|dificil de chegar|nao tenho como ir ai|nao consigo ir ai)\b/],
  ["fear", /\b(tenho medo|com medo|medo de|receio|insegur[ao]|me preocupa|preocupad[ao]|doi muito|vai doer|machuca|sera que doi|tenho pavor|tenho trauma|e perigoso|tem risco|da algum risco)\b/],
  ["compare", /\b(em outra clinica|na outra clinica|outra clinica|ta mais barato|mais barato la|estou comparando|to comparando|qual a diferenca (entre|do|da)|qual (e )?melhor (entre|o|a)|me indicaram outra|vi mais barato)\b/],
  ["third_party", /\b(preciso (falar|conversar|ver) com (o |a )?(meu|minha|marido|esposa|namorad[ao]|mae|pai|filh[ao]|medic[ao])|vou (falar|conversar|ver) com (o |a )?(meu|minha|marido|esposa|namorad[ao]|mae|pai)|deixa eu (falar|conversar) com|preciso da (autorizacao|opiniao)|meu marido|minha mae vai)\b/],
  ["bad_experience", /\b(ja fiz e nao gostei|nao gostei (do|da) (resultado|atendimento)|tive (uma )?(experiencia|reacao) ruim|me arrependi|fiquei com (marca|mancha|cicatriz)|deu errado|nao funcionou comigo|ja tive problema)\b/],
];

// PURO: a objecao identificavel na fala. null = nenhuma (sem inferencia por tom).
export function detectObjection(text: string): ObjectionKind | null {
  const f = norm(text);
  for (const [kind, re] of OBJECTIONS) if (re.test(f)) return kind;
  return null;
}

// Pedido de DESCONTO/negociacao ("faz por menos", "tem desconto", "faz um precinho"): isso nao se inventa nem se responde pela Alice (regra da clinica: equipe).
export function asksDiscount(text: string): boolean {
  return /\b(desconto|faz por menos|faz mais barato|abaixa o (preco|valor)|fazer um precinho|negocia|negociar|promocao|cupom|melhorar o valor|condicao especial)\b/.test(norm(text));
}

// ---------- mencao x escolha de procedimento ----------

// PURO: tira da fala os trechos que NAO escolhem procedimento: o que ela NEGOU ("nao quero botox"), a experiencia passada ("ja fiz botox", "minha amiga fez peeling") e relato de outra
// pessoa. O que sobra e o que ela quer. Usado na identificacao do procedimento escolhido: mencionar nao e escolher.
export function stripNonChoiceSegments(text: string): string {
  const segments = text.split(/(?<=[,;.!?])\s+|\s+(?:mas|porem|e sim)\s+/i);
  const keep = segments.filter((s) => {
    const f = norm(s);
    if (/^(nao|nunca|sem)\b.*\b(quero|preciso|vou|pretendo|tenho interesse|me interessa|fazer|gosto)\b/.test(f)) return false; // "nao quero o botox"
    if (/\bnao (e|era) (o |a |de |para )?/.test(f) && !/\b(quero|prefiro|e sim)\b/.test(f)) return false; // "nao e botox"
    if (/\b(ja (fiz|fez|usei|experimentei|tratei)|fiz (um|uma|o|a|ha)|minha (amiga|mae|irma|prima|colega|filha|vizinha) (fez|faz|usou|tratou|indicou)|uma amiga (fez|minha fez)|me falaram (do|da|de))\b/.test(f) && !/\b(quero|queria|gostaria|repetir|de novo|outra vez|voltar a fazer)\b/.test(f)) return false; // experiencia/relato ("ja fiz e quero de novo" continua sendo escolha)
    return true;
  });
  return keep.join(" ").trim();
}
