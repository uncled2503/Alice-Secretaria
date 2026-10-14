import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { prisma } from "../db/client.js";
import { enrichPatientFromCe } from "../clinicaexperts/sync.js";
import { fixRelativeDayLabels, fixWeekdayDatePairs } from "./relativeDays.js";
import { findNearestSlots,
  findAvailableSlots,
  findAvailableSlotsOnDay,
  findAvailableDays,
  checkSpecificTime,
  createBooking,
  professionalsForProcedure,
  SLOT_REASON_PT,
} from "../scheduling/slots.js";
import { offerFreedSlotToWaitlist } from "../scheduling/waitlist.js";
import { formatInZone, formatDayInZone, formatDateTimeInZone, upcomingWeekdayTable, isoDateInZone, zonedWallClockToUtc, wallClockInZone } from "../scheduling/time.js";
import { parseHolidayOpen, upcomingNationalHolidays } from "../scheduling/holidays.js";
import { pushAppointmentInBackground, removeAppointmentInBackground } from "../integrations/calendarSync.js";
import { sendMedia } from "../uazapi/client.js";
import { getActiveRulesPrompt } from "./rules.js";
import { getFunnelStages } from "../crm/stages.js";
import { movePatientToKind, movePatientToStage, movePatientToRecovery } from "../crm/stageAutomation.js";
import { notifyStaff } from "../crm/notify.js";
import { logActivity } from "../crm/activity.js";
import { enqueueLead, enqueueSchedule } from "../meta/events.js";
import { ctwaClidToFbc } from "../meta/userData.js";
import { checkAtendimentoLimit } from "../crm/usage.js";
import { tagNewLead } from "../crm/leadTag.js";
import { recordIntentSignals } from "../crm/intent.js";
import { handoffCard } from "../crm/handoffCard.js";
import { findRepetitions, removeSentences, askedAgain, conversationMemory, splitSentences } from "./repetition.js";
import { announcesAction, brokenPromise, PROMISE_NUDGE } from "./promises.js";
import { analyzeFlow, complainsAboutBot, type SalesFlow } from "./salesFlow.js";
import { confirmationThanks, isConfirmationReply } from "./confirmation.js";
import { buildPreProcedureText } from "../reminders/preProcedure.js";

// Orientacao de PRE-procedimento que sai como resposta da Alice logo apos a cliente confirmar o horario (por conversa).
// A ferramenta de confirmar preenche; generateReplyUnlocked usa o texto exato (nao deixa o modelo reescrever).
const pendingPreProcedure = new Map<string, string>();
import { reportsProcedureReaction, REACTION_HANDOFF_REASON, REACTION_TEXT, REACTION_WINDOW_DAYS } from "./safety.js";
import { bookingRiskNote } from "../crm/patientRisk.js";
import { isFreePlan } from "../crm/plan.js";
import type { Procedure } from "@prisma/client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
// gpt-4o-mini por padrao: conversa de qualificacao/agendamento nao precisa do
// modelo mais caro. Troque via OPENAI_MODEL se a qualidade exigir.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// --- Trava anti-loop ------------------------------------------------------
// O modelo as vezes trava reenviando a mesma resposta (ou variacoes dela) a
// cada mensagem do cliente. Detectamos isso comparando o texto normalizado.
export function normalizeReply(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // tira acentos (ate == ate)
    .replace(/https?:\/\/\S+/g, " ") // ignora links (mudam de conversa pra conversa)
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // tira pontuacao e emoji
    .replace(/\s+/g, " ")
    .trim();
}

// Similaridade de Jaccard entre os conjuntos de palavras (0 a 1).
export function replySimilarity(a: string, b: string): number {
  const wa = new Set(normalizeReply(a).split(" ").filter(Boolean));
  const wb = new Set(normalizeReply(b).split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

const REPEAT_SIMILARITY = 0.82; // acima disso conta como "mesma resposta"

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Agenda em dois passos. SEM 'date': devolve os DIAS que tem vaga - use primeiro, pra perguntar qual dia o paciente prefere. COM 'date': devolve os horarios livres daquele dia - use depois que ele escolher o dia (ou quando ele mesmo ja citar um dia). Nunca liste a agenda inteira de uma vez.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string", description: "Nome do procedimento, deve bater com um dos cadastrados na clinica." },
          date: { type: "string", description: "Opcional: AAAA-MM-DD do dia escolhido, pra listar os horarios livres dele. Use o ano corrente do contexto e o calendario dos proximos dias - nunca assuma um ano de memoria. Omita pra ver primeiro quais dias tem vaga." },
          professional_name: { type: "string", description: "Opcional: nome do profissional, se o paciente escolheu um." },
        },
        required: ["procedure_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_specific_time",
      description:
        "Verifica se um dia e horario especifico que o paciente pediu esta livre. SEMPRE chame isto quando o paciente citar um dia/hora (ex: 'quinta as 10h', 'amanha de tarde'). Retorna se esta disponivel e com quais profissionais; se nao estiver, retorna o motivo e alternativas.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string" },
          date: { type: "string", description: "Data no formato AAAA-MM-DD, no fuso da clinica. Use SEMPRE o ano corrente informado no contexto (linha 'HOJE E ...') e o calendario dos proximos dias que esta no contexto - nunca assuma um ano de memoria, senao a data cai no passado." },
          time: { type: "string", description: "Hora no formato HH:MM em 24h, no fuso da clinica." },
          professional_name: { type: "string", description: "Opcional: nome do profissional, se o paciente escolheu um." },
        },
        required: ["procedure_name", "date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Confirma o agendamento de verdade na agenda. SEMPRE chame antes de dizer ao paciente que a consulta esta confirmada/marcada - sem isso nada foi agendado. Informe o horario de uma destas duas formas: start_iso (o campo 'iso' que a ferramenta de disponibilidade devolveu, quando voce ainda tiver ele) OU date + time do horario combinado. O sistema revalida a disponibilidade de qualquer forma e recusa se o horario nao estiver livre.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string" },
          start_iso: { type: "string", description: "O valor exato do campo 'iso' retornado pelas ferramentas de disponibilidade, quando voce ainda tiver ele." },
          date: { type: "string", description: "Alternativa ao start_iso: AAAA-MM-DD do horario combinado, no ano corrente do contexto." },
          time: { type: "string", description: "Alternativa ao start_iso: HH:MM em 24h do horario combinado." },
          professional_id: { type: "string", description: "Opcional: o 'profissional_id' retornado junto com o horario escolhido." },
          patient_full_name: { type: "string", description: "Nome COMPLETO (nome e sobrenome) do paciente, quando ele informou. Obrigatorio se o sistema disser que o cadastro nao foi localizado." },
        },
        required: ["procedure_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_my_appointment",
      description:
        "Gerencia os agendamentos futuros do proprio paciente. Use 'confirm' quando ele confirmar presenca (ex: 'confirmado', 'pode confirmar', 'sim vou' - confirma todos os horarios do dia), 'cancel' quando pedir pra cancelar (tira da agenda), 'reschedule' quando pedir pra remarcar (informe new_date e new_time). Se ele tiver MAIS DE UM agendamento, para cancelar/remarcar informe qual com appointment_date (+ appointment_time), ou all_that_day=true pra cancelar todos os horarios do dia; sem isso a ferramenta devolve a lista e voce pergunta qual.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["confirm", "cancel", "reschedule"] },
          new_date: { type: "string", description: "So para reschedule: AAAA-MM-DD no fuso da clinica." },
          new_time: { type: "string", description: "So para reschedule: HH:MM em 24h." },
          appointment_date: { type: "string", description: "Qual agendamento (quando ha mais de um): AAAA-MM-DD do agendamento atual, como vem na lista de agendamentos." },
          appointment_time: { type: "string", description: "Qual agendamento (quando ha varios no mesmo dia): HH:MM do agendamento atual." },
          all_that_day: { type: "boolean", description: "So para cancel: true = cancelar TODOS os horarios do dia de appointment_date." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_procedure_photos",
      description:
        "Envia pro paciente as fotos de exemplo (ex.: antes/depois) cadastradas pra um procedimento. Chame ANTES de responder quando o paciente aceitar ver resultado ou pedir foto - depois so pergunte se e esse tipo de resultado que ele busca, sem descrever a foto (ele ja esta vendo). Se a ferramenta disser que nao ha fotos cadastradas, nao invente nem prometa: descreva os beneficios reais do procedimento.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string", description: "Nome do procedimento, deve bater com um dos cadastrados na clinica." },
        },
        required: ["procedure_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "join_waitlist",
      description:
        "Coloca o paciente na lista de espera quando o horario que ele queria nao esta disponivel e ele topa ser avisado se abrir uma vaga. So chame se o paciente concordar.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string" },
          note: { type: "string", description: "Preferencia do paciente em texto livre, ex: 'quinta de manha', 'qualquer dia a tarde'." },
        },
        required: ["procedure_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description:
        "Transfere o atendimento para uma pessoa da equipe. Use quando a situacao exige uma pessoa: pedido de desconto ou negociacao, reclamacao, paciente insatisfeito, paciente pede pra falar com alguem, duvida clinica que so o profissional responde, risco medico ou situacao potencialmente urgente, problema de pagamento, exames prontos com interesse cirurgico, ou algo que voce nao consegue resolver com seguranca. Depois de chamar, escreva UMA frase curta de encerramento e PARE de responder.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Motivo curto do handoff (ex: 'pedido de desconto', 'reclamacao', 'duvida clinica')." },
          summary: {
            type: "string",
            description:
              "Resumo pra pessoa continuar de onde voce parou: quem e o paciente, o que procura, queixa, o que ja foi conversado, ultima duvida e o proximo passo sugerido. Nao invente dados que voce nao tem.",
          },
        },
        required: ["reason", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_recontact",
      description:
        "Registra QUANDO a Alice deve retomar o contato com a pessoa (ex.: ela disse 'vou pensar' e combinou de falar sexta as 10h). No dia e horario combinados a Alice manda a mensagem de retomada sozinha. Chame SO depois que a pessoa disser ou aceitar um dia/horario. Se ela nao disse a hora, use 10:00. Depois confirme em uma frase ('Combinado, te chamo sexta as 10h!').",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "AAAA-MM-DD do dia combinado, no ano corrente do contexto (copie do calendario dos proximos dias)." },
          time: { type: "string", description: "HH:MM em 24h, no fuso da clinica. Padrao 10:00." },
          note: { type: "string", description: "Opcional: o que ficou pendente (ex.: 'pensando no valor da criolipolise')." },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_satisfaction",
      description:
        "Registra a nota da pesquisa de satisfacao quando o paciente responde com um numero (0 a 10) e ha uma pesquisa pendente no contexto. So chame quando o paciente realmente deu uma nota.",
      parameters: {
        type: "object",
        properties: {
          score: { type: "integer", description: "Nota de 0 a 10." },
          comment: { type: "string", description: "Comentario do paciente, se houver." },
        },
        required: ["score"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_crm_stage",
      description:
        "Atualiza a etapa do paciente no funil de vendas conforme a conversa evolui (ex: demonstrou interesse real -> 'interesse confirmado'; recebeu orcamento -> 'proposta enviada'; fechou -> a etapa de venda ganha). Pode usar QUALQUER etapa listada no contexto. Se a etapa normalmente pede um dado que voce nao tem (ex: o valor da venda), mova assim mesmo - o card fica sinalizado pra equipe completar.",
      parameters: {
        type: "object",
        properties: {
          stage_id: { type: "string", description: "O id (slug) de uma das etapas listadas no contexto." },
          reason: { type: "string", description: "Frase curta do porque da mudanca (aparece no historico da clinica)." },
        },
        required: ["stage_id"],
      },
    },
  },
];

// Ferramentas de agenda que ficam indisponiveis quando a clinica pede que o
// agendamento seja feito pela equipe (Clinic.aliceCanBook = false).
const BOOKING_TOOLS = new Set(["check_availability", "check_specific_time", "book_appointment", "manage_my_appointment", "join_waitlist"]);

// A clinica usa o Clinica Experts como agenda (a Alice espelha la o que agenda)?
async function ceConnected(clinicId: string): Promise<boolean> {
  return (await prisma.clinicaExpertsAccount.count({ where: { clinicId } })) > 0;
}

async function findProcedure(clinicId: string, name: unknown): Promise<Procedure | null> {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  return (
    (await prisma.procedure.findFirst({ where: { clinicId, internalOnly: false, name: { equals: raw } } })) ??
    (await prisma.procedure.findFirst({ where: { clinicId, internalOnly: false, name: { contains: raw } } }))
  );
}

// Mensagem de erro quando o procedimento nao bate com nada cadastrado. O
// modelo as vezes joga o nome de um PROFISSIONAL nesse campo (ex.: paciente
// so citou "Dra. Fulana", sem dizer qual tratamento) — nesses casos "nao
// encontramos esse procedimento" confunde o paciente, que nao perguntou por
// um procedimento. Detecta esse caso e orienta a perguntar o procedimento
// certo em vez de repetir que "nao existe" algo que o paciente nunca pediu.
async function procedureNotFoundMessage(clinicId: string, rawName: unknown): Promise<string> {
  const raw = String(rawName ?? "").trim();
  const totalProcedures = await prisma.procedure.count({ where: { clinicId, internalOnly: false } });
  if (totalProcedures === 0) {
    return "Esta clinica ainda nao tem procedimentos cadastrados no sistema, entao nao da pra checar disponibilidade automaticamente. Nao invente horario nem diga que nao ha vaga: explique que vai confirmar com a equipe e chame transfer_to_human.";
  }
  const rawLower = raw.toLowerCase();
  const professionals = rawLower
    ? await prisma.professional.findMany({ where: { clinicId, active: true }, select: { name: true } })
    : [];
  const looksLikeProfessional = professionals.some((p) => {
    const nameLower = p.name.toLowerCase();
    return nameLower.includes(rawLower) || rawLower.includes(nameLower);
  });
  if (looksLikeProfessional) {
    return `"${raw}" e o nome de um PROFISSIONAL, nao de um procedimento. Nao diga ao paciente que esse "procedimento" nao existe. Em vez disso, pergunte qual procedimento/tratamento ele quer agendar com essa pessoa e so entao chame check_availability de novo com o procedure_name correto.`;
  }
  return `Procedimento "${raw}" nao encontrado na clinica. Pergunte ao paciente qual procedimento ele deseja, usando os nomes cadastrados.`;
}

// Resolve quais profissionais considerar para um procedimento. Se o paciente
// citou um nome, tenta so ele; senao, todos os que atendem o procedimento
// (lista vazia = usa a agenda da clinica toda).
async function resolveProfessionalIds(
  clinicId: string,
  procedureId: string,
  professionalName: unknown,
): Promise<string[]> {
  const pros = await professionalsForProcedure(clinicId, procedureId);
  const named = String(professionalName ?? "").trim().toLowerCase();
  if (named) {
    const match = pros.find((p) => p.name.toLowerCase().includes(named));
    if (match) return [match.id];
  }
  return pros.map((p) => p.id);
}

// So a data (AAAA-MM-DD), pra listar o dia inteiro. null = nao veio/invalida.
function parseRequestedDate(date: unknown) {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date ?? "").trim());
  if (!d) return null;
  const parsed = { year: +d[1], month: +d[2], day: +d[3] };
  if (parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > 31) return null;
  return parsed;
}

function parseRequestedDateTime(date: unknown, time: unknown) {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date ?? "").trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!d || !t) return null;
  const parsed = { year: +d[1], month: +d[2], day: +d[3], hour: +t[1], minute: +t[2] };
  if (parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > 31) return null;
  if (parsed.hour > 23 || parsed.minute > 59) return null;
  return parsed;
}


// Dia + hora combinados para a Alice retomar o contato (fuso da clinica). null = invalido, no passado ou longe demais (~13 meses).
export function recontactInstant(date: unknown, time: unknown, tz: string, now = new Date()): Date | null {
  const p = parseRequestedDateTime(date, time ? time : "10:00");
  if (!p) return null;
  const at = zonedWallClockToUtc(tz, p.year, p.month, p.day, p.hour, p.minute);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
  if (at.getTime() > now.getTime() + 400 * 24 * 3_600_000) return null;
  return at;
}

async function runTool(
  clinicId: string,
  patientId: string,
  conversationId: string,
  name: string,
  input: any,
): Promise<string> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  if (!clinic.aliceCanBook && BOOKING_TOOLS.has(name)) {
    return JSON.stringify({ erro: "Nesta clinica quem agenda, remarca e cancela e a EQUIPE. Colete procedimento de interesse e preferencia de dia/turno, escreva a frase de transferencia e chame transfer_to_human com esse resumo. Nao diga que agendou." });
  }
  const tz = clinic.timezone || "America/Sao_Paulo";
  const patientLabelOf = (p: { name: string | null; phone: string } | null) => p?.name ?? p?.phone ?? "paciente";

  if (name === "transfer_to_human") {
    const reason = String(input.reason ?? "").slice(0, 120).trim() || "atendimento humano necessario";
    const summary = String(input.summary ?? "").slice(0, 1500).trim();
    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    const who = patientLabelOf(patient);

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { humanTakeover: true, handoffReason: reason, handoffPending: true },
    });
    // Ficha pra quem assume: origem do lead, interesse, objetivo, prazo, objecoes e o que a pessoa ja sinalizou.
    const ficha = patient ? handoffCard(patient) : "";
    await prisma.message.create({
      data: {
        conversationId,
        role: "system",
        content: `Atendimento transferido pela Alice. Motivo: ${reason}.${ficha ? `\n\nFicha:\n${ficha}` : ""}${summary ? `\n\nResumo:\n${summary}` : ""}`,
        authorName: null,
      },
    });
    await notifyStaff(
      clinicId,
      "human_handoff",
      `Atendimento transferido pela Alice: ${who}\nMotivo: ${reason}.${ficha ? `\n\n${ficha}` : ""}${summary ? `\n\n${summary}` : ""}`,
    );
    await logActivity({
      clinicId,
      type: "human_takeover",
      area: "atendimento",
      title: "Atendimento transferido pela Alice",
      description: `${who} — ${reason}.`,
      actorName: null,
    });
    return JSON.stringify({ transferido: true, instrucao: "Escreva UMA frase curta de encerramento e nao responda mais nesta conversa." });
  }

  if (name === "check_availability") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    if (!procedure) return await procedureNotFoundMessage(clinicId, input.procedure_name);

    const professionalIds = await resolveProfessionalIds(clinicId, procedure.id, input.professional_name);

    const day = parseRequestedDate(input.date);

    // AVALIACAO (Clinic.evalNearestFirst): em vez de listar dias, devolve os horarios livres MAIS PROXIMOS (hoje, depois amanha).
    if (!day && clinic.evalNearestFirst && /avalia/i.test(procedure.name)) {
      const nearest = await findNearestSlots(clinicId, procedure.id, { professionalIds, limit: 3 });
      if (nearest.length) {
        const today = isoDateInZone(new Date(), tz);
        const tomorrow = isoDateInZone(new Date(Date.now() + 86_400_000), tz);
        return JSON.stringify({
          procedimento: procedure.name,
          horarios_mais_proximos: nearest.map((sl) => {
            const d = isoDateInZone(sl.start, tz);
            return {
              iso: sl.start.toISOString(),
              quando: formatInZone(sl.start, tz),
              ...(d === today ? { relativo: "hoje" } : d === tomorrow ? { relativo: "amanha" } : {}),
              ...(sl.professionalName ? { profissional: sl.professionalName, profissional_id: sl.professionalId } : {}),
            };
          }),
          instrucao:
            "AVALIACAO: ofereca JA estes horarios (sao os mais proximos; hoje e amanha primeiro) em uma frase, sem perguntar o dia antes. Diga 'hoje'/'amanha' quando o campo 'relativo' vier. Se nao servirem, pergunte o dia que ela prefere e chame de novo com 'date'. Pra agendar use o 'iso' exato no book_appointment.",
        });
      }
    }

    // Passo 1 (sem "date"): so os DIAS que tem vaga.
    if (!day) {
      const days = await findAvailableDays(clinicId, procedure.id, { professionalIds });
      if (days.length === 0) {
        return JSON.stringify({ procedimento: procedure.name, dias: [], observacao: "Nenhum dia com vaga nas proximas duas semanas." });
      }
      return JSON.stringify({
        procedimento: procedure.name,
        dias: days.map((d) => ({ date: d.date, dia: d.label, horarios_livres: d.freeCount })),
        instrucao:
          "Pergunte qual DIA o paciente prefere (nao liste horario ainda). Quando ele escolher, chame check_availability de novo com o 'date' daquele dia.",
      });
    }

    // Passo 2 (com "date"): os horarios livres do dia escolhido.
    const slots = await findAvailableSlotsOnDay(clinicId, procedure.id, day, { professionalIds });
    if (slots.length === 0) {
      return JSON.stringify({
        procedimento: procedure.name,
        horarios: [],
        observacao: "Nenhum horario livre nesse dia. Chame de novo sem 'date' pra ver quais dias tem vaga e ofereca outro dia.",
      });
    }
    return JSON.stringify({
      procedimento: procedure.name,
      dia: formatDayInZone(slots[0].start, tz),
      horarios: slots.map((s) => ({
        iso: s.start.toISOString(),
        quando: formatInZone(s.start, tz),
        ...(s.professionalName ? { profissional: s.professionalName, profissional_id: s.professionalId } : {}),
      })),
      instrucao: "Pra agendar, use o 'iso' exato do horario escolhido no book_appointment - nao recalcule a data.",
    });
  }

  if (name === "check_specific_time") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    if (!procedure) return await procedureNotFoundMessage(clinicId, input.procedure_name);

    const requested = parseRequestedDateTime(input.date, input.time);
    if (!requested) return "Nao entendi a data/hora. Peca ao paciente pra confirmar o dia e o horario.";

    const professionalIds = await resolveProfessionalIds(clinicId, procedure.id, input.professional_name);
    const check = await checkSpecificTime(clinicId, procedure.id, requested, { professionalIds });

    if (check.available) {
      return JSON.stringify({
        disponivel: true,
        iso: check.requestedIso,
        quando: check.requestedLabel,
        profissionais: check.availableProfessionals.map((p) => ({ id: p.id, nome: p.name })),
      });
    }
    return JSON.stringify({
      disponivel: false,
      motivo: SLOT_REASON_PT[check.reason ?? "conflict"],
      horario_pedido: check.requestedLabel,
      alternativas: check.alternatives.map((a) => ({
        iso: a.iso,
        quando: a.label,
        ...(a.professionalName ? { profissional: a.professionalName, profissional_id: a.professionalId } : {}),
      })),
    });
  }

  if (name === "schedule_recontact") {
    const at = recontactInstant(input.date, input.time, tz);
    if (!at) return JSON.stringify({ registrado: false, motivo: "data ou hora invalida ou que ja passou: confirme o dia (AAAA-MM-DD) e a hora (HH:MM) com a pessoa e tente de novo" });
    await prisma.patient.update({ where: { id: patientId }, data: { callbackAt: at, callbackNote: String(input.note ?? "").trim().slice(0, 200) || null } });
    return JSON.stringify({ registrado: true, quando: formatDateTimeInZone(at, tz), instrucao: "Confirme em UMA frase o dia e o horario combinados. Se for fora do expediente, a mensagem sai na abertura." });
  }

  if (name === "book_appointment") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    if (!procedure) return await procedureNotFoundMessage(clinicId, input.procedure_name);

    // Cadastro nao localizado na agenda da clinica (Clinica Experts) e so o apelido do WhatsApp: pede o nome completo
    // antes de agendar (o agendamento e o cadastro la saem com o nome certo). Se a pessoa ja informou, grava.
    const fullNameGiven = String(input.patient_full_name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const bookingPatient = await prisma.patient.findUnique({ where: { id: patientId }, select: { name: true, ceUuid: true } });
    const hasSurname = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/).filter(Boolean).length >= 2;
    if (bookingPatient && !bookingPatient.ceUuid && (await ceConnected(clinicId))) {
      if (hasSurname(fullNameGiven)) {
        await prisma.patient.update({ where: { id: patientId }, data: { name: fullNameGiven } });
      } else if (!hasSurname(bookingPatient.name)) {
        return JSON.stringify({
          agendado: false,
          motivo: "cadastro do paciente nao localizado na agenda: peca o NOME COMPLETO (nome e sobrenome) e chame book_appointment de novo informando patient_full_name",
        });
      }
    }

    let professionalId: string | null = input.professional_id ? String(input.professional_id) : null;
    let candidateProIds: string[] = [];
    if (!professionalId) {
      const pros = await professionalsForProcedure(clinicId, procedure.id);
      if (pros.length === 1) professionalId = pros[0].id;
      else candidateProIds = pros.map((p) => p.id);
    }

    // O "iso" da consulta de disponibilidade nao sobrevive entre turnos (so o
    // texto das mensagens e guardado), entao aceitar date+time e o que permite
    // agendar depois de uma conversa longa. Seguro: o createBooking revalida
    // passado/expediente/conflito dentro da transacao.
    const requested = parseRequestedDateTime(input.date, input.time);
    const startUtc = input.start_iso
      ? new Date(String(input.start_iso))
      : requested
        ? zonedWallClockToUtc(tz, requested.year, requested.month, requested.day, requested.hour, requested.minute)
        : new Date(NaN);

    if (isNaN(startUtc.getTime())) {
      return JSON.stringify({
        agendado: false,
        motivo: "nao entendi o horario; informe start_iso, ou date (AAAA-MM-DD) e time (HH:MM) do horario combinado",
      });
    }

    // Varios profissionais fazem o procedimento e a Alice nao informou qual: SEM profissional, o agendamento e validado contra a
    // agenda da clinica INTEIRA (qualquer paciente de qualquer profissional conta como conflito) e recusava horarios que ela mesma
    // acabou de oferecer ("nao tem mais disponibilidade"). Escolhe um profissional que esteja realmente livre nesse horario.
    if (!professionalId && candidateProIds.length > 1) {
      const wc = wallClockInZone(startUtc, tz);
      const check = await checkSpecificTime(clinicId, procedure.id, { year: wc.year, month: wc.month, day: wc.day, hour: wc.hour, minute: wc.minute }, { professionalIds: candidateProIds });
      if (check.available) professionalId = check.availableProfessionals.find((p) => p.id)?.id ?? null;
    }

    const booking = await createBooking({
      clinicId,
      patientId,
      procedureId: procedure.id,
      professionalId,
      startUtc,
    });

    if (!booking.ok) {
      const motivo =
        booking.error === "conflict"
          ? "esse horario acabou de ser ocupado por outro paciente; ofereca outro horario"
          : SLOT_REASON_PT[booking.error] ?? "nao foi possivel agendar";
      return JSON.stringify({ agendado: false, motivo });
    }

    await prisma.conversation.updateMany({ where: { patientId }, data: { status: "scheduled" } });
    await movePatientToKind(clinicId, patientId, "avaliacao_agendada", { note: "agendou pela Alice" });
    void enqueueSchedule(clinicId, booking.appointmentId).catch((err) => console.error("[meta] enqueueSchedule:", err));

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    const whenLabel = formatDateTimeInZone(booking.scheduledAt, tz);
    const withPro = booking.professionalName ? ` com ${booking.professionalName}` : "";
    await notifyStaff(
      clinicId,
      "new_appointment",
      `Novo agendamento (via Alice): ${patientLabelOf(patient)} - ${booking.procedureName}${withPro} em ${whenLabel}.${await bookingRiskNote(patientId)}`,
    );
    await logActivity({
      clinicId,
      type: "appointment_booked",
      area: "agenda",
      title: "Agendamento criado pela Alice",
      description: `${patientLabelOf(patient)} — ${booking.procedureName}${withPro} em ${whenLabel}.`,
      actorName: null,
    });

    return JSON.stringify({ agendado: true, quando: booking.label, profissional: booking.professionalName ?? undefined });
  }

  if (name === "manage_my_appointment") {
    const action = String(input.action ?? "");
    const upcoming = await prisma.appointment.findMany({
      where: { patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
      orderBy: { scheduledAt: "asc" },
      take: 10,
      include: { procedure: true, professional: true, patient: true },
    });
    if (upcoming.length === 0) return JSON.stringify({ ok: false, motivo: "nao encontrei um agendamento futuro pra esse paciente" });

    const pad2 = (n: number) => String(n).padStart(2, "0");
    const hhmmOf = (d: Date) => {
      const wc = wallClockInZone(d, tz);
      return `${pad2(wc.hour)}:${pad2(wc.minute)}`;
    };
    const describe = (a: (typeof upcoming)[number]) => ({
      quando: formatDateTimeInZone(a.scheduledAt, tz),
      procedimento: a.procedure.name,
      appointment_date: isoDateInZone(a.scheduledAt, tz),
      appointment_time: hhmmOf(a.scheduledAt),
    });
    const who = patientLabelOf(upcoming[0].patient);

    // QUAL agendamento? O paciente pode ter varios (ex.: 3 procedimentos no mesmo dia). Sem indicacao, vale o proximo; mas
    // pra CANCELAR/REMARCAR com mais de um, a Alice precisa perguntar qual - antes cancelava o primeiro sem perguntar.
    const dayWanted = String(input.appointment_date ?? "").trim();
    const timeWanted = String(input.appointment_time ?? "").trim().replace(/^(\d):/, "0$1:");
    let candidates = upcoming;
    if (dayWanted) candidates = candidates.filter((a) => isoDateInZone(a.scheduledAt, tz) === dayWanted);
    if (timeWanted) candidates = candidates.filter((a) => hhmmOf(a.scheduledAt) === timeWanted);
    if (candidates.length === 0) {
      return JSON.stringify({ ok: false, motivo: "nao encontrei agendamento nesse dia/horario", agendamentos: upcoming.map(describe) });
    }
    const askWhich = () =>
      JSON.stringify({
        ok: false,
        motivo: "o paciente tem mais de um agendamento: preciso saber qual",
        agendamentos: candidates.map(describe),
        instrucao:
          "Pergunte QUAL agendamento (ou se sao todos do dia) e chame a ferramenta de novo informando appointment_date e appointment_time (ou all_that_day=true pra cancelar todos os horarios daquele dia). Nao escolha por conta propria.",
      });

    if (action === "confirm") {
      // A confirmacao e uma so por dia: confirma TODOS os horarios do dia do agendamento escolhido (o lembrete so cita o primeiro).
      const day = isoDateInZone(candidates[0].scheduledAt, tz);
      const group = upcoming.filter((a) => isoDateInZone(a.scheduledAt, tz) === day);
      await prisma.appointment.updateMany({
        where: { id: { in: group.map((a) => a.id) } },
        data: { patientConfirmed: true, confirmedAt: new Date() },
      });
      const label = formatDateTimeInZone(group[0].scheduledAt, tz);
      const procs = group.map((a) => a.procedure.name).join(", ");
      await notifyStaff(clinicId, "confirmed", `Presenca confirmada: ${who} - ${procs} em ${label}${group.length > 1 ? ` (${group.length} horarios no dia)` : ""}.`);
      await logActivity({
        clinicId, type: "appointment_confirmed", area: "agenda",
        title: "Presença confirmada pelo paciente",
        description: `${who} — ${procs} em ${label}.`, actorName: null,
      });
      // Orientacao de preparo (pre-procedimento): sai como a resposta desta confirmacao, com o texto exato da clinica.
      let preparo = false;
      try {
        const pre = await buildPreProcedureText(group);
        if (pre) {
          pendingPreProcedure.set(conversationId, pre);
          preparo = true;
        }
      } catch (err) {
        console.error("[pre-procedimento] falha ao montar a mensagem:", err);
      }
      return JSON.stringify({
        ok: true,
        confirmado: label,
        horarios_confirmados: group.length,
        ...(preparo ? { orientacoes_de_preparo: "O sistema envia sozinho, como resposta, a mensagem de agradecimento com as orientacoes de preparo. Nao escreva as orientacoes; responda so uma frase curta." } : {}),
      });
    }

    if (action === "cancel") {
      let targets: typeof upcoming;
      if (input.all_that_day === true) {
        const day = isoDateInZone(candidates[0].scheduledAt, tz);
        targets = upcoming.filter((a) => isoDateInZone(a.scheduledAt, tz) === day);
      } else if (candidates.length === 1) {
        targets = candidates;
      } else {
        return askWhich();
      }

      for (const appt of targets) {
        await prisma.appointment.update({ where: { id: appt.id }, data: { status: "cancelled" } });
        removeAppointmentInBackground(appt.id); // tira do Google Agenda e do Clinica Experts
        await logActivity({
          clinicId, type: "appointment_cancelled", area: "agenda",
          title: "Agendamento cancelado pelo paciente",
          description: `${who} — ${appt.procedure.name} em ${formatDateTimeInZone(appt.scheduledAt, tz)}.`, actorName: null,
        });
      }
      const labels = targets.map((a) => `${a.procedure.name} em ${formatDateTimeInZone(a.scheduledAt, tz)}`);
      await notifyStaff(clinicId, "cancel", `Agendamento cancelado pelo paciente: ${who} - ${labels.join("; ")}.`);
      await movePatientToRecovery(clinicId, patientId, { note: "cancelou o agendamento" });
      for (const appt of targets) {
        await offerFreedSlotToWaitlist({ clinicId, procedureId: appt.procedureId, professionalId: appt.professionalId, freedAt: appt.scheduledAt });
      }
      return JSON.stringify({
        ok: true,
        cancelado: labels.join("; "),
        removido_da_agenda: true,
        instrucao:
          "Confirme em UMA frase que o horario foi cancelado e OFERECA reagendar: pergunte se ela quer remarcar e qual dia/periodo fica melhor (use check_availability pra oferecer horarios reais). Se ela disser que nao quer remarcar agora, respeite e deixe a porta aberta, sem insistir.",
      });
    }

    if (action === "reschedule") {
      if (candidates.length > 1) return askWhich();
      const appt = candidates[0];
      const requested = parseRequestedDateTime(input.new_date, input.new_time);
      if (!requested) return JSON.stringify({ ok: false, motivo: "preciso da nova data e hora (new_date e new_time)" });

      const professionalIds = appt.professionalId ? [appt.professionalId] : [];
      // ignoreAppointmentId exclui o proprio agendamento do "ocupado" - sem
      // isso, remarcar pra um horario que toca no horario ATUAL dele mesmo
      // seria recusado por "conflito com ele mesmo".
      const check = await checkSpecificTime(clinicId, appt.procedureId, requested, { professionalIds, ignoreAppointmentId: appt.id });
      if (!check.available) {
        return JSON.stringify({
          ok: false,
          motivo: SLOT_REASON_PT[check.reason ?? "conflict"],
          alternativas: check.alternatives.map((a) => ({ iso: a.iso, quando: a.label })),
        });
      }

      const oldSlot = { procedureId: appt.procedureId, professionalId: appt.professionalId, freedAt: appt.scheduledAt };
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { scheduledAt: new Date(check.requestedIso), patientConfirmed: false, confirmedAt: null },
      });
      pushAppointmentInBackground(appt.id); // move o evento no Google pro horario novo
      await notifyStaff(clinicId, "reschedule", `Agendamento remarcado pelo paciente: ${who} - ${appt.procedure.name} agora em ${check.requestedLabel}.${await bookingRiskNote(patientId)}`);
      await logActivity({
        clinicId, type: "appointment_rescheduled", area: "agenda",
        title: "Agendamento remarcado pelo paciente",
        description: `${who} — ${appt.procedure.name} agora em ${check.requestedLabel}.`, actorName: null,
      });
      await offerFreedSlotToWaitlist({ clinicId, ...oldSlot });
      return JSON.stringify({ ok: true, remarcado: check.requestedLabel });
    }

    return JSON.stringify({ ok: false, motivo: "acao invalida" });
  }

  if (name === "send_procedure_photos") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    if (!procedure) return await procedureNotFoundMessage(clinicId, input.procedure_name);

    const photos = await prisma.procedurePhoto.findMany({ where: { procedureId: procedure.id }, orderBy: { order: "asc" } });
    if (photos.length === 0) {
      return JSON.stringify({
        enviado: false,
        motivo: "nenhuma foto cadastrada pra esse procedimento",
        instrucao: "Nao prometa nem invente foto. Descreva os beneficios reais do procedimento (goals/benefits cadastrados) em vez de enviar imagem.",
      });
    }

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) return JSON.stringify({ enviado: false, motivo: "paciente nao encontrado" });

    let sentCount = 0;
    try {
      for (const photo of photos) {
        await sendMedia(clinicId, patient.phone, { dataUrl: photo.dataUrl, kind: "image", caption: photo.caption ?? undefined });
        sentCount++;
        if (sentCount < photos.length) await new Promise((r) => setTimeout(r, 800)); // sem rajada: o WhatsApp entrega em ordem
      }
    } finally {
      // Registra no chat (so o aviso, sem duplicar as imagens no banco): a equipe ve que as fotos foram enviadas.
      if (sentCount > 0) {
        await prisma.message.create({
          data: { conversationId, role: "assistant", content: `📷 ${sentCount} foto(s) de resultado enviada(s): ${procedure.name}`, authorName: null, deliveryStatus: "sent" },
        });
      }
    }
    return JSON.stringify({
      enviado: true,
      quantidade: photos.length,
      instrucao: "As fotos ja foram enviadas nesta mesma resposta. Nao descreva as fotos (o paciente ja esta vendo) - so pergunte se e esse tipo de resultado que ele busca.",
    });
  }

  if (name === "join_waitlist") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    const procedureId = procedure?.id ?? null;
    const existing = await prisma.waitlistEntry.findFirst({
      where: { clinicId, patientId, status: { in: ["waiting", "notified"] }, procedureId },
    });
    if (existing) return JSON.stringify({ ok: true, ja_estava: true });

    await prisma.waitlistEntry.create({
      data: {
        clinicId,
        patientId,
        procedureId,
        preferredNote: String(input.note ?? "").slice(0, 200),
      },
    });
    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    await logActivity({
      clinicId, patientId, type: "waitlist_added", area: "agenda",
      title: "Paciente entrou na lista de espera",
      description: `${patientLabelOf(patient)}${procedure ? ` — ${procedure.name}` : ""}${input.note ? ` (${input.note})` : ""}.`,
      actorName: null,
    });
    return JSON.stringify({ ok: true });
  }

  if (name === "update_crm_stage") {
    // Sem restrictToKinds: a Alice move o lead pra qualquer etapa. Quando a
    // etapa costuma pedir um dado que ela nao tem (o valor da venda), o card
    // fica marcado no quadro pra equipe completar - melhor do que travar a
    // movimentacao e o funil ficar desatualizado.
    const result = await movePatientToStage(clinicId, patientId, String(input.stage_id ?? ""), {
      note: input.reason ? String(input.reason).slice(0, 200) : "atualizado pela Alice no atendimento",
      aiDriven: true, // a Alice move o card, mas nao gera evento de compra (Purchase) na Meta sozinha
    });
    if (!result.ok) return JSON.stringify({ atualizado: false, motivo: result.error });
    return JSON.stringify({ atualizado: true, etapa: result.label });
  }

  if (name === "record_satisfaction") {
    const score = Math.round(Number(input.score));
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      return JSON.stringify({ ok: false, motivo: "nota deve ser de 0 a 10" });
    }
    const survey = await prisma.satisfactionSurvey.findFirst({
      where: { clinicId, patientId, answeredAt: null, askedAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } },
      orderBy: { askedAt: "desc" },
    });
    if (!survey) return JSON.stringify({ ok: false, motivo: "nao ha pesquisa pendente pra este paciente" });

    await prisma.satisfactionSurvey.update({
      where: { id: survey.id },
      data: {
        score,
        comment: input.comment ? String(input.comment).slice(0, 500) : null,
        answeredAt: new Date(),
        reviewLinkSent: score >= clinic.npsThreshold && !!clinic.googleReviewUrl,
      },
    });

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    const who = patientLabelOf(patient);
    await logActivity({
      clinicId, patientId, type: "satisfaction_recorded", area: "atendimento",
      title: "Pesquisa de satisfação respondida",
      description: `${who} deu nota ${score}${input.comment ? `: "${String(input.comment).slice(0, 200)}"` : "."}`,
      actorName: null,
    });

    if (score <= 6) {
      await notifyStaff(clinicId, "human_handoff", `Avaliação baixa (${score}/10): ${who}${input.comment ? ` — "${String(input.comment).slice(0, 200)}"` : ""}. Vale um retorno da equipe.`);
      return JSON.stringify({ ok: true, acao: "Agradeça pela sinceridade, pergunte o que pode melhorar e diga que vai passar pra equipe. Se ele reclamar, use transfer_to_human." });
    }
    if (score >= clinic.npsThreshold && clinic.googleReviewUrl?.trim()) {
      return JSON.stringify({ ok: true, acao: `Agradeça de coração e peça, se puder, uma avaliação neste link: ${clinic.googleReviewUrl.trim()}. Depois, em uma MENSAGEM SEPARADA (nao junto do link), pergunte com carinho se ela teria um amigo(a) ou familiar que gostaria de conhecer o atendimento (indicação).` });
    }
    return JSON.stringify({ ok: true, acao: "Agradeça pelo retorno." });
  }

  return "Ferramenta desconhecida.";
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  dinheiro: "dinheiro",
  pix: "Pix",
  credito: "cartao de credito",
  debito: "cartao de debito",
};

// So passa pro prompt o que a clinica realmente cadastrou - nunca inventa
// indicacao, beneficio, prazo ou preco que nao veio do banco.
function describeProcedureForPrompt(p: Procedure & { _count?: { photos: number } }, quotePrices = true): string {
  const lines = [`- ${p.name} (${p.durationMin}min)`];
  if (p._count?.photos) lines.push("  Fotos de resultado (antes/depois): TEM cadastradas - quando a pessoa demonstrar interesse neste procedimento, ofereca ('Posso te enviar alguns resultados?') e, se ela aceitar ou pedir, use send_procedure_photos");

  if (!quotePrices) {
    lines.push("  Valor: apresentado pela equipe na avaliacao (NAO informar valor, parcelas nem formas de pagamento)");
  } else if (p.price != null) {
    let priceLine = `  Valor: R$ ${p.price.toFixed(2)}`;
    if (p.offerInstallments && p.maxInstallments) {
      priceLine += ` (ate ${p.maxInstallments}x de R$ ${(p.price / p.maxInstallments).toFixed(2)})`;
    }
    lines.push(priceLine);
  } else if (p.priceVariable) {
    lines.push("  Valor: depende de avaliacao presencial (nao informar valor fixo)");
  }

  const methods = p.paymentMethods
    ? p.paymentMethods
        .split(",")
        .filter(Boolean)
        .map((m) => PAYMENT_METHOD_LABELS[m] || m)
    : [];
  if (methods.length) lines.push(`  Formas de pagamento: ${methods.join(", ")}`);
  if (p.paymentLink) lines.push(`  Link de pagamento: ${p.paymentLink}`);

  if (p.description) lines.push(`  Descricao: ${p.description}`);
  if (p.aliases) lines.push(`  Tambem pode ser chamado de: ${p.aliases}`);
  if (p.goals) lines.push(`  Atende objetivos/queixas: ${p.goals.split("\n").filter(Boolean).join("; ")}`);
  if (p.benefits) lines.push(`  Beneficios que podem ser afirmados: ${p.benefits.split("\n").filter(Boolean).join("; ")}`);
  if (p.resultTimeline) lines.push(`  Prazo de resultado: ${p.resultTimeline}`);

  return lines.join("\n");
}

// Concordancia em portugues: o nome de uma PESSOA leva "de" ("secretaria de
// Ana"), mas um titulo define o genero ("secretaria do Dr. Joao", "da Dra.
// Ana"). Sem isso a Alice fala "secretaria de Dr. Isac".
function prepPessoa(name: string): string {
  const n = name.trim();
  if (/^(dra\.?|doutora)\b/i.test(n)) return `da ${n}`;
  if (/^(dr\.?|doutor)\b/i.test(n)) return `do ${n}`;
  return `de ${n}`;
}

// Nome de ESTABELECIMENTO: "da Clinica X", mas "do Consultorio X" / "do Espaco
// X". Default "da" (clinica, casa, unidade e nomes proprios soltos).
function prepLugar(name: string): string {
  const n = name.trim();
  if (/^(consult[oó]rio|espa[cç]o|centro|instituto|est[uú]dio|studio|sal[aã]o|hospital|laborat[oó]rio|grupo|ambulat[oó]rio|nucleo|n[uú]cleo)\b/i.test(n)) {
    return `do ${n}`;
  }
  return `da ${n}`;
}

// Reforco de gramatica usado em mais de um ponto do prompt (self-apresentacao
// e o fechamento geral) - um lugar so pra nao desalinhar exemplo/redacao entre eles.
const GRAMMAR_REMINDER =
  'Escreva com gramatica correta: concordancia verbal e nominal, e contracoes de preposicao ("do"/"da" em vez de "de o"/"de a", "no"/"na" em vez de "em o"/"em a"). Ex: "secretaria do Dr. Joao", "da equipe do Consultorio", nunca "secretaria de Dr." nem "da equipe da Consultorio".';

// Como a Alice se apresenta pro paciente - ela NUNCA diz que e IA/assistente
// virtual, so uma destas tres formas (escolhida pela clinica no painel).
function personaInstruction(clinic: { name: string; assistantName: string; assistantPersona: string; assistantPersonaName: string | null }): string {
  const a = clinic.assistantName || "Alice";
  const who = clinic.assistantPersonaName?.trim();
  const grammar = " Sempre com a concordancia e as contracoes corretas do portugues (ex: \"do Dr.\", \"da Dra.\", \"da Clinica\", \"do Consultorio\", \"da equipe do Consultorio\") - nunca \"de Dr.\" nem \"da Consultorio\".";
  if (clinic.assistantPersona === "clinic_secretary") {
    return `Voce se apresenta como secretaria ${prepLugar(clinic.name)}. Ex: "Oi! Aqui e a ${a}, secretaria ${prepLugar(clinic.name)}".${grammar}`;
  }
  if (clinic.assistantPersona === "professional_secretary" && who) {
    return `Voce se apresenta como secretaria ${prepPessoa(who)} (${prepLugar(clinic.name)}). Ex: "Oi! Aqui e a ${a}, secretaria ${prepPessoa(who)}".${grammar}`;
  }
  // team (padrao) - e tambem o fallback do professional_secretary sem nome
  return `Voce se apresenta apenas como parte da equipe ${prepLugar(clinic.name)}, sem citar cargo. Ex: "Oi! Aqui e a ${a}, da equipe ${prepLugar(clinic.name)}".${grammar}`;
}

export async function buildSystemPrompt(clinicId: string, ctx: { patientId?: string; flow?: SalesFlow } = {}): Promise<string> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    include: {
      procedures: { where: { internalOnly: false }, include: { professionals: { where: { active: true }, select: { name: true, title: true } }, _count: { select: { photos: true } } } }, // internalOnly (retoque/cortesia importados do CE) a Alice nao oferece
      messageTemplates: { where: { active: true } },
      faqs: { where: { active: true } },
      playbooks: { where: { active: true } },
    },
  });

  const a = clinic.assistantName || "Alice";
  const procedureList = clinic.procedures.map((p) => describeProcedureForPrompt(p, clinic.quotePrices)).join("\n\n");

  const areaLine = clinic.activityArea?.trim()
    ? `\nArea de atuacao: ${clinic.activityArea.trim()}.`
    : "";

  const depositLine = clinic.requireDepositProof
    ? `\nSINAL OBRIGATORIO: so confirme (book_appointment) um agendamento depois que o paciente enviar o comprovante do sinal na conversa. Antes disso, peca o pagamento e aguarde o comprovante.`
    : "";

  const handoffPhrase = clinic.handoffPhrase?.trim();
  const handoffLine = `\nHANDOFF: voce atende PELO proprio WhatsApp oficial da clinica - esta conversa JA e o canal. NUNCA mande link de WhatsApp (wa.me) nem numero de telefone pra "falar com o atendimento" / "chamar a recepcao": e aqui mesmo. Quando a situacao exigir uma pessoa (pedido de desconto ou negociacao, reclamacao, paciente insatisfeito, paciente pede pra falar com alguem OU pra ligar, paciente diz que as respostas estao "no automatico" / repetitivas / confusas, duvida clinica que so o profissional responde, risco medico ou urgencia, problema de pagamento, exames prontos com interesse cirurgico, ou algo que voce nao resolve com seguranca): ${handoffPhrase ? `escreva exatamente "${handoffPhrase}" e ` : "escreva uma frase curta e acolhedora e "}chame a ferramenta transfer_to_human com o motivo e um resumo pra pessoa continuar. Depois disso pare de responder. Nao anuncie que vai "transferir pra um atendente".`;

  // Trava anti-loop: o modelo (gpt-4o-mini) as vezes trava repetindo a mesma
  // resposta. Isso e reforcado no prompt e checado de novo no codigo.
  const noRepeatLine = `\nLEIA A CONVERSA ANTES DE RESPONDER: o historico acima e tudo o que ja foi dito. Veja o que voce ja informou e o que ja perguntou e CONTINUE de onde parou, como uma pessoa que acompanha a conversa. Nunca repita informacao (valor, endereco, horarios, avisos) nem a pergunta de fechamento que ja apareceu; so volte a um assunto se a pessoa pedir de novo.
NAO SE REPITA: nunca reenvie uma resposta que voce ja mandou nesta conversa, nem uma variacao da mesma frase. Responda SEMPRE a ultima mensagem do cliente - se ele fez uma pergunta nova (ex: "da pra mandar um cartao junto?", "entrega de manha?"), responda ESSA pergunta, sem voltar pro assunto anterior. Se voce ja explicou tudo o que sabia e o cliente continua sem avancar, NAO repita: use transfer_to_human. Cada resposta sua tem que acrescentar algo novo.
NAO FIQUE SE DESPEDINDO: se voce ja se despediu ou disse "fico a disposicao"/"e so chamar" nesta conversa e o cliente so respondeu com um agradecimento ou confirmacao sem pedir nada novo (ex: "obrigado", "valeu", "ok", "de nada", um emoji), a conversa ja terminou - NAO mande mais uma mensagem de despedida. Um atendimento bom sabe ficar em silencio quando ja resolveu tudo.`;

  // Tres coisas que entregam na hora que do outro lado tem um robo, mesmo
  // quando o conteudo da resposta esta certo.
  const naturalnessLine = `\nSOE GENTE, NAO SISTEMA:
- NUNCA fique repetindo o nome da pessoa. Depois que ela se apresentar, use o nome no maximo uma vez e siga tratando de forma proxima sem repetir - chamar pelo nome em toda mensagem e a marca registrada de robo.
- Mensagem curta, do tamanho do que uma pessoa digita no WhatsApp. Se a resposta esta virando um texto longo com varios topicos, e porque voce esta despejando informacao: fique no que foi perguntado e deixe o resto pra quando ele perguntar.
- Nao abra toda mensagem do mesmo jeito ("Entendo!", "Perfeito!", "Que otimo!"). Repetir a mesma formula de abertura conversa inteira soa decorado - varie ou simplesmente responda direto.`;

  const consultivo = clinic.servicePosture === "consultivo";

  const postureLine = consultivo
    ? `\nPOSTURA CONSULTIVA: conduza como um consultorio, sem pressao comercial. Responda a duvida atual primeiro; so pergunte de novo quando a resposta mudar o proximo passo; se ja respondeu, aguardar e uma acao valida. Nao encerre com pergunta generica so pra manter a conversa. Nao empurre o agendamento - ofereca o caminho da avaliacao quando houver interesse real.`
    : `\nPOSTURA COMERCIAL - MAQUINA DE VENDAS CONSULTIVA. Cada mensagem sua tem UM objetivo: levar a cliente ao proximo passo (avaliacao ou agendamento), com naturalidade e sem enrolar. Como:
- LEIA a conversa inteira antes de responder. Nunca pergunte o que ela ja contou; nunca repita pergunta, informacao ou oferta que voce ja fez.
- Ela ja disse o que quer? Reconheca com as palavras dela (1 frase), conecte a solucao do catalogo (1 frase) e feche com UMA pergunta concreta rumo ao horario ("Quer que eu veja um horario pra sua avaliacao?"). Ela ainda nao disse? Faca UMA pergunta especifica ao assunto dela (gordura: qual regiao; pele: o que quer melhorar; se veio de anuncio, use o procedimento do anuncio).
- Pediu avaliacao, horario ou agendar (mesmo com poucas palavras: "prefiro uma avaliacao", "quero marcar")? Pare de qualificar e AGENDE agora (check_availability / check_specific_time). Isso nunca e "insistir".
- Recusou os horarios ("nenhum deles", "nao posso")? Nao se despeca: pergunte o dia da semana e o periodo que preferem e ofereca outras datas. So desista se ela disser claramente que nao quer mais.
- Nao fale de valor se ela nao perguntou. Se perguntou, responda direto, em 1 frase, e volte ao proximo passo.
- Objecao (preco, medo, tempo, indecisao): acolha, reconecte com o resultado que ela quer, use so as orientacoes cadastradas e proponha o proximo passo menor (a avaliacao). Nunca invente desconto, garantia nem urgencia.
- Respondeu "nao", "vou pensar" ou "vou me organizar"? NUNCA responda so "ok"/"tudo bem": acolha em meia frase e, se fizer sentido, faca UMA pergunta aberta sobre o motivo (o que ficou pesando?), SEM empurrar avaliacao. Proponha um momento para retomar o contato ("posso te chamar amanha?") e, quando ela disser o dia e o horario, chame schedule_recontact.
- NAO monte pacote, combo nem junte procedimentos por conta propria, e nao indique tratamento que nao tenha relacao direta com a queixa que ela contou. Indique o procedimento do catalogo que resolve a queixa dela; combo/pacote so se ja estiver cadastrado como condicao vigente ou se ela pedir.
- Mensagens curtas (ate 3 frases), uma pergunta so, tom de WhatsApp, sem formulario, sem repetir a mesma abertura nem a mesma pergunta de fechamento.
- Nunca diga que "ja tem outro paciente" no horario: diga so que "esse horario nao esta disponivel" e ofereca o mais proximo.
Tudo isso sem quebrar regra nenhuma: nao invente valor, prazo, garantia nem urgencia que nao seja real.`;

  // Vendedora proativa - vale pro modo "geral" (loja/servico). Respeita a
  // postura consultiva se a conta estiver configurada assim.
  const sellerLine = consultivo
    ? `\nATENDIMENTO NO RITMO DO CLIENTE: recomende quando ele pedir, mande o link certo e nao insista. Um proximo passo claro, sem pressao.`
    : `\nVOCE E VENDEDORA (esse e o seu papel principal, nao so responder e mandar link): voce conduz a conversa ate a compra, com simpatia e sem ser insistente.
- Afunile rapido, 1 ou 2 perguntas por vez: pra quem e (menina/menino/neutro), tamanho ou idade, ocasiao, faixa de preco.
- RECOMENDE de verdade. Em vez de "quer ver alguma opcao?", diga o que voce levaria ("pra recem-nascida em algodao eu iria de macacao + manta") e mande o link direto da peca ou da colecao ja filtrada.
- Leve pro proximo passo concreto: "e so adicionar ao carrinho e finalizar" + link. Se o cliente travar numa etapa, ajude a destravar.
- Use os gatilhos REAIS quando existirem: prazo de entrega no mesmo dia, frete gratis a partir de um valor ("faltam R$ X pro frete sair de graca"), cupom com validade, item quase esgotado. Nunca invente urgencia.
- Contorne objecao com informacao, nao com "fale com a equipe": duvida de tamanho -> guia de tamanhos; achou caro -> faixa de preco menor ou o cupom; inseguranca -> troca em 30 dias, algodao.
- Se o cliente demonstrar intencao de compra e for algo que voce nao fecha sozinha (pagamento, confirmar entrega hoje, incluir um cartao com mensagem), NAO perca a venda: use transfer_to_human ja com o resumo do que ele quer e escolheu.
Tudo isso SEM quebrar as regras cadastradas: nunca invente preco, estoque ou prazo; siga o tom e as politicas.`;

  const medicalLine =
    clinic.clinicKind && clinic.clinicKind !== "estetica"
      ? `\nSEGURANCA MEDICA (prioridade sobre qualquer objetivo comercial): nunca diagnostique, prescreva, interprete exame, garanta cirurgia, determine quantidade de ml, nem afirme que um procedimento e o indicado sem avaliacao. "O que eu tenho?", "preciso operar?", "quantos ml?", "isso e cancer?" nao se respondem como decisao medica - de informacao geral e conduza pra avaliacao, ou transfira pra equipe. Foto nao diagnostica.`
      : "";

  const noPricesLine = clinic.quotePrices
    ? ""
    : `\nVALORES: voce NAO informa valores, parcelas nem formas de pagamento de procedimento algum, e NUNCA traz o assunto de valor sozinha: so fale disso se a pessoa perguntar. Quando perguntarem, diga em uma frase que o valor depende do protocolo de cada pessoa e que a equipe apresenta o investimento na avaliacao, e volte ao proximo passo. Nao de faixas nem estimativas.`;
  const teamBooksLine = clinic.aliceCanBook
    ? ""
    : `
AGENDAMENTO PELA EQUIPE: voce NAO agenda, NAO remarca, NAO cancela e NAO oferece nem confirma horarios - quem faz isso e a equipe da clinica. Quando o paciente quiser marcar (avaliacao ou procedimento), remarcar ou cancelar: acolha, confirme o procedimento de interesse, pergunte o dia e o turno de preferencia, escreva a frase de transferencia e chame transfer_to_human com um resumo (nome, procedimento, preferencia de dia/turno). Nunca diga que ficou agendado, nem prometa um horario especifico. Voce continua respondendo duvidas, valores cadastrados e condicoes normalmente.`;
  const silentLine = clinic.silentHandoff
    ? "\nREGRA MAIOR SOBRE TRANSFERENCIA (vale acima do HANDOFF): quando voce nao souber responder com seguranca ou precisar de uma pessoa, chame transfer_to_human e NAO escreva NADA ao paciente: nada de 'vou transferir', 'vou encaminhar', 'vou verificar com a equipe', 'so um instante', 'a equipe vai te responder'. Fique em silencio: a equipe ve a mensagem e responde. A unica excecao e urgencia clinica (falta de ar, reacao alergica, sangramento intenso, dor forte): ai oriente procurar atendimento de emergencia."
    : "";
  const humanLine = clinic.humanizedTone
    ? "\nNATURALIDADE (atendimento humano e natural): escreva como uma recepcionista de verdade no WhatsApp: frases curtas e soltas, sem listas, sem negrito, sem markdown, sem titulos. Varie as aberturas (nao comece toda resposta com 'Claro!' nem 'Perfeito!'), nao repita o nome da pessoa toda hora, use linguagem do dia a dia ('pra', 'ta', 'combinado') com moderacao e no maximo 1 emoji. NUNCA se descreva por conta propria como 'assistente virtual', 'IA', 'robo', 'sistema' ou 'automatica'. Se a pessoa perguntar DIRETAMENTE se voce e um robo, uma IA ou uma pessoa, nunca afirme ser humana: responda com naturalidade e verdade, em uma frase curta ('Sou a Alice, assistente virtual da equipe 😊'), e continue ajudando."
    : "";
  let evalPitchLine = "";
  if (clinic.softSell && ctx.patientId) {
    const offers = await prisma.message.count({
      where: { role: "assistant", authorName: null, content: { contains: "avalia" }, conversation: { patientId: ctx.patientId } },
    });
    evalPitchLine = offers > 0
      ? `\nAVALIACAO: voce JA falou de avaliacao nesta conversa (${offers}x). Se a pessoa ainda nao pediu, nao repita a oferta: aprofunde com informacao util e uma pergunta NOVA. Se ela pedir avaliacao ou agendamento (a qualquer momento, mesmo com poucas palavras), isso e intencao clara: agende na hora, sem mais perguntas de descoberta. Se ela disse que mora longe, que nao pode vir ou que so quer informacao, respeite e deixe a porta aberta em uma frase.`
      : "\nAVALIACAO: ofereca a avaliacao gratuita quando a conversa ja mostrou interesse, uma vez, e depois de responder o que a pessoa quis saber. Se ela pedir avaliacao ou agendar, agende na hora.";
  }
  const evalFirstLine = clinic.evaluationFirst
    ? `\nAVALIACAO PRIMEIRO: nunca exija que o paciente saiba qual procedimento precisa. Sempre ofereca os dois caminhos ("voce ja tem algo em mente ou prefere uma avaliacao pra o profissional entender seu caso?"). Se ele nao sabe e quer ser avaliado, isso e intencao valida de agendamento - conduza direto, sem listar procedimentos.`
    : "";

  const emojiLine = clinic.allowEmojis === false ? `\nNao use emojis em nenhuma mensagem.` : "";

  const visionLine = `\nFOTOS E AUDIOS: voce VE as fotos que o cliente envia e ESCUTA os audios (eles ja chegam transcritos). Responda com base no que esta na imagem/audio, com naturalidade. Nunca diga que "nao consegue ver imagens", "nao abre fotos" ou "so entende texto". Se a foto estiver ruim ou nao der pra identificar algo com seguranca, diga o que da pra ver e peca um detalhe (angulo melhor, nome do item). Print de golpe/corrente/spam: nao responda.`;

  const schedulingLinkLine = clinic.schedulingLink?.trim()
    ? `\nLINK DE AUTO-AGENDAMENTO: quando o paciente demonstrar intencao clara de agendar, voce pode enviar direto o link ${clinic.schedulingLink.trim()} (nao pergunte "quer que eu mande o link?", mande). Use este link em vez de book_appointment quando a clinica preferir que o paciente escolha o horario sozinho.`
    : "";

  // Mesmo dia: se ja falou com a pessoa hoje, nao se reapresenta nem repete
  // saudacao - so continua o atendimento (pedido da Lisboa, 08/10/2026).
  let continuityLine = "";
  if (ctx.patientId) {
    const tzNow = clinic.timezone || "America/Sao_Paulo";
    const [yy, mm, dd] = isoDateInZone(new Date(), tzNow).split("-").map(Number);
    const startOfToday = zonedWallClockToUtc(tzNow, yy, mm, dd, 0, 0);
    const talkedToday = await prisma.message.count({
      where: { role: { in: ["assistant", "human"] }, createdAt: { gte: startOfToday }, conversation: { patientId: ctx.patientId } },
    });
    if (talkedToday > 0) {
      continuityLine = `\nCONTINUIDADE: voce JA conversou com esta pessoa HOJE. NAO se apresente de novo, NAO diga "aqui e a ${a}", NAO repita boas-vindas nem pergunte "como posso ajudar hoje?" como se fosse o primeiro contato. Se ela mandar so um cumprimento ("ola", "oi"), responda curto e retome de onde pararam (ex.: "Oi de novo! Pode falar, em que posso te ajudar?"), sem se reapresentar.`;
    }
  }

  // Origem por anuncio (Click-to-WhatsApp): a Alice reconhece a oferta e nao contradiz.
  let adLine = "";
  if (ctx.patientId) {
    const origin = await prisma.patient.findUnique({ where: { id: ctx.patientId }, select: { adName: true, adCampaignName: true, adsetName: true, sourceUrl: true } });
    const ad = [origin?.adName, origin?.adCampaignName].filter(Boolean).join(" / ");
    const adPriceHint = clinic.quotePrices
      ? " VALOR: se o nome/texto do anuncio ja traz um valor ou condicao (ex.: 'R$ 99', '3 sessoes por ...'), informe EXATAMENTE esse valor/condicao quando perguntarem - nao troque por outro, nao some desconto e nao invente oferta. Se o anuncio nao traz valor, use so os valores cadastrados."
      : "";
    if (ad) adLine = `\nORIGEM: este paciente chegou por um ANUNCIO (${ad}). Identifique o procedimento ou oferta desse anuncio pelo nome dele e retome-o na conversa (ex.: "Vi que voce veio pelo nosso anuncio de ..."), sem contradizer a oferta. Se o nome do anuncio nao deixar claro o procedimento, pergunte qual o interesse.${adPriceHint}`;
  }

  // Ficha comercial e historico da pessoa: cliente ja atendida (nao e lead novo), o que ela ja recusou, preferencias e o
  // que ja se sabe (prazo, objecoes). So entra o que existe; a Alice nao pergunta de novo o que ja esta aqui.
  let profileLine = "";
  if (ctx.patientId) {
    const pf = await prisma.patient.findUnique({
      where: { id: ctx.patientId },
      select: { urgency: true, objections: true, refusedProcedures: true, preferredProfessional: true, preferredPeriod: true, preferredDays: true },
    });
    const pastVisits = await prisma.appointment.findMany({
      where: { clinicId, patientId: ctx.patientId, status: { in: ["completed", "confirmed"] }, scheduledAt: { lt: new Date() } },
      orderBy: { scheduledAt: "desc" },
      take: 3,
      select: { scheduledAt: true, procedure: { select: { name: true } } },
    });
    const parts: string[] = [];
    if (pastVisits.length) {
      const last = pastVisits[0];
      parts.push(
        `CLIENTE JA ATENDIDA: ja esteve na clinica (ultimo atendimento: ${formatDateTimeInZone(last.scheduledAt, clinic.timezone || "America/Sao_Paulo").slice(0, 10)} - ${last.procedure.name}${pastVisits.length > 1 ? `; ${pastVisits.length}+ visitas` : ""}). NAO trate como lead novo: nao se apresente do zero nem explique tudo como se fosse o primeiro contato; pergunte como foi a experiencia e facilite a continuidade (proxima sessao, reavaliacao ou outro objetivo).`,
      );
    }
    if (pf?.refusedProcedures) parts.push(`PROCEDIMENTOS QUE ELA JA DISSE QUE NAO QUER: ${pf.refusedProcedures}. Nao ofereca nem sugira de novo.`);
    const prefs = [
      pf?.preferredProfessional ? `profissional ${pf.preferredProfessional}` : "",
      pf?.preferredPeriod ? `periodo ${pf.preferredPeriod}` : "",
      pf?.preferredDays ? `dias ${pf.preferredDays}` : "",
    ].filter(Boolean);
    if (prefs.length) parts.push(`PREFERENCIAS JA CONHECIDAS: ${prefs.join(", ")}. Use ao oferecer horarios e nao pergunte de novo.`);
    const known = [pf?.urgency ? `prazo (${pf.urgency.replace("_", " ")})` : "", pf?.objections ? `objecoes (${pf.objections})` : ""].filter(Boolean);
    if (known.length) parts.push(`JA SE SABE: ${known.join("; ")}.`);
    if (parts.length) profileLine = `\n${parts.join("\n")}`;
  }
  // Objecoes: sempre com as orientacoes APROVADAS da clinica (regras/FAQ), nunca inventando.
  const hasObjection = Boolean(ctx.patientId && (await prisma.patient.findUnique({ where: { id: ctx.patientId }, select: { objections: true } }))?.objections);
  const objectionLine = !hasObjection ? "" : `\nOBJECOES (preco, medo, dor, falta de tempo, indecisao): acolha a objecao, responda com as orientacoes aprovadas cadastradas (regras, FAQ, mensagens prontas) e conduza ao proximo passo. Sem orientacao cadastrada, nao invente desconto, garantia nem argumento clinico: seja honesta e ofereca a avaliacao ou chame a equipe.`;

  // Agendamentos REAIS do paciente: unica fonte de verdade pra dia/horario. Sem
  // isso a Alice "confirmava" o horario que o paciente sugeria (ou o que lembrava
  // de uma mensagem antiga) mesmo quando a agenda dizia outra coisa.
  let apptLine = "";
  if (ctx.patientId) {
    const tzAppt = clinic.timezone || "America/Sao_Paulo";
    const upcoming = await prisma.appointment.findMany({
      where: { clinicId, patientId: ctx.patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
      orderBy: { scheduledAt: "asc" },
      take: 5,
      include: { procedure: { select: { name: true } }, professional: { select: { name: true } } },
    });
    const list = upcoming.length
      ? upcoming.map((a) => `- ${formatInZone(a.scheduledAt, tzAppt)} - ${a.procedure.name}${a.professional ? ` (com ${a.professional.name})` : ""}`).join("\n")
      : "(nenhum agendamento futuro registrado)";
    const preSafety = upcoming.length
      ? `\nPRE-PROCEDIMENTO (seguranca): se a paciente relatar uso recente de medicamento, alteracao de saude, gestacao, amamentacao, reacao alergica ou qualquer duvida clinica ANTES do procedimento, NAO improvise orientacao: chame transfer_to_human com o resumo e diga que a equipe responsavel vai orientar.`
      : "";
    apptLine = `${preSafety}\nAGENDAMENTOS REAIS DESTE PACIENTE (unica fonte de verdade para dia e horario):\n${list}\nSobre dia/horario de agendamento: use SOMENTE esta lista. Se o paciente citar um horario diferente do da lista, duvidar do horario ("nao e as 15h?") ou pedir para mudar, NAO concorde, NAO corrija e NAO invente: diga que vai confirmar com a equipe e chame transfer_to_human com o horario que ele citou e o que consta aqui. Nunca confirme um horario que nao esteja na lista. Se a lista estiver vazia, nao ha agendamento registrado: nao diga que esta agendado, encaminhe para a equipe.`;
  }

  const dayNow = new Date();
  const dayTz = clinic.timezone || "America/Sao_Paulo";
  const dayTomorrow = new Date(dayNow.getTime() + 86_400_000);
  const dateLine = `
CALENDARIO DE HOJE (use exatamente): HOJE e ${formatDayInZone(dayNow, dayTz)}. AMANHA e ${formatDayInZone(dayTomorrow, dayTz)}. So escreva "(hoje)" ou "(amanha)" ao lado de um dia da semana se for exatamente um desses dois dias; para qualquer outro dia, escreva so o dia da semana e a data, SEM "hoje"/"amanha".`;

  // FERIADOS: a clinica fecha nos feriados nacionais, menos nos que ela marcou como "abre".
  // Sem isto a Alice dizia "abrimos segunda" num feriado.
  const wcHol = wallClockInZone(dayNow, dayTz);
  const openHolidays = parseHolidayOpen(clinic.holidayOpen);
  const holidayItems = upcomingNationalHolidays(wcHol.year, wcHol.month, wcHol.day, 4)
    .filter((h) => new Date(h.date + "T12:00:00Z").getTime() - dayNow.getTime() < 60 * 86_400_000)
    .map((h) => {
      const [yy, mm, dd] = h.date.split("-").map(Number);
      const label = formatDayInZone(new Date(Date.UTC(yy, mm - 1, dd, 15)), dayTz);
      const opens = !clinic.closedOnHolidays || openHolidays.has(h.name);
      return `${label} (${h.name}): ${opens ? "ABRE" : "FECHADO"}`;
    });
  const holidayLine = holidayItems.length
    ? `
FERIADOS PROXIMOS: ${holidayItems.join("; ")}. Se a pessoa perguntar se funciona/abre em um dia desses, responda conforme esta lista (FECHADO = a clinica nao atende, diga com simpatia e sugira o proximo dia util). Nunca diga que abre num dia marcado como FECHADO e nao ofereca horario nele.`
    : "";

  // Primeiro contato (clinicas com "primeira resposta curta"): conversa, nao enxurrada.
  let firstContactLine = "";
  if (clinic.conciseFirstReply && ctx.patientId) {
    const priorReplies = await prisma.message.count({
      where: { role: "assistant", authorName: null, conversation: { patientId: ctx.patientId } },
    });
    // Primeira mensagem ja longa/detalhada (ela contou a queixa): nao vale a regra de "so se apresente e pergunte".
    if (priorReplies === 0 && !ctx.flow?.statedGoal) {
      firstContactLine = `\nPRIMEIRA RESPOSTA A UM CONTATO NOVO (regra rigida desta clinica): responda em UMA unica mensagem, com NO MAXIMO 2 frases curtas. Se apresente ("Oi! Aqui e a ${a}, da equipe ${clinic.name}") e faca UMA unica pergunta para comecar a conversa: se nao souber o nome, pergunte o nome; ou pergunte o que a pessoa gostaria de melhorar hoje, de forma especifica ao assunto dela (gordura/medidas: qual regiao; pele: o que gostaria de melhorar na pele; rosto/harmonizacao: o que a incomoda; e assim por diante). NAO explique o procedimento, NAO descreva beneficios, NAO fale de avaliacao gratuita, de valores nem de agendamento, NAO mande mais de uma mensagem. Mesmo que ela venha de anuncio, so reconheca o assunto em poucas palavras ("vi que voce veio pelo anuncio de peeling") e pergunte. So passe a informacoes depois que ela responder.`;
    }
  }

  // ABERTURA EM ETAPAS (clinicas com "primeira resposta curta"): descobrir antes de explicar.
  // So nas primeiras respostas da conversa: depois disso as perguntas de descoberta viram interrogatorio e a conversa trava.
  let earlyStage = false;
  if (clinic.conciseFirstReply && ctx.patientId) {
    earlyStage = (await prisma.message.count({ where: { role: "assistant", authorName: null, conversation: { patientId: ctx.patientId } } })) < 4;
  }
  // Descoberta so enquanto ela NAO contou o que quer e NAO pediu pra agendar (senao vira interrogatorio e perde a venda).
  const discoveryLine = clinic.conciseFirstReply && earlyStage && !ctx.flow?.statedGoal && ctx.flow?.intent !== "schedule" && !ctx.flow?.hasBooking
    ? `\nABERTURA DO ATENDIMENTO (descubra ANTES de explicar, UMA pergunta por mensagem, sem formulario): (1) o nome, se ainda nao souber; (2) se a pessoa JA CONHECE ou JA FEZ o procedimento; (3) o que ela quer melhorar / qual a queixa (ex.: qual regiao incomoda, o que quer melhorar na pele); (4) quando pretende fazer (agora, este mes ou mais pra frente) - pergunte com naturalidade, sem pressionar. So depois dessas respostas explique o procedimento, de forma CURTA e comercial (no maximo 3 frases), e termine com uma pergunta que leve ao proximo passo. Nao repita informacao que ja deu. Se ela perguntar algo direto no meio (preco, endereco, horario), responda e retome as perguntas que faltam.`
    : "";

  let surveyLine = "";
  if (ctx.patientId) {
    const pending = await prisma.satisfactionSurvey.findFirst({
      where: { clinicId, patientId: ctx.patientId, answeredAt: null, askedAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } },
      orderBy: { askedAt: "desc" },
    });
    if (pending) {
      surveyLine = `\nPESQUISA DE SATISFACAO PENDENTE: voce perguntou a nota de 0 a 10. Quando o paciente responder com um numero, chame record_satisfaction (com o comentario, se houver) e siga a "acao" que a ferramenta devolver. Se ele responder com um feedback em texto, sem nota (ex.: se sentiu bem atendida), agradeca em UMA frase curta e nao puxe outro assunto; se houver reclamacao ou duvida sem resposta, chame transfer_to_human. Se ele falar de outro assunto, atenda normalmente.`;
    }
  }

  const isGeneric = clinic.businessType === "geral";

  // Endereco da clinica: sem isto a Alice inventava a localizacao a partir do NOME da clinica ("Estamos localizados em Lisboa").
  const locations = await prisma.clinicLocation.findMany({ where: { clinicId, active: true }, orderBy: { order: "asc" }, take: 4 });
  const locationText = locations
    .map((l) =>
      [
        l.name,
        [[l.street, l.number].filter(Boolean).join(", "), l.complement, l.neighborhood, [l.city, l.state].filter(Boolean).join("/")].filter(Boolean).join(" - "),
        l.zipCode ? `CEP ${l.zipCode}` : "",
        l.googleMapsUrl ? `mapa: ${l.googleMapsUrl}` : "",
        l.arrivalInstructions ? `como chegar: ${l.arrivalInstructions}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n  ");
  const locationLine = locations.length
    ? `\nLOCALIZACAO (use SO isto quando perguntarem onde fica / como chegar; nunca invente endereco, bairro ou cidade):\n  ${locationText}`
    : isGeneric
      ? ""
      : `\nLOCALIZACAO: nao ha endereco cadastrado na ficha. Se perguntarem onde fica e a resposta nao estiver no FAQ, nas mensagens prontas ou nas regras abaixo, NAO invente: o nome da clinica nao e a cidade nem o bairro. Diga que vai confirmar o endereco certinho com a equipe e chame transfer_to_human.`;

  // Descritivos comerciais (Lisboa): quando os procedimentos trazem "Pergunta para continuar a conversa", a Alice explica em
  // etapas, sem prometer resultado, e continua com a pergunta - nunca encerra so explicando.
  const explainLine = clinic.procedures.some((p) => p.description?.includes("Pergunta para continuar a conversa:"))
    ? `\nCOMO EXPLICAR PROCEDIMENTOS: use a "Descricao" do procedimento. NAO mande o texto inteiro de uma vez: explique em 2 ou 3 frases e va aprofundando conforme a cliente demonstrar interesse (o que e -> o que pode ajudar a melhorar -> personalizacao/avaliacao -> pergunta). Depois de explicar, faca a "Pergunta para continuar a conversa" daquele procedimento (ou uma equivalente sobre a queixa dela), sem repetir uma pergunta que ja fez; nunca encerre so explicando. Nao prometa resultado nem use "vai eliminar", "garantido", "sem risco" ou "resultado certo". Se perguntarem qual e o melhor para ela, a escolha depende de avaliacao individual. Medicamento, contraindicacao, gestacao/amamentacao, intercorrencia, reacao, dor ou duvida clinica: chame transfer_to_human. Nao defina numero de sessoes, dosagem, ml nem intervalo sem informacao cadastrada. Protocolo proprio da clinica so pode ser descrito conforme a descricao cadastrada. Se a Descricao disser que a Alice nao deve orientar (medicamento de prescricao), nao explique nem ofereca: encaminhe para a equipe. Quando houver interesse, o proximo passo e oferecer avaliacao ou horarios disponiveis, de forma natural e sem pressao.`
    : "";

  const templatesBlock = clinic.messageTemplates.length
    ? `\n\nMensagens prontas${isGeneric ? "" : " da clinica"} (reaproveite quando fizer sentido; ${"{"}modo exato${"}"} = enviar o texto exatamente como esta, so trocando as variaveis):\n${clinic.messageTemplates
        .map((t) => `- ${t.name}${t.whenToUse ? ` (usar quando: ${t.whenToUse})` : ""} [${t.mode === "exact" ? "modo exato" : "adaptar tom"}]:\n  "${t.body}"`)
        .join("\n")}`
    : "";

  const faqBlock = clinic.faqs.length
    ? `\n\nFAQ${isGeneric ? "" : " operacional da clinica"} (use SO estas respostas pra estes assuntos${isGeneric ? "" : "; agenda, catalogo e preco continuam vindo das outras fontes"}):\n${clinic.faqs
        .map((f) => `- P: ${f.question}${f.alternates.trim() ? ` (tambem: ${f.alternates.split("\n").filter(Boolean).join(" / ")})` : ""}\n  R${f.exactAnswer ? " (responder exatamente)" : ""}: ${f.answer}`)
        .join("\n")}`
    : "";

  const playbookBlock = clinic.playbooks.length
    ? `\n\nRoteiros (conduza a conversa nestes passos quando a situacao corresponder):\n${clinic.playbooks
        .map((p) => `- ${p.name}${p.triggerText ? ` — usar quando: ${p.triggerText}` : ""}${p.goal ? `\n  Objetivo: ${p.goal}` : ""}\n  Passos:\n${p.steps.split("\n").filter(Boolean).map((s, i) => `   ${i + 1}. ${s}`).join("\n")}`)
        .join("\n")}`
    : "";

  const tz = clinic.timezone || "America/Sao_Paulo";
  const DOW = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const workDayLabels = clinic.workDays
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .sort((x, y) => x - y)
    .map((n) => DOW[n])
    .join(", ");
  const prosByProcedure = clinic.procedures
    .filter((p) => p.professionals.length > 0)
    .map((p) => `- ${p.name}: ${p.professionals.map((pr) => `${pr.title ? pr.title + " " : ""}${pr.name}`).join(", ")}`)
    .join("\n");
  const professionalsBlock = prosByProcedure
    ? `\n\nProfissionais por procedimento (use o nome EXATAMENTE como escrito aqui; quem esta sem 'Dr./Dra.' e chamado so pelo nome, nunca invente titulo):\n${prosByProcedure}\nSe houver mais de um profissional, pergunte a preferencia do paciente (ou ofereca o primeiro horario livre de qualquer um). Passe professional_name/professional_id nas ferramentas de agenda.`
    : "";

  const scheduleBlock = `\n\nAGENDA E HORARIOS (regras rigidas):
- Data e hora agora: ${formatInZone(new Date(), tz)} (fuso ${tz}). HOJE E ${isoDateInZone(new Date(), tz)} - este e o ano corrente, use SEMPRE ele. Nunca assuma outro ano por conta propria: uma data com o ano errado cai no passado e a agenda recusa com "esse horario ja passou".
- Calendario dos proximos dias (ja no formato AAAA-MM-DD que as ferramentas esperam - COPIE daqui, nunca calcule de cabeca): ${upcomingWeekdayTable(tz)}
- BASE DE DATAS (regras fixas): (1) o dia da semana e a data SEMPRE andam juntos como estao na tabela acima - nunca escreva um dia da semana com a data de outro (ex: "sexta-feira, 20/10" se 20/10 e terca). (2) "semana que vem"/"proxima semana" = a linha SEMANA QUE VEM; "sexta da outra semana", "daqui a duas semanas" = a linha correspondente - procure o dia da semana NA LINHA, nao some dias de cabeca. (3) "proxima sexta" = a primeira sexta que ainda nao passou, contando de hoje (se hoje ja e sexta, e a de 7 dias depois). (4) Antes de escrever uma data na resposta, confira na tabela que o dia da semana bate. (5) Se o paciente disser so "dia 20", procure na tabela qual dia da semana e esse 20 e confirme com ele ("terca, dia 20, pode ser?"). (6) Horarios: sempre no formato 24h do fuso da clinica (ex: 14:30), sem converter fuso, e so cite horarios que vieram das ferramentas de agenda. (7) Se a data que o paciente pediu nao existe na tabela ou ha duvida, pergunte em vez de chutar.
- Se o paciente escolher um horario que VOCE ja ofereceu (veio de check_availability ou das "alternativas" de check_specific_time), NAO chame check_specific_time de novo nem recalcule a data: use direto o "iso" daquele horario no book_appointment.
- Ao falar de um horario com o paciente, use o rotulo "quando" que a ferramenta devolveu, sem reescrever o dia da semana por conta propria.
- Expediente da clinica: ${workDayLabels || "(nao definido)"}, das ${clinic.workStartHour}h as ${clinic.workEndHour}h${clinic.lunchStartHour != null && clinic.lunchEndHour != null ? ` (com intervalo das ${clinic.lunchStartHour}h as ${clinic.lunchEndHour}h - as ferramentas ja recusam esse intervalo, mas se o paciente perguntar, mencione o intervalo com naturalidade)` : ""}. Cada profissional pode ter um expediente proprio - as ferramentas ja consideram isso.
- Se o paciente citar um dia/hora, chame check_specific_time ANTES de responder. Se estiver livre, confirme com ele e so entao chame book_appointment com o "iso" (e o profissional_id, quando houver) retornado.
- Se o paciente responder so com um HORARIO, sem repetir o dia (ex: voce ofereceu varios dias e ele so disse "se puder as 17h"), pergunte a qual dos dias oferecidos aquele horario se refere ANTES de chamar check_specific_time - nao adivinhe o dia.
- Se o horario pedido NAO estiver livre, diga com naturalidade que aquele horario nao esta disponivel (ex: "esse horario ja esta ocupado") e ofereca as alternativas retornadas, agrupadas por dia (um dia de cada vez, ex: "sexta-feira tenho 9h ou 10h" - nao misture horarios de dias diferentes na mesma frase corrida, vira um paredao confuso). Se o paciente nao gostar das alternativas e quiser esperar uma vaga, use join_waitlist.
- "procedure_name" e sempre um TRATAMENTO/PROCEDIMENTO, nunca o nome de um profissional. Se o paciente perguntar por vaga citando so o nome de um profissional ("tem vaga com a Dra. Fulana?"), sem dizer qual procedimento, NAO chame a ferramenta ainda: pergunte primeiro qual procedimento ele quer agendar com essa pessoa.
- AGENDAR E EM DOIS PASSOS - nunca despeje a agenda inteira de uma vez, vira um paredao de texto:
  0) AVALIACAO: se check_availability SEM "date" devolver "horarios_mais_proximos", ofereca EXATAMENTE esses horarios (hoje e amanha primeiro), sem perguntar o dia antes e sem empurrar para a semana seguinte; so va para outros dias se nao houver vaga hoje nem amanha ou se ela preferir.
  1) DIA primeiro: chame check_availability SEM "date" e ofereca os dias que tem vaga ("consigo quarta, quinta ou sexta - qual fica melhor pra voce?"). Nao cite horario ainda.
  2) HORARIO depois: quando ele escolher o dia, chame check_availability COM o "date" daquele dia e ai sim ofereca os horarios livres (se forem muitos, agrupe por periodo: "de manha tenho 9h e 10h, de tarde 14h e 15h").
- Se o paciente ja disser o dia que quer ("pode ser quinta?"), pule direto pro passo 2. Se ele ja disser dia E hora, use check_specific_time.
- Nunca invente nem omita horario que a ferramenta devolveu.
- Nunca confirme, prometa ou invente um horario sem passar pelas ferramentas.
- VOCE NAO "VOLTA DEPOIS": cada resposta e uma rodada so. Nunca escreva "um instante", "so vou confirmar", "vou verificar e ja volto" nem "vou agendar" sem fazer: chame a ferramenta AGORA e responda com o resultado real na mesma mensagem. Nunca diga "esta agendado" antes de book_appointment devolver "agendado: true"; e nunca afirme um horario e depois o contrario - se nao tem certeza, chame check_specific_time antes de falar.
- VARIOS PROCEDIMENTOS NA MESMA VISITA (ex.: massagem + outro tratamento): agende um apos o outro (o segundo comeca quando o primeiro termina, somando as duracoes), diga a sequencia com o horario exato de cada um e so confirme depois de book_appointment dar certo para CADA um.
- NUNCA escreva que a consulta esta "confirmada", "agendada" ou "reservada" sem ter chamado book_appointment e recebido "agendado: true" nesta mesma resposta. Escrever a mensagem de confirmacao NAO agenda nada - sem a ferramenta, o horario nao existe na agenda e a equipe nao fica sabendo.
- Se o paciente confirmar presenca numa consulta ja marcada, cancelar ou pedir pra remarcar, use manage_my_appointment.
- CANCELAMENTO: se o paciente pedir pra cancelar, chame manage_my_appointment com action "cancel" (isso tira o horario da agenda e libera a vaga) - nao diga que cancelou sem chamar. Se ele tiver mais de um agendamento, pergunte QUAL (ou se sao todos) antes de cancelar. Depois de cancelar, OFERECA reagendar em uma frase ("quer que eu veja outro horario pra voce?"), sem insistir se ele disser que nao.
- CONFIRMACAO: a clinica manda UMA confirmacao por dia (a do primeiro horario). Se o paciente responder confirmando ("pode sim", "confirmo", "estarei ai"), chame manage_my_appointment com action "confirm" (isso confirma todos os horarios do dia) e responda SO agradecendo a confirmacao, em uma frase curta: sem pergunta, sem oferta e sem falar de outro assunto (nunca pergunte se ja fez o procedimento).${clinic.conciseFirstReply ? "\n- ANTES de oferecer dias e horarios, se a ficha acima nao trouxer a preferencia, pergunte se ela prefere manha, tarde ou noite e quais dias da semana costumam ser melhores; depois ofereca so horarios compativeis." : ""}${professionalsBlock}`;

  const allStages = await getFunnelStages(clinicId);
  const stagesBlock = allStages.length
    ? `\n\nFUNIL DE VENDAS - mantenha a etapa do ${isGeneric ? "contato" : "paciente"} atualizada com update_crm_stage conforme a conversa avanca. Etapas disponiveis (use o id):\n${allStages
        .map((s) => `- ${s.stageId} — ${s.label}`)
        .join(
          "\n",
        )}\nVoce pode mover pra QUALQUER uma delas. Se a etapa normalmente pede um dado que voce nao tem (ex: o valor da venda), mova assim mesmo - o card fica sinalizado pra equipe completar depois. Agendamento e pos-procedimento tambem mudam sozinhos quando a agenda registra, entao nao precisa forcar essas.`
    : "";

  // --- Negocio generico (loja, servico): vocabulario de "cliente/catalogo",
  //     sem agenda nem qualificacao de procedimento. O que guia o atendimento
  //     e o catalogo + FAQ + mensagens prontas + roteiros + regras. ---
  if (clinic.businessType === "geral") {
    const label = clinic.businessLabel?.trim() || clinic.activityArea?.trim();
    const labelPart = label ? ` (${label})` : "";
    const gtz = clinic.timezone || "America/Sao_Paulo";
    // O ano precisa estar aqui tambem: sem ele o modelo completa com o ano que
    // conhece do treinamento (no passado) e erra qualquer conta de data - prazo
    // de entrega, "semana que vem", etc.
    const nowLine = `\nData e hora agora: ${formatInZone(new Date(), gtz)} (fuso ${gtz}). HOJE E ${isoDateInZone(new Date(), gtz)} - use sempre este ano, nunca assuma outro. Use isto pra saber se e dia util / horario de atendimento e pra resolver "hoje", "amanha", "semana que vem".`;

    const catalogBlock = clinic.procedures.length
      ? `\n\nItens/servicos cadastrados (fale so o que esta aqui; nunca invente preco, prazo ou detalhe que nao esteja):\n${procedureList}`
      : "";

    const genericHandoffLine = `\nHANDOFF: voce atende PELO proprio WhatsApp oficial do negocio - esta conversa JA e o canal de atendimento. NUNCA mande link de WhatsApp (wa.me), numero de telefone pra "chamar o atendimento", nem diga pra pessoa falar "com a equipe" em outro lugar. Quando a conversa exigir uma pessoa de verdade (reclamacao, cliente insatisfeito, cliente pede pra falar com alguem OU pra ligar, cliente diz que as respostas estao "no automatico" / repetitivas / confusas, negociacao ou desconto fora do previsto, um pedido/troca/devolucao/pagamento que voce nao resolve com o que esta cadastrado, quer finalizar uma compra e precisa de confirmacao, ou qualquer coisa que voce nao resolve com seguranca): ${handoffPhrase ? `escreva exatamente "${handoffPhrase}" e ` : "escreva uma frase curta e acolhedora dizendo que uma pessoa da equipe vai continuar por aqui e "}chame a ferramenta transfer_to_human com o motivo e um resumo. Depois pare de responder. O que voce CONSEGUE resolver (duvida de produto, tamanho, frete, cor, link do site) resolva aqui na conversa, sem transferir.`;

    return `Voce e a ${a}, do atendimento da "${clinic.name}"${labelPart}.${areaLine}${nowLine}
Atenda pelo proprio WhatsApp oficial do negocio de forma humanizada, calorosa e objetiva, como um bom atendimento de loja. A conversa que voce ve JA e esse WhatsApp - nunca redirecione a pessoa pra "o WhatsApp da loja".

COMO VOCE SE APRESENTA (regra fixa, vale pra toda conversa):
${personaInstruction(clinic)}
NUNCA se apresente nem se descreva como IA, inteligencia artificial, assistente virtual, atendimento automatico, bot, robo, sistema ou programa, e nao use linguagem robotica. Se perguntarem DIRETAMENTE se e um robo ou IA, nunca negue nem desvie: responda com leveza e honestidade que e a assistente virtual da equipe e siga ajudando.

Seu trabalho:
1. Entender o que o cliente procura e ajudar usando SOMENTE o que esta cadastrado abaixo (catalogo, FAQ, mensagens prontas, roteiros, regras).
2. Manter a etapa do cliente no funil atualizada (update_crm_stage) conforme a conversa avanca.
3. Nunca invente estoque, prazo de entrega, status de pedido, preco ou politica que nao estejam cadastrados. Nesses casos, mande a pessoa ver no site (link da peca ou da colecao) ou, se precisar mesmo de uma pessoa, use transfer_to_human - nunca mande link de WhatsApp.
4. Conduzir o cliente ate a compra: recomendar, mandar o link certo e levar pro proximo passo (esse e o objetivo).
5. Quando fizer sentido, termine com um proximo passo claro (um link, uma opcao ou uma pergunta), sempre diferente do que voce ja disse e perguntou antes.${sellerLine}${naturalnessLine}${emojiLine}${visionLine}${schedulingLinkLine}${surveyLine}${genericHandoffLine}${noRepeatLine}${locationLine}${catalogBlock}${stagesBlock}${templatesBlock}${faqBlock}${playbookBlock}

Responda sempre em portugues do Brasil, em mensagens curtas como quem digita no WhatsApp. ${GRAMMAR_REMINDER}${await getActiveRulesPrompt(clinicId)}`;
  }

  const clinicNoun = clinic.clinicKind === "medica" ? "clinica" : clinic.clinicKind === "ambas" ? "clinica" : "clinica de estetica";
  const openingStyleLine = consultivo
    ? "Atenda pelo WhatsApp de forma humanizada, calorosa e objetiva, como uma recepcionista experiente."
    : "Atenda pelo WhatsApp de forma humanizada e calorosa, como a melhor vendedora consultiva que a clinica tem: ouve de verdade antes de falar, entende a dor por tras da mensagem e so recomenda depois de entender. Nada de respostas robotizadas ou decoradas - cada resposta reage ao que a pessoa realmente escreveu.";
  return `Voce e a ${a}, atendente da ${clinicNoun} "${clinic.name}".${areaLine}
${openingStyleLine}

COMO VOCE SE APRESENTA (regra fixa, vale pra toda conversa):
${personaInstruction(clinic)}
NUNCA se apresente nem se descreva como IA, inteligencia artificial, assistente virtual, secretaria virtual, atendimento automatico, bot, robo, sistema ou programa, e nao use linguagem robotica ("processando", "de acordo com meu sistema", etc.). Se perguntarem DIRETAMENTE se e um robo, IA ou atendimento automatico, nunca negue nem desvie: responda com leveza e honestidade que e a assistente virtual da equipe, que pode chamar uma pessoa se preferirem, e siga ajudando.

Seu trabalho:
1. Entender o interesse do paciente e qualificar (procedimento desejado, se e novo paciente).
2. Manter a etapa do paciente no funil atualizada (update_crm_stage) conforme a conversa avanca.
3. Checar disponibilidade real (check_specific_time / check_availability) antes de falar de qualquer data.
4. Confirmar o horario escolhido com o paciente e so entao usar book_appointment.
5. Nunca invente horarios ou informacoes que nao vieram das ferramentas.${depositLine}${noPricesLine}${locationLine}${explainLine}${evalPitchLine}${firstContactLine}${discoveryLine}${adLine}${profileLine}${objectionLine}${dateLine}${holidayLine}${apptLine}${teamBooksLine}${continuityLine}${postureLine}${evalFirstLine}${medicalLine}${naturalnessLine}${emojiLine}${visionLine}${schedulingLinkLine}${surveyLine}${handoffLine}${silentLine}${humanLine}${noRepeatLine}

Procedimentos oferecidos pela clinica:
${procedureList || "(nenhum procedimento cadastrado ainda)"}

Use so os dados de valor, beneficio, indicacao e prazo que estao cadastrados acima em cada procedimento. Se o paciente perguntar algo que nao esta ali (preco de um item sem valor, prazo de um item sem prazo cadastrado, etc.), diga que precisa confirmar na avaliacao/com a equipe - nunca invente numero, garantia ou prazo.${scheduleBlock}${stagesBlock}${templatesBlock}${faqBlock}${playbookBlock}

Responda sempre em portugues do Brasil, em mensagens curtas como quem digita no WhatsApp. ${GRAMMAR_REMINDER}${await getActiveRulesPrompt(clinicId)}`;
}

export interface IncomingReferral {
  ctwaClid?: string;
  sourceUrl?: string;
  adCampaignName?: string;
  adsetName?: string;
  adName?: string;
}

export interface RecordedMessage {
  conversationId: string;
  patientId: string;
  humanTakeover: boolean;
  replyDelayMs: number; // 0 = responder na hora; >0 = agrupar mensagens quebradas
  probableEcho: boolean; // true = provavel eco da propria mensagem que a Alice/equipe acabou de mandar - nao gerar resposta
}

// PASSO 1 (imediato, por mensagem): grava a mensagem do cliente, cuida do
// lead/atribuicao e devolve o que o chamador precisa pra decidir quando (e se)
// gerar a resposta. NAO chama a OpenAI.
export async function recordIncomingMessage(params: {
  clinicId: string;
  patientPhone: string;
  patientName?: string;
  text: string;
  imageDataUrl?: string;
  media?: { type: "image" | "video" | "document" | "audio"; dataUrl: string; name?: string };
  referral?: IncomingReferral;
  externalId?: string; // id da mensagem no WhatsApp: guardado na mensagem pra o reprocessamento do webhook nao gravar duas vezes
}): Promise<RecordedMessage | null> {
  const { clinicId, patientPhone, patientName, text, imageDataUrl, media, referral, externalId } = params;
  const trimmed = text.trim();
  const mediaPlaceholder: Record<string, string> = { image: "[imagem]", video: "[vídeo]", audio: "[áudio]", document: "[arquivo]" };
  const storedContent = trimmed || (media ? mediaPlaceholder[media.type] : imageDataUrl ? "[imagem]" : "");
  if (!storedContent) return null;

  const existing = await prisma.patient.findUnique({
    where: { clinicId_phone: { clinicId, phone: patientPhone } },
    select: { id: true, metaFbc: true, name: true },
  });
  const attribution =
    referral && (!existing || !existing.metaFbc)
      ? {
          ...(referral.ctwaClid ? { metaFbc: ctwaClidToFbc(referral.ctwaClid), metaFbclid: referral.ctwaClid } : {}),
          ...(referral.sourceUrl ? { sourceUrl: referral.sourceUrl } : {}),
          ...(referral.adCampaignName ? { adCampaignName: referral.adCampaignName } : {}),
          ...(referral.adsetName ? { adsetName: referral.adsetName } : {}),
          ...(referral.adName ? { adName: referral.adName } : {}),
        }
      : {};

  const patient = existing
    ? await prisma.patient.update({ where: { id: existing.id }, data: { ...(existing.name ? {} : { name: patientName }), ...attribution } }) // o nome que a equipe (ou a propria pessoa) ja definiu nao e sobrescrito pelo apelido do WhatsApp
    : await prisma.patient.create({ data: { clinicId, phone: patientPhone, name: patientName, ...attribution } });

  if (!existing) {
    void logActivity({ clinicId, patientId: patient.id, type: "patient_created", area: "crm", title: "Card criado" });
    void enqueueLead(clinicId, patient.id).catch((err) => console.error("[meta] enqueueLead:", err));
    // Etiqueta de origem + data ("Lead Lavieen | 12/10/2026"), nas clinicas que ligaram isso.
    void tagNewLead(clinicId, patient.id, { adName: referral?.adName, adCampaignName: referral?.adCampaignName, fromAd: !!referral });
  }

  let conversation = await prisma.conversation.findFirst({
    where: { patientId: patient.id, status: { in: ["active", "qualified", "scheduled"] } }, // "scheduled" tambem: senao cada agendamento abria uma conversa nova e a Alice perdia o historico
    orderBy: { createdAt: "desc" },
  });
  // Sem conversa aberta: se o contato tem uma conversa ARQUIVADA (ex: histórico
  // importado, ou arquivada na mão), reabre ELA - mantém tudo num fio só - em
  // vez de criar uma conversa nova.
  if (!conversation) {
    conversation = await prisma.conversation.findFirst({
      where: { patientId: patient.id, archived: true },
      orderBy: { lastMessageAt: "desc" },
    });
  }
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { patientId: patient.id } });
  }

  // Trava anti-eco: se o que "chegou do cliente" e quase identico a ULTIMA
  // mensagem que SAIU dessa conversa (Alice ou humano) a poucos minutos, e
  // bem mais provavel que seja um eco da propria mensagem voltando (bug de
  // webhook/entrega) do que o cliente repetindo palavra por palavra o que a
  // Alice acabou de dizer. Sem essa trava a Alice responde ao proprio eco, o
  // eco volta de novo, e ela entra num loop conversando sozinha.
  const lastOutgoing = await prisma.message.findFirst({
    where: { conversationId: conversation.id, role: { in: ["assistant", "human"] } },
    orderBy: { createdAt: "desc" },
  });
  const probableEcho =
    !!lastOutgoing &&
    Date.now() - lastOutgoing.createdAt.getTime() < 5 * 60_000 &&
    normalizeReply(storedContent).length > 8 &&
    replySimilarity(storedContent, lastOutgoing.content) >= REPEAT_SIMILARITY;
  if (probableEcho) {
    console.warn(`[eco?] mensagem "recebida" quase identica ao que a propria conversa acabou de mandar - pulando resposta (conv ${conversation.id})`);
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: storedContent,
      ...(externalId ? { externalId } : {}),
      ...(media
        ? { mediaType: media.type, mediaUrl: media.dataUrl, mediaName: media.name ?? null }
        : imageDataUrl
          ? { mediaType: "image", mediaUrl: imageDataUrl }
          : {}),
    },
  });
  // Eco provavel: nao reabre conversa arquivada nem marca "nao lida" - nada
  // disso faz sentido pra uma mensagem que nem era realmente nova. Sem essa
  // trava, cada eco reabria a conversa e reacendia o aviso de handoff sozinho.
  if (!probableEcho) {
    // Sinais de intencao (perguntou valor/parcelamento/horario, "quero fazer"): esquenta o lead e alimenta o alerta de
    // lead quente parado.
    void recordIntentSignals(clinicId, patient.id, storedContent);
    // Disse "sem interesse" ha mais de 1 dia e voltou a escrever: volta a poder receber recontato.
    void prisma.patient
      .updateMany({ where: { id: patient.id, noInterest: true, noInterestAt: { lt: new Date(Date.now() - 24 * 3_600_000) } }, data: { noInterest: false, noInterestAt: null } })
      .catch(() => undefined);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        lastFollowUpOrder: 0,
        // Reabre a conversa: sai de arquivada e volta a ficar "aberta". Se um
        // humano tinha assumido, marca "nao lida" ate alguem abrir.
        ...(conversation.archived ? { archived: false } : {}),
        ...(conversation.status === "closed" ? { status: "active" } : {}),
        ...(conversation.humanTakeover ? { handoffPending: true } : {}),
      },
    });
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { replyDelaySeconds: true } });
  const delaySec = Math.min(Math.max(clinic?.replyDelaySeconds ?? 0, 0), 60);

  return {
    conversationId: conversation.id,
    patientId: patient.id,
    humanTakeover: conversation.humanTakeover,
    replyDelayMs: delaySec * 1000,
    probableEcho,
  };
}

// Na PRIMEIRA acao manual da conversa, registra a transferencia pro atendente
// (evento + aviso + log). Nao repete a cada mensagem. Usado tanto quando
// alguem responde pelo painel (routes.ts) quanto quando responde direto pelo
// celular/WhatsApp Web (recordOutgoingFromDevice, abaixo).
export async function ensureManualTakeover(
  conversation: { id: string; humanTakeover: boolean; patient: { clinicId: string; name: string | null; phone: string } },
  authorName: string | null,
): Promise<void> {
  if (conversation.humanTakeover) return;
  const patientLabel = conversation.patient.name ?? conversation.patient.phone;
  await prisma.message.create({
    data: { conversationId: conversation.id, role: "system", content: "Atendimento transferido para o atendente", authorName },
  });
  await notifyStaff(
    conversation.patient.clinicId,
    "human_handoff",
    `Atendimento assumido manualmente: ${patientLabel}${authorName ? ` (por ${authorName})` : ""}.`,
  );
  await logActivity({
    clinicId: conversation.patient.clinicId,
    type: "human_takeover",
    area: "atendimento",
    title: "Atendimento assumido por uma pessoa",
    description: `A Alice parou de responder a conversa com ${patientLabel} para a equipe continuar o atendimento.`,
    actorName: authorName,
  });
}

export interface RecordedDeviceMessage {
  conversationId: string;
  patientId: string;
}

// Rotulo de authorName pras mensagens que chegam pelo webhook como "fromMe":
// nao da pra saber QUAL pessoa da equipe respondeu (o WhatsApp nao expoe isso
// por aqui), so que saiu direto do celular/WhatsApp Web, nao do painel.
const DEVICE_AUTHOR_LABEL = "Enviado pelo WhatsApp (celular)";

// Mensagem que SAIU deste WhatsApp sem passar pela Alice nem pelo painel - a
// clinica respondeu direto pelo celular ou pelo WhatsApp Web. Grava na
// conversa certa como atendimento humano (mesma trava de humanTakeover que o
// envio pelo painel usa) e NUNCA gera resposta da Alice.
//
// Diferente de recordIncomingMessage: nao captura atribuicao de anuncio nem
// dispara evento de Lead pra Meta - quem comecou esse contato foi a propria
// clinica, nao uma campanha.
export async function recordOutgoingFromDevice(params: {
  clinicId: string;
  patientPhone: string;
  patientName?: string;
  text: string;
  media?: { type: "image" | "video" | "document" | "audio"; dataUrl: string; name?: string };
  externalId?: string;
}): Promise<RecordedDeviceMessage | null> {
  const { clinicId, patientPhone, patientName, text, media, externalId } = params;
  const mediaPlaceholder: Record<string, string> = { image: "[imagem]", video: "[vídeo]", audio: "[áudio]", document: "[arquivo]" };
  const storedContent = text.trim() || (media ? mediaPlaceholder[media.type] : "");
  if (!storedContent) return null;

  const existing = await prisma.patient.findUnique({
    where: { clinicId_phone: { clinicId, phone: patientPhone } },
    select: { id: true, name: true },
  });
  const patient = existing
    ? patientName && !existing.name
      ? await prisma.patient.update({ where: { id: existing.id }, data: { name: patientName } })
      : existing
    : await prisma.patient.create({ data: { clinicId, phone: patientPhone, name: patientName ?? null } });
  if (!existing) {
    void logActivity({ clinicId, patientId: patient.id, type: "patient_created", area: "crm", title: "Card criado" });
  }

  let conversation = await prisma.conversation.findFirst({
    where: { patientId: patient.id, status: { in: ["active", "qualified", "scheduled"] } }, // "scheduled" tambem: senao cada agendamento abria uma conversa nova e a Alice perdia o historico
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.findFirst({
      where: { patientId: patient.id, archived: true },
      orderBy: { lastMessageAt: "desc" },
    });
  }
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { patientId: patient.id } });
  }

  await ensureManualTakeover(
    { id: conversation.id, humanTakeover: conversation.humanTakeover, patient: { clinicId, name: patient.name ?? null, phone: patientPhone } },
    null,
  );

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "human",
      content: storedContent,
      ...(externalId ? { externalId } : {}),
      authorName: DEVICE_AUTHOR_LABEL,
      ...(media ? { mediaType: media.type, mediaUrl: media.dataUrl, mediaName: media.name ?? null } : {}),
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      humanTakeover: true,
      handoffPending: false,
      staffTouchedAt: new Date(), // a equipe agiu: base do "Alice volta se a equipe demorar"
      lastMessageAt: new Date(),
      ...(conversation.archived ? { archived: false } : {}),
      ...(conversation.status === "closed" ? { status: "active" } : {}),
    },
  });

  return { conversationId: conversation.id, patientId: patient.id };
}

// PASSO 2 (pode ser adiado): olha TODAS as mensagens acumuladas da conversa,
// gera a resposta da Alice, grava e devolve o texto pra enviar. Devolve "" se
// nao deve responder (humano assumiu, ou chegou mensagem nova durante a geracao).
const FIRST_REPLY_MAX_CHARS = 320;

// Urgencia clinica: nem no modo silencioso a Alice cala (orientar emergencia salva gente).
export const EMERGENCY_RE = /emerg[eê]ncia|samu|pronto[- ]socorro|hospital|procure (imediatamente )?(um )?(atendimento|servi[cç]o|pronto)/i;

// Resposta que oferece avaliacao / pede dia e turno / tenta agendar (texto normalizado).
export const EVAL_PITCH_RE = /avaliacao|dia e turno|qual dia|melhor dia|agendar|marcar um horario|horario pra voce|horario para voce/;

// A pessoa esta falando de agendar (texto normalizado): ai a oferta faz sentido.
export const SCHEDULING_INTENT_RE = /agend|marc|horario|turno|disponib|vaga|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana|manha|tarde|pode ser|quero ir|quero fazer|quando/;

// Pergunta DIRETA do paciente se esta falando com robo/IA/pessoa (texto ja normalizado:
// minusculo, sem acento nem pontuacao). A resposta e fixa e honesta.
export const ASKS_IF_BOT_RE =
  /(e|eh|era) (um |uma )?(robo|bot|ia|inteligencia artificial|maquina|automatico|automatica)|falando com (um |uma )?(robo|bot|ia|pessoa|humano|humana|maquina)|(pessoa|gente|humano|humana|atendente) (de verdade|real)|(voce|vc|tu) (e|eh) (uma )?(pessoa|gente|humana|humano)|atendimento (e |eh )?(automatico|de robo|robotizado)/;

// O paciente esta perguntando VALOR/PRECO (texto normalizado). "quanto tempo dura" NAO conta.
export const PRICE_ASK_RE =
  /quanto ((voces|vcs|voce|vc|a clinica) )?(custa|cobra|cobram|cobrar|fica|ficaria|sai|vai (custar|ficar|sair)|ta|esta|estao|pago|seria|seriam|vale|e|eh)\b|\b(valor|valores|preco|precos|orcamento|investimento)\b|a partir de quanto|(cobram|cobra|custa|custam) quanto/;

// Sinais de urgencia clinica na mensagem do paciente (texto normalizado).
export const URGENT_RE =
  /falta de ar|nao consigo respirar|dificuldade (pra|para|de) respirar|sangramento|sangrando muito|desmai|dor (muito )?forte|dor no peito|reacao alergica|alergia grave|garganta (fechando|inchad)|rosto (muito )?inchad|necrose|pele (escurecendo|roxa)/;

const URGENT_TEXT =
  "Sinto muito que isso esteja acontecendo. Se você está com falta de ar, inchaço no rosto ou na garganta, sangramento intenso, desmaio ou dor forte, procure agora um pronto-socorro ou ligue para o SAMU (192). Já estou avisando a nossa equipe para falar com você. 💗";

// Texto em que a Alice ANUNCIA que vai passar pra equipe / verificar com a equipe.
export const SAYS_HANDOFF_RE =
  /(vou|irei|iremos|vamos|j[aá] vou)[^.!?]{0,60}(transferir|encaminhar|passar|verificar|confirmar|checar|consultar|repassar)[^.!?]{0,50}(equipe|time|respons[aá]vel|profissional|atendente|setor|colega)|(nossa|a) equipe (vai|ir[aá]|entrar[aá]|retorna|responde)|(aguarde|um instante|s[oó] um momento)[^.!?]{0,40}(equipe|verific)/i;

// Reescreve a resposta tirando as frases que a Alice JA tinha dito: responde so ao que a pessoa mandou agora.
async function rewriteWithoutRepetition(draft: string, userNow: string, repeated: string[], clinicName: string): Promise<string | null> {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `Voce reescreve a resposta de uma secretaria de clinica (${clinicName}) no WhatsApp. O rascunho REPETE frases que ela ja disse nas mensagens anteriores (lista abaixo). Reescreva respondendo APENAS ao que a pessoa perguntou agora, SEM repetir essas frases nem o mesmo assunto, em no maximo 3 frases curtas e naturais. Se o rascunho traz uma informacao NOVA que responde a pergunta atual (ex.: dias e horarios de atendimento), mantenha so ela. Termine, se fizer sentido, com UMA pergunta curta DIFERENTE das anteriores que leve ao proximo passo (ou apenas pare, se a pergunta ja foi respondida). Nao invente nada: use so o que esta no rascunho. Sem markdown, no maximo 1 emoji. Responda SO com a mensagem.\n\nFRASES JA DITAS (nao repetir):\n${repeated.map((r) => `- ${r}`).join("\n")}`,
        },
        { role: "user", content: `Mensagem da pessoa agora: ${userNow.slice(0, 500)}\n\nRascunho:\n${draft.slice(0, 1500)}` },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    return text && text.length >= 10 ? text : null;
  } catch (err) {
    console.error("[repeticao] falha ao reescrever:", err);
    return null;
  }
}

// Tira a oferta de avaliacao / pedido de dia e turno de uma resposta que ia insistir nisso.
async function removeEvaluationPitch(draft: string, patientMessages: string[], clinicName: string): Promise<string | null> {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `Voce reescreve a resposta de uma secretaria de clinica (${clinicName}) no WhatsApp. A versao original insiste em avaliacao/agendamento, e a pessoa NAO pediu isso. Reescreva SEM nenhuma oferta de avaliacao, convite para agendar, pergunta de dia/turno ou de horario. Responda ao que a pessoa perguntou ou disse usando o que ha de informativo no rascunho (sem inventar nada; nao informe valores) e termine com UMA unica pergunta sobre o interesse dela (o que quer melhorar ou saber). Se ela perguntou VALOR, responda isso primeiro: o valor depende do protocolo de cada pessoa e a equipe apresenta o investimento (sem dar numero). Se ela disse que mora longe ou nao pode vir, respeite e deixe a porta aberta em uma frase. NAO comece com saudacao (Oi/Ola): a conversa ja esta em andamento. No maximo 3 frases curtas, tom natural de WhatsApp, sem markdown, no maximo 1 emoji. Responda SO com a mensagem.`,
        },
        { role: "user", content: `Mensagens recentes da pessoa:\n${patientMessages.join("\n").slice(0, 600)}\n\nRascunho:\n${draft.slice(0, 1500)}` },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    return text && text.length >= 15 ? text : null;
  } catch (err) {
    console.error("[sem-pressao] falha ao reescrever:", err);
    return null;
  }
}

// Reescreve a primeira resposta em no maximo 2 frases: apresentacao + UMA pergunta.
async function shortenFirstReply(draft: string, patientMessages: string[], clinicName: string, assistantName: string): Promise<string | null> {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `Voce reescreve a PRIMEIRA mensagem de uma secretaria de clinica (${assistantName}, da equipe ${clinicName}) a um contato novo no WhatsApp. A versao original despejou informacao demais. Reescreva em UMA unica mensagem de NO MAXIMO 2 frases curtas: (1) apresentacao curta ("Oi! Aqui e a ${assistantName}, da equipe ${clinicName}.") e, se vier de anuncio, reconheca o assunto em poucas palavras; (2) UMA unica pergunta para comecar a conversa: o nome da pessoa (se ainda nao se sabe) OU o que ela gostaria de melhorar, de forma especifica ao assunto (gordura: qual regiao; pele: o que melhorar na pele; rosto: o que incomoda). PROIBIDO: explicar o procedimento, listar beneficios, falar de avaliacao gratuita, valores, agendamento ou dia/turno. Sem listas, sem markdown. Tom proximo e acolhedor, no maximo 1 emoji. Responda SO com a mensagem.`,
        },
        { role: "user", content: `Mensagens da pessoa:\n${patientMessages.join("\n").slice(0, 600)}\n\nVersao original (longa demais):\n${draft.slice(0, 1500)}` },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    return text && text.length >= 20 && text.length < draft.length ? text : null;
  } catch (err) {
    console.error("[primeira-resposta] falha ao encurtar:", err);
    return null;
  }
}

// Penalidades de repeticao so existem nos modelos gpt-4*; os modelos mais novos (raciocinio) as recusam.
// Familia gpt-6: no Chat Completions as ferramentas (agenda, transferencia) so funcionam com reasoning_effort "none" (relato de
// terceiros, ainda nao validado aqui: se o modelo recusar, createChat volta ao padrao).
function samplingFor(model: string): Record<string, unknown> {
  if (/^gpt-4/i.test(model)) return { frequency_penalty: 0.3, presence_penalty: 0.2 };
  if (/^gpt-6/i.test(model)) return { reasoning_effort: "none" };
  return {};
}

// Chamada principal da conversa. Se a clinica usa um modelo proprio (Clinic.aiModel) e ele falha (nome errado, sem acesso, parametro
// recusado), volta ao modelo padrao NA MESMA resposta: a Alice nunca fica muda por causa de um teste de modelo.
async function createChat(model: string, messages: ChatCompletionMessageParam[], activeTools: ChatCompletionTool[]) {
  try {
    return await openai.chat.completions.create({ model, messages, tools: activeTools, ...samplingFor(model) } as Parameters<typeof openai.chat.completions.create>[0] & { stream?: false }) as ChatCompletion;
  } catch (err) {
    if (model === MODEL) throw err;
    console.error(`[modelo] ${model} falhou, usando ${MODEL}:`, err);
    return await openai.chat.completions.create({ model: MODEL, messages, tools: activeTools, ...samplingFor(MODEL) } as Parameters<typeof openai.chat.completions.create>[0] & { stream?: false }) as ChatCompletion;
  }
}

// Uma resposta por vez POR CONVERSA. Sem isso, duas mensagens seguidas do paciente
// ("Oi boa tarde" + "quanto custa?") geravam duas respostas em paralelo, cada uma
// sem enxergar a outra, e o paciente recebia a mesma coisa 2 ou 3 vezes.
const replyLocks = new Map<string, Promise<unknown>>();

export function generateReply(
  conversationId: string,
  opts: { imageDataUrl?: string; guardAgainstNewerThan?: Date; resumedAfterStaffDelay?: boolean } = {},
): Promise<string> {
  const prev = replyLocks.get(conversationId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => generateReplyUnlocked(conversationId, opts));
  replyLocks.set(conversationId, run);
  void run.finally(() => {
    if (replyLocks.get(conversationId) === run) replyLocks.delete(conversationId);
  }).catch(() => undefined);
  return run;
}

// Ja mandou algo MUITO parecido nos ultimos 2 minutos? Entao esta resposta e
// redundante: descarta em silencio (diferente do anti-loop, que transfere).
const RECENT_DUPLICATE_SIMILARITY = 0.6;
const RECENT_DUPLICATE_WINDOW_MS = 120_000;

export function isRecentDuplicate(text: string, recentAliceReplies: string[]): boolean {
  if (normalizeReply(text).length <= 25) return false;
  return recentAliceReplies.some((r) => replySimilarity(text, r) >= RECENT_DUPLICATE_SIMILARITY);
}

async function generateReplyUnlocked(
  conversationId: string,
  opts: { imageDataUrl?: string; guardAgainstNewerThan?: Date; resumedAfterStaffDelay?: boolean } = {},
): Promise<string> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { patient: { select: { id: true, clinicId: true, name: true, phone: true, ceUuid: true } } },
  });
  if (!conversation) return "";
  if (conversation.humanTakeover) return "";

  const clinicId = conversation.patient.clinicId;
  // Nada a responder: a ultima fala da conversa ja e da Alice (ou da equipe). Acontece
  // quando duas chamadas disputam a mesma mensagem - a primeira ja respondeu tudo.
  const lastTurn = await prisma.message.findFirst({
    where: { conversationId, role: { in: ["user", "assistant", "human"] } },
    orderBy: { createdAt: "desc" },
    select: { role: true },
  });
  if (lastTurn && lastTurn.role !== "user") return "";

  const patient = conversation.patient;
  const { imageDataUrl } = opts;

  // Limite de atendimentos do plano: se estourou, a Alice nao pega este contato
  // novo - passa direto pra equipe. Conversas ja em andamento continuam.
  const usageClinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, plan: true, aiModel: true, businessType: true, aliceActive: true, silentHandoff: true, handoffOnPrice: true, humanizedTone: true, softSell: true, conversationLimitOverride: true, usageMonth: true, usageCount: true, usageLimitNotified: true },
  });
  // Alice PAUSADA pela clinica (botao "Alice atendendo"): nao responde. A conversa
  // fica como "nao lida" pra equipe, sem virar atendimento humano (quando a Alice
  // voltar, ela retoma normalmente).
  if (usageClinic && !usageClinic.aliceActive) {
    await prisma.conversation.updateMany({
      where: { id: conversation.id, handoffPending: false },
      data: { handoffPending: true, handoffReason: "Alice pausada" },
    });
    return "";
  }
  // Plano grátis: a Alice nao atende. O lead e o evento Lead ja foram criados
  // em recordIncomingMessage (atribuicao da Meta intacta); a conversa fica so
  // pra virar evento de CRM quando a equipe mover o lead no funil.
  if (isFreePlan(usageClinic?.plan)) return "";
  if (usageClinic) {
    const check = await checkAtendimentoLimit(usageClinic, { id: conversation.id, aliceMonth: conversation.aliceMonth });
    if (!check.allowed) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { humanTakeover: true, handoffPending: true, handoffReason: "limite de atendimentos do plano" },
      });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "system",
          content: `Atendimento encaminhado para a equipe: o limite de atendimentos do plano (${check.limit}/mês) foi atingido.`,
          authorName: null,
        },
      });
      return "";
    }
  }

  // As 30 mensagens MAIS RECENTES (desc + reverse). Com "asc" o take pegava as
  // 30 mais antigas: numa conversa longa a Alice respondia sem enxergar o fim
  // da conversa - inclusive sem ver o horario que acabou de ser combinado.
  const history = (
    await prisma.message.findMany({
      // Mensagens de sistema (resumo de transferencia, avisos internos) NAO entram: antes eram enviadas ao modelo como se a Alice as tivesse dito.
      where: { conversationId, role: { in: ["user", "assistant", "human"] } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, role: true, content: true, authorName: true, createdAt: true }, // sem o anexo em base64
    })
  ).reverse();

  // PERGUNTOU O VALOR (pedido da clinica): a equipe apresenta o investimento, entao a conversa vai
  // direto pra atendimento humano, sem a Alice responder nada sobre preco.
  if (usageClinic?.handoffOnPrice) {
    const lastUserText = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (PRICE_ASK_RE.test(normalizeReply(lastUserText))) {
      try {
        await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
          reason: "Cliente perguntou o valor",
          summary: `O paciente perguntou sobre valores: "${String(lastUserText).slice(0, 300)}". A equipe apresenta o investimento.`,
        });
      } catch (err) {
        console.error("[valor] falha ao encaminhar pra equipe:", err);
      }
      if (usageClinic.silentHandoff) return "";
      const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { handoffPhrase: true } });
      const phrase = c?.handoffPhrase?.trim() || "Vou pedir pra uma pessoa da equipe continuar com você por aqui e te passar os valores.";
      await prisma.message.create({ data: { conversationId: conversation.id, role: "assistant", content: phrase, deliveryStatus: "pending" } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return phrase;
    }
  }

  // RECLAMOU DO ATENDIMENTO AUTOMATICO ("a IA de voces e pessima", "repetitiva", "nao ajuda em nada"): quem responde e uma
  // pessoa. Continuar tentando so piora (e foi o que aconteceu no caso da Cibele, 13/10).
  {
    const lastUserText = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (complainsAboutBot(lastUserText)) {
      try {
        await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
          reason: "Cliente reclamou do atendimento automatico",
          summary: `A cliente disse: "${String(lastUserText).slice(0, 300)}". Assuma a conversa com atencao e peca desculpas pela experiência.`,
        });
      } catch (err) {
        console.error("[reclamacao] falha ao encaminhar pra equipe:", err);
      }
      if (usageClinic?.silentHandoff) return "";
      const phrase = "Poxa, desculpa por isso! Vou pedir pra uma pessoa da equipe continuar com você por aqui agora. 💗";
      await prisma.message.create({ data: { conversationId: conversation.id, role: "assistant", content: phrase, deliveryStatus: "pending" } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return phrase;
    }
  }

  // URGENCIA clinica (falta de ar, sangramento intenso, reacao alergica...): resposta FIXA e imediata, SEM esperar o
  // modelo, em qualquer clinica (antes so valia com o "modo silencioso" ligado). Orienta procurar emergencia e a
  // equipe e avisada.
  if (usageClinic && usageClinic.businessType !== "geral") {
    const lastUserText = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (URGENT_RE.test(normalizeReply(lastUserText))) {
      try {
        await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
          reason: "URGENCIA: possivel intercorrencia",
          summary: `Mensagem do paciente: "${String(lastUserText).slice(0, 300)}".`,
        });
      } catch (err) {
        console.error("[urgencia] falha ao sinalizar a equipe:", err);
      }
      await prisma.message.create({ data: { conversationId: conversation.id, role: "assistant", content: URGENT_TEXT, deliveryStatus: "pending" } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return URGENT_TEXT;
    }
  }

  // REACAO APOS PROCEDIMENTO: quem foi atendida nos ultimos 21 dias e relata dor intensa, alergia, bolha, queimadura,
  // secrecao, febre, alteracao de cor... NAO recebe orientacao da Alice: o fluxo automatico para e a equipe assume na hora.
  if (usageClinic && usageClinic.businessType !== "geral") {
    const lastUserText = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (reportsProcedureReaction(normalizeReply(lastUserText))) {
      const recentVisit = await prisma.appointment.count({
        where: {
          clinicId,
          patientId: patient.id,
          status: { in: ["completed", "confirmed"] },
          scheduledAt: { gte: new Date(Date.now() - REACTION_WINDOW_DAYS * 24 * 3_600_000), lt: new Date() },
        },
      });
      if (recentVisit > 0) {
        try {
          await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
            reason: REACTION_HANDOFF_REASON,
            summary: `REAÇÃO RELATADA após atendimento recente. Mensagem da paciente: "${String(lastUserText).slice(0, 300)}". Não houve orientação clínica da Alice. Falar com a paciente com prioridade.`,
          });
        } catch (err) {
          console.error("[reacao] falha ao sinalizar a equipe:", err);
        }
        await prisma.message.create({ data: { conversationId: conversation.id, role: "assistant", content: REACTION_TEXT, deliveryStatus: "pending" } });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return REACTION_TEXT;
      }
    }
  }

  // RESPOSTA A CONFIRMACAO DE PRESENCA ("pode sim" ao lembrete de 24h): so agradece (ou manda o preparo, se houver), sem passar pelo modelo.
  if (usageClinic && usageClinic.businessType !== "geral") {
    const lastUserText = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    // so vale se a ULTIMA fala foi o proprio lembrete (senao o "sim" pode ser resposta a outra pergunta da conversa)
    const lastNonUser = history.filter((m) => m.role !== "user").at(-1);
    if (isConfirmationReply(lastUserText) && lastNonUser?.authorName === "Lembrete de consulta") {
      const now = new Date();
      const awaiting = await prisma.appointment.findFirst({
        where: {
          clinicId,
          patientId: patient.id,
          status: "confirmed",
          patientConfirmed: false,
          scheduledAt: { gte: now, lte: new Date(now.getTime() + 72 * 3_600_000) },
          reminders: { some: { sentAt: { gte: new Date(now.getTime() - 36 * 3_600_000) }, rule: { hoursBefore: { gte: 12 } } } },
        },
        select: { id: true },
      });
      if (awaiting) {
        try {
          const raw = await runTool(clinicId, patient.id, conversation.id, "manage_my_appointment", { action: "confirm" });
          if ((JSON.parse(raw) as { ok?: boolean }).ok) {
            const pre = pendingPreProcedure.get(conversation.id);
            pendingPreProcedure.delete(conversation.id);
            const text = pre || confirmationThanks(patient.name);
            await prisma.message.create({ data: { conversationId: conversation.id, role: "assistant", content: text, deliveryStatus: "pending" } });
            await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
            return text;
          }
        } catch (err) {
          console.error("[confirmacao] falha ao confirmar direto; segue pelo modelo:", err);
        }
      }
    }
  }

  await enrichPatientFromCe(clinicId, patient); // nome completo/vinculo pelo Clinica Experts (melhor esforco)
  // FLUXO DE VENDA: le a conversa (intencao agora, o que ela ja contou, se recusou horarios) e define a PROXIMA JOGADA. O
  // prompt desliga as regras que conflitam com ela e a jogada vai na ultima instrucao ao modelo.
  const trailingNow: string[] = [];
  for (let i = history.length - 1; i >= 0 && history[i].role === "user"; i--) trailingNow.unshift(history[i].content);
  const hasBooking = (await prisma.appointment.count({ where: { patientId: patient.id, status: "confirmed", scheduledAt: { gte: new Date() } } })) > 0;
  const flow = analyzeFlow({ history, trailing: trailingNow, priceAsked: PRICE_ASK_RE.test(normalizeReply(trailingNow.join(" "))), hasBooking });
  const system = await buildSystemPrompt(clinicId, { patientId: patient.id, flow });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...history.map((m): ChatCompletionMessageParam => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    })),
  ];

  // Foto recebida no meio do "burst": anexa a imagem na ultima fala do cliente.
  if (imageDataUrl) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      const caption = typeof lastUser.content === "string" && lastUser.content !== "[imagem]" ? lastUser.content : "(o cliente enviou esta foto)";
      lastUser.content = [
        { type: "text", text: caption },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ];
    }
  }

  // Historico de respostas da Alice (e da equipe), pra detectar (e cortar) repeticao.
  const priorAssistant = history.filter((m) => m.role === "assistant").map((m) => m.content);
  const priorReplies = history.filter((m) => m.role !== "user").map((m) => m.content);
  // Mensagens novas da pessoa (ainda sem resposta) e as que ela mandou antes (ja respondidas).
  const trailingUser: string[] = [];
  for (let i = history.length - 1; i >= 0 && history[i].role === "user"; i--) trailingUser.unshift(history[i].content);
  const answeredUser = history.slice(0, history.length - trailingUser.length).filter((m) => m.role === "user").map((m) => m.content);
  const lastAssistant = priorAssistant.at(-1) ?? "";
  const alreadyRepeatingInHistory =
    priorAssistant.length >= 2 &&
    replySimilarity(priorAssistant.at(-1)!, priorAssistant.at(-2)!) >= REPEAT_SIMILARITY;
  if (alreadyRepeatingInHistory) {
    // Injeta um empurrao forte logo antes de gerar: o modelo ja travou.
    messages.push({
      role: "system",
      content:
        "ATENCAO: voce mandou a mesma resposta varias vezes seguidas e o cliente nao avancou. NAO repita de novo. Faca uma destas duas coisas: (1) responda de forma DIRETA e diferente a ultima mensagem do cliente, resolvendo exatamente o que ele perguntou; ou (2) se voce ja nao tem como ajudar sozinha, chame transfer_to_human agora com um resumo. Nao reenvie a mesma informacao.",
    });
  }

  // A equipe estava atendendo e demorou: a Alice retoma (job de src/crm/humanReturn.ts).
  if (opts.resumedAfterStaffDelay) {
    messages.push({
      role: "system",
      content:
        "RETOMADA DO ATENDIMENTO: uma pessoa da equipe estava atendendo esta conversa e a cliente ficou esperando uma resposta; agora VOCE esta retomando. NAO peca desculpa pela demora e NAO se reapresente: responda direto o que ela mandou, como se a conversa seguisse normal. As falas anteriores da equipe no historico foram escritas por uma pessoa: continue de onde ela parou, sem contradizer nem repetir o que a equipe ja disse. Se o assunto so a equipe resolve (negociacao, caso clinico), diga que ja avisou a equipe e chame transfer_to_human.",
    });
  }

  // LEMBRETE FINAL (ultima mensagem do modelo, onde ele mais presta atencao): responda SO o que a pessoa acabou de mandar.
  // O modelo tinha o habito de re-responder perguntas antigas (valor, endereco, aviso de marca-passo) dentro de cada
  // resposta nova e fechar todas com a mesma pergunta.
  {
    const trailing = trailingUser;
    if (trailing.length) {
      const memory = conversationMemory(priorReplies, answeredUser);
      messages.push({
        role: "system",
        content: `JOGADA AGORA (siga isto): ${flow.nextMove}\n\n${memory ? memory + "\n\n" : ""}LEMBRETE FINAL: ${trailing.length > 1 ? "as mensagens novas da pessoa (ainda sem resposta) sao" : "a mensagem nova da pessoa e"}: ${trailing.map((t) => `"${t.slice(0, 300)}"`).join(" + ")}. Responda SOMENTE a isso, UMA vez${trailing.length > 1 ? ", juntando as mensagens numa resposta so" : ""}. O que ela perguntou ANTES ja foi respondido nas mensagens anteriores: NAO responda de novo, NAO repita valores, endereco, horarios, avisos nem frases que voce ja disse, e NAO feche com a mesma pergunta das mensagens anteriores (mude a pergunta ou so responda e pare). Fale como uma pessoa conversando: curto, direto, natural, continuando a conversa de onde ela parou.`,
      });
    }
  }

  const canBook = (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { aliceCanBook: true } }))?.aliceCanBook ?? true;
  const activeTools = canBook ? tools : tools.filter((t) => !(t.type === "function" && BOOKING_TOOLS.has(t.function.name)));

  let finalText = "";
  let didTransfer = false;
  const toolsUsed: string[] = [];
  let bookedOk = false; // book_appointment devolveu agendado:true nesta rodada
  let promiseNudged = false;
  pendingPreProcedure.delete(conversation.id); // sobra de uma tentativa anterior que falhou
  const chatModel = usageClinic?.aiModel?.trim() || MODEL;
  for (let turn = 0; turn < 6; turn++) {
    const response = await createChat(chatModel, messages, activeTools);

    const choice = response.choices[0].message;
    finalText = choice.content ?? "";

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      // Anunciou "um instante, vou agendar/verificar" (ou disse "agendado") e encerrou sem chamar a ferramenta: manda fazer AGORA.
      if (!promiseNudged && canBook && !didTransfer && turn < 5 && brokenPromise(finalText, bookedOk)) {
        promiseNudged = true;
        console.warn(`[promessa] resposta anunciou acao sem executar - reforcando (conv ${conversation.id}): ${finalText.slice(0, 120)}`);
        messages.push(choice);
        messages.push({ role: "system", content: PROMISE_NUDGE });
        continue;
      }
      break;
    }

    messages.push(choice);

    for (const toolCall of choice.tool_calls) {
      if (toolCall.type !== "function") continue;
      if (toolCall.function.name === "transfer_to_human") didTransfer = true;
      toolsUsed.push(toolCall.function.name);
      let result: string;
      try {
        const input = JSON.parse(toolCall.function.arguments || "{}");
        result = await runTool(clinicId, patient.id, conversation.id, toolCall.function.name, input);
      } catch (err) {
        console.error(`Falha na ferramenta ${toolCall.function.name}:`, err);
        result = "Ocorreu um erro ao executar essa acao. Nao invente o resultado; peca desculpas e diga que vai confirmar com a equipe.";
      }
      if (toolCall.function.name === "book_appointment" && result.includes('"agendado":true')) bookedOk = true;
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }

  // Se mesmo depois do reforco a resposta ainda promete ("um instante", "ja volto"), corta a promessa: ela nao tem como voltar.
  if (canBook && !didTransfer && finalText.trim() && announcesAction(finalText)) {
    const kept = removeSentences(finalText, splitSentences(finalText).filter((s) => announcesAction(s)));
    if (kept.length >= 15) finalText = kept;
  }

  // Orientacao de preparo (pre-procedimento): o texto da clinica, exato, no lugar da resposta do modelo (que so confirmou).
  const preText = pendingPreProcedure.get(conversation.id);
  pendingPreProcedure.delete(conversation.id);
  const fixedReply = !!preText && !didTransfer;
  if (fixedReply) finalText = preText as string;

  // Re-checa o estado da conversa DEPOIS de gerar a resposta.
  const after = await prisma.conversation.findUnique({
    where: { id: conversation.id },
    select: { humanTakeover: true, messages: { where: { role: "user", createdAt: { gt: opts.guardAgainstNewerThan ?? new Date(0) } }, take: 1, select: { id: true } } },
  });

  if (after?.humanTakeover && !didTransfer) {
    // Um atendente assumiu a conversa enquanto a Alice ainda estava respondendo.
    if (finalText.trim()) {
      await prisma.message.create({
        data: { conversationId: conversation.id, role: "system", content: "(a Alice ia responder, mas o atendimento acabou de ser assumido por uma pessoa)", authorName: null },
      });
    }
    return "";
  }

  // Chegou mensagem nova do cliente enquanto a Alice gerava a resposta: descarta
  // esta (ja e velha) - o novo agrupamento vai gerar uma resposta atualizada.
  if (opts.guardAgainstNewerThan && after && after.messages.length > 0) {
    return "";
  }

  // Primeira resposta a um contato novo ficou longa (enxurrada de informacao): reescreve
  // curta - apresentacao + UMA pergunta. Vale mesmo se o modelo ignorar a instrucao.
  if (!didTransfer && !fixedReply && finalText.trim() && (finalText.length > FIRST_REPLY_MAX_CHARS || (finalText.match(/\?/g) ?? []).length > 1) && !history.some((m) => m.role === "assistant")) {
    const conciseOn = (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { conciseFirstReply: true, name: true, assistantName: true } })) ?? null;
    if (conciseOn?.conciseFirstReply) {
      const shortText = await shortenFirstReply(finalText, history.filter((m) => m.role === "user").map((m) => m.content).slice(-3), conciseOn.name, conciseOn.assistantName || "Alice");
      if (shortText) finalText = shortText;
    }
  }

  // (Removido em 13/10/2026: o filtro "sem insistir em avaliacao" reescrevia a resposta quando a cliente dizia "Prefiro uma
  // avaliacao" - frase sem as palavras de agendamento da lista -, apagava a oferta e injetava o texto fixo "o valor depende do
  // protocolo... O que voce gostaria de melhorar?". Quem decide a jogada agora e o fluxo de venda: ver ai/salesFlow.ts.)

  // REPETICAO POR FRASE: a resposta repete frases que a Alice ja disse nas ultimas mensagens (re-responde pergunta antiga,
  // fecha com a mesma pergunta). Reescreve respondendo so ao que a pessoa mandou agora; se a reescrita falhar, corta as
  // frases repetidas. Nao mexe quando a pessoa REPETIU a propria pergunta (ai repetir e legitimo).
  if (!didTransfer && !fixedReply && finalText.trim()) {
    const userTexts = history.filter((m) => m.role === "user").map((m) => m.content);
    const lastUserText = userTexts.at(-1) ?? "";
    if (trailingUser.length && !askedAgain(lastUserText, userTexts.slice(0, -1))) {
      const recentReplies = priorReplies.slice(-8);
      // Turno de agendamento (ferramentas de agenda): reofertar dias/horarios e perguntar "qual dia?" de novo e normal; nao mexe.
      const bookingTurn = toolsUsed.some((n) => BOOKING_TOOLS.has(n));
      const userNow = trailingUser.join(" ");
      const detect = (t: string) => (bookingTurn ? [] : findRepetitions(t, recentReplies, userNow));
      const repeated = detect(finalText);
      if (repeated.length) {
        console.warn(`[repeticao] ${repeated.length} frase(s) repetida(s) na resposta (conv ${conversation.id}) - reescrevendo`);
        const rewritten = await rewriteWithoutRepetition(finalText, trailingUser.join(" / "), repeated, (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } }))?.name ?? "a clinica");
        // Confere a reescrita com o MESMO detector; se ainda repetir algo, corta so essas frases.
        let candidate = rewritten ?? finalText;
        const stillRepeated = detect(candidate);
        if (stillRepeated.length) {
          const stripped = removeSentences(candidate, stillRepeated);
          if (stripped.length >= 15) candidate = stripped;
        }
        finalText = candidate;
      }
    }
  }

  // Redundante: a propria Alice acabou de mandar (quase) isso. Nao reenvia.
  if (!didTransfer && finalText.trim()) {
    const recent = await prisma.message.findMany({
      where: { conversationId: conversation.id, role: "assistant", authorName: null, createdAt: { gte: new Date(Date.now() - RECENT_DUPLICATE_WINDOW_MS) } },
      select: { content: true },
    });
    if (isRecentDuplicate(finalText, recent.map((m) => m.content))) {
      console.warn(`[dedupe] resposta repetida descartada (conv ${conversation.id})`);
      return "";
    }
  }

  // Trava anti-loop: a Alice ia mandar de novo (quase) a mesma resposta que
  // acabou de dar. Um bom atendimento nao repete - passa pra uma pessoa.
  if (
    !didTransfer &&
    finalText.trim() &&
    normalizeReply(finalText).length > 25 &&
    lastAssistant &&
    replySimilarity(finalText, lastAssistant) >= REPEAT_SIMILARITY
  ) {
    const lastUserMsg = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    console.warn(`[anti-loop] Alice ia repetir a resposta - transferindo (conv ${conversation.id})`);
    try {
      await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
        reason: "Alice repetindo a mesma resposta; cliente sem avancar",
        summary: `A Alice ia reenviar a mesma resposta de novo e o cliente continuou sem fechar. Ultima mensagem do cliente: "${String(lastUserMsg).slice(0, 300)}".`,
      });
    } catch (err) {
      console.error("[anti-loop] falha ao transferir:", err);
    }
    didTransfer = true;
    const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { handoffPhrase: true } });
    finalText = usageClinic?.silentHandoff ? "" : c?.handoffPhrase?.trim() || "Vou pedir pra uma pessoa da equipe continuar com voce por aqui.";
  }

  // Se a Alice transferiu pra equipe nesta rodada e nao produziu texto de
  // encerramento, usa a frase de handoff da clinica (ou uma padrao).
  if (didTransfer && !finalText.trim() && !usageClinic?.silentHandoff) {
    const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { handoffPhrase: true } });
    finalText = c?.handoffPhrase?.trim() || "Vou pedir pra uma pessoa da equipe continuar com voce por aqui.";
  }

  // Pergunta DIRETA se e robo/IA/pessoa: resposta fixa e HONESTA. O modelo as vezes desvia
  // ("sou eu que cuido do atendimento"), o que nao nega nem diz a verdade.
  const lastUserNorm = normalizeReply(history.filter((m) => m.role === "user").at(-1)?.content ?? "");
  if (!didTransfer && ASKS_IF_BOT_RE.test(lastUserNorm)) { // vale pra todas as clinicas: perguntou direto, a resposta e honesta
    const ident = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true, assistantName: true } });
    finalText = `Sou a ${ident?.assistantName || "Alice"}, assistente virtual da equipe da ${ident?.name ?? "clínica"}. 😊 Posso te ajudar por aqui com informações e agendamentos; se preferir falar com uma pessoa da equipe, é só me dizer!`;
  }

  // MODO SILENCIOSO (pedido da clinica): se a Alice ia avisar "vou transferir/encaminhar/verificar
  // com a equipe", ela nao escreve nada. A conversa fica nao lida pra equipe, que responde. Garante que a
  // equipe seja avisada mesmo que o modelo tenha escrito a frase sem chamar a ferramenta.
  if (usageClinic?.silentHandoff && finalText.trim() && !EMERGENCY_RE.test(finalText)) {
    if (didTransfer) {
      finalText = "";
    } else if (SAYS_HANDOFF_RE.test(finalText)) {
      const lastUser = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
      try {
        await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
          reason: "Alice sem resposta segura (aguardando a equipe)",
          summary: `Ultima mensagem do paciente: "${String(lastUser).slice(0, 300)}".`,
        });
      } catch (err) {
        console.error("[silencio] falha ao sinalizar a equipe:", err);
      }
      didTransfer = true;
      finalText = "";
    }
  }

  // URGENCIA clinica: mesmo em modo silencioso a Alice orienta procurar emergencia e a equipe e avisada.
  if (usageClinic?.silentHandoff && URGENT_RE.test(lastUserNorm) && !EMERGENCY_RE.test(finalText)) {
    if (!didTransfer) {
      try {
        await runTool(clinicId, patient.id, conversation.id, "transfer_to_human", {
          reason: "URGENCIA: possivel intercorrencia",
          summary: `Mensagem do paciente: "${String(history.filter((m) => m.role === "user").at(-1)?.content ?? "").slice(0, 300)}".`,
        });
      } catch (err) {
        console.error("[urgencia] falha ao sinalizar a equipe:", err);
      }
      didTransfer = true;
    }
    finalText = URGENT_TEXT;
  }

  if (finalText.trim()) {
    const clinicTz = (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } }))?.timezone || "America/Sao_Paulo";
    finalText = fixWeekdayDatePairs(finalText, new Date(), clinicTz); // "sexta, 20/10" numa terca vira "terca, 20/10"
    finalText = fixRelativeDayLabels(finalText, new Date(), clinicTz); // "quinta (amanha)" numa quinta vira "quinta (hoje)"
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "assistant", content: finalText, deliveryStatus: "pending" }, // vira "sent"/"failed" depois do envio (uazapi/client.ts)
    });
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  return finalText;
}

// Compat: grava a mensagem e responde na hora (usado onde nao ha debounce).
export async function handleIncomingMessage(params: {
  clinicId: string;
  patientPhone: string;
  patientName?: string;
  text: string;
  imageDataUrl?: string;
  referral?: IncomingReferral;
}): Promise<string> {
  const rec = await recordIncomingMessage(params);
  if (!rec || rec.humanTakeover || rec.probableEcho) return "";
  return generateReply(rec.conversationId, { imageDataUrl: params.imageDataUrl });
}
