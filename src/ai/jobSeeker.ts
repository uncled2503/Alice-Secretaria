// Quem escreve por causa de uma VAGA DE EMPREGO (anuncio de contratacao, "envio meu curriculo") nao e paciente: nao recebe oferta de avaliacao.
// "tem vaga amanha?" e pergunta de horario (vaga = lugar na agenda) e NAO conta: so vale "vaga de <funcao>", curriculo, processo seletivo
// ou o anuncio ser de vaga.

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const JOB_TEXT_RE =
  /curricul|processo seletivo|\bvaga (de|para|pra) (esteticista|recepcionista|biomedic|auxiliar|atendente|secretaria|massagista|depiladora|enfermeir|tecnic|estagi|comercial|vendedora|gerente)|oportunidade de (emprego|trabalho)|trabalhar (com voces|ai|na lisboa|na clinica|ai na)|(quero|gostaria de|tenho interesse em) (me )?candidatar|enviar (meu )?curricul/;

const JOB_AD_RE = /\bvaga\b|contrata|recrutamento|selecao|curricul|emprego/;

// PURO: `text` = ultima mensagem; `adText` = nome do anuncio/campanha de origem (se houver).
export function isJobSeeker(text: string, adText = ""): boolean {
  const t = fold(text);
  if (JOB_TEXT_RE.test(t)) return true;
  // anuncio de vaga + a mensagem fala de vaga/interesse em trabalhar
  return JOB_AD_RE.test(fold(adText)) && /\bvaga\b|interesse|curricul|trabalh/.test(t);
}
