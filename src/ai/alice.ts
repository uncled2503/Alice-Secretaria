import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { prisma } from "../db/client.js";
import {
  findAvailableSlots,
  checkSpecificTime,
  createBooking,
  professionalsForProcedure,
} from "../scheduling/slots.js";
import { offerFreedSlotToWaitlist } from "../scheduling/waitlist.js";
import { formatInZone, formatDateTimeInZone } from "../scheduling/time.js";
import { getActiveRulesPrompt } from "./rules.js";
import { getFunnelStages } from "../crm/stages.js";
import { movePatientToKind, movePatientToStage, movePatientToRecovery } from "../crm/stageAutomation.js";
import { notifyStaff } from "../crm/notify.js";
import { logActivity } from "../crm/activity.js";
import { enqueueLead, enqueueSchedule } from "../meta/events.js";
import { ctwaClidToFbc } from "../meta/userData.js";
import type { Procedure } from "@prisma/client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
        "Lista os proximos horarios livres para um procedimento. Use quando o paciente quer agendar mas nao citou um dia/hora especifico. Se a clinica tem mais de um profissional pra esse procedimento, cada horario vem com o profissional.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string", description: "Nome do procedimento, deve bater com um dos cadastrados na clinica." },
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
          date: { type: "string", description: "Data no formato AAAA-MM-DD, no fuso da clinica. Resolva 'hoje'/'amanha' a partir da data atual informada no contexto." },
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
        "Confirma o agendamento. So chame depois que o paciente confirmar explicitamente o horario, e SO com um start_iso que veio do campo 'iso' de check_availability ou check_specific_time. Nunca invente o start_iso.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string" },
          start_iso: { type: "string", description: "O valor exato do campo 'iso' retornado pelas ferramentas de disponibilidade." },
          professional_id: { type: "string", description: "Opcional: o 'profissional_id' retornado junto com o horario escolhido." },
        },
        required: ["procedure_name", "start_iso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_my_appointment",
      description:
        "Gerencia o proximo agendamento futuro do proprio paciente. Use 'confirm' quando ele confirmar presenca (ex: 'confirmado', 'pode confirmar', 'sim vou'), 'cancel' quando pedir pra cancelar, 'reschedule' quando pedir pra remarcar (informe new_date e new_time).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["confirm", "cancel", "reschedule"] },
          new_date: { type: "string", description: "So para reschedule: AAAA-MM-DD no fuso da clinica." },
          new_time: { type: "string", description: "So para reschedule: HH:MM em 24h." },
        },
        required: ["action"],
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
        "Atualiza a etapa do paciente no funil de vendas conforme a conversa evolui (ex: demonstrou interesse real -> 'interesse confirmado'; recebeu orcamento -> 'proposta enviada'). NAO use para agendamento, venda fechada, pos-procedimento ou perdido - essas etapas sao automaticas.",
      parameters: {
        type: "object",
        properties: {
          stage_id: { type: "string", description: "O id (slug) de uma das etapas 'abertas' listadas no contexto." },
          reason: { type: "string", description: "Frase curta do porque da mudanca (aparece no historico da clinica)." },
        },
        required: ["stage_id"],
      },
    },
  },
];

async function findProcedure(clinicId: string, name: unknown): Promise<Procedure | null> {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  return (
    (await prisma.procedure.findFirst({ where: { clinicId, name: { equals: raw } } })) ??
    (await prisma.procedure.findFirst({ where: { clinicId, name: { contains: raw } } }))
  );
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

function parseRequestedDateTime(date: unknown, time: unknown) {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date ?? "").trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!d || !t) return null;
  const parsed = { year: +d[1], month: +d[2], day: +d[3], hour: +t[1], minute: +t[2] };
  if (parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > 31) return null;
  if (parsed.hour > 23 || parsed.minute > 59) return null;
  return parsed;
}

const SLOT_REASON_PT: Record<string, string> = {
  past: "esse horario ja passou",
  closed_day: "a clinica nao atende nesse dia da semana",
  outside_hours: "esse horario esta fora do expediente da clinica",
  conflict: "ja tem outro paciente marcado nesse horario",
  blocked: "a agenda esta bloqueada nesse horario (folga/feriado)",
  procedure_not_found: "procedimento nao encontrado",
  invalid_datetime: "o horario informado e invalido; use um valor 'iso' retornado pelas ferramentas de disponibilidade",
};

async function runTool(
  clinicId: string,
  patientId: string,
  conversationId: string,
  name: string,
  input: any,
): Promise<string> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
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
    await prisma.message.create({
      data: {
        conversationId,
        role: "system",
        content: `Atendimento transferido pela Alice. Motivo: ${reason}.${summary ? `\n\nResumo:\n${summary}` : ""}`,
        authorName: null,
      },
    });
    await notifyStaff(
      clinicId,
      "human_handoff",
      `Atendimento transferido pela Alice: ${who}\nMotivo: ${reason}.${summary ? `\n\n${summary}` : ""}`,
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
    if (!procedure) return `Procedimento "${input.procedure_name}" nao encontrado na clinica.`;

    const professionalIds = await resolveProfessionalIds(clinicId, procedure.id, input.professional_name);
    const slots = await findAvailableSlots(clinicId, procedure.id, { professionalIds, limit: 6 });
    if (slots.length === 0) {
      return JSON.stringify({ procedimento: procedure.name, horarios: [], observacao: "Nenhum horario livre nos proximos dias." });
    }
    return JSON.stringify({
      procedimento: procedure.name,
      horarios: slots.map((s) => ({
        iso: s.start.toISOString(),
        quando: formatInZone(s.start, tz),
        ...(s.professionalName ? { profissional: s.professionalName, profissional_id: s.professionalId } : {}),
      })),
    });
  }

  if (name === "check_specific_time") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    if (!procedure) return `Procedimento "${input.procedure_name}" nao encontrado.`;

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

  if (name === "book_appointment") {
    const procedure = await findProcedure(clinicId, input.procedure_name);
    if (!procedure) return `Procedimento "${input.procedure_name}" nao encontrado.`;

    let professionalId: string | null = input.professional_id ? String(input.professional_id) : null;
    if (!professionalId) {
      const pros = await professionalsForProcedure(clinicId, procedure.id);
      if (pros.length === 1) professionalId = pros[0].id;
    }

    const booking = await createBooking({
      clinicId,
      patientId,
      procedureId: procedure.id,
      professionalId,
      startUtc: new Date(String(input.start_iso ?? "")),
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
      `Novo agendamento (via Alice): ${patientLabelOf(patient)} - ${booking.procedureName}${withPro} em ${whenLabel}.`,
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
    const appt = await prisma.appointment.findFirst({
      where: { patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
      orderBy: { scheduledAt: "asc" },
      include: { procedure: true, professional: true, patient: true },
    });
    if (!appt) return JSON.stringify({ ok: false, motivo: "nao encontrei um agendamento futuro pra esse paciente" });

    const label = formatDateTimeInZone(appt.scheduledAt, tz);
    const who = patientLabelOf(appt.patient);

    if (action === "confirm") {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { patientConfirmed: true, confirmedAt: new Date() },
      });
      await notifyStaff(clinicId, "confirmed", `Presenca confirmada: ${who} - ${appt.procedure.name} em ${label}.`);
      await logActivity({
        clinicId, type: "appointment_confirmed", area: "agenda",
        title: "Presença confirmada pelo paciente",
        description: `${who} — ${appt.procedure.name} em ${label}.`, actorName: null,
      });
      return JSON.stringify({ ok: true, confirmado: label });
    }

    if (action === "cancel") {
      await prisma.appointment.update({ where: { id: appt.id }, data: { status: "cancelled" } });
      await notifyStaff(clinicId, "cancel", `Agendamento cancelado pelo paciente: ${who} - ${appt.procedure.name} em ${label}.`);
      await logActivity({
        clinicId, type: "appointment_cancelled", area: "agenda",
        title: "Agendamento cancelado pelo paciente",
        description: `${who} — ${appt.procedure.name} em ${label}.`, actorName: null,
      });
      await movePatientToRecovery(clinicId, patientId, { note: "cancelou o agendamento" });
      await offerFreedSlotToWaitlist({
        clinicId,
        procedureId: appt.procedureId,
        professionalId: appt.professionalId,
        freedAt: appt.scheduledAt,
      });
      return JSON.stringify({ ok: true, cancelado: label });
    }

    if (action === "reschedule") {
      const requested = parseRequestedDateTime(input.new_date, input.new_time);
      if (!requested) return JSON.stringify({ ok: false, motivo: "preciso da nova data e hora (new_date e new_time)" });

      const professionalIds = appt.professionalId ? [appt.professionalId] : [];
      const check = await checkSpecificTime(clinicId, appt.procedureId, requested, { professionalIds });
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
      await notifyStaff(clinicId, "reschedule", `Agendamento remarcado pelo paciente: ${who} - ${appt.procedure.name} agora em ${check.requestedLabel}.`);
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
      clinicId, type: "waitlist_added", area: "agenda",
      title: "Paciente entrou na lista de espera",
      description: `${patientLabelOf(patient)}${procedure ? ` — ${procedure.name}` : ""}${input.note ? ` (${input.note})` : ""}.`,
      actorName: null,
    });
    return JSON.stringify({ ok: true });
  }

  if (name === "update_crm_stage") {
    const result = await movePatientToStage(clinicId, patientId, String(input.stage_id ?? ""), {
      note: input.reason ? String(input.reason).slice(0, 200) : "atualizado pela Alice no atendimento",
      restrictToKinds: ["aberta"],
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
      clinicId, type: "satisfaction_recorded", area: "atendimento",
      title: "Pesquisa de satisfação respondida",
      description: `${who} deu nota ${score}${input.comment ? `: "${String(input.comment).slice(0, 200)}"` : "."}`,
      actorName: null,
    });

    if (score <= 6) {
      await notifyStaff(clinicId, "human_handoff", `Avaliação baixa (${score}/10): ${who}${input.comment ? ` — "${String(input.comment).slice(0, 200)}"` : ""}. Vale um retorno da equipe.`);
      return JSON.stringify({ ok: true, acao: "Agradeça pela sinceridade, pergunte o que pode melhorar e diga que vai passar pra equipe. Se ele reclamar, use transfer_to_human." });
    }
    if (score >= clinic.npsThreshold && clinic.googleReviewUrl?.trim()) {
      return JSON.stringify({ ok: true, acao: `Agradeça de coração e peça, se puder, uma avaliação neste link: ${clinic.googleReviewUrl.trim()}` });
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
function describeProcedureForPrompt(p: Procedure): string {
  const lines = [`- ${p.name} (${p.durationMin}min)`];

  if (p.price != null) {
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

// Como a Alice se apresenta pro paciente - ela NUNCA diz que e IA/assistente
// virtual, so uma destas tres formas (escolhida pela clinica no painel).
function personaInstruction(clinic: { name: string; assistantName: string; assistantPersona: string; assistantPersonaName: string | null }): string {
  const a = clinic.assistantName || "Alice";
  const who = clinic.assistantPersonaName?.trim();
  if (clinic.assistantPersona === "clinic_secretary") {
    return `Voce se apresenta como secretaria da ${clinic.name}. Ex: "Oi! Aqui e a ${a}, secretaria da ${clinic.name}".`;
  }
  if (clinic.assistantPersona === "professional_secretary" && who) {
    return `Voce se apresenta como secretaria de ${who} (da ${clinic.name}). Ex: "Oi! Aqui e a ${a}, secretaria de ${who}".`;
  }
  // team (padrao) - e tambem o fallback do professional_secretary sem nome
  return `Voce se apresenta apenas como parte da equipe da ${clinic.name}, sem citar cargo. Ex: "Oi! Aqui e a ${a}, da equipe da ${clinic.name}".`;
}

export async function buildSystemPrompt(clinicId: string, ctx: { patientId?: string } = {}): Promise<string> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    include: {
      procedures: { include: { professionals: { where: { active: true }, select: { name: true } } } },
      messageTemplates: { where: { active: true } },
      faqs: { where: { active: true } },
      playbooks: { where: { active: true } },
    },
  });

  const a = clinic.assistantName || "Alice";
  const procedureList = clinic.procedures.map((p) => describeProcedureForPrompt(p)).join("\n\n");

  const areaLine = clinic.activityArea?.trim()
    ? `\nArea de atuacao: ${clinic.activityArea.trim()}.`
    : "";

  const depositLine = clinic.requireDepositProof
    ? `\nSINAL OBRIGATORIO: so confirme (book_appointment) um agendamento depois que o paciente enviar o comprovante do sinal na conversa. Antes disso, peca o pagamento e aguarde o comprovante.`
    : "";

  const handoffPhrase = clinic.handoffPhrase?.trim();
  const handoffLine = `\nHANDOFF: quando a situacao exigir uma pessoa (pedido de desconto ou negociacao, reclamacao, paciente insatisfeito, paciente pede pra falar com alguem OU pra ligar, paciente diz que as respostas estao "no automatico" / repetitivas / confusas, duvida clinica que so o profissional responde, risco medico ou urgencia, problema de pagamento, exames prontos com interesse cirurgico, ou algo que voce nao resolve com seguranca): ${handoffPhrase ? `escreva exatamente "${handoffPhrase}" e ` : "escreva uma frase curta e acolhedora e "}chame a ferramenta transfer_to_human com o motivo e um resumo pra pessoa continuar. Depois disso pare de responder. Nao anuncie que vai "transferir pra um atendente".`;

  // Trava anti-loop: o modelo (gpt-4o-mini) as vezes trava repetindo a mesma
  // resposta. Isso e reforcado no prompt e checado de novo no codigo.
  const noRepeatLine = `\nNAO SE REPITA: nunca reenvie uma resposta que voce ja mandou nesta conversa, nem uma variacao da mesma frase. Responda SEMPRE a ultima mensagem do cliente - se ele fez uma pergunta nova (ex: "da pra mandar um cartao junto?", "entrega de manha?"), responda ESSA pergunta, sem voltar pro assunto anterior. Se voce ja explicou tudo o que sabia e o cliente continua sem avancar, NAO repita: use transfer_to_human. Cada resposta sua tem que acrescentar algo novo.`;

  const consultivo = clinic.servicePosture === "consultivo";

  const postureLine = consultivo
    ? `\nPOSTURA CONSULTIVA: conduza como um consultorio, sem pressao comercial. Responda a duvida atual primeiro; so pergunte de novo quando a resposta mudar o proximo passo; se ja respondeu, aguardar e uma acao valida. Nao encerre com pergunta generica so pra manter a conversa. Nao empurre o agendamento - ofereca o caminho da avaliacao quando houver interesse real.`
    : `\nPOSTURA COMERCIAL (voce converte, nao so informa): qualifique com objetividade, recomende o procedimento que resolve a queixa do paciente e conduza de forma ativa pro agendamento da avaliacao/consulta - ofereca horario voce mesma ("consigo quinta as 15h ou sexta as 10h, qual fica melhor?"). Contorne objecao de preco com o beneficio e o parcelamento (quando cadastrado). Nunca encerre sem um proximo passo. Isso sem quebrar regra nenhuma: nao invente valor, prazo nem garantia.`;

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

  const evalFirstLine = clinic.evaluationFirst
    ? `\nAVALIACAO PRIMEIRO: nunca exija que o paciente saiba qual procedimento precisa. Sempre ofereca os dois caminhos ("voce ja tem algo em mente ou prefere uma avaliacao pra o profissional entender seu caso?"). Se ele nao sabe e quer ser avaliado, isso e intencao valida de agendamento - conduza direto, sem listar procedimentos.`
    : "";

  const emojiLine = clinic.allowEmojis === false ? `\nNao use emojis em nenhuma mensagem.` : "";

  const visionLine = `\nFOTOS E AUDIOS: voce VE as fotos que o cliente envia e ESCUTA os audios (eles ja chegam transcritos). Responda com base no que esta na imagem/audio, com naturalidade. Nunca diga que "nao consegue ver imagens", "nao abre fotos" ou "so entende texto". Se a foto estiver ruim ou nao der pra identificar algo com seguranca, diga o que da pra ver e peca um detalhe (angulo melhor, nome do item). Print de golpe/corrente/spam: nao responda.`;

  const schedulingLinkLine = clinic.schedulingLink?.trim()
    ? `\nLINK DE AUTO-AGENDAMENTO: quando o paciente demonstrar intencao clara de agendar, voce pode enviar direto o link ${clinic.schedulingLink.trim()} (nao pergunte "quer que eu mande o link?", mande). Use este link em vez de book_appointment quando a clinica preferir que o paciente escolha o horario sozinho.`
    : "";

  let surveyLine = "";
  if (ctx.patientId) {
    const pending = await prisma.satisfactionSurvey.findFirst({
      where: { clinicId, patientId: ctx.patientId, answeredAt: null, askedAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } },
      orderBy: { askedAt: "desc" },
    });
    if (pending) {
      surveyLine = `\nPESQUISA DE SATISFACAO PENDENTE: voce perguntou a nota de 0 a 10. Quando o paciente responder com um numero, chame record_satisfaction (com o comentario, se houver) e siga a "acao" que a ferramenta devolver. Se ele falar de outro assunto, atenda normalmente.`;
    }
  }

  const isGeneric = clinic.businessType === "geral";

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
    .map((p) => `- ${p.name}: ${p.professionals.map((pr) => pr.name).join(", ")}`)
    .join("\n");
  const professionalsBlock = prosByProcedure
    ? `\n\nProfissionais por procedimento:\n${prosByProcedure}\nSe houver mais de um profissional, pergunte a preferencia do paciente (ou ofereca o primeiro horario livre de qualquer um). Passe professional_name/professional_id nas ferramentas de agenda.`
    : "";

  const scheduleBlock = `\n\nAGENDA E HORARIOS (regras rigidas):
- Data e hora agora: ${formatInZone(new Date(), tz)} (fuso ${tz}). Use isto pra resolver "hoje", "amanha", "semana que vem".
- Expediente da clinica: ${workDayLabels || "(nao definido)"}, das ${clinic.workStartHour}h as ${clinic.workEndHour}h. Cada profissional pode ter um expediente proprio - as ferramentas ja consideram isso.
- Se o paciente citar um dia/hora, chame check_specific_time ANTES de responder. Se estiver livre, confirme com ele e so entao chame book_appointment com o "iso" (e o profissional_id, quando houver) retornado.
- Se o horario pedido NAO estiver livre, diga com naturalidade que aquele horario nao esta disponivel (ex: "esse horario ja esta ocupado") e ofereca as alternativas retornadas. Se o paciente nao gostar das alternativas e quiser esperar uma vaga, use join_waitlist.
- Se o paciente nao citou horario, use check_availability e ofereca no maximo 2 ou 3 opcoes.
- Nunca confirme, prometa ou invente um horario sem passar pelas ferramentas.
- Se o paciente confirmar presenca numa consulta ja marcada, cancelar ou pedir pra remarcar, use manage_my_appointment.${professionalsBlock}`;

  const openStages = (await getFunnelStages(clinicId)).filter((s) => s.kind === "aberta");
  const stagesBlock = openStages.length
    ? `\n\nFUNIL DE VENDAS - atualize a etapa do ${isGeneric ? "contato" : "paciente"} com update_crm_stage conforme a conversa avanca. Etapas disponiveis (use o id):\n${openStages
        .map((s) => `- ${s.stageId} — ${s.label}`)
        .join("\n")}\n${isGeneric ? 'Venda fechada e "perdido" sao automaticos quando aplicavel: foque nas etapas acima.' : 'Agendamento, venda fechada, pos-procedimento e "perdido" sao automaticos: nao tente defini-los.'}`
    : "";

  // --- Negocio generico (loja, servico): vocabulario de "cliente/catalogo",
  //     sem agenda nem qualificacao de procedimento. O que guia o atendimento
  //     e o catalogo + FAQ + mensagens prontas + roteiros + regras. ---
  if (clinic.businessType === "geral") {
    const label = clinic.businessLabel?.trim() || clinic.activityArea?.trim();
    const labelPart = label ? ` (${label})` : "";
    const gtz = clinic.timezone || "America/Sao_Paulo";
    const nowLine = `\nData e hora agora: ${formatInZone(new Date(), gtz)} (fuso ${gtz}). Use isto pra saber se e dia util / horario de atendimento.`;

    const catalogBlock = clinic.procedures.length
      ? `\n\nItens/servicos cadastrados (fale so o que esta aqui; nunca invente preco, prazo ou detalhe que nao esteja):\n${procedureList}`
      : "";

    const genericHandoffLine = `\nHANDOFF: voce atende PELO proprio WhatsApp oficial do negocio - esta conversa JA e o canal de atendimento. NUNCA mande link de WhatsApp (wa.me), numero de telefone pra "chamar o atendimento", nem diga pra pessoa falar "com a equipe" em outro lugar. Quando a conversa exigir uma pessoa de verdade (reclamacao, cliente insatisfeito, cliente pede pra falar com alguem OU pra ligar, cliente diz que as respostas estao "no automatico" / repetitivas / confusas, negociacao ou desconto fora do previsto, um pedido/troca/devolucao/pagamento que voce nao resolve com o que esta cadastrado, quer finalizar uma compra e precisa de confirmacao, ou qualquer coisa que voce nao resolve com seguranca): ${handoffPhrase ? `escreva exatamente "${handoffPhrase}" e ` : "escreva uma frase curta e acolhedora dizendo que uma pessoa da equipe vai continuar por aqui e "}chame a ferramenta transfer_to_human com o motivo e um resumo. Depois pare de responder. O que voce CONSEGUE resolver (duvida de produto, tamanho, frete, cor, link do site) resolva aqui na conversa, sem transferir.`;

    return `Voce e a ${a}, do atendimento da "${clinic.name}"${labelPart}.${areaLine}${nowLine}
Atenda pelo proprio WhatsApp oficial do negocio de forma humanizada, calorosa e objetiva, como um bom atendimento de loja. A conversa que voce ve JA e esse WhatsApp - nunca redirecione a pessoa pra "o WhatsApp da loja".

COMO VOCE SE APRESENTA (regra fixa, vale pra toda conversa):
${personaInstruction(clinic)}
NUNCA se apresente nem se descreva como IA, inteligencia artificial, assistente virtual, atendimento automatico, bot, robo, sistema ou programa, e nao use linguagem robotica. Se perguntarem diretamente se e um robo, responda de forma leve e humana e siga ajudando normalmente.

Seu trabalho:
1. Entender o que o cliente procura e ajudar usando SOMENTE o que esta cadastrado abaixo (catalogo, FAQ, mensagens prontas, roteiros, regras).
2. Manter a etapa do cliente no funil atualizada (update_crm_stage) conforme a conversa avanca.
3. Nunca invente estoque, prazo de entrega, status de pedido, preco ou politica que nao estejam cadastrados. Nesses casos, mande a pessoa ver no site (link da peca ou da colecao) ou, se precisar mesmo de uma pessoa, use transfer_to_human - nunca mande link de WhatsApp.
4. Conduzir o cliente ate a compra: recomendar, mandar o link certo e levar pro proximo passo (esse e o objetivo).
5. Termine sempre com um proximo passo claro: um link, uma opcao ou uma pergunta.${sellerLine}${emojiLine}${visionLine}${schedulingLinkLine}${surveyLine}${genericHandoffLine}${noRepeatLine}${catalogBlock}${stagesBlock}${templatesBlock}${faqBlock}${playbookBlock}

Responda sempre em portugues do Brasil, em mensagens curtas como quem digita no WhatsApp.${await getActiveRulesPrompt(clinicId)}`;
  }

  const clinicNoun = clinic.clinicKind === "medica" ? "clinica" : clinic.clinicKind === "ambas" ? "clinica" : "clinica de estetica";
  return `Voce e a ${a}, atendente da ${clinicNoun} "${clinic.name}".${areaLine}
Atenda pelo WhatsApp de forma humanizada, calorosa e objetiva, como uma recepcionista experiente.

COMO VOCE SE APRESENTA (regra fixa, vale pra toda conversa):
${personaInstruction(clinic)}
NUNCA se apresente nem se descreva como IA, inteligencia artificial, assistente virtual, secretaria virtual, atendimento automatico, bot, robo, sistema ou programa, e nao use linguagem robotica ("processando", "de acordo com meu sistema", etc.). Se perguntarem diretamente se e um robo ou atendimento automatico, nao entre nesse assunto: responda de forma leve e humana (ex: "Sou eu que cuido do atendimento aqui pela ${clinic.name} 😊 me conta como posso te ajudar") e siga ajudando normalmente.

Seu trabalho:
1. Entender o interesse do paciente e qualificar (procedimento desejado, se e novo paciente).
2. Manter a etapa do paciente no funil atualizada (update_crm_stage) conforme a conversa avanca.
3. Checar disponibilidade real (check_specific_time / check_availability) antes de falar de qualquer data.
4. Confirmar o horario escolhido com o paciente e so entao usar book_appointment.
5. Nunca invente horarios ou informacoes que nao vieram das ferramentas.${depositLine}${postureLine}${evalFirstLine}${medicalLine}${emojiLine}${visionLine}${schedulingLinkLine}${surveyLine}${handoffLine}${noRepeatLine}

Procedimentos oferecidos pela clinica:
${procedureList || "(nenhum procedimento cadastrado ainda)"}

Use so os dados de valor, beneficio, indicacao e prazo que estao cadastrados acima em cada procedimento. Se o paciente perguntar algo que nao esta ali (preco de um item sem valor, prazo de um item sem prazo cadastrado, etc.), diga que precisa confirmar na avaliacao/com a equipe - nunca invente numero, garantia ou prazo.${scheduleBlock}${stagesBlock}${templatesBlock}${faqBlock}${playbookBlock}

Responda sempre em portugues do Brasil, em mensagens curtas como quem digita no WhatsApp.${await getActiveRulesPrompt(clinicId)}`;
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
  referral?: IncomingReferral;
}): Promise<RecordedMessage | null> {
  const { clinicId, patientPhone, patientName, text, imageDataUrl, referral } = params;
  const trimmed = text.trim();
  const storedContent = trimmed || (imageDataUrl ? "[imagem]" : "");
  if (!storedContent) return null;

  const existing = await prisma.patient.findUnique({
    where: { clinicId_phone: { clinicId, phone: patientPhone } },
    select: { id: true, metaFbc: true },
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
    ? await prisma.patient.update({ where: { id: existing.id }, data: { name: patientName, ...attribution } })
    : await prisma.patient.create({ data: { clinicId, phone: patientPhone, name: patientName, ...attribution } });

  if (!existing) {
    void enqueueLead(clinicId, patient.id).catch((err) => console.error("[meta] enqueueLead:", err));
  }

  let conversation = await prisma.conversation.findFirst({
    where: { patientId: patient.id, status: { in: ["active", "qualified"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { patientId: patient.id } });
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: storedContent,
      ...(imageDataUrl ? { mediaType: "image", mediaUrl: imageDataUrl } : {}),
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: new Date(),
      lastFollowUpOrder: 0,
      // Mensagem nova em conversa que um humano assumiu = "nao lida" ate alguem
      // abrir. Conversa arquivada volta pra lista (estilo WhatsApp).
      ...(conversation.humanTakeover ? { handoffPending: true } : {}),
      ...(conversation.archived ? { archived: false } : {}),
    },
  });

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { replyDelaySeconds: true } });
  const delaySec = Math.min(Math.max(clinic?.replyDelaySeconds ?? 0, 0), 60);

  return {
    conversationId: conversation.id,
    patientId: patient.id,
    humanTakeover: conversation.humanTakeover,
    replyDelayMs: delaySec * 1000,
  };
}

// PASSO 2 (pode ser adiado): olha TODAS as mensagens acumuladas da conversa,
// gera a resposta da Alice, grava e devolve o texto pra enviar. Devolve "" se
// nao deve responder (humano assumiu, ou chegou mensagem nova durante a geracao).
export async function generateReply(
  conversationId: string,
  opts: { imageDataUrl?: string; guardAgainstNewerThan?: Date } = {},
): Promise<string> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { patient: { select: { id: true, clinicId: true, name: true, phone: true } } },
  });
  if (!conversation) return "";
  if (conversation.humanTakeover) return "";

  const clinicId = conversation.patient.clinicId;
  const patient = conversation.patient;
  const { imageDataUrl } = opts;

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: 30,
  });

  const system = await buildSystemPrompt(clinicId, { patientId: patient.id });

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

  // Historico de respostas da Alice, pra detectar (e cortar) repeticao.
  const priorAssistant = history.filter((m) => m.role === "assistant").map((m) => m.content);
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

  let finalText = "";
  let didTransfer = false;
  for (let turn = 0; turn < 6; turn++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      frequency_penalty: 0.3,
      presence_penalty: 0.2,
    });

    const choice = response.choices[0].message;
    finalText = choice.content ?? "";

    if (!choice.tool_calls || choice.tool_calls.length === 0) break;

    messages.push(choice);

    for (const toolCall of choice.tool_calls) {
      if (toolCall.type !== "function") continue;
      if (toolCall.function.name === "transfer_to_human") didTransfer = true;
      let result: string;
      try {
        const input = JSON.parse(toolCall.function.arguments || "{}");
        result = await runTool(clinicId, patient.id, conversation.id, toolCall.function.name, input);
      } catch (err) {
        console.error(`Falha na ferramenta ${toolCall.function.name}:`, err);
        result = "Ocorreu um erro ao executar essa acao. Nao invente o resultado; peca desculpas e diga que vai confirmar com a equipe.";
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }

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
    finalText = c?.handoffPhrase?.trim() || "Vou pedir pra uma pessoa da equipe continuar com voce por aqui.";
  }

  // Se a Alice transferiu pra equipe nesta rodada e nao produziu texto de
  // encerramento, usa a frase de handoff da clinica (ou uma padrao).
  if (didTransfer && !finalText.trim()) {
    const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { handoffPhrase: true } });
    finalText = c?.handoffPhrase?.trim() || "Vou pedir pra uma pessoa da equipe continuar com voce por aqui.";
  }

  if (finalText.trim()) {
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "assistant", content: finalText },
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
  if (!rec || rec.humanTakeover) return "";
  return generateReply(rec.conversationId, { imageDataUrl: params.imageDataUrl });
}
