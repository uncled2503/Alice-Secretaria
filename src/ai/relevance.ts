// ---------------------------------------------------------------------------
// TRAVA DE RELEVANCIA (pedido da Lisboa, 14/10/2026): a Alice indicou "Preenchimento Labial" para quem queria melhorar a SOBRANCELHA.
// A regra no prompt ("nao indique tratamento sem relacao com a queixa") nao bastou. Aqui, depois que o modelo escreveu, conferimos a
// REGIAO: se a pessoa falou de uma regiao (sobrancelha, abdomen, braco...) e a resposta recomenda um procedimento cujo nome e de OUTRA
// regiao, a resposta e trocada por uma segura. So olha a regiao que aparece no NOME/apelidos do procedimento (conservador: "Botox facial"
// serve para qualquer regiao do rosto; "Peeling" sem regiao nunca e barrado).
// ---------------------------------------------------------------------------

import { CONCERN_LABEL, eligibleProcedures, procedureFitsObjective, type Objective, type ProcedureInfo } from "./concerns.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

type Area =
  | "sobrancelha" | "olhos" | "labios" | "nariz" | "testa" | "bochechas" | "queixo" | "pescoco" | "colo" | "maos"
  | "papada" | "bracos" | "abdomen" | "coxas" | "gluteos" | "costas" | "seios" | "axilas" | "virilha" | "cabelo"
  | "rosto" | "corpo";

const AREAS: { area: Area; label: string; re: RegExp }[] = [
  { area: "sobrancelha", label: "as sobrancelhas", re: /sobrancel/ },
  { area: "olhos", label: "a região dos olhos", re: /\bolh|olheir|palpebr|cilio|periorbit/ },
  { area: "labios", label: "os lábios", re: /\blabi|\bboca\b|bigode chines|codigo de barras/ },
  { area: "nariz", label: "o nariz", re: /\bnariz|nasal|rinomodel/ },
  { area: "testa", label: "a testa", re: /\btesta|glabela|frontal/ },
  { area: "bochechas", label: "as bochechas", re: /bochech|malar|zigomat/ },
  { area: "queixo", label: "o queixo", re: /queixo|\bmento\b|mandibul/ },
  { area: "papada", label: "a papada", re: /papada/ },
  { area: "pescoco", label: "o pescoço", re: /pescoc|cervical/ },
  { area: "colo", label: "o colo", re: /\bcolo\b|decote/ },
  { area: "maos", label: "as mãos", re: /\bmaos?\b/ },
  { area: "bracos", label: "os braços", re: /\bbracos?\b/ },
  { area: "abdomen", label: "o abdômen", re: /abdom|barriga|cintura|flanco/ },
  { area: "coxas", label: "as coxas", re: /\bcoxa|culote|\bperna|panturrilha/ },
  { area: "gluteos", label: "os glúteos", re: /glute|bumbum|\bbunda/ },
  { area: "costas", label: "as costas", re: /\bcostas\b/ },
  { area: "seios", label: "os seios", re: /\bseios?\b|\bmama|\bbusto/ },
  { area: "axilas", label: "as axilas", re: /axila/ },
  { area: "virilha", label: "a virilha", re: /virilha|\bintim[ao]|bikini/ },
  { area: "cabelo", label: "o cabelo", re: /cabel|capilar|couro cabeludo/ },
  { area: "rosto", label: "o rosto", re: /\brosto|facial|\bface\b/ },
  { area: "corpo", label: "o corpo", re: /\bcorpo|corporal/ },
];

const FACE = new Set<Area>(["sobrancelha", "olhos", "labios", "nariz", "testa", "bochechas", "queixo", "papada", "rosto"]);
const BODY = new Set<Area>(["bracos", "abdomen", "coxas", "gluteos", "costas", "seios", "maos", "pescoco", "colo", "corpo"]);

export function areasIn(text: string): Set<Area> {
  const t = fold(text);
  return new Set(AREAS.filter((a) => a.re.test(t)).map((a) => a.area));
}

const labelOf = (a: Area) => AREAS.find((x) => x.area === a)!.label;

// PURO: o procedimento (areas do nome) serve para a queixa (areas citadas pela pessoa)?
export function procedureFitsComplaint(procAreas: Set<Area>, complaintAreas: Set<Area>): boolean {
  if (procAreas.size === 0 || complaintAreas.size === 0) return true; // sem regiao no nome ou na queixa: nao ha o que barrar
  for (const a of procAreas) if (complaintAreas.has(a)) return true;
  if ((procAreas.has("queixo") || procAreas.has("papada")) && (complaintAreas.has("queixo") || complaintAreas.has("papada"))) return true; // mesma regiao
  const procFace = [...procAreas].some((a) => FACE.has(a));
  const procBody = [...procAreas].some((a) => BODY.has(a));
  const complaintFace = [...complaintAreas].some((a) => FACE.has(a));
  const complaintBody = [...complaintAreas].some((a) => BODY.has(a));
  // "Botox facial" serve a qualquer regiao do rosto (e uma queixa de "rosto" aceita procedimento de regiao do rosto); idem corpo.
  if (procAreas.has("rosto") && complaintFace) return true;
  if (procAreas.has("corpo") && complaintBody) return true;
  if (complaintAreas.has("rosto") && procFace) return true;
  if (complaintAreas.has("corpo") && procBody) return true;
  return false;
}

export interface RelevanceMismatch {
  procedure: string;
  complaintArea: Area | "objetivo";
  complaintLabel: string;
}

// PURO: a resposta cita (pelo nome) algum procedimento do catalogo que e de outra regiao que a da queixa?
export function findRelevanceMismatch(params: {
  complaintTexts: string[]; // mensagens da pessoa (as novas; se nao citam regiao, as ultimas)
  reply: string;
  procedures: ProcedureInfo[];
  // OBJETIVO identificado (queixa, nao so regiao - ver concerns.ts). Quando existe, ele manda: o procedimento citado precisa ter, no cadastro aprovado,
  // indicacao para essa queixa; sem indicacao declarada (informacao insuficiente) tambem nao pode ser indicado.
  objective?: Pick<Objective, "concerns" | "regions">;
  // procedimentos que a PESSOA mesma escolheu/ja tem agendado: citar o nome deles e responder o que ela pediu, nao e indicacao
  allowed?: string[];
}): RelevanceMismatch | null {
  if (params.objective && params.objective.concerns.length) {
    const replyFolded0 = fold(params.reply);
    const allowed = new Set((params.allowed ?? []).map((n) => fold(n).trim()));
    for (const p of params.procedures) {
      const name = fold(p.name).trim();
      if (name.length < 6 || !replyFolded0.includes(name) || allowed.has(name)) continue;
      if (/avalia/.test(name)) continue;
      if (!procedureFitsObjective(p, params.objective)) {
        return { procedure: p.name, complaintArea: "objetivo", complaintLabel: params.objective.concerns.map((c) => CONCERN_LABEL[c]).join(" + ") };
      }
    }
    return null;
  }
  const complaint = new Set<Area>();
  for (const t of params.complaintTexts) for (const a of areasIn(t)) complaint.add(a);
  if (complaint.size === 0) return null;
  const replyFolded = fold(params.reply);
  // O procedimento que a PESSOA escolheu (ou ja tem agendado) nao e "indicacao" da Alice: citar o nome dele e responder o que ela pediu. Sem esta excecao a trava apagava a frase com o
  // procedimento escolhido (ex.: Lavieen, com queixa so de regiao 'costas') e a reescrita indicava outro (Carboxiterapia) como se fosse o "mais indicado" - caso Nathalia.
  const allowedByName = new Set((params.allowed ?? []).map((n) => fold(n).trim()));
  for (const p of params.procedures) {
    const name = fold(p.name).trim();
    if (name.length < 6 || !replyFolded.includes(name) || allowedByName.has(name)) continue;
    const procAreas = areasIn(`${p.name} ${p.aliases ?? ""}`);
    if (!procedureFitsComplaint(procAreas, complaint)) {
      // regiao "principal" da queixa: a mais especifica (nao rosto/corpo)
      const specific = [...complaint].find((a) => a !== "rosto" && a !== "corpo") ?? [...complaint][0];
      return { procedure: p.name, complaintArea: specific, complaintLabel: labelOf(specific) };
    }
  }
  return null;
}

// Resposta segura no lugar da errada: nao cita procedimento nenhum.
// (Antes a versao sem avaliacao ja oferecida empurrava "avaliacao gratuita... quer que eu veja um horario?" mesmo quando ela so contou a queixa: era um dos
// pontos que reiniciavam a venda. Agora so esclarece, sem oferta de agenda.)
export function safeReplyForMismatch(m: RelevanceMismatch, _evalOffered: boolean): string {
  void _evalOffered;
  return `Entendi! Para ${m.complaintLabel}, quem indica o melhor caminho com segurança é a profissional. Me conta um pouco mais: o que mais te incomoda aí hoje? 💗`;
}

// PURO: procedimentos aprovados no cadastro para o objetivo (familias em ate 5 nomes), para a reescrita indicar so o que serve.
export function fittingForObjective(objective: Pick<Objective, "concerns" | "regions">, procedures: ProcedureInfo[]): string[] {
  return eligibleProcedures(objective, procedures).eligible.slice(0, 5);
}

// PURO: procedimentos do catalogo que SERVEM a queixa (a regiao do nome bate com a regiao da queixa). Usado para a Alice indicar so esses.
export function fittingProcedures(complaintTexts: string[], procedures: { name: string; aliases?: string | null }[]): string[] {
  const complaint = new Set<Area>();
  for (const t of complaintTexts) for (const a of areasIn(t)) complaint.add(a);
  if (complaint.size === 0) return [];
  const out: string[] = [];
  for (const p of procedures) {
    const procAreas = areasIn(`${p.name} ${p.aliases ?? ""}`);
    if (procAreas.size === 0 || !procedureFitsComplaint(procAreas, complaint)) continue;
    if ([...procAreas].some((a) => complaint.has(a) || (a === "queixo" && complaint.has("papada")) || (a === "papada" && complaint.has("queixo")))) out.push(p.name);
  }
  return out.slice(0, 5);
}

// Rotulos das regioes citadas no texto ("a papada", "as sobrancelhas"), sem repetir.
export function areaLabelsIn(text: string): string[] {
  const t = fold(text);
  return AREAS.filter((a) => a.re.test(t)).map((a) => a.label);
}
