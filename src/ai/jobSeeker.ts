// Quem escreve por causa de uma VAGA DE EMPREGO (anuncio de contratacao, "envio meu curriculo") nao e paciente: nao recebe oferta de avaliacao.
// "tem vaga amanha?" e pergunta de horario (vaga = lugar na agenda) e NAO conta: so vale "vaga de <funcao>", curriculo, processo seletivo
// ou o anuncio ser de vaga.

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const JOB_TEXT_RE =
  /curricul|processo seletivo|\bvaga (de|para|pra) (esteticista|recepcionista|biomedic|auxiliar|atendente|secretaria|massagista|depiladora|enfermeir|tecnic|estagi|comercial|vendedora|gerente|avaliador|consultor|manicure|cabeleireir|podolog|terapeuta|fisioterapeuta|esteticista de|aplicador)|oportunidade de (emprego|trabalho)|trabalhar (com voces|ai|na lisboa|na clinica|ai na)|(quero|gostaria de|tenho interesse em) (me )?candidatar|enviar (meu )?curricul/;

// "vaga" sozinha NAO basta: anuncio de promocao ("Ultima vaga da semana", "vagas limitadas") fala de agenda, nao de emprego.
const JOB_AD_RE = /\bvagas? (de|para|pra) (emprego|trabalho|esteticista|recepcionista|biomedic|auxiliar|atendente|secretaria|massagista|depiladora|enfermeir|tecnic|estagi|vendedora|gerente|avaliador|consultor|manicure|cabeleireir|podolog|terapeuta|fisioterapeuta|aplicador)|\bvagas? aberta|contrata|recrutamento|processo seletivo|curricul|emprego/;

// PURO: `text` = ultima mensagem; `adText` = nome do anuncio/campanha de origem (se houver).
export function isJobSeeker(text: string, adText = ""): boolean {
  const t = fold(text);
  if (JOB_TEXT_RE.test(t)) return true;
  // anuncio de vaga + a mensagem fala de vaga/interesse em trabalhar
  return JOB_AD_RE.test(fold(adText)) && /\bvaga\b|interesse|curricul|trabalh/.test(t);
}

// Outros contatos que NAO sao paciente (checklist Lisboa 15/10): fornecedor/representante oferecendo produto ou servico, proposta de
// parceria, cobranca/boleto de empresa. Frases FORTES de proposito: "tem parceria com convenio?" ou "quanto custa?" continuam sendo paciente.
// Vai pra equipe em silencio, sem oferta de avaliacao nem horario.
export type NonPatientKind = "fornecedor" | "parceria" | "cobranca";

const SUPPLIER_RE =
  /(sou|somos) (a |o )?(representante|fornecedor|fornecedora|distribuidor|distribuidora|vendedor da|vendedora da|da empresa|da distribuidora)|represent(o|amos) (a |o )?(empresa|marca|laboratorio|distribuidora)|oferecer (nossos|nossas|o nosso|a nossa) (produtos?|servicos?|solucoes|sistema|software|equipamentos?)|apresentar (nossos|nossas|o nosso|a nossa) (produtos?|servicos?|solucoes|empresa|sistema|equipamentos?)|gostaria de apresentar (a |o )?(minha|meu|nossa|nosso)|falar com (o|a) (responsavel|proprietari[oa]|dono|dona|gerente) (de compras|da clinica|pela clinica)/;
const PARTNERSHIP_RE = /proposta de parceria|propor (uma )?parceria|parceria (comercial|com a (clinica|lisboa)|com voces)|permuta|divulgacao (em troca|por troca)|sou influenciador|sou influencer|publi(cidade)? (na|no) (meu|nosso)|midia kit|media kit/;
const BILLING_RE = /(segunda via|2a via) (do )?boleto|boleto (em aberto|vencido|da clinica|da empresa)|nota fiscal (da|de) (compra|entrega)|cobranca (de|da) (empresa|fatura|mensalidade do sistema)|fatura (em aberto|vencida) (da|do) (clinica|sistema)|titulo (protestado|em aberto)/;

// PURO: `text` = mensagem da pessoa. Devolve a categoria ou null (paciente / duvida comum).
export function nonPatientKind(text: string): NonPatientKind | null {
  const t = fold(text);
  if (SUPPLIER_RE.test(t)) return "fornecedor";
  if (PARTNERSHIP_RE.test(t)) return "parceria";
  if (BILLING_RE.test(t)) return "cobranca";
  return null;
}
