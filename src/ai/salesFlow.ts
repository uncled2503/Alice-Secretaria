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

export type Intent = "schedule" | "decline" | "hesitate" | "price" | "info" | "booked" | "returning";

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
  hasBooking: boolean; // ela ja tem agendamento futuro (nao e lead em descoberta)
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

// A ultima fala da Alice ofereceu avaliacao/horario/agendamento (e terminou em pergunta)?
const OFFER_RE = /avalia|horario|agend|marcar|disponibilidade|vaga/;
const ACCEPT_RE = /^(sim|pode|pode sim|quero|quero sim|claro|com certeza|por favor|pode ser|bora|vamos|ok|isso|isso mesmo|aceito|topo|blz|beleza|gostaria|tenho interesse|tenho sim|pode marcar|pode agendar|fechado|combinado|perfeito|otimo)\b/;
const REFUSE_RE = /\b(nao|nem|talvez|depois|outra hora|so queria|so estou)\b/;
const DAYPART_RE = /\b(amanha|hoje|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|manha|tarde|noite|folga|de manha|a tarde)\b/;

// PURO: "Sim" (ou "pode", "quero"...) respondendo a uma oferta de avaliacao/horario = ACEITOU: e pedido de agendamento.
export function acceptsSchedulingOffer(trailing: string, lastAssistant: string): boolean {
  const t = fold(trailing).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 7) return false;
  if (!OFFER_RE.test(fold(lastAssistant)) || !/\?/.test(lastAssistant)) return false;
  return ACCEPT_RE.test(t) && !REFUSE_RE.test(t);
}

// priceAsked: o chamador diz se as mensagens novas perguntam valor (PRICE_ASK_RE vive em alice.ts).
// hasBooking: ela ja tem agendamento futuro (nao empurra agendamento de novo).
export function analyzeFlow(input: { history: FlowMessage[]; trailing: string[]; priceAsked: boolean; hasBooking: boolean; pastVisits?: boolean }): SalesFlow {
  const { history, trailing, priceAsked, hasBooking } = input;
  const pastVisits = input.pastVisits === true;
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

  // "Sim" a uma oferta de horario/avaliacao, ou "amanha estarei de folga" depois de uma oferta: quer agendar (antes a Alice explicava o
  // procedimento de novo e perguntava "voce ja fez antes?").
  const lastOffered = OFFER_RE.test(fold(lastAssistant)) && /\?/.test(lastAssistant);
  const accepted = acceptsSchedulingOffer(trailText, lastAssistant);
  const gaveAvailability = lastOffered && DAYPART_RE.test(trailFold) && !REFUSE_RE.test(trailFold);
  const wantsToBook = wantsSchedule(trailText) || accepted || gaveAvailability;

  let intent: Intent = "info";
  if (hasBooking && !wantsToBook) intent = "booked"; // ja agendou: so responde o que perguntou e para
  else if (hesitates) intent = "hesitate";
  else if (declined) intent = "decline";
  else if (wantsToBook || scheduleAsked) intent = "schedule";
  else if (pastVisits) intent = "returning"; // ja e paciente: nao e lead, nao recebe oferta de avaliacao
  else if (priceAsked) intent = "price";

  const noPrice = priceAsked ? "" : " Ela NAO perguntou valor: nao fale de valor, investimento nem parcelas.";
  let nextMove: string;
  switch (intent) {
    case "schedule":
      nextMove =
        "A cliente quer AGENDAR. Va DIRETO ao agendamento, sem perguntas de descoberta e sem repetir o que ja foi dito (se ela so disse 'sim'/'pode' a uma oferta sua, ACEITOU: ofereca os horarios agora, nao explique o procedimento de novo). " +
        "QUAL PROCEDIMENTO: se ela quer um procedimento especifico do catalogo (ex.: limpeza de pele, drenagem), agende ESSE procedimento (nome exato do catalogo), nao a avaliacao. A avaliacao gratuita e para quem pediu avaliacao ou ainda nao sabe o que quer; se o procedimento citado ou a oferta do anuncio NAO estiver no catalogo, NAO diga que nao encontrou nem pergunte de novo: agende a AVALIACAO gratuita (a equipe apresenta a oferta, sem prometer valor ou condicao). " +
        "HORARIOS: chame check_availability (ja devolve os mais proximos) e ofereca NO MAXIMO 3 horarios reais, hoje e amanha primeiro; nunca liste mais de 3. Se ela disse o turno (manha, tarde ou noite), passe period e ofereca so desse turno; se ainda nao disse, pode perguntar UMA vez qual turno prefere. Se ela ja citou dia/hora, chame check_specific_time. " +
        "Se o horario pedido nao esta livre, diga so que 'esse horario nao esta disponivel' (NUNCA cite outro paciente) e ofereca os mais proximos. " +
        "NUNCA escreva 'conseguimos agendar', 'agendei' ou 'esta agendado' antes de book_appointment dar certo: ate la voce so OFERECE ('tenho estes horarios'). Horario escolhido: book_appointment. Se ela fez outra pergunta junto (endereco, valor), responda tambem." +
        noPrice;
      break;
    case "decline":
      nextMove =
        "A cliente RECUSOU as opcoes que voce deu. NAO se despeca e NAO encerre ('se mudar de ideia...' perde a venda). Em UMA frase curta, pergunte qual dia da semana e periodo (manha, tarde ou noite) ficam melhores pra ela, e ja chame check_availability para ver OUTROS dias (inclusive amanha em outro horario) e ofereca 2 opcoes novas. So pare se ela disser claramente que nao quer mais." +
        noPrice;
      break;
    case "hesitate":
      nextMove =
        "A cliente disse NAO, que vai pensar ou que vai se organizar - sem marcar nada. NUNCA responda so 'ok', 'tudo bem' ou 'quando estiver pronta me avise': isso entrega a venda. Respeite (sem pressao, sem insistir, sem inventar desconto/urgencia). Em 1 frase acolha e, se fizer sentido, faca UMA pergunta aberta que descubra o motivo (ex.: 'o que te deixou ainda pensando?'). NAO proponha avaliacao nem peca dia e turno de agendamento agora. Proponha um momento para retomar o contato (ex.: 'posso te chamar amanha?' ou 'qual dia e horario ficam bons pra eu te chamar?'); quando ela disser o dia e o horario, chame schedule_recontact (date AAAA-MM-DD, time HH:MM) e confirme em uma frase. Se ela ja disse quando quer ser chamada, registre direto. Nao repita uma pergunta que ja fez." +
        noPrice;
      break;
    case "booked":
      nextMove =
        "A cliente JA TEM HORARIO MARCADO. O atendimento esta concluido: NAO faca perguntas de descoberta (queixa, regiao, 'o que gostaria de melhorar'), NAO ofereca avaliacao nem outro horario, NAO puxe assunto novo. Responda SO o que ela perguntou, em ate 2 frases, e PARE, sem pergunta no final." +
        (priceAsked ? " Ela perguntou valor: responda conforme a regra de valores desta clinica, em 1 frase." : " Se for so agradecimento ou 'ok', encerre com uma frase curta ('Por nada! Te esperamos') ou nao responda.");
      break;
    case "returning":
      nextMove =
        "Ela JA E PACIENTE da clinica (ja foi atendida): NAO e lead. NAO ofereca avaliacao gratuita nem pergunte o que ela quer melhorar como se fosse o primeiro contato. Responda so ao que ela disse, curto e caloroso. Se for feedback positivo (ex.: 'estou otima'), agradeca em UMA frase e encerre, sem pergunta. Se ela quiser agendar algo, agende o procedimento que ela pedir." +
        (priceAsked ? " Ela perguntou valor: responda conforme a regra de valores desta clinica, em 1 frase." : "");
      break;
    case "price":
      nextMove = evalOffered
        ? "Ela perguntou VALOR. Responda isso primeiro, em 1 frase, conforme a regra de valores desta clinica. Voce JA ofereceu a avaliacao e ela nao pegou a oferta: NAO ofereca avaliacao nem horario agora. Converse de verdade: explique o procedimento de que ela esta falando com o que esta cadastrado (o que e, para que serve, como funciona), em 2 ou 3 frases, sem despejar tudo, e termine com UMA pergunta sobre o interesse ou a duvida dela. So volte a falar de avaliacao se ela demonstrar interesse em agendar."
        : "Ela perguntou VALOR. Responda isso primeiro, em 1 frase, conforme a regra de valores desta clinica (cadastrados, ou a equipe apresenta), sem enrolar, e conduza ao proximo passo: avaliacao ou horario.";
      break;
    default:
      nextMove = statedGoal
        ? evalOffered
          ? "Ela JA contou o que quer e voce JA falou de avaliacao sem que ela pedisse. NAO repita a oferta nem pergunte de novo o que ela quer melhorar. Converse de verdade: explique o procedimento do catalogo que resolve a queixa dela (o que e, para que serve, como funciona) em 2 ou 3 frases, sem despejar tudo, e termine com UMA pergunta NOVA sobre o interesse ou a duvida dela. So volte a falar de avaliacao se ela demonstrar interesse em agendar." +
            noPrice
          : "Ela JA contou o que quer (queixa/regiao). NAO pergunte de novo 'o que voce gostaria de melhorar'. Reconheca a queixa com as palavras dela (1 frase), conecte a solucao do catalogo (1 frase) e feche com UMA pergunta concreta que leve a avaliacao ou ao horario (ex.: 'Quer que eu veja um horario pra sua avaliacao?')." +
            noPrice
        : "Descubra o que ela quer com UMA pergunta especifica ao assunto dela (se veio de anuncio, use o procedimento do anuncio; ex.: gordura -> qual regiao). Curto, natural." + noPrice;
  }

  return { intent, askedPrice: priceAsked, statedGoal, scheduleAsked, slotsOffered, evalOffered, hasBooking, nextMove };
}

// Reclamacao direta do atendimento automatico ("a IA de voces e pessima", "repetitiva", "nao ajuda em nada"): pessoa de verdade.
const BOT_COMPLAINT_RE =
  /\b(ia|robo|bot|maquina|automatic[oa]|atendimento automatico)\b.{0,50}\b(pessim|horriv|ruim|repetitiv|burr|inutil|nao (ajuda|auxilia|resolve|entende))|\b(repetitiv[ao]|nao auxilia|nao ajuda em nada|nao entende nada|so repete|fala (a mesma|sempre a mesma) coisa)\b/;

export function complainsAboutBot(text: string): boolean {
  return BOT_COMPLAINT_RE.test(fold(text));
}
