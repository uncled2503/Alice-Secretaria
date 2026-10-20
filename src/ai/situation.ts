// ---------------------------------------------------------------------------
// SITUACAO DA CONVERSA + HIERARQUIA DE REGRAS (pedido do dono, 16/10/2026: "ela comete os mesmos erros todos os dias; quero uma hierarquia de
// regras de acordo com as informacoes de cada cliente e que ela leia um briefing sobre a cliente ANTES de responder").
//
// O problema nao era uma regra so: o prompt tinha dezenas de regras que se contradiziam ("quem pede pra mudar horario -> equipe" x "remarcar
// -> manage_my_appointment" x "oferte os horarios mais proximos da avaliacao") e o modelo escolhia uma delas ao acaso. Aqui a decisao e
// DETERMINISTICA: a cada mensagem o codigo olha os fatos (agenda dela, ultima mensagem automatica, se a equipe estava negociando, o que a
// pessoa pediu de dia/hora) e escolhe UMA situacao, pela ordem de prioridade abaixo. Cada situacao traz a ordem exata para o modelo (que
// substitui a "jogada" generica) e as travas que o codigo confere depois. Tudo PURO (testavel).
// ---------------------------------------------------------------------------

import { isCourtesyOnly } from "./courtesy.js";
import { isoDateInZone } from "../scheduling/time.js";
import { extractMentions } from "./slotGuard.js";
import { declinesOptions, wantsSchedule } from "./salesFlow.js";
import { describeSlotRequest, isEmptyRequest, parseSlotRequest, type SlotRequest } from "./slotRequest.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// A ORDEM em que as regras valem (a de cima vence a de baixo). Vai resumida no prompt e completa em docs/hierarquia-de-regras.md.
export const RULE_HIERARCHY =
  "ORDEM DE PRIORIDADE DAS REGRAS (se duas conflitarem, vale a de cima). FATOS AO VIVO (a AGENDA dela, o resultado de uma ferramenta, o que ela disse AGORA) valem mais que NOTAS antigas da memoria do lead e que qualquer regra de texto: " +
  "1) seguranca clinica (urgencia, reacao, duvida clinica -> equipe); " +
  "2) nao e paciente (vaga, fornecedor, parceria, cobranca -> equipe em silencio); " +
  "3) a pessoa so respondeu a uma mensagem AUTOMATICA (lembrete, pos, pesquisa) -> agradece e pronto, sem oferta; " +
  "4) ela JA TEM horario e quer remarcar/cancelar/tirar duvida dele -> use a agenda DELA (mesmo procedimento e profissional), nunca avaliacao nem horario novo; " +
  "5) a EQUIPE estava negociando o horario -> continue de onde a equipe parou; " +
  "6) o PEDIDO explicito dela (dia, hora, limite, turno, profissional) vale mais que 'horarios mais proximos'; " +
  "7) conduta comercial: recusa e 'vou pensar' sao respeitados (sem insistir); queixa NAO e procedimento escolhido; so se indica o que o cadastro aprovado diz atender a queixa; servico que a clinica nao oferece nunca e citado; " +
  "8) regras da clinica (valores, tom, postura); " +
  "9) padroes do sistema (avaliacao para quem nao sabe, descoberta).";

export type SituationKind = "automation_ack" | "courtesy_ack" | "booking_claim" | "cancel" | "reschedule" | "staff_followup" | "plain_reply" | "default";

export interface SituationMessage {
  role: string; // user | assistant | human
  content: string;
  authorName?: string | null;
  createdAt: Date;
}

export interface UpcomingAppt {
  id: string;
  dateIso: string; // AAAA-MM-DD no fuso da clinica
  time: string; // HH:MM
  label: string; // "terca-feira, 20/10 as 13:30"
  procedure: string;
  professional: string | null;
  isEvaluation: boolean;
  patientConfirmed: boolean;
}

export interface SituationInput {
  history: SituationMessage[]; // cronologico; pode terminar com as mensagens novas da pessoa
  trailing: string[]; // mensagens novas da pessoa, sem resposta
  now: Date;
  todayIso: string;
  tz?: string; // fuso da clinica: permite ancorar 'amanha' na DATA DA MENSAGEM (processamento depois da meia-noite nao desloca o compromisso)
  refIso?: string; // dia (fuso da clinica) em que a mensagem nova da pessoa foi escrita; padrao: todayIso
  upcoming: UpcomingAppt[];
  pastVisits: number;
  schedulingSignal: boolean; // esta mensagem pede/aceita/recusa horario (ou a conversa esta no meio do agendamento): so entao a Alice pode listar horarios
  resumedAfterStaffDelay?: boolean; // a equipe demorou e a Alice voltou
}

export interface Situation {
  kind: SituationKind;
  label: string; // nome curto para a ficha
  request: SlotRequest; // o que ela pediu de dia/hora
  directive: string | null; // ordem exata (substitui a "jogada" generica) ou null = fluxo normal
  briefing: string[]; // linhas da FICHA
  forceTransfer: { reason: string; summary: string } | null; // o codigo passa pra equipe, sem consultar o modelo
  forbidEvaluationOffer: boolean; // a resposta nao pode oferecer avaliacao
  forbidSlotOffer: boolean; // a resposta nao pode listar horarios
  closeWith: "thanks" | "silence" | null; // resposta fixa curta (agradece e para) ou silencio
}

// ---------- mensagem automatica ----------

export type AutomationKind = "lembrete" | "nps" | "pos" | "recontato" | "outra";

// PURO: a fala e uma mensagem AUTOMATICA da clinica (lembrete, pos, pesquisa, recontato...)? Mensagens normais da Alice nao tem autor.
export function automationKindOf(m: { role: string; content: string; authorName?: string | null }): AutomationKind | null {
  if (m.role !== "assistant" || !m.authorName) return null;
  const a = fold(m.authorName);
  const c = fold(m.content);
  if (/lembrete|confirmacao/.test(a)) return "lembrete";
  if (/pesquisa|satisfacao|nps/.test(a) || /\bde 0 a 10\b|como foi (a )?sua experiencia/.test(c)) return "nps";
  if (/\bpos\b|pos-|pos procedimento|acompanhamento/.test(a) || /passando para saber como (sua|seu)|cuidados pos/.test(c)) return "pos";
  if (/recontato|reativ|retomada/.test(a)) return "recontato";
  return "outra";
}

// ---------- intencao sobre o horario que ja tem ----------

const RESCHEDULE_RE =
  /\b(troc(ar|o|a|ando)|mud(ar|o|a|ando)|alter(ar|o)|remarc(ar|o|a|ando)|reagend(ar|o|a)|adi(ar|o|ando)|antecip(ar|o)|passar (o|meu|minha|a)|transferir (o|meu|minha))\b.{0,50}\b(horario|hora|dia|consulta|agendamento|sessao|avaliacao|marcad\w*|marcacao|terca|quarta|quinta|sexta|sabado|segunda|domingo|amanha|hoje|\d{1,2}\s?(h\b|:))|\bpreciso (trocar|mudar|remarcar|alterar|adiar|antecipar)\b|\b(da|dava|posso|podemos|consegue|conseguem|poderia|pode) (pra |para )?(trocar|mudar|remarcar|adiar|antecipar)\b/;
const CANCEL_RE =
  /\b(cancel(ar|o|e|amos)|desmarc(ar|o)|nao (vou|poderei|consigo|posso|irei) (ir|comparecer|conseguir|estar)|nao vou (poder|conseguir)|nao vai dar (pra|para) (ir|comparecer)|nao conseguirei|tive um imprevisto|surgiu (um|uma) (imprevisto|compromisso))\b/;
// Cancelou MAS propos outro horario ("nao vou conseguir ir hoje, pode ser amanha?"): e remarcacao, nao cancelamento.
const ALT_RE = /\b(pode ser|posso (ir|vir)|consigo (ir|vir)|da pra|dar pra)\b.{0,30}\b(amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|outro (dia|horario)|mais tarde|mais cedo)|\boutro (dia|horario)\b|\b(quero|queria|gostaria de) (trocar|mudar|remarcar|reagendar)\b/;
const CANCEL_POLICY_RE = /politica|multa|taxa|cobram|cobrar|regra de cancelamento|como funciona o cancelamento/;
// Diz que JA TEM um horario ("meu horario e as 13:15", "tenho uma sessao no dia 20/10", "estava agendado pras 13:30")
const CLAIM_RE =
  /\b(meu|minha) (horario|consulta|sessao|agendamento|avaliacao)\b.{0,30}\b(e|era|esta|foi)\b|\b(tenho|temos) (agendad\w*|marcad\w*)\b|\b(tenho|temos)\b.{0,25}\b(uma |um )?(sessao|consulta|avaliacao|agendamento|procedimento|horario marcad\w*)\b.{0,40}(\bdia\b|\d{1,2}\/\d{1,2}|terca|quarta|quinta|sexta|sabado|segunda|\b(as|a) \d)|\b(estava|esta|ja estava|ja esta) (agendad|marcad)\w*/;

export function wantsReschedule(text: string): boolean {
  const f = fold(text);
  return RESCHEDULE_RE.test(f) || (CANCEL_RE.test(f) && ALT_RE.test(f));
}

// hasBooking = ela tem horario futuro na agenda. Sem horario, "nao consigo ir" e recusa de convite (nao cancelamento): so conta se disse cancelar/desmarcar.
export function wantsCancel(text: string, hasBooking = true): boolean {
  const f = fold(text);
  if (CANCEL_POLICY_RE.test(f)) return false;
  if (hasBooking && ALT_RE.test(f)) return false; // propos outro horario: e remarcacao
  return hasBooking ? CANCEL_RE.test(f) : /\b(cancel(ar|o|e|amos)|desmarc(ar|o))\b/.test(f);
}

export function claimsExistingBooking(text: string): boolean {
  const f = fold(text);
  if (/\bhorario (de|do) (trabalho|saida|almoco|aula|folga|entrada|servico)\b|\bmeu horario (livre|flexivel|disponivel)\b/.test(f)) return false; // disponibilidade, nao agendamento
  return CLAIM_RE.test(f);
}

const ACCEPT_SHORT_RE = /^(pode|pode ser|pode sim|fechado|combinado|ok|sim|beleza|blz|perfeito|otimo|tudo bem|ta bom|ta otimo|esse mesmo|aceito|quero|claro)\b/;

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function ageText(from: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (min < 2) return "agora ha pouco";
  if (min < 90) return `ha ${min} min`;
  const h = Math.round(min / 60);
  return h < 36 ? `ha ${h}h` : `ha ${Math.round(h / 24)} dias`;
}

const STAFF_CONTEXT_MS = 12 * 3_600_000;

export function resolveSituation(i: SituationInput): Situation {
  const trailText = i.trailing.join(" \n ");
  const trailFold = fold(trailText);
  const userRecent = i.history.filter((m) => m.role === "user").slice(-6).map((m) => m.content);
  const request = parseSlotRequest([...userRecent.slice(-5), ...i.trailing], i.refIso ?? i.todayIso);
  // o horario que ela JA TEM nao e pedido novo
  const currentTimes = new Set(i.upcoming.map((a) => a.time));
  request.times = request.times.filter((t) => !currentTimes.has(t) || !i.upcoming.length);

  // ultima fala que NAO e da pessoa, antes das mensagens novas
  const beforeTrailing = i.history.slice(0, Math.max(0, i.history.length - i.trailing.length));
  const lastOut = [...beforeTrailing].reverse().find((m) => m.role !== "user") ?? null;
  const automation = lastOut ? automationKindOf(lastOut) : null;
  const staffMsgs = i.history.filter((m) => m.role === "human");
  const lastStaff = staffMsgs.at(-1) ?? null;
  const staffRecent = !!lastStaff && i.now.getTime() - lastStaff.createdAt.getTime() <= STAFF_CONTEXT_MS;

  // ----- ficha (sempre) -----
  const briefing: string[] = [];
  if (i.upcoming.length) {
    briefing.push(
      `AGENDA DELA (a unica verdade sobre o horario dela): ${i.upcoming
        .slice(0, 4)
        .map((a) => `${a.procedure}${a.professional ? ` com ${a.professional}` : ""} em ${a.label}${a.patientConfirmed ? " (ja confirmou presenca)" : ""}`)
        .join(" | ")}`,
    );
  } else briefing.push(`AGENDA DELA: nenhum horario futuro${i.pastVisits > 0 ? ` (ja foi atendida ${i.pastVisits}x: e paciente, nao lead)` : ""}`);
  if (lastOut && automation) {
    briefing.push(`ULTIMA MENSAGEM FOI AUTOMATICA DA CLINICA (${automation}, ${ageText(lastOut.createdAt, i.now)}): "${clip(lastOut.content, 110)}" -> o que ela escreveu agora e RESPOSTA a isso`);
  }
  if (lastStaff) {
    briefing.push(`EQUIPE (pessoa de verdade) falou ${ageText(lastStaff.createdAt, i.now)}: "${clip(lastStaff.content, 110)}"${staffRecent ? " -> a conversa de horario estava com a equipe: continue de onde ela parou" : ""}`);
  }
  if (!isEmptyRequest(request)) briefing.push(`PEDIDO DE DIA/HORA DELA (respeite): ${describeSlotRequest(request)}`);
  if (!i.schedulingSignal) briefing.push("ELA NAO PEDIU HORARIO NEM AGENDAMENTO nesta mensagem: NAO liste horarios e NAO tente agendar; responda so o que ela disse");
  const patientLike = i.pastVisits > 0 || beforeTrailing.some((m) => { const k = automationKindOf(m); return k === "nps" || k === "pos"; });
  if (patientLike) briefing.push("ELA JA E PACIENTE (ja foi atendida/avaliada): nao ofereca avaliacao gratuita nem trate como lead novo");

  const base = (kind: SituationKind, label: string, extra: Partial<Situation> = {}): Situation => ({
    kind,
    label,
    request,
    directive: null,
    briefing: [`SITUACAO AGORA: ${label}`, ...briefing],
    forceTransfer: null,
    forbidEvaluationOffer: false,
    forbidSlotOffer: false,
    closeWith: null,
    ...extra,
  });

  // ----- 3) so respondeu a uma mensagem automatica informativa (pesquisa, pos): agradece e pronto -----
  if (automation && (automation === "nps" || automation === "pos") && i.trailing.length && i.trailing.every((t) => isCourtesyOnly(t))) {
    return base("automation_ack", "ela so agradeceu uma mensagem automatica da clinica (pesquisa/acompanhamento)", {
      closeWith: "thanks",
      forbidEvaluationOffer: true,
      forbidSlotOffer: true,
      directive: "Ela so agradeceu a mensagem automatica da clinica. Responda com UMA frase curta de agradecimento e PARE: sem pergunta, sem oferta de avaliacao, sem horarios.",
    });
  }

  // ----- 3a2) "OK, obrigada" a uma PERGUNTA de convite (ex.: "quer que eu veja um horario para a avaliacao?"): agradecer sem aceitar nao e aceite. Agradece e para, sem
  //        listar horarios nem repetir o convite. "ok" SOZINHO (sem agradecimento) ou com palavra de aceite ("sim", "quero", "pode") continua sendo aceite. -----
  if (lastOut && /\?/.test(lastOut.content) && i.trailing.length && i.trailing.every((t) => isCourtesyOnly(t)) && /\b(obrigad\w*|obg|valeu|vlw|agradec\w*)\b/.test(trailFold) && !/\b(sim|quero|pode|por favor|claro|bora|vamos|aceito|topo|fechado)\b/.test(trailFold)) {
    return base("courtesy_ack", "ela agradeceu (sem aceitar) uma pergunta de convite", {
      closeWith: "thanks",
      forbidEvaluationOffer: true,
      forbidSlotOffer: true,
      directive: "Ela agradeceu sem aceitar o convite. Responda com UMA frase curta de agradecimento e PARE: sem repetir o convite, sem horarios, sem nova pergunta.",
    });
  }

  // ----- 3b) so reconheceu ("ok", "obrigada") uma fala que NAO pedia resposta: silencio (nada de oferta, nada de despedida) -----
  if (lastOut && i.trailing.length && i.trailing.every((t) => isCourtesyOnly(t)) && !/\?/.test(lastOut.content)) {
    return base("courtesy_ack", "ela so reconheceu ('ok', 'obrigada') uma fala que nao pedia resposta", {
      closeWith: "silence",
      forbidEvaluationOffer: true,
      forbidSlotOffer: true,
      directive: "Ela so respondeu 'ok'/'obrigada' a uma fala que nao fazia pergunta. Nao responda (silencio): sem oferta de avaliacao, sem horarios, sem despedida repetida.",
    });
  }

  const fullUpcoming = i.upcoming;
  const dayHint = request.dates.filter((d) => fullUpcoming.some((a) => a.dateIso === d));
  const which = (() => {
    if (!fullUpcoming.length) return "";
    if (fullUpcoming.length === 1) return `O agendamento dela e UM so: ${fullUpcoming[0].procedure} em ${fullUpcoming[0].label}.`;
    const hinted = dayHint.length ? fullUpcoming.filter((a) => dayHint.includes(a.dateIso)) : [];
    return hinted.length === 1
      ? `Ela tem varios; pelo que escreveu e este: ${hinted[0].procedure} em ${hinted[0].label} (appointment_date="${hinted[0].dateIso}", appointment_time="${hinted[0].time}").`
      : `Ela tem mais de um agendamento (${fullUpcoming.slice(0, 4).map((a) => `${a.procedure} ${a.label}`).join("; ")}): se nao ficou claro qual, pergunte QUAL antes de agir.`;
  })();

  // ----- 4a) quer cancelar / avisou que nao vai -----
  if (wantsCancel(trailText, fullUpcoming.length > 0) && !wantsReschedule(trailText)) {
    if (!fullUpcoming.length) {
      return base("cancel", "ela quer cancelar, mas NAO ha horario dela na agenda da Alice", {
        forbidEvaluationOffer: true,
        forbidSlotOffer: true,
        forceTransfer: {
          reason: "Quer cancelar um horario que nao consta na agenda da Alice",
          summary: `A pessoa escreveu "${clip(trailText, 200)}", mas nao ha agendamento futuro dela na agenda da Alice (pode estar so no Clinica Experts). A Alice nao respondeu nada. Confira e cancele/avise.`,
        },
      });
    }
    return base("cancel", "ela quer CANCELAR (ou avisou que nao vai) um horario que ja tem", {
      forbidEvaluationOffer: true,
      directive:
        `ELA QUER CANCELAR / NAO VAI CONSEGUIR IR. ${which} Chame manage_my_appointment com action="cancel" AGORA (informe appointment_date e appointment_time se houver mais de um). ` +
        "So diga que cancelou DEPOIS de a ferramenta devolver ok:true; NUNCA escreva 'vou cancelar' ou 'cancelei' sem a ferramenta. Depois, em UMA frase, acolha e ofereca remarcar sem insistir (nao ofereca avaliacao nem liste horarios, a menos que ela peca). " +
        "Se ela disse que JA AVISOU antes e o horario continuou na agenda, peca desculpa em meia frase e cancele do mesmo jeito.",
    });
  }

  // ----- 4b) quer remarcar / trocar o horario que ja tem -----
  if (wantsReschedule(trailText)) {
    if (!fullUpcoming.length) {
      return base("reschedule", "ela quer remarcar, mas NAO ha horario dela na agenda da Alice", {
        forbidEvaluationOffer: true,
        forbidSlotOffer: true,
        forceTransfer: {
          reason: "Quer remarcar um horario que nao consta na agenda da Alice",
          summary: `A pessoa escreveu "${clip(trailText, 200)}", mas nao ha agendamento futuro dela na agenda da Alice (pode estar so no Clinica Experts). A Alice nao respondeu nada. Confira e remarque.`,
        },
      });
    }
    const ask = isEmptyRequest(request) ? "Ela ainda nao disse para quando: pergunte o dia e o horario (ou turno) que ela prefere." : `O PEDIDO dela: ${describeSlotRequest(request)}.`;
    return base("reschedule", "ela quer REMARCAR / TROCAR o horario de um agendamento que ja tem (nao e agendamento novo)", {
      forbidEvaluationOffer: true,
      directive:
        `ELA QUER MUDAR O HORARIO QUE JA TEM (nao e agendamento novo). ${which} ${ask} ` +
        "O procedimento, o profissional e a duracao sao os DO AGENDAMENTO DELA: NUNCA ofereca avaliacao nem outro procedimento. " +
        "Se ela deu o novo dia E a nova hora: chame manage_my_appointment com action=\"reschedule\", new_date e new_time (e appointment_date/appointment_time do atual, se houver mais de um); so diga 'remarquei' depois de ok:true. " +
        "Se a ferramenta disser que o horario nao esta livre, diga so isso e ofereca as alternativas que ela devolver, comecando pelas mais proximas do PEDIDO (mesmo dia). " +
        "Se ela deu so o dia ou so a hora, ou pediu opcoes, use check_availability com o procedure_name do AGENDAMENTO DELA, com date do dia pedido (e from_time/until_time se houver limite) e ofereca ate 3 horarios. " +
        "NAO diga que 'a clinica nao atende nesse dia' a menos que a ferramenta diga exatamente isso. NAO use 'horarios mais proximos' se ela pediu um dia/hora.",
    });
  }

  // ----- 4c) diz que tem um horario que nao bate com a agenda da Alice -----
  const claimMention = extractMentions(trailText);
  if (claimsExistingBooking(trailText) && (claimMention.times.length > 0 || claimMention.dates.length > 0)) {
    const claimedTimes = claimMention.times;
    const claimedDates = claimMention.dates;
    const matches = fullUpcoming.some((a) => (claimedTimes.length ? claimedTimes.includes(a.time) : true) && (claimedDates.length ? claimedDates.includes(dm(a.dateIso)) : true));
    if (!matches) {
      return base("booking_claim", "ela cita um horario/sessao que NAO bate com a agenda da Alice", {
        forbidEvaluationOffer: true,
        forbidSlotOffer: true,
        forceTransfer: {
          reason: "Cliente cita horario que nao consta (ou diverge) na agenda da Alice",
          summary: `A pessoa disse: "${clip(trailText, 220)}". Na agenda da Alice ${fullUpcoming.length ? `consta: ${fullUpcoming.slice(0, 3).map((a) => `${a.procedure} em ${a.label}`).join("; ")}` : "nao consta horario futuro dela"}. A Alice nao confirmou nem agendou nada: confira no Clinica Experts e responda.`,
        },
      });
    }
  }

  // ----- 5) a equipe estava negociando o horario e a pessoa respondeu -----
  const staffAboutSchedule = !!lastStaff && (/\b(horario|agend\w*|marc\w*|vaga|disponi\w*|avalia\w*|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|reserv\w*)\b/.test(fold(lastStaff.content)) || extractMentions(lastStaff.content).times.length > 0);
  const staffTalk = staffRecent && lastOut?.role === "human" && staffAboutSchedule;
  const resumed = i.resumedAfterStaffDelay === true && staffAboutSchedule && i.now.getTime() - lastStaff!.createdAt.getTime() <= 24 * 3_600_000;
  const schedulingReply =
    wantsSchedule(trailText) || declinesOptions(trailText) || !isEmptyRequest(request) || ACCEPT_SHORT_RE.test(trailFold.trim()) || /\b(nao da|nao posso|nao consigo|nao rola)\b/.test(trailFold);
  if ((staffTalk || resumed) && schedulingReply) {
    const prop = lastStaff ? parseSlotRequest([lastStaff.content], i.tz ? isoDateInZone(lastStaff.createdAt, i.tz) : i.todayIso) : null; // 'amanha' da EQUIPE = dia seguinte ao dia em que ela escreveu
    const proposed = prop && (prop.dates.length || prop.times.length) ? describeSlotRequest(prop) : "";
    return base("staff_followup", "a EQUIPE estava combinando o horario com ela e a Alice esta retomando: continuar de onde a equipe parou", {
      forbidEvaluationOffer: false,
      directive:
        `A EQUIPE (pessoa de verdade) estava combinando o horario com ela. Ultima fala da equipe: "${clip(lastStaff?.content ?? "", 160)}".${proposed ? ` PROPOSTA DA EQUIPE: ${proposed}.` : ""} ` +
        "CONTINUE DE ONDE A EQUIPE PAROU: nao se reapresente, nao peca desculpa, nao reinicie a oferta de avaliacao nem volte para 'os horarios mais proximos (hoje/amanha)'. " +
        (fullUpcoming.length
          ? `(1) Ela JA TEM horario (${fullUpcoming[0].procedure} em ${fullUpcoming[0].label}): a proposta da equipe e para TROCAR esse horario. Se ela ACEITOU ('pode ser', 'fechado'), chame manage_my_appointment com action="reschedule", new_date e new_time da proposta (NAO use book_appointment: seria um agendamento duplicado) e so confirme depois de ok:true; se o horario nao estiver livre, diga que nao esta mais disponivel e ofereca os mais proximos DELE. `
          : "(1) Se ela ACEITOU a proposta da equipe ('pode ser', 'fechado'): chame check_specific_time com o dia e a hora da proposta (procedimento: o que a conversa ja definiu; se foi so a avaliacao, a avaliacao) e, estando livre, book_appointment e confirme o resultado real; se nao estiver livre, diga que esse horario nao esta mais disponivel e ofereca os mais proximos DELE. ") +
        `(2) Se ela RECUSOU ou deu uma restricao ('nao da', 'tenho aula as 18:40', 'so sabado'): use o PEDIDO DELA${isEmptyRequest(request) ? "" : ` (${describeSlotRequest(request)})`} - chame check_availability COM date do dia que ela pediu (e from_time/until_time quando houver limite) e ofereca ATE 3 horarios que respeitem o pedido; se o dia/horario pedido nao existir, diga isso em uma frase e ofereca os mais proximos DO PEDIDO (outro horario no mesmo dia, ou o mesmo dia da semana na semana seguinte), nunca 'hoje'/'amanha' se ela nao pediu. ` +
        "(3) Responda tambem qualquer pergunta que ela tenha feito junto.",
    });
  }

  // ----- 6b) retomando depois que a equipe demorou, ou ja e paciente, e ela NAO pediu horario: responde so o que ela disse -----
  if (!i.schedulingSignal && (patientLike || i.resumedAfterStaffDelay === true)) {
    return base("plain_reply", "ela NAO pediu horario: responder so o que ela disse (sem venda, sem avaliacao, sem horarios)", {
      forbidEvaluationOffer: true,
      forbidSlotOffer: true,
      directive:
        "ELA NAO PEDIU HORARIO NEM AGENDAMENTO. Responda SO ao que ela escreveu agora, em ate 2 frases curtas, com naturalidade. NAO ofereca avaliacao, NAO liste horarios, NAO tente agendar e NAO puxe venda (voce esta " +
        (i.resumedAfterStaffDelay ? "retomando uma conversa que a equipe estava conduzindo" : "falando com quem ja e paciente") +
        "). Se ela fez uma pergunta, responda; se foi so um comentario, acolha em uma frase e pare. So volte a falar de horario se ELA pedir.",
    });
  }

  return base("default", "fluxo normal de atendimento", { forbidSlotOffer: !i.schedulingSignal });
}
