// ---------------------------------------------------------------------------
// FLUXO DE VENDA. A Alice acumulou dezenas de regras no prompt (descoberta, nao insistir em avaliacao, nao falar de valor, ...)
// que se contradiziam: a cliente escrevia "Prefiro uma avaliacao" e ela respondia com preco e a mesma pergunta de descoberta.
// Aqui a conversa e lida de forma DETERMINISTICA a cada turno: qual e a intencao da cliente agora (agendar, recusou horarios,
// perguntou valor, so quer informacao), o que ela ja contou, e qual e a PROXIMA JOGADA. O resultado vira UMA instrucao clara
// pro modelo (e desliga as regras que conflitam com ela).
// ---------------------------------------------------------------------------

import { chosenSlotDirective, wantedDirective, type ChosenSlot, type Wanted } from "./bookingIntent.js";
import { asksOpeningHours } from "./replyFacts.js";
import { asksDiscount, detectObjection, extractQuestions, interpretAnswer, isGoalCorrection, type AnswerMeaning, type ObjectionKind } from "./turnReading.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export type Intent = "schedule" | "decline" | "hesitate" | "refuse" | "price" | "info" | "booked" | "returning" | "manage" | "staff";

export interface FlowMessage {
  role: string;
  content: string;
}

export interface SalesFlow {
  intent: Intent;
  askedPrice: boolean; // as mensagens novas perguntam valor
  statedGoal: boolean; // ela ja contou o que quer (queixa/regiao/procedimento)
  scheduleAsked: boolean; // em algum momento pediu avaliacao/agendamento (e ainda nao tem horario marcado)
  schedulingSignal: boolean; // ESTA mensagem (ou a conversa em andamento) pede/aceita/recusa horario: so entao a Alice pode listar horarios
  slotsOffered: boolean; // a ultima fala da Alice ofereceu horarios
  evalOffered: boolean; // a Alice ja falou de avaliacao nesta conversa
  hasBooking: boolean; // ela ja tem agendamento futuro (nao e lead em descoberta)
  nextMove: string; // instrucao pro modelo
  reading: TurnReading; // o que as mensagens novas SIGNIFICAM (resposta curta, correcao de objetivo, objecao, perguntas): entrada do contrato de decisao do turno
}

export interface TurnReading {
  meaning: AnswerMeaning; // resposta curta interpretada em relacao a pergunta anterior da Alice
  prevQuestion: string; // a pergunta/oferta anterior (texto), "" se nao havia
  goalCorrection: boolean; // "nao quero X, quero Y": corrige o objetivo, nao recusa
  objection: ObjectionKind | null;
  discountAsk: boolean;
  questions: string[]; // perguntas feitas nas mensagens novas: todas precisam de resposta
  asksHours: boolean; // perguntou o EXPEDIENTE da clinica (dias/horarios de atendimento): nao e pedido de vagas
  infoQuestionOnly: boolean; // pergunta INFORMATIVA (sessoes, duracao, o que inclui...): responde, nao muda para a agenda
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

// "Nao." / "Agora nao." respondendo a uma OFERTA: recusa da oferta (nao dos horarios, que e outro caso: "nao consigo nesse horario, so sabado").
const REFUSE_ONLY_RE = /^(nao|nao obrigad[oa]|agora nao|nao quero|nao preciso|prefiro nao|por enquanto nao|nao por enquanto|nao no momento|no momento nao|nao tenho interesse|sem interesse)[ .!,]*$/;
export function isBareRefusal(text: string): boolean {
  return REFUSE_ONLY_RE.test(fold(text).replace(/\s+/g, " ").trim());
}

// A Alice acabou de pedir o NOME para concluir o agendamento?
const ASKED_NAME_RE = /nome completo|sobrenome|qual (e )?(o )?seu nome|seu nome (completo|e sobrenome)|como (voce )?(se )?chama|me (passa|diz|informa|manda) (o )?seu nome|preciso do seu nome/;
export function askedForName(lastAssistant: string): boolean {
  return ASKED_NAME_RE.test(fold(lastAssistant));
}

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
const OFFER_RE = /avalia|horario|agend|marcar|disponibilidade|vaga|turno|periodo|prefere (de )?(manha|tarde|noite)|(manha|tarde|noite) ou (a |de )?(manha|tarde|noite)|qual dia|que dia|que horas/;
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
export function analyzeFlow(input: {
  history: FlowMessage[];
  trailing: string[];
  priceAsked: boolean;
  hasBooking: boolean;
  pastVisits?: boolean;
  wanted?: Wanted; // qual procedimento ela quer (bookingIntent.identifyWanted)
  chosen?: ChosenSlot | null; // horario que ela ja escolheu numa lista oferecida
  chosenFullName?: string | null; // nome completo que ela ja deu (pra book_appointment)
  evaluationName?: string | null; // nome da avaliacao no catalogo
  awaitingName?: boolean; // ela acabou de responder o NOME que a Alice pediu para concluir um agendamento em andamento
  unmappedOffer?: string | null; // oferta anunciada/citada SEM cadastro: nao vira avaliacao nem outro procedimento (vem da conducao)
  needOptions?: string[]; // procedimentos APROVADOS no cadastro para a queixa dela (vem da conducao); [] = nenhum com indicacao aprovada
}): SalesFlow {
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
  // ALICE_TURN_READING=off desliga a leitura do turno (volta a jogada generica anterior); padrao: ligada
  const readingOn = process.env.ALICE_TURN_READING !== "off";
  const reading: TurnReading = !readingOn
    ? { meaning: null, prevQuestion: "", goalCorrection: false, objection: null, discountAsk: false, questions: [], asksHours: false, infoQuestionOnly: false }
    : {
    ...(() => { const r = interpretAnswer(lastAssistant, trailing); return { meaning: r.meaning, prevQuestion: r.prev.text }; })(),
    goalCorrection: isGoalCorrection(trailText),
    objection: detectObjection(trailText),
    discountAsk: asksDiscount(trailText),
    questions: extractQuestions(trailing),
    asksHours: asksOpeningHours(trailText),
    infoQuestionOnly: false, // calculado abaixo (depende de ter pedido/aceito horario)
  };
  const declined = declinesOptions(trailText) && !proposesTime && !reading.goalCorrection && (slotsOffered || evalOffered || scheduleAsked);

  // Disse "nao"/"vou pensar"/"vou me organizar" sem propor nada: a Alice nao pode responder so "ok" nem ficar esperando.
  const trailFold = fold(trailText);
  const hardNo = HARD_NO_RE.test(trailFold) && !reading.goalCorrection; // "nao quero tratar gordura, quero clarear" e CORRECAO do objetivo, nao recusa
  const softStall = SOFT_STALL_RE.test(trailFold) && !slotsOffered;
  const hesitates = !proposesTime && (hardNo || softStall);
  const lastOfferedEarly = OFFER_RE.test(fold(lastAssistant)) && /\?/.test(lastAssistant);
  const refusesOffer = !hesitates && !proposesTime && lastOfferedEarly && isBareRefusal(trailText);

  // "Sim" a uma oferta de horario/avaliacao, ou "amanha estarei de folga" depois de uma oferta: quer agendar (antes a Alice explicava o
  // procedimento de novo e perguntava "voce ja fez antes?").
  const lastOffered = OFFER_RE.test(fold(lastAssistant)) && /\?/.test(lastAssistant);
  const accepted = acceptsSchedulingOffer(trailText, lastAssistant);
  const gaveAvailability = lastOffered && DAYPART_RE.test(trailFold) && !REFUSE_RE.test(trailFold);
  const chosen = hasBooking ? null : input.chosen ?? null; // ja agendada: nada a escolher
  // "Quero uma limpeza de pele": pediu um procedimento do catalogo pelo nome = quer agendar ESSE (nao e so curiosidade). Pergunta de valor/informacao nao conta.
  const namesProcedure = !reading.goalCorrection && input.wanted !== undefined && (input.wanted.kind === "specific" || input.wanted.kind === "options") && /\b(quero|queria|gostaria|tenho interesse|interesse em|fazer|marcar)\b/.test(fold(trailText)) && !priceAsked && !/\b(saber|informac\w*|duvida|como funciona|explic\w*|o que e)\b/.test(fold(trailText));
  const awaitingName = input.awaitingName === true && !hasBooking;
  // Pergunta INFORMATIVA (quantas sessoes? quanto tempo dura? inclui radiofrequencia?) nao e pedido de agenda: responde primeiro. So conta quando a fala nao traz nada de
  // horario/dia/aceite, nao escolheu horario e nao esta entregando o nome de um agendamento em andamento.
  const SCHED_WORD_RE = /\b(horario|horarios|vaga|vagas|agendar|agenda|marcar|marca|dia|dias|hora|horas|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|manha|tarde|noite|disponivel|disponibilidade|encaixe|encaixar)\b/;
  const awaitingNameEarly = input.awaitingName === true && !hasBooking;
  if (readingOn && !priceAsked && reading.questions.length > 0 && !reading.asksHours && !hasBooking && !accepted && !gaveAvailability && !input.chosen && !awaitingNameEarly && !wantsSchedule(trailText) && !SCHED_WORD_RE.test(trailFold)) reading.infoQuestionOnly = true;
  const hoursOnly = reading.asksHours && !accepted && !input.chosen && !awaitingNameEarly;
  const wantsToBook = (wantsSchedule(trailText) || accepted || gaveAvailability || !!chosen || namesProcedure || awaitingName) && !hoursOnly;

  // Pedido ANTIGO de horario (scheduleAsked) so conta se a conversa ainda esta no meio do agendamento (a ultima fala ofereceu horario ou perguntou
  // de agendar). Antes valia pra sempre: depois de a pessoa pedir horario uma vez, TODA mensagem ("Ok.", "Nao.", "Pra minha amiga.") virava "va
  // direto ao agendamento" e a Alice listava horarios de avaliacao do nada (Clarinda, 16/10).
  // "Recente" = pediu horario numa das ULTIMAS 4 falas dela (a conversa ainda e de agendamento: ela responde as perguntas de qualificacao da Alice).
  const scheduleRecent = !hasBooking && !hoursOnly && !reading.infoQuestionOnly && userAll.slice(-4).some((m) => wantsSchedule(m));
  const midScheduling = slotsOffered || lastOffered;
  // Recusou a oferta ou disse que vai pensar: nao ha pedido de agenda neste turno (mesmo que ela tenha pedido horario antes na conversa).
  const schedulingSignal = (wantsToBook || (declined && midScheduling) || scheduleRecent) && !refusesOffer && !hesitates;
  let intent: Intent = "info";
  if (hasBooking && !wantsToBook) intent = "booked"; // ja agendou: so responde o que perguntou e para
  else if (hesitates) intent = "hesitate";
  else if (refusesOffer) intent = "refuse";
  else if (declined) intent = "decline";
  else if (wantsToBook || scheduleRecent) intent = "schedule";
  else if (pastVisits) intent = "returning"; // ja e paciente: nao e lead, nao recebe oferta de avaliacao
  else if (priceAsked) intent = "price";

  const noPrice = priceAsked ? "" : " Ela NAO perguntou valor: nao fale de valor, investimento nem parcelas.";
  const wanted: Wanted = input.wanted ?? { kind: "none" };
  const evalName = input.evaluationName ?? null;
  // Queixa sem escolha: as opcoes sao as APROVADAS no cadastro para a queixa (vem da conducao), nunca as que bateram so por apelido.
  const needWanted: Wanted | null = wanted.kind === "need" && input.needOptions ? { kind: "need", options: input.needOptions } : null;
  let nextMove: string;
  switch (intent) {
    case "schedule":
      nextMove =
        "A cliente quer AGENDAR. Va DIRETO ao agendamento, sem perguntas de descoberta e sem repetir o que ja foi dito (se ela so disse 'sim'/'pode' a uma oferta sua, ACEITOU: ofereca os horarios agora, nao explique o procedimento de novo). " +
        (chosen ? chosenSlotDirective(chosen, input.chosenFullName ?? null) : "") +
        (awaitingName
          ? "ELA ACABOU DE INFORMAR O NOME QUE VOCE PEDIU para CONCLUIR um agendamento que ja estava em andamento: isso e a CONTINUACAO, nao um recomeço. NAO reinicie a venda, NAO ofereca avaliacao, NAO explique o procedimento de novo e NAO liste outros horarios. Use o procedimento e o horario combinados nas mensagens acima e chame book_appointment (patient_full_name com o nome dela). So se nao estiver claro QUAL horario ela escolheu, pergunte apenas isso. "
          : "") +
        (input.unmappedOffer
          ? `OFERTA SEM CADASTRO: ela falou de "${input.unmappedOffer}", que ainda nao esta cadastrada (sem procedimento nem agenda no sistema). NAO liste horarios dela, NAO escolha um procedimento parecido e NAO agende avaliacao no lugar. `
          : input.wanted
          ? wantedDirective(needWanted ?? wanted, evalName)
          : "QUAL PROCEDIMENTO: se ela quer um procedimento especifico do catalogo (ex.: limpeza de pele, drenagem), agende ESSE procedimento (nome exato do catalogo), nao a avaliacao. A avaliacao gratuita e para quem pediu avaliacao ou ainda nao sabe o que quer. ") +
        "Se ela pediu a avaliacao gratuita de forma explicita, agende a avaliacao. Se o procedimento citado ou a oferta do anuncio NAO estiver no catalogo: NAO diga que 'nao encontrou' nem pergunte de novo; NAO agende avaliacao no lugar, NAO associe a outro procedimento e NAO prometa valor, condicao nem disponibilidade. Diga em UMA frase que vai confirmar essa oferta com a equipe e chame transfer_to_human; a avaliacao so entra se ELA pedir a avaliacao. " +
        "HORARIOS: chame check_availability (ja devolve os mais proximos) e ofereca NO MAXIMO 3 horarios reais, hoje e amanha primeiro; nunca liste mais de 3. Se ela disse o turno (manha, tarde ou noite), passe period e ofereca so desse turno; se ainda nao disse, pode perguntar UMA vez qual turno prefere. Se ela ja citou dia/hora, chame check_specific_time. " +
        "Se o horario pedido nao esta livre, diga so que 'esse horario nao esta disponivel' (NUNCA cite outro paciente) e ofereca os mais proximos. " +
        "NUNCA escreva 'conseguimos agendar', 'agendei' ou 'esta agendado' antes de book_appointment dar certo: ate la voce so OFERECE ('tenho estes horarios'). Horario escolhido: book_appointment. Se ela fez outra pergunta junto (endereco, valor), responda tambem." +
        noPrice;
      break;
    case "decline":
      nextMove =
        "A cliente RECUSOU os horarios que voce deu, mas continua no agendamento. Nao encerre ainda: em UMA frase curta, pergunte qual dia da semana e periodo (manha, tarde ou noite) ficam melhores pra ela, e ja chame check_availability para ver OUTROS dias (inclusive amanha em outro horario) e ofereca ate 2 opcoes novas. Pare assim que ela disser que nao quer mais ou que nao quer agendar." +
        noPrice;
      break;
    case "hesitate":
      nextMove =
        "A cliente disse que vai PENSAR / se organizar (ou que nao quer agora) - sem marcar nada. Respeite: acolha em UMA frase calorosa, sem pressao, sem insistir e sem inventar desconto ou urgencia. NAO ofereca avaliacao, NAO liste horarios e NAO peca dia e turno agora; a insistencia imediata acabou. Pode deixar a porta aberta em meia frase ('qualquer coisa e so me chamar'). So se ELA disser quando quer ser chamada (ex.: 'me chama dia 20'), chame schedule_recontact (date AAAA-MM-DD, time HH:MM) e confirme em uma frase. Nao repita uma pergunta que ja fez. Nao e desinteresse definitivo: se ela voltar a falar de agenda, atenda normalmente." +
        noPrice;
      break;
    case "refuse":
      nextMove =
        "A cliente RECUSOU a oferta que voce fez ('nao'). Respeite em UMA frase curta e acolhedora ('Tudo bem! Qualquer coisa e so me chamar 💗'). NAO insista, NAO ofereca avaliacao nem horarios de novo, NAO pergunte o motivo e NAO faca outra pergunta de venda. Recusar essa oferta nao e recusar o atendimento: se ela fizer outra pergunta ou voltar a falar de agenda, atenda normalmente." +
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
          : "Ela JA contou o que quer (queixa/regiao). NAO pergunte de novo 'o que voce gostaria de melhorar'. Reconheca a queixa com as palavras dela (1 frase), conecte a solucao do catalogo (1 frase) e, se fizer sentido para o momento dela, feche com UMA pergunta concreta que leve ao proximo passo (sem obrigar pergunta no fim se ela so agradeceu ou ja decidiu): " +
            (wanted.kind === "specific"
              ? `ela quer "${wanted.procedure}", entao pergunte se quer que voce veja um horario pra esse procedimento (NAO fale de avaliacao).`
              : wanted.kind === "options"
                ? `o catalogo tem mais de um que serve (${wanted.options.map((o) => `"${o}"`).join(", ")}): pergunte qual ela prefere pra ver o horario; so se ela nao souber, ofereca a avaliacao.`
                : wanted.kind === "need"
                  ? `ela contou uma NECESSIDADE, nao escolheu procedimento: NAO escolha um por ela e NAO ofereca horarios agora. Em 1 ou 2 frases acolha, diga que a clinica tem opcoes para isso (${wanted.options.map((o) => `"${o}"`).join(", ")}) sem despejar detalhes e pergunte UMA coisa (qual regiao mais incomoda, ou se ja conhece algum). A avaliacao gratuita e o caminho quando ela nao souber qual escolher.`
                  : "se ela nao sabe qual procedimento precisa, a avaliacao gratuita (ex.: 'Quer que eu veja um horario pra sua avaliacao?').") +
            noPrice
        : "Descubra o que ela quer com UMA pergunta especifica ao assunto dela (se veio de anuncio, use o procedimento do anuncio; ex.: gordura -> qual regiao). Curto, natural." + noPrice;
  }

  nextMove = refineMove(nextMove, intent, reading, { priceAsked, hasBooking, noPrice });
  return { intent, askedPrice: priceAsked, statedGoal, scheduleAsked, schedulingSignal, slotsOffered, evalOffered, hasBooking, nextMove, reading };
}

// ---------------------------------------------------------------------------
// REFINAMENTO DA JOGADA pela leitura do turno. NAO e outra camada de regras empilhada: onde a jogada generica ignorava o que a pessoa acabou de dizer (resposta curta,
// objecao, pergunta junto de "vou pensar"), ela e SUBSTITUIDA (ou completada com a obrigacao de responder). Casos de agenda (schedule), horario ja marcado (booked),
// recusa da oferta (refuse) e as travas de conducao/situacao continuam mandando como antes.
// ---------------------------------------------------------------------------
const OBJECTION_MOVE: Record<ObjectionKind, string> = {
  price: "OBJECAO DE PRECO ('achei caro'). Responda ao impedimento REAL antes de qualquer pergunta: reconheca sem discutir, mostre o que o cadastro aprovado diz de beneficio/duracao/o que esta incluido e, SE a clinica tiver condicoes de pagamento cadastradas (FAQ, mensagens prontas, regras), diga quais; se NAO tiver, diga com honestidade que a equipe apresenta o investimento e as condicoes e como seguir. NAO invente desconto, parcelamento, promocao, urgencia nem comparacao com outras clinicas, e NAO transfira so por ela achar caro (transfira apenas se ela PEDIR desconto/negociacao). Pergunta curta so se precisar entender o que pesou.",
  time: "OBJECAO DE TEMPO ('sem tempo'). Acolha em meia frase e responda ao impedimento: use a duracao e a frequencia que o cadastro aprovado informa (sem inventar), e mostre que o horario pode se encaixar (dias/turnos que a clinica atende). Ofereca alternativas compativeis SO se ela quiser ver horarios; nao pressione.",
  distance: "OBJECAO DE DISTANCIA ('moro longe'). Acolha e responda com o que o cadastro informa (endereco, como chegar, estacionamento, duracao do atendimento, numero de sessoes SE cadastrado) para ela decidir se compensa; nao invente atendimento remoto nem beneficio de deslocamento. Pergunta curta so se precisar saber o dia/turno que facilita.",
  fear: "MEDO/DUVIDA SOBRE O PROCEDIMENTO. Acolha primeiro (sem exagerar nem prometer 'sem dor' ou 'sem risco') e responda com a informacao aprovada do cadastro (como e feito, o que se sente, cuidados). Duvida clinica, contraindicacao ou saude: transfer_to_human. Pergunta curta so se precisar saber qual e a duvida especifica.",
  compare: "COMPARACAO ('vi em outra clinica', 'qual a diferenca'). Nao fale mal de ninguem nem compare preco: explique o que ESTA no cadastro desta clinica (o que e, como funciona, para quem) e o criterio para escolher bem; a escolha individual e da profissional na avaliacao. Nao invente diferencial, resultado nem garantia.",
  third_party: "ELA PRECISA CONVERSAR COM OUTRA PESSOA (marido, mae...). Respeite: facilite a decisao dela com as informacoes aprovadas que ela possa levar (o que e, duracao, como funciona), sem pressao e sem nova rodada de oferta. Pode dizer que fica a disposicao; so registre retorno (schedule_recontact) se ELA disser quando.",
  bad_experience: "EXPERIENCIA ANTERIOR RUIM. Acolha sem minimizar nem julgar a outra clinica, pergunte (UMA vez, curta) o que aconteceu SE isso mudar a orientacao e explique o que o cadastro aprovado diz sobre o procedimento e a avaliacao individual. Nao prometa que 'aqui sera diferente' nem resultado.",
};

const HOURS_MOVE = "Ela perguntou o EXPEDIENTE da clinica (dias e horarios de atendimento), NAO por vagas. Responda PRIMEIRO isso, com o expediente cadastrado no contexto (dias e horas de funcionamento; a jornada de uma profissional so se ela perguntou dela). NAO consulte a agenda, NAO liste vagas de um dia e NAO volte ao assunto anterior. Se nao der para saber se ela quer o expediente ou vagas para marcar, faca UMA pergunta curta; so ofereca ver vagas como continuacao, depois de responder.";

export function refineMove(move: string, intent: Intent, r: TurnReading, ctx: { priceAsked: boolean; hasBooking: boolean; noPrice: string }): string {
  let out = r.asksHours ? HOURS_MOVE : move;
  // 1) resposta curta interpretada (so onde a jogada generica seria "descubra"/"explique de novo")
  if (["info", "price", "returning"].includes(intent)) {
    if (r.meaning === "experience_none")
      out = "Ela respondeu NAO a pergunta '" + r.prevQuestion + "': significa que NUNCA fez (primeira vez). NAO e recusa e NAO e desinteresse. NAO pergunte de novo se ja fez. Acolha em meia frase (sem exagerar) e avance: explique em 2 ou 3 frases, com o que esta CADASTRADO, como funciona/o que esperar para quem faz pela primeira vez, e termine com no maximo UMA pergunta util para o proximo passo (so se ainda faltar saber o que ela quer tratar, ou se ela ja demonstrou querer ver horarios)." + ctx.noPrice;
    else if (r.meaning === "experience_yes")
      out = "Ela respondeu que JA FEZ antes ('" + r.prevQuestion + "'). NAO explique do zero. Pergunte (uma vez, curto) quando/como foi SO se isso mudar a orientacao, e conecte ao que o cadastro aprovado diz do procedimento." + ctx.noPrice;
    else if (r.meaning === "accepts_info")
      out = "Ela ACEITOU a explicacao ('" + r.prevQuestion + "' -> sim). Isso NAO e pedido de agendamento: NAO ofereca horarios nem avaliacao agora e NAO agende. Explique em 2 ou 3 frases, so com o que esta CADASTRADO (o que e, como funciona, o que esperar), e termine perguntando se ficou alguma duvida; so proponha ver horarios se ela ja demonstrou querer fazer." + ctx.noPrice;
    else if (r.meaning === "declines_info")
      out = "Ela disse NAO a oferta de explicar ('" + r.prevQuestion + "'). Respeite em UMA frase, sem insistir; pergunte apenas se ha algo especifico que ela queira saber. NAO ofereca avaliacao nem horarios." + ctx.noPrice;
  }
  // 1b) pergunta INFORMATIVA (sessoes, duracao, o que inclui): a jogada generica de descoberta/horario sai; vale responder com o cadastro aprovado
  if (r.infoQuestionOnly && ["info", "price", "returning"].includes(intent) && !r.meaning) {
    const INFO_PREFIX = "Ela fez uma pergunta INFORMATIVA (nao pediu horario): responda PRIMEIRO com o que esta CADASTRADO (descricao, beneficios, FAQ); se a informacao nao estiver cadastrada (ex.: numero de sessoes, o que a oferta inclui), diga com honestidade que vai confirmar com a equipe e chame transfer_to_human - NUNCA 'vou verificar e ja te aviso' sem chamar a ferramenta, e NUNCA invente. NAO mude o assunto para agenda nem liste horarios. ";
    // a jogada generica de DESCOBERTA sai (ela ja esta perguntando); as demais (ja contou a queixa, avaliacao ja oferecida...) continuam valendo depois da resposta
    out = out.startsWith("Descubra") ? INFO_PREFIX + ctx.noPrice : INFO_PREFIX + out;
  }
  // 2) objecao identificavel: responder o impedimento real primeiro (nao a jogada de descoberta)
  const objectionHandled = !!r.objection && !r.discountAsk && ["info", "price", "returning"].includes(intent);
  if (objectionHandled && r.objection) {
    out = OBJECTION_MOVE[r.objection];
    if (r.objection === "price" && !ctx.priceAsked) out += " (Ela falou do preco: pode tratar do valor conforme a regra de valores desta clinica.)";
  }
  // 3) e 4) pedido de desconto e perguntas feitas junto: valem em QUALQUER jogada (tambem quando a conducao ou a situacao a substituem, ver turnObligations)
  const ob = turnObligations(r, intent, objectionHandled);
  if (r.discountAsk) out = ob;
  else if (ob) out += " " + ob;
  return out;
}

// Reclamacao direta do atendimento automatico ("a IA de voces e pessima", "repetitiva", "nao ajuda em nada"): pessoa de verdade.
const BOT_COMPLAINT_RE =
  /\b(ia|robo|bot|maquina|automatic[oa]|atendimento automatico)\b.{0,50}\b(pessim|horriv|ruim|repetitiv|burr|inutil|nao (ajuda|auxilia|resolve|entende))|\b(repetitiv[ao]|nao auxilia|nao ajuda em nada|nao entende nada|so repete|fala (a mesma|sempre a mesma) coisa)\b/;

export function complainsAboutBot(text: string): boolean {
  return BOT_COMPLAINT_RE.test(fold(text));
}

// Obrigacoes do turno que NAO dependem de qual jogada esta valendo: pedido de desconto (nao se inventa), perguntas que ficaram sem resposta e a objecao dita agora.
// alice.ts acrescenta este texto tambem quando a conducao (so queixa/so regiao/recusa) ou a situacao (cancelar/remarcar...) substituem a jogada do fluxo.
export function turnObligations(r: TurnReading, intent: Intent, objectionHandled = false): string {
  if (r.discountAsk)
    return "Ela pediu DESCONTO/negociacao. NAO prometa, invente nem insinue desconto, promocao ou condicao. Responda em UMA frase que condicoes e negociacao sao tratadas pela equipe e chame transfer_to_human com o pedido dela (nao deixe a conversa sem resposta).";
  const parts: string[] = [];
  if (r.objection && !objectionHandled) parts.push("ELA LEVANTOU UMA OBJECAO neste turno: responda ao impedimento real com informacao aprovada ANTES de qualquer outra pergunta ou oferta. " + OBJECTION_MOVE[r.objection]);
  const must = ["hesitate", "refuse", "decline", "booked", "returning", "manage", "staff"].includes(intent) || r.questions.length >= 2 || r.infoQuestionOnly;
  if (r.questions.length && must) {
    parts.push("ELA PERGUNTOU" + (r.questions.length > 1 ? " VARIAS COISAS" : "") + ": " + r.questions.map((q, i) => (r.questions.length > 1 ? (i + 1) + ") " : "") + '"' + q.slice(0, 140) + '"').join(" ") + " RESPONDA " + (r.questions.length > 1 ? "TODAS" : "ESSA pergunta") + ", com o que esta cadastrado (se nao souber algo, diga que confirma com a equipe; nao invente), ANTES de qualquer acolhimento sobre pensar/agradecer. Nao volte a assuntos antigos nem repita o que ja respondeu.");
  }
  return parts.join(" ");
}
