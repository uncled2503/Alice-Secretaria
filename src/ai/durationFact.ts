// ---------------------------------------------------------------------------
// DURACAO DE UM PROCEDIMENTO, COM FONTE (caso Nathalia, 21/10/2026: "demora quanto tempo?" sobre Lavieen foi respondida com os 15 minutos da Carboxiterapia). A duracao que a Alice pode
// dizer vem do CADASTRO do procedimento em discussao, distinguindo a AVALIACAO da SESSAO, e nunca de outro servico:
//   1. duracao ESCRITA na descricao/beneficios aprovados ("a sessao dura cerca de 30 minutos") = informacao do cadastro;
//   2. senao, o tempo RESERVADO na agenda (Procedure.durationMin) - que NAO e necessariamente o tempo de aplicacao; so e confiavel quando a clinica usa o Clinica Experts E o procedimento
//      esta vinculado a ele (a duracao veio de la), ou quando a clinica nao usa o CE (a clinica a digitou);
//   3. senao, nao ha duracao confiavel: a Alice diz que confirma com a equipe, nunca usa a de outro procedimento.
// PURO.
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export interface DurationProc {
  name: string;
  durationMin: number;
  ceId?: number | null;
  description?: string | null;
  benefits?: string | null;
  resultTimeline?: string | null;
}

export type DurationSource = "texto_aprovado" | "reserva_cadastro" | "reserva_ce" | "nenhuma";
export interface DurationFact { procedure: string; source: DurationSource; text: string }

const WRITTEN_RE = /(?:dura|duracao|demora|leva|tempo (?:de|do|da) (?:aplicacao|procedimento|sessao|atendimento))[^.\n;]{0,45}?(\d{1,3}(?:\s*(?:a|-|ou|e)\s*\d{1,3})?)\s*(minutos?|min\b|horas?|h\b)/;

export function durationFactOf(p: DurationProc, ctx: { clinicUsesCe: boolean }): DurationFact {
  const text = fold([p.description ?? "", p.benefits ?? "", p.resultTimeline ?? ""].join(" \n "));
  const m = WRITTEN_RE.exec(text);
  if (m) return { procedure: p.name, source: "texto_aprovado", text: `${m[1].replace(/\s+/g, " ")} ${/^h/.test(m[2]) ? "hora(s)" : "minutos"} (escrito no cadastro aprovado)` };
  if (!ctx.clinicUsesCe) return { procedure: p.name, source: "reserva_cadastro", text: `${p.durationMin} minutos de tempo RESERVADO na agenda (cadastro da clinica; nao e necessariamente o tempo de aplicacao)` };
  if (p.ceId != null) return { procedure: p.name, source: "reserva_ce", text: `${p.durationMin} minutos de tempo RESERVADO na agenda (vindo do Clinica Experts; nao e necessariamente o tempo de aplicacao)` };
  return { procedure: p.name, source: "nenhuma", text: "sem duracao confiavel no cadastro" };
}

// Texto da ficha: separa avaliacao e sessao e proibe usar a duracao de outro procedimento.
export function durationBriefing(subject: DurationProc | null, evaluation: DurationProc | null, ctx: { clinicUsesCe: boolean; evaluationFirst: boolean }): string {
  if (!subject) return "FATO DE DURACAO: nao ha procedimento identificado nesta conversa: NAO responda duracao de nenhum procedimento especifico; pergunte de qual ela fala (ou diga que confirma com a equipe). NUNCA use a duracao de outro servico.";
  const s = durationFactOf(subject, ctx);
  const sessao = s.source === "nenhuma"
    ? `SESSAO de "${subject.name}": ${s.text}. Diga que a duracao exata confirma com a equipe/na avaliacao (chame transfer_to_human se ela insistir) - NUNCA use a duracao de outro procedimento.`
    : `SESSAO de "${subject.name}": ${s.text}.`;
  const aval = evaluation ? ` AVALIACAO ("${evaluation.name}"): ${durationFactOf(evaluation, ctx).text}.` : "";
  return `FATO DE DURACAO (so estes dados valem; a duracao de outro procedimento NAO se aplica): ${sessao}${aval}${ctx.evaluationFirst ? " Este procedimento so e feito DEPOIS da avaliacao: distinga as duas duracoes." : ""}`;
}
