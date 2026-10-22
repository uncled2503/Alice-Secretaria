// ---------------------------------------------------------------------------
// PROMESSA QUE A ALICE NAO CUMPRE. Ela nao "volta depois": cada resposta e uma unica rodada. Quando o modelo escreve "um
// instante, so vou confirmar", "vou agendar" ou "vou verificar e ja volto" e ENCERRA a rodada sem chamar a ferramenta, a
// cliente fica esperando uma resposta que nunca vem, e na mensagem seguinte ele afirma e desmente o horario.
// Aqui detectamos o anuncio (e a afirmacao de "agendado" sem o book_appointment ter dado certo) pra o codigo mandar o
// modelo FAZER agora, na mesma rodada.
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// Anuncia uma acao futura que ela nao tem como fazer depois.
const ANNOUNCE_RE =
  /\b(um instante|so um instante|um momento|so um momento|vou (agendar|verificar|confirmar|checar|ver|consultar|reservar|marcar)|vou ja|ja volto|ja retorno|ja te (retorno|aviso|confirmo|respondo)|aguarde um|aguarda um|vou fazer (isso|isso agora|ja|agora)|farei isso|ja vou (verificar|fazer|ver|buscar|checar)|vou (buscar|procurar|olhar|dar uma olhada)|vou (cancelar|remarcar|reagendar|alterar|trocar|mudar|desmarcar|liberar))\b/;

// Afirma que o horario esta agendado/confirmado/marcado.
const CLAIM_RE = /\b(esta agendad|ficou agendad|foi agendad|agendei|ja agendei|marquei|esta marcad|ficou marcad|esta reservad|reservei|conseguimos agendar|consegui agendar|conseguimos marcar|consegui marcar|agendamos)/; // prefixos (agendad[oa]): sem \b no fim

// Afirma que cancelou / remarcou (so vale se a ferramenta deu certo nesta rodada).
const CANCEL_CLAIM_RE = /\b(cancelei|cancelamos|ja cancelei|esta cancelad|ficou cancelad|foi cancelad|horario cancelad|agendamento cancelad|desmarquei|desmarcamos)/;
const RESCHEDULE_CLAIM_RE = /\b(remarquei|remarcamos|reagendei|reagendamos|remarcad[oa] para|ficou remarcad|foi remarcad|esta remarcad|troquei o horario|trocamos o horario|alterei o horario|alteramos o horario)/;

// Anuncio de transferir pra equipe nao e promessa quebrada: e o fluxo de handoff.
const HANDOFF_RE = /\b(equipe|atendente|colega|responsavel|profissional)\b/;

export function announcesAction(text: string): boolean {
  const f = fold(text);
  return ANNOUNCE_RE.test(f) && !HANDOFF_RE.test(f);
}

export function claimsBooking(text: string): boolean {
  return CLAIM_RE.test(fold(text));
}

// A resposta prometeu algo que nao aconteceu? bookedOk = book_appointment devolveu agendado:true nesta rodada.
export function claimsCancel(text: string): boolean {
  return CANCEL_CLAIM_RE.test(fold(text));
}

export function claimsReschedule(text: string): boolean {
  return RESCHEDULE_CLAIM_RE.test(fold(text));
}

export function brokenPromise(text: string, bookedOk: boolean, done: { cancelOk?: boolean; rescheduleOk?: boolean } = {}): boolean {
  return announcesAction(text) || (claimsBooking(text) && !bookedOk) || (claimsCancel(text) && !done.cancelOk) || (claimsReschedule(text) && !done.rescheduleOk);
}

export const CLAIM_NUDGE =
  "ATENCAO: voce afirmou que o horario esta agendado/confirmado/marcado (ou que a pessoa sera esperada), mas NAO existe reserva criada por book_appointment nesta rodada nem reserva dela na agenda que bata com esse dia e hora. Uma proposta de horario no chat e o 'pode ser' da pessoa NAO sao reserva. Se voce tem procedimento, dia e hora e o nome completo, chame check_specific_time e depois book_appointment AGORA e so afirme depois do agendado:true; se falta algo, peca so o que falta; se a ferramenta recusar, diga isso. Para mais de uma pessoa, afirme apenas as reservas que a ferramenta devolveu como feitas. Nunca afirme sem a ferramenta.";

export const PROMISE_NUDGE =
  "ATENCAO: voce escreveu que ia agendar/verificar/confirmar ('um instante', 'vou verificar', 'ja volto') ou disse que o horario esta agendado, mas NAO executou a acao nesta rodada. Voce NAO consegue 'voltar depois': tudo o que precisa fazer tem que ser feito AGORA, chamando a ferramenta (check_specific_time, check_availability, book_appointment, manage_my_appointment com action cancel ou reschedule). So diga que cancelou/remarcou se manage_my_appointment devolveu ok:true nesta rodada. Chame a ferramenta que falta e responda com o RESULTADO REAL ja nesta mensagem, sem anunciar nada. So diga que esta agendado se book_appointment devolveu 'agendado: true'; se o horario nao esta livre, diga isso com clareza e ofereca as alternativas. Se for marcar mais de um procedimento na mesma visita, agende um apos o outro (o segundo comeca quando o primeiro termina) e confirme cada horario.";

// "Vou confirmar com a equipe e te retorno", "a equipe vai verificar e te avisa": promessa de ACOMPANHAMENTO que so existe se uma pendencia real for criada (transfer_to_human). O anuncio "equipe" nao
// e promessa quebrada por si so (announcesAction o exclui: e o fluxo de handoff) - mas SO quando a ferramenta foi chamada. Sem ela, a pessoa fica esperando alguem que ninguem acionou.
const TEAM_FOLLOWUP_RE = /\b((vou|irei|vamos|iremos|posso|preciso)\s+(\w+\s+){0,2}(confirmar|verificar|checar|consultar|perguntar|ver|alinhar|checar)\s+(isso\s+)?(com|junto (a|com))\s+(a|o|as|os)?\s*(equipe|profissional|responsavel|atendente|time|colega|financeiro|recepcao)|(a|o)\s+(equipe|profissional|responsavel|time|atendente)\s+(vai|ira|vao|podera)\s+(\w+\s+){0,3}(confirmar|verificar|retornar|responder|entrar em contato|te (ajudar|avisar|chamar))|vou pedir (para|pra) (a|o) (equipe|profissional|responsavel))\b/;
export function promisesTeamFollowUp(text: string): boolean {
  return TEAM_FOLLOWUP_RE.test(fold(text));
}
