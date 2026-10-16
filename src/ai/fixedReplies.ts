// Respostas FIXAS que o proprio codigo escreve (agradecimento, aviso de urgencia, "sou a assistente virtual"...): nao precisam de revisao por IA
// (nao gastam token) e as de seguranca NUNCA podem ser barradas (orientam procurar emergencia).
const FIXED: RegExp[] = [
  /^Por nada(, [^!]+)?!/i,
  /^Obrigada pela confirma[cç][aã]o/i,
  /^Que bom saber/i,
  /^Combinado! Qualquer coisa/i,
  /^Sinto muito que isso esteja acontecendo/i,
  /^Poxa, desculpa por isso!/i,
  /^Vou pedir pra uma pessoa da equipe/i,
  /^Sou a [^,]+, assistente virtual/i,
];
const SAFETY = /\bsamu\b|pronto[- ]socorro|emerg[eê]ncia/i;

export function isFixedReply(text: string): boolean {
  const t = text.trim();
  return SAFETY.test(t) || FIXED.some((re) => re.test(t));
}
