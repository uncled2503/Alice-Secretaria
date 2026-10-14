// ---------------------------------------------------------------------------
// FLUXO DE VENDA. A Alice acumulou dezenas de regras no prompt (descoberta, nao insistir em avaliacao, nao falar de valor, ...)
// que se contradiziam: a cliente escrevia "Prefiro uma avaliacao" e ela respondia com preco e a mesma pergunta de descoberta.
// Aqui a conversa e lida de forma DETERMINISTICA a cada turno: qual e a intencao da cliente agora (agendar, recusou horarios,
// perguntou valor, so quer informacao), o que ela ja contou, e qual e a PROXIMA JOGADA. O resultado vira UMA instrucao clara
// pro modelo (e desliga as regras que conflitam com ela).
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export type Intent = "schedule" | "decline" | "hesitate" | "price" | "info";

export interface FlowMessage {
  role: string;
  content: string;
}

export interface SalesFlow {
  intent: Intent;
  askedPrice: boolean; // as mensagens novas perguntam valor
  statedGoal: boolean; // ela ja contou o que quer (queixa/regiao/procedimento)
  scheduleAsked: boolean; // em algum momento pediu avaliacao/agendamento (e ainda nao tem horario marcado)
  slotsOffered: boolean; // a ultima fala da Alice ofereceu horarios
  evalOffered: boolean; // a Alice ja falou de avaliacao nesta conversa
  nextMove: string; // instrucao pro modelo
}

const SCHEDULE_RE =
  /\bavalia(cao|coes)\b|agend|\bmarc(ar|o|a|ado|acao)\b|horario|disponib|\bvaga|quero (ir|fazer|marcar)|gostaria de (agendar|marcar|ir|fazer)|quando (posso|da|tem)|pode ser (hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado)|(amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado)\b.{0,18}\b(as|a partir)\b|\b\d{1,2}\s?(h\b|horas|:\d\d)/;

const DECLINE_RE =
  /\b(nenhum(a)?( deles| delas| desses| dessas)?|nao (da|posso|consigo|rola|tenho como|vai dar|serve|quero)|nao me (serve|atende)|outro (dia|horario)|mais pra frente|mais tarde|vou pensar|depois (eu )?(vejo|falo|aviso|te falo)|talvez depois)\b/;

// "Nao" claro ao procedimento/proposta (nao a um horario) e adiamentos ("vou me organizar", "depois eu vejo").
const HARD_NO_RE =
  /\b(nao tenho (mais )?interesse|sem interesse|nao quero( mais)?( fazer| esse| isso)?|desisti|nao vou (fazer|querer)|nao (era|e) isso|nao me interessa)\b/;
const SOFT_STALL_RE =
  /\b(vou pensar|vou me organizar|vou ver (e|com)|te aviso|depois (eu )?(vejo|falo|aviso|te falo|entro em contato)|mais pra frente|talvez depois|agora nao|no momento nao|deixa eu ver)\b/;

const GOAL_RE =
  /gordura|barriga|abdom|flacidez|flacida|braco|ruga|mancha|celulite|estria|papada|coxa|culote|olheira|acne|labio|rosto|\bpele\b|cabelo|emagrec|peso|sobrancelha|tatuagem|depila|cicatriz|poros|bumbum|gluteo|perna|seio|colo\b|melasma|vasinho/;

const OFFERED_SLOT_RE = /(\d{1,2}h(\d\d)?|\d{1,2}:\d\d)/;

export function wantsSchedule(text: string): boolean {
  return SCHEDULE_RE.test(fold(text));
}

export function declinesOptions(text: string): boolean {
  return DECLINE_RE.test(fold(text));
}

export function statesGoal(messages: string[]): boolean {
  return messages.some((m) => m.length >= 60 || GOAL_RE.test(fold(m)));
}

// priceAsked: o chamador diz se as mensagens novas perguntam valor (PRICE_ASK_RE vive em alice.ts).
// hasBooking: ela ja tem agendamento futuro (nao empurra agendamento de novo).
export function analyzeFlow(input: { history: FlowMessage[]; trailing: string[]; priceAsked: boolean; hasBooking: boolean }): SalesFlow {
  const { history, trailing, priceAsked, hasBooking } = input;
  const userAll = history.filter((m) => m.role === "user").map((m) => m.content);
  const assistant = history.filter((m) => m.role !== "user").map((m) => m.content);
  const lastAssistant = assistant.at(-1) ?? "";
  const trailText = trailing.join(" ");

  const slotsOffered = OFFERED_SLOT_RE.test(fold(lastAssistant)) && /\?/.test(lastAssistant);
  const evalOffered = assistant.some((m) => /avalia/i.test(fold(m)));
  const scheduleAsked = !hasBooking && userAll.some((m) => wantsSchedule(m));
  const statedGoal = statesGoal(userAll);
  // "Nao posso hoje, pode ser amanha as 15h?" recusou E propos outro horario: segue o agendamento (nao e recusa).
  const proposesTime = /\b\d{1,2}\s?(h\b|horas|:\d\d)|\b(amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(fold(trailText));
  const declined = declinesOptions(trailText) && !proposesTime && (slotsOffered || evalOffered || scheduleAsked);

  // Disse "nao"/"vou pensar"/"vou me organizar" sem propor nada: a Alice nao pode responder so "ok" nem ficar esperando.
  const trailFold = fold(trailText);
  const hardNo = HARD_NO_RE.test(trailFold);
  const softStall = SOFT_STALL_RE.test(trailFold) && !slotsOffered;
  const hesitates = !proposesTime && (hardNo || softStall);

  let intent: Intent = "info";
  if (hasBooking && !wantsSchedule(trailText)) intent = priceAsked ? "price" : "info";
  else if (hesitates) intent = "hesitate";
  else if (declined) intent = "decline";
  else if (wantsSchedule(trailText) || scheduleAsked) intent = "schedule";
  else if (priceAsked) intent = "price";

  const noPrice = priceAsked ? "" : " Ela NAO perguntou valor: nao fale de valor, investimento nem parcelas.";
  let nextMove: string;
  switch (intent) {
    case "schedule":
      nextMove =
        "A cliente quer AGENDAR (avaliacao ou procedimento). Va DIRETO ao agendamento, sem perguntas de descoberta e sem repetir o que ja foi dito: se ela ja citou dia/hora, chame check_specific_time; senao chame check_availability e ofereca 2 ou 3 opcoes reais (um dia por vez). Para 'avaliacao', use o procedimento de avaliacao cadastrado. Se ela respondeu a uma pergunta sua (ex.: a regiao, a queixa), agradeca em meia frase e volte ao agendamento. Se o horario pedido nao esta livre, diga so que 'esse horario nao esta disponivel' (NUNCA cite outro paciente) e ofereca o mais proximo no mesmo dia e nos dias seguintes. Horario combinado: book_appointment." +
        noPrice;
      break;
    case "decline":
      nextMove =
        "A cliente RECUSOU as opcoes que voce deu. NAO se despeca e NAO encerre ('se mudar de ideia...' perde a venda). Em UMA frase curta, pergunte qual dia da semana e periodo (manha, tarde ou noite) ficam melhores pra ela, e ja chame check_availability para ver OUTROS dias (inclusive amanha em outro horario) e ofereca 2 opcoes novas. So pare se ela disser claramente que nao quer mais." +
        noPrice;
      break;
    case "hesitate":
      nextMove =
        "A cliente disse NAO, que vai pensar ou que vai se organizar - sem marcar nada. NUNCA responda so 'ok', 'tudo bem' ou 'quando estiver pronta me avise': isso entrega a venda. Respeite (sem pressao, sem insistir, sem inventar desconto/urgencia), mas em 1 frase acolha e faca UMA pergunta aberta que descubra o motivo ou combine o retorno, por exemplo: 'o que te deixou ainda pensando sobre o protocolo?' ou 'quando podemos retomar nosso contato?' (se ela disse que vai se organizar: 'qual dia da semana costuma ficar mais tranquilo pra voce? ja deixo um horario em mente'). Escolha a pergunta que combina com o que ela disse; nao repita uma pergunta que ja fez." +
        noPrice;
      break;
    case "price":
      nextMove =
        "Ela perguntou VALOR. Responda isso primeiro, em 1 frase, conforme a regra de valores desta clinica (cadastrados, ou a equipe apresenta), sem enrolar, e conduza ao proximo passo: avaliacao ou horario.";
      break;
    default:
      nextMove = statedGoal
        ? "Ela JA contou o que quer (queixa/regiao). NAO pergunte de novo 'o que voce gostaria de melhorar'. Reconheca a queixa com as palavras dela (1 frase), conecte a solucao do catalogo (1 frase) e feche com UMA pergunta concreta que leve a avaliacao ou ao horario (ex.: 'Quer que eu veja um horario pra sua avaliacao?')." +
          noPrice +
          (evalOffered ? " Voce ja falou de avaliacao: se ela nao pediu, nao repita a oferta; aprofunde com informacao util e uma pergunta NOVA." : "")
        : "Descubra o que ela quer com UMA pergunta especifica ao assunto dela (se veio de anuncio, use o procedimento do anuncio; ex.: gordura -> qual regiao). Curto, natural." + noPrice;
  }

  return { intent, askedPrice: priceAsked, statedGoal, scheduleAsked, slotsOffered, evalOffered, nextMove };
}

// Reclamacao direta do atendimento automatico ("a IA de voces e pessima", "repetitiva", "nao ajuda em nada"): pessoa de verdade.
const BOT_COMPLAINT_RE =
  /\b(ia|robo|bot|maquina|automatic[oa]|atendimento automatico)\b.{0,50}\b(pessim|horriv|ruim|repetitiv|burr|inutil|nao (ajuda|auxilia|resolve|entende))|\b(repetitiv[ao]|nao auxilia|nao ajuda em nada|nao entende nada|so repete|fala (a mesma|sempre a mesma) coisa)\b/;

export function complainsAboutBot(text: string): boolean {
  return BOT_COMPLAINT_RE.test(fold(text));
}
