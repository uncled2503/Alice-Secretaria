// ---------------------------------------------------------------------------
// MOTIVOS DE VETO (juiz de recontato e revisor de envio). Log de producao de 19/10/2026: vetos como "A pessoa nao tem horario agendado", "A pessoa nao respondeu a mensagem
// anterior", "A pessoa e um novo lead" e "A pessoa parou de responder apos solicitar agendamento". Esses fatos DESCREVEM o publico do recontato/retomada: quem nao tem horario,
// nao respondeu e some depois de pedir agendamento e justamente quem recebe a automacao. Sozinhos nunca justificam barrar. Aqui: a lista de categorias que SIM justificam
// (opt-out, equipe falando, retorno combinado, reclamacao/assunto sensivel, contato nao comercial, repeticao, conteudo errado...), e um filtro que reconhece o veto cujo UNICO
// motivo e descrever o publico. Veto com motivo legitimo, ou sem motivo reconhecivel, continua valendo: nada aqui obriga o envio. Tudo PURO.
// ---------------------------------------------------------------------------

export type VetoCategory =
  | "opt_out" | "sem_interesse" | "atendimento_humano" | "retorno_combinado" | "reclamacao" | "assunto_sensivel" | "nao_comercial"
  | "ja_tem_horario" | "ja_atendida" | "repeticao" | "conteudo_incorreto" | "momento_inadequado" | "contexto_incoerente" | "outro";

export const VETO_CATEGORIES: readonly VetoCategory[] = ["opt_out", "sem_interesse", "atendimento_humano", "retorno_combinado", "reclamacao", "assunto_sensivel", "nao_comercial", "ja_tem_horario", "ja_atendida", "repeticao", "conteudo_incorreto", "momento_inadequado", "contexto_incoerente", "outro"];

// categorias que justificam barrar uma automacao por si so
export const LEGITIMATE_VETO: ReadonlySet<VetoCategory> = new Set<VetoCategory>(["opt_out", "sem_interesse", "atendimento_humano", "retorno_combinado", "reclamacao", "assunto_sensivel", "nao_comercial", "ja_tem_horario", "ja_atendida", "repeticao", "conteudo_incorreto", "momento_inadequado"]);

export function parseCategory(raw: unknown): VetoCategory | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[\s-]+/g, "_") : "";
  return (VETO_CATEGORIES as readonly string[]).includes(v) ? (v as VetoCategory) : null;
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

// o motivo diz so uma condicao que faz parte do publico da automacao
const AUDIENCE = /(nao (tem|possui|ha|existe)( nenhum| qualquer)? (horario|agendamento|consulta|atendimento|avaliacao)( agendad[oa]| marcad[oa])?|sem (horario|agendamento|consulta|avaliacao)( agendad[oa]| marcad[oa])?|nao respondeu|nao respondeu a mensagem anterior|parou de responder|ficou sem responder|sem resposta (ao|a) (anterior|recontato|mensagem)|nao agendou|ainda nao (agendou|marcou|fechou)|nao (fechou|confirmou|marcou)|(e|eh) um (novo )?lead|lead novo|novo lead|solicit\w+ (o )?agendamento|pediu (para )?(agendar|marcar|horario)|nao tem interacao recente|poucas mensagens)/;

// qualquer sinal de motivo REAL na mesma frase mantem o veto
const REAL = /(pediu para (nao|parar)|nao quer|nao (tem|demonstrou) interesse|sem interesse|recus|opt[- ]?out|reclam|problema|queixa|dor\b|doente|hospital|luto|equipe|atendimento humano|retorno combinado|combinou|ja (tem|possui) (um )?(horario|agendamento|consulta)|tem (horario|agendamento) (marcad|agendad)|cancel|ja (foi|esta) (atendid|avaliad)|duplicad|repetid|ja recebeu|ja (enviamos|mandamos)|curricul|candidat|fornecedor|parceria|cobranca|sensivel|urgenc|incoerente|contradiz|diverge|informacao incorret|errad)/;

// PURO: o motivo descreve SO o publico da automacao (nao justifica o veto)?
export function isEligibilityRestatement(reason: string | null | undefined): boolean {
  const r = fold(reason ?? "");
  if (!r) return false;
  if (!AUDIENCE.test(r)) return false;
  // "nao tem horario" nao e "ja tem horario": REAL so conta quando a frase nao e a negacao do publico
  const stripped = r.replace(AUDIENCE, " ");
  return !REAL.test(stripped);
}

// PURO: o veto vale? Com categoria legitima vale; sem categoria (ou "outro") vale, exceto se o motivo for so a descricao do publico.
// Envios que existem POR CAUSA de um horario marcado (aviso de agendamento, lembrete, confirmacao, preparo): "a pessoa ja tem horario" e a RAZAO do envio, nunca motivo para barrar
// (log de 22/10: aviso de agendamento vetado "porque a pessoa ja tem horario"). Os demais motivos continuam valendo (cancelado/remarcado/outro horario sao divergencia, categoria propria).
const APPOINTMENT_BOUND_KINDS: ReadonlySet<string> = new Set(["agendamento", "lembrete", "preparo"]);

export function vetoStands(category: VetoCategory | null, reason: string | null | undefined, kind?: string): { stands: boolean; why: string } {
  if (category === "ja_tem_horario" && kind && APPOINTMENT_BOUND_KINDS.has(kind)) return { stands: false, why: "o aviso e sobre o proprio horario marcado: ja ter horario e o motivo do envio, nao do veto" };
  if (category && LEGITIMATE_VETO.has(category)) return { stands: true, why: `categoria ${category}` };
  if (isEligibilityRestatement(reason)) return { stands: false, why: "o motivo apenas descreve o publico da automacao (sem horario / sem resposta / lead novo / pediu agendamento)" };
  return { stands: true, why: category ? `categoria ${category}` : "motivo sem categoria reconhecida" };
}

// Finalidade de cada automacao, dita ao revisor/juiz (o que ela existe para fazer e quem e o publico dela).
export const AUTOMATION_PURPOSE: Record<string, string> = {
  recontato: "Recontato por silencio: existe PARA quem demonstrou interesse e parou de responder. O publico normal e: lead novo, sem horario marcado, que nao respondeu a mensagem anterior ou sumiu depois de pedir agendamento. Esses fatos sao o MOTIVO do envio, nunca motivo para barrar.",
  retomada: "Retomada de avaliacao: existe PARA quem cancelou a avaliacao ou foi avaliada e nao fechou. Nao ter horario marcado e o publico dela.",
  indicacao: "Convite de indicacao: existe PARA quem acabou de dar nota alta. Nao e oferta de agenda.",
  pesquisa: "Pesquisa de satisfacao: existe PARA quem acabou de ser atendida. Nao e oferta de agenda.",
  pos: "Acompanhamento pos-procedimento: existe PARA quem acabou de ser atendida.",
  aniversario: "Parabens de aniversario: existe PARA qualquer pessoa da base que nao pediu para sair.",
  renovacao: "Convite de renovacao: existe PARA quem fez um procedimento periodico ha meses.",
  campanha: "Campanha/mensagem programada: existe PARA o publico escolhido pela clinica.",
  agendamento: "Aviso de agendamento: existe PARA quem TEM um horario marcado (acabou de ser criado/alterado). Ter horario e a razao do envio, nunca motivo para barrar; so barre se o horario da mensagem diverge da agenda (cancelado/remarcado) ou ha opt-out/equipe falando.",
  lembrete: "Lembrete/confirmacao: existe PARA quem TEM horario marcado. Ter horario e a razao do envio, nunca motivo para barrar.",
  preparo: "Orientacao de preparo: existe PARA quem TEM horario marcado para o procedimento. Ter horario e a razao do envio.",
};
