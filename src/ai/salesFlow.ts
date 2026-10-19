// ---------------------------------------------------------------------------
// FLUXO DE VENDA. A Alice acumulou dezenas de regras no prompt (descoberta, nao insistir em avaliacao, nao falar de valor, ...)
// que se contradiziam: a cliente escrevia "Prefiro uma avaliacao" e ela respondia com preco e a mesma pergunta de descoberta.
// Aqui a conversa e lida de forma DETERMINISTICA a cada turno: qual e a intencao da cliente agora (agendar, recusou horarios,
// perguntou valor, so quer informacao), o que ela ja contou, e qual e a PROXIMA JOGADA. O resultado vira UMA instrucao clara
// pro modelo (e desliga as regras que conflitam com ela).
// ---------------------------------------------------------------------------

import { chosenSlotDirective, wantedDirective, type ChosenSlot, type Wanted } from "./bookingIntent.js";

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
  const declined = declinesOptions(trailText) && !proposesTime && (slotsOffered || evalOffered || scheduleAsked);

  // Disse "nao"/"vou pensar"/"vou me organizar" sem propor nada: a Alice nao pode responder so "ok" nem ficar esperando.
  const trailFold = fold(trailText);
  const hardNo = HARD_NO_RE.test(trailFold);
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
  const namesProcedure = input.wanted !== undefined && (input.wanted.kind === "specific" || input.wanted.kind === "options") && /\b(quero|queria|gostaria|tenho interesse|interesse em|fazer|marcar)\b/.test(fold(trailText)) && !priceAsked && !/\b(saber|informac\w*|duvida|como funciona|explic\w*|o que e)\b/.test(fold(trailText));
  const awaitingName = input.awaitingName === true && !hasBooking;
  const wantsToBook = wantsSchedule(trailText) || accepted || gaveAvailability || !!chosen || namesProcedure || awaitingName;

  // Pedido ANTIGO de horario (scheduleAsked) so conta se a conversa ainda esta no meio do agendamento (a ultima fala ofereceu horario ou perguntou
  // de agendar). Antes valia pra sempre: depois de a pessoa pedir horario uma vez, TODA mensagem ("Ok.", "Nao.", "Pra minha amiga.") virava "va
  // direto ao agendamento" e a Alice listava horarios de avaliacao do nada (Clarinda, 16/10).
  // "Recente" = pediu horario numa das ULTIMAS 4 falas dela (a conversa ainda e de agendamento: ela responde as perguntas de qualificacao da Alice).
  const scheduleRecent = !hasBooking && userAll.slice(-4).some((m) => wantsSchedule(m));
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
        (input.wanted
          ? wantedDirective(needWanted ?? wanted, evalName)
          : "QUAL PROCEDIMENTO: se ela quer um procedimento especifico do catalogo (ex.: limpeza de pele, drenagem), agende ESSE procedimento (nome exato do catalogo), nao a avaliacao. A avaliacao gratuita e para quem pediu avaliacao ou ainda nao sabe o que quer. ") +
        "Se ela pediu a avaliacao gratuita de forma explicita, agende a avaliacao. Se o procedimento citado ou a oferta do anuncio NAO estiver no catalogo, NAO diga que nao encontrou nem pergunte de novo: se ja combinaram dia e hora, agende a AVALIACAO gratuita NESSE MESMO dia e hora (a equipe apresenta a oferta, sem prometer valor ou condicao); senao ofereca os horarios da avaliacao. " +
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
          : "Ela JA contou o que quer (queixa/regiao). NAO pergunte de novo 'o que voce gostaria de melhorar'. Reconheca a queixa com as palavras dela (1 frase), conecte a solucao do catalogo (1 frase) e feche com UMA pergunta concreta que leve ao horario: " +
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

  return { intent, askedPrice: priceAsked, statedGoal, scheduleAsked, schedulingSignal, slotsOffered, evalOffered, hasBooking, nextMove };
}

// Reclamacao direta do atendimento automatico ("a IA de voces e pessima", "repetitiva", "nao ajuda em nada"): pessoa de verdade.
const BOT_COMPLAINT_RE =
  /\b(ia|robo|bot|maquina|automatic[oa]|atendimento automatico)\b.{0,50}\b(pessim|horriv|ruim|repetitiv|burr|inutil|nao (ajuda|auxilia|resolve|entende))|\b(repetitiv[ao]|nao auxilia|nao ajuda em nada|nao entende nada|so repete|fala (a mesma|sempre a mesma) coisa)\b/;

export function complainsAboutBot(text: string): boolean {
  return BOT_COMPLAINT_RE.test(fold(text));
}
