import { areasIn } from "./relevance.js";

// ---------------------------------------------------------------------------
// QUEIXA x REGIAO x PROCEDIMENTO (pedido da Lisboa, 16/10/2026: "gordura localizada virou escolha de Enzimas", "clareamento recebeu sugestao
// de gordura/celulite/flacidez", "so a regiao era o criterio"). A regiao do corpo, sozinha, NUNCA justifica uma indicacao: o que a pessoa quer
// TRATAR (a queixa/objetivo) e o que manda, e a relacao entre queixa e procedimento vem do CADASTRO aprovado pela clinica (nome, apelidos,
// objetivos, beneficios, descricao), nunca do conhecimento geral do modelo.
//
// Tudo PURO (testavel). Nao e "bloqueio cego por palavra": a leitura e por oracao e entende negacao ("nao e gordura, e escurecimento"),
// correcao, duas demandas na mesma frase, passado ("ja tratei gordura"), terceiros ("minha amiga quer ...") e o tom de pele como informacao
// diferente de queixa ("minha pele e escura e quero tratar gordura").
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export type ConcernId =
  | "pigmentacao" | "gordura" | "celulite" | "flacidez" | "estrias" | "vasinhos" | "olheiras" | "acne" | "rugas" | "cicatriz" | "capilar" | "retencao" | "tatuagem" | "depilacao"
  | "volume" | "hidratacao" | "relaxamento" | "tonus";

export const CONCERN_LABEL: Record<ConcernId, string> = {
  pigmentacao: "clareamento / manchas",
  gordura: "gordura localizada",
  celulite: "celulite",
  flacidez: "flacidez / firmeza",
  estrias: "estrias",
  vasinhos: "vasinhos",
  olheiras: "olheiras",
  acne: "acne / poros / cravos",
  rugas: "rugas / linhas de expressão",
  cicatriz: "cicatrizes",
  capilar: "queda de cabelo / capilar",
  retencao: "inchaço / retenção de líquido",
  tatuagem: "tatuagem / micropigmentação",
  depilacao: "depilação",
  volume: "volume / contorno / preenchimento",
  hidratacao: "hidratação / viço / qualidade da pele",
  relaxamento: "relaxamento / massagem",
  tonus: "tônus / definição muscular",
};

// Texto ja sem acento e em minusculas. A ordem nao importa.
const CONCERN_RE: Record<ConcernId, RegExp> = {
  pigmentacao: /\bclare(ar|amento|ando|ada|ado)\b|\bmancha|\bmanchad|\bescurec|\bescurecid|\bmelasma|\bhiperpigment|\bpigmentac|\btom (irregular|desigual|despadronizado)|\buniformiz\w* (o )?tom|\bpele (mais )?escurecida/,
  gordura: /\bgordur|\bgl\b|\bgordinh|\bculote\b|\bpochete\b|\bmedidas\b/,
  celulite: /\bcelulite|\bcasca de laranja/,
  flacidez: /\bflacid|\bpele (caida|mole|solta|frouxa|flacida)|\b(perda|falta) de firmeza|\bfirmeza\b|\bsustentacao da pele/,
  estrias: /\bestria/,
  vasinhos: /\bvasinho|\bmicrovaso|\bvarize|\bveias? (aparente|saltada)|\bvasos aparentes/,
  olheiras: /\bolheira/,
  acne: /\bacne\b|\bcravo|\bespinha|\bporos?\b|\boleosidade/,
  rugas: /\bruga|\blinhas? de expressao|\bpes? de galinha|\bmarcas? de expressao/,
  cicatriz: /\bcicatri[zc]|\bmarcas? de (acne|cirurgia|queimadura)/,
  capilar: /\bqueda de cabelo|\bcalvicie|\balopecia|\bcapilar|\bcouro cabeludo|\bcabelo (caindo|ralo|fino)/,
  retencao: /\bretencao de liquido|\binchaco|\binchad[ao]|\bretencao\b/,
  tatuagem: /\btatuagem|\bmicropigmentacao|\bremover tattoo|\btattoo/,
  depilacao: /\bdepila|\bpelos?\b indesejad|\bremocao de pelos/,
  volume: /\bpreench|\bvolume\b|\baumentar (o |os |a |as )?(labio|labios|bumbum|gluteo|gluteos|seio|seios|queixo|malar|maca)|\bharmoniz|\bprojecao\b|\bcontorno (facial|do rosto|mandibular)|\bdefinicao (do )?(rosto|mandibula|queixo|labio)/,
  hidratacao: /\bhidrat|\bvico\b|\bluminos|\brejuvenesc|\bpele seca|\bqualidade da pele|\bglow\b|\bpele opaca/,
  relaxamento: /\bmassagem|\brelax|\bestresse|\btensao muscular|\bbem estar|\bspa\b/,
  tonus: /\btonus\b|\bdefinicao muscular|\bfortalec|\bhipertrofia|\bmusculo|\bmuscular\b/,
};

const ALL: ConcernId[] = Object.keys(CONCERN_RE) as ConcernId[];

// Terceiros e passado: a queixa existe, mas NAO e o objetivo desta pessoa agora.
const THIRD_PARTY_RE = /\b(minha|meu) (amiga|amigo|mae|irma|irmao|prima|primo|filha|filho|esposa|marido|sogra|vizinha|colega|namorada|namorado|tia|avo|cunhada)\b|\b(pra|para|de) (uma |um )?(amiga|amigo)\b|\b(ela|ele) (quer|esta querendo|precisa|tem|sofre)\b/;
const PAST_RE = /\bja (fiz|fiquei|tratei|usei|tive|resolvi|trato)\b|\bantes (eu )?(tinha|fazia|tratava|usava)\b|\bano passado\b|\bja foi (tratad|resolvid)/;
// Negacao: "nao e X", "nao quero tratar X", "nada de X", "nao tenho X", "sem interesse em X"
const NEGATION_RE = /\bnao (e|era|eh|quero|preciso|busco|procuro|vim|tenho|me interessa|estou procurando|estou buscando|e sobre|e para|e pra|se trata)\b|\bnada de\b|\bsem interesse (em|no|na)\b|\bnem (e|era)\b|\bnao tem a ver com\b|\bdeixa (pra la )?(a|o)? ?\w* de lado\b/;
// Troca de assunto: o que vem depois substitui o que vinha antes.
const REPLACE_RE = /\b(na verdade|agora (eu )?(quero|preciso|busco)|mudei de ideia|so (quero|preciso|busco)|apenas|somente|esquece|esquece isso|o que eu quero (mesmo )?e)\b/;
// Tom de pele: informacao DIFERENTE de queixa ("minha pele e escura", "sou morena"). Sozinho, "pele escura" e queixa de clareamento (regra da Lisboa).
const TONE_RE = /\b(minha pele (e|eh|e bem|e muito|e bastante) (escura|morena|negra|parda|clara)|(sou|tenho (a )?pele) (bem |muito )?(escura|morena|negra|parda|clara|branca)|pele (negra|morena|parda))\b/;
const BARE_DARK_SKIN_RE = /\bpele escura\b|\bpele mais escura\b|\bpele muito escura\b/;
const TONE_ALL_RE = new RegExp(TONE_RE.source, "g");

export interface ObjectiveMessage {
  text: string;
  createdAt?: Date;
}

export interface Objective {
  concerns: ConcernId[]; // o que ela quer tratar AGORA (mais recente primeiro)
  negated: ConcernId[]; // o que ela disse que NAO e / NAO quer
  past: ConcernId[]; // queixa antiga ou de outra pessoa: informacao, nao objetivo
  regions: string[]; // regioes citadas junto da queixa (ou na ultima mensagem)
  toneMentioned: boolean; // falou do tom da pele como descricao (nao como queixa)
  regionOnly: boolean; // citou regiao do corpo mas NENHUMA queixa: precisa esclarecer
}

export const EMPTY_OBJECTIVE: Objective = { concerns: [], negated: [], past: [], regions: [], toneMentioned: false, regionOnly: false };

// Quebra em oracoes (ponto, virgula, ponto e virgula, "mas"): o escopo de uma negacao e a oracao.
function clausesOf(text: string): string[] {
  return fold(text)
    .split(/[.!?;\n,]+|\bmas\b/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function concernsIn(clause: string): ConcernId[] {
  return ALL.filter((id) => CONCERN_RE[id].test(clause));
}

// PURO: as queixas de UMA mensagem, separadas por papel.
export function readMessageConcerns(text: string): { wanted: ConcernId[]; negated: ConcernId[]; past: ConcernId[]; tone: boolean; replace: boolean } {
  const wanted = new Set<ConcernId>();
  const negated = new Set<ConcernId>();
  const past = new Set<ConcernId>();
  let tone = false;
  let replace = false;
  const clauses = clausesOf(text);
  // 1) tom de pele descrito: tira da oracao (nao e queixa) quando ha outra queixa na mensagem
  const anyOtherConcern = clauses.some((c) => concernsIn(c.replace(TONE_ALL_RE, " ").replace(BARE_DARK_SKIN_RE, " ")).length > 0);
  for (const raw of clauses) {
    let c = raw;
    if (TONE_RE.test(c)) {
      tone = true;
      c = c.replace(TONE_ALL_RE, " ");
    }
    if (BARE_DARK_SKIN_RE.test(c)) {
      if (anyOtherConcern) tone = true; // "minha pele e escura e quero tratar gordura": tom, nao queixa
      else wanted.add("pigmentacao"); // so "pele escura": regra da Lisboa = clareamento
      c = c.replace(BARE_DARK_SKIN_RE, " ");
    }
    const found = concernsIn(c);
    if (!found.length) continue;
    if (THIRD_PARTY_RE.test(c) || PAST_RE.test(c)) {
      for (const id of found) past.add(id);
      continue;
    }
    if (NEGATION_RE.test(c)) {
      for (const id of found) negated.add(id);
      continue;
    }
    if (REPLACE_RE.test(c)) replace = true;
    for (const id of found) wanted.add(id);
  }
  // "clareamento" na mesma oracao de uma negacao da gordura ("nao e gordura, e escurecimento") ja foi separado por virgula acima.
  for (const id of negated) wanted.delete(id);
  return { wanted: [...wanted], negated: [...negated], past: [...past], tone, replace };
}

const WINDOW_MS = 72 * 3_600_000;
const WINDOW_MESSAGES = 8;

// PURO: o objetivo ATUAL, lendo as ultimas mensagens da pessoa (da mais antiga para a mais nova). Uma correcao posterior vence; duas demandas
// na conversa ficam as duas; queixa de outra pessoa, antiga, ou muito velha nao contamina.
export function readObjective(messages: ObjectiveMessage[], now = new Date()): Objective {
  const recent = messages
    .filter((m) => m.text.trim())
    .filter((m) => !m.createdAt || now.getTime() - m.createdAt.getTime() <= WINDOW_MS)
    .slice(-WINDOW_MESSAGES);
  let wanted: ConcernId[] = []; // mais recente por ultimo
  const negated = new Set<ConcernId>();
  const past = new Set<ConcernId>();
  let tone = false;
  const regionHistory: string[] = [];
  for (const m of recent) {
    const r = readMessageConcerns(m.text);
    if (r.tone) tone = true;
    for (const id of r.past) past.add(id);
    for (const id of r.negated) {
      negated.add(id);
      wanted = wanted.filter((w) => w !== id); // corrigiu: o que vinha antes sai
    }
    if (r.wanted.length) {
      if (r.replace) wanted = [];
      for (const id of r.wanted) {
        negated.delete(id); // voltou a querer
        wanted = wanted.filter((w) => w !== id);
        wanted.push(id);
      }
    }
    const areas = [...areasIn(m.text)];
    if (areas.length) regionHistory.push(...areas);
  }
  const last = recent.at(-1);
  const lastAreas = last ? [...areasIn(last.text)] : [];
  const regions = [...new Set(lastAreas.length ? lastAreas : regionHistory.slice(-3))];
  const concerns = [...wanted].reverse();
  // regiao sem queixa: ela citou so a regiao nas mensagens recentes e nenhuma queixa em momento algum
  const regionOnly = concerns.length === 0 && regionHistory.length > 0 && negated.size === 0;
  return { concerns, negated: [...negated], past: [...past].filter((p) => !concerns.includes(p)), regions, toneMentioned: tone, regionOnly };
}

// ---------------------------------------------------------------------------
// O que o CADASTRO aprovado diz que cada procedimento atende.
// ---------------------------------------------------------------------------

export interface ProcedureInfo {
  name: string;
  aliases?: string | null;
  goals?: string | null;
  benefits?: string | null;
  description?: string | null;
}

// PURO: as queixas que o cadastro do procedimento declara atender. So texto aprovado (nome, apelidos, objetivos, beneficios e o inicio da descricao).
// "GL" maiusculo no nome ("Enzima GL Abdomen") e a sigla de gordura localizada usada pela Lisboa. Sem nada declarado, o conjunto e vazio:
// o procedimento NAO e recomendado para queixa alguma (informacao insuficiente - nunca se completa por adivinhacao).
export function procedureConcerns(p: ProcedureInfo): Set<ConcernId> {
  const found = new Set<ConcernId>();
  const collect = (text: string) => {
    // A descricao fala de varias coisas ("nao substitui tratamento de gordura"): negacao na oracao tira do conjunto.
    for (const clause of clausesOf(text)) {
      if (NEGATION_RE.test(clause)) continue;
      for (const id of concernsIn(clause)) found.add(id);
    }
  };
  // "Objetivos" (goals) = as queixas que a clinica diz que o procedimento atende; mais nome e apelidos. Beneficios e descricao so valem quando esses
  // nao dizem nada (a descricao cita muita coisa de passagem: "clareamento progressivo de pigmentos de tatuagem" nao e clareamento de pele).
  collect([p.name, p.aliases ?? "", p.goals ?? ""].join(" \n "));
  if (/\bGL\b/.test(p.name)) found.add("gordura");
  if (found.size === 0) collect([p.benefits ?? "", (p.description ?? "").slice(0, 600)].join(" \n "));
  return found;
}

export interface Eligibility {
  eligible: string[]; // procedimentos cujo cadastro atende a queixa (e, quando ha regiao nos dois lados, a regiao tambem bate)
  uninformed: string[]; // sem queixa declarada no cadastro: nao podem ser indicados
  excludedForOtherConcerns: string[]; // atendem OUTRAS queixas (ex.: gordura) e nao a dela
}

const isEvaluation = (n: string) => /avalia/i.test(n);

// PURO: quais procedimentos do catalogo podem ser indicados para o objetivo. A avaliacao nunca entra aqui (e um caminho, nao um tratamento).
export function eligibleProcedures(objective: Pick<Objective, "concerns" | "regions">, catalog: ProcedureInfo[]): Eligibility {
  const out: Eligibility = { eligible: [], uninformed: [], excludedForOtherConcerns: [] };
  if (!objective.concerns.length) return out;
  const want = new Set(objective.concerns);
  const wantAreas = new Set(objective.regions);
  for (const p of catalog) {
    if (isEvaluation(p.name)) continue;
    const have = procedureConcerns(p);
    if (have.size === 0) { out.uninformed.push(p.name); continue; }
    const serves = [...have].some((c) => want.has(c));
    if (!serves) { out.excludedForOtherConcerns.push(p.name); continue; }
    // regiao e REFINAMENTO (nunca o unico criterio): se a queixa e a procedimento citam regioes e nenhuma bate, nao serve
    const procAreas = areasIn(`${p.name} ${p.aliases ?? ""}`);
    if (wantAreas.size && procAreas.size && ![...procAreas].some((a) => wantAreas.has(a) || regionCompatible(a, wantAreas))) { out.excludedForOtherConcerns.push(p.name); continue; }
    out.eligible.push(p.name);
  }
  // Ela citou uma regiao e ha procedimento cujo cadastro (nome/apelidos) fala DESSA regiao: os que nao dizem regiao nenhuma ficam de fora (o cadastro especifico vence o generico).
  if (wantAreas.size && out.eligible.length > 1) {
    const byName = new Map(catalog.map((p) => [p.name, p]));
    const specific = out.eligible.filter((n) => {
      const p = byName.get(n);
      const procAreas = p ? areasIn(`${p.name} ${p.aliases ?? ""}`) : new Set<string>();
      return procAreas.size > 0;
    });
    if (specific.length > 0) out.eligible = specific;
  }
  return out;
}

// rosto/corpo genericos aceitam regioes especificas do mesmo grupo; queixo~papada
function regionCompatible(procArea: string, wanted: Set<string>): boolean {
  const FACE = new Set(["sobrancelha", "olhos", "labios", "nariz", "testa", "bochechas", "queixo", "papada", "rosto"]);
  const BODY = new Set(["bracos", "abdomen", "coxas", "gluteos", "costas", "seios", "maos", "pescoco", "colo", "corpo"]);
  if (procArea === "rosto") return [...wanted].some((a) => FACE.has(a));
  if (procArea === "corpo") return [...wanted].some((a) => BODY.has(a));
  if (wanted.has("rosto") && FACE.has(procArea)) return true;
  if (wanted.has("corpo") && BODY.has(procArea)) return true;
  if ((procArea === "queixo" && wanted.has("papada")) || (procArea === "papada" && wanted.has("queixo"))) return true;
  return false;
}

// PURO: o procedimento citado numa resposta e adequado ao objetivo? Sem objetivo identificado, nada a barrar.
export function procedureFitsObjective(p: ProcedureInfo, objective: Pick<Objective, "concerns" | "regions">): boolean {
  if (!objective.concerns.length) return true;
  const e = eligibleProcedures(objective, [p]);
  return e.eligible.length === 1;
}
