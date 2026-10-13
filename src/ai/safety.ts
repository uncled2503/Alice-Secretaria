// ---------------------------------------------------------------------------
// REACAO APOS PROCEDIMENTO (regra de seguranca da Lisboa): se a paciente, depois de um atendimento recente, relatar dor
// intensa, alergia, sangramento, queimadura, bolha, secrecao, alteracao de cor, febre ou qualquer reacao que preocupe, a
// Alice NAO tenta diagnosticar nem orientar clinicamente: interrompe o fluxo automatico e passa na hora pra equipe.
// O deteccao e por palavras (rapida e sem depender do modelo); na duvida, transfere - o custo de uma transferencia a
// mais e pequeno perto do de ignorar uma reacao.
// ---------------------------------------------------------------------------

// Texto ja normalizado (minusculo, sem acento nem pontuacao) - ver normalizeReply em alice.ts.
const REACTION_RE =
  /queimadur|queimou|queimei|\bbolhas?\b|secrecao|\bpus\b|febre|infeccion|infeccao|alergi|coceira (forte|intensa|muito)|muito (inchad|vermelh)|ficou (roxa|roxo|preta|preto|escura|escuro|branca|branco)|manchas? (roxa|roxo|escura|escuro|preta|preto)|dor (intensa|forte|insuportavel)|doendo muito|ardendo muito|sangrou|esta sangrando|sangrando/;

// "nao tenho alergia", "sem alergia a nada": historico informado, nao reacao.
const NEGATED_RE = /\b(sem|nao tenho|nao tem|nenhuma|nunca tive) (nenhuma )?alergi/;

export function reportsProcedureReaction(normalizedText: string): boolean {
  if (!normalizedText) return false;
  const cleaned = normalizedText.replace(NEGATED_RE, " ");
  return REACTION_RE.test(cleaned);
}

export const REACTION_HANDOFF_REASON = "REAÇÃO após procedimento"; // o job de pos-procedimento para quando ve isto

export const REACTION_TEXT =
  "Sinto muito que isso esteja acontecendo. 💗 Já estou avisando nossa equipe, que vai falar com você agora para te orientar. Se piorar, ou se sentir muita dor, falta de ar ou sangramento intenso, procure um pronto-atendimento.";

// Janela em que um relato conta como possivel reacao ao procedimento.
export const REACTION_WINDOW_DAYS = 21;
