import { prisma } from "../db/client.js";
import { isConfirmationReply } from "./confirmation.js";
import { isoDateInZone, wallClockInZone, formatDateTimeInZone } from "../scheduling/time.js";
import { canonicalKey } from "../uazapi/phone.js";

// ---------------------------------------------------------------------------
// CONFIRMACAO DE PRESENCA ("Confirmado" ao lembrete) - erro de producao da Lisboa, 19/10/2026: a cliente respondeu "Confirmado" ao lembrete da reserva de 20/10 09:00 e a Alice
// respondeu "Pra eu te passar os horarios certinhos: voce prefere manha, tarde ou noite?" (o texto de seguranca da validacao final, que so aparece quando a resposta do MODELO
// foi barrada): a mensagem NAO foi tratada como confirmacao, foi para o modelo como se fosse um pedido de agendamento.
// A decisao agora e deterministica e se apoia no que esta GRAVADO, nao so na ultima fala do chat:
//   - o lembrete e a reserva a que ele se refere (ReminderDispatch: pessoa, reserva e horario lembrado; ReminderSent legado; lembrete no chat);
//   - a mesma pessoa com o telefone com/sem o 9o digito (CE e WhatsApp podem ter linhas diferentes);
//   - a reserva continua valida (confirmada, futura, no mesmo horario que o lembrete citou). Cancelada/remarcada/passada NAO e confirmada por lembrete antigo;
//   - mais de uma reserva possivel: so confirma se o contexto identifica qual (mesmo dia = uma confirmacao so; ou o lembrete citou so uma); senao pergunta qual.
// Nao ha regra global "sim/ok = presenca": mensagem com pedido, pergunta ou recusa nunca e so confirmacao (isConfirmationReply), e palavra fraca ("sim", "ok") exige que o
// lembrete tenha sido a ultima coisa perguntada a ela.
// ---------------------------------------------------------------------------

export const REMINDER_AUTHOR = "Lembrete de consulta";
export const DISAMBIGUATION_PREFIX = "Qual destes horários você está confirmando?";
const WINDOW_MS = 72 * 3_600_000;
// A solicitacao de confirmacao pode ser feita DIAS antes (sabado: quarta e sexta). A resposta continua valendo para a reserva citada enquanto ela for futura e nada diferente tiver
// sido perguntado depois (palavra fraca como "sim" ja exige que o lembrete tenha sido a ultima pergunta), entao a janela de busca acompanha a antecedencia da politica.
const REMINDER_WINDOW_MS = 5 * 24 * 3_600_000;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}\s:]/gu, " ").replace(/\s+/g, " ").trim();
// palavras que dizem "vou estar la" por si so; "sim"/"ok"/"pode" sao fracas (dependem de o lembrete ter sido a ultima pergunta)
const STRONG_RE = /\b(confirm(o|ado|ada)|presenca confirmada|estarei|estaremos|vou sim|vou estar|pode contar)\b/;

// PURO: mesma pessoa com o telefone com e sem o 9o digito cai na mesma chave (DDD + ultimos 8 digitos). Outros formatos: o proprio numero.
export function phoneKey(phone: string): string {
  return canonicalKey(phone) ?? phone.replace(/\D/g, ""); // leitura central: fixo e celular nao se fundem
}

export interface PresenceOption {
  appointmentId: string;
  ownerPatientId: string;
  day: string; // AAAA-MM-DD (fuso da clinica)
  time: string; // HH:MM
  label: string; // "20/10/2026 09:00"
  procedure: string;
}

export type PresenceDecision =
  | { kind: "none"; why: string; confirmationLike: boolean; hasUpcoming: boolean }
  | { kind: "confirm"; option: PresenceOption; already: boolean; confirmationLike: true; via: string }
  | { kind: "ambiguous"; options: PresenceOption[]; confirmationLike: true }
  | { kind: "stale"; why: string; confirmationLike: true };

export interface HistoryMsg { role: string; content: string; authorName?: string | null; createdAt: Date }

export async function samePersonIds(clinicId: string, patient: { id: string; phone: string }): Promise<string[]> {
  const digits = patient.phone.replace(/\D/g, "");
  const key = phoneKey(patient.phone);
  if (key === digits) return [patient.id]; // formato que nao varia
  const rows = await prisma.patient.findMany({ where: { clinicId, phone: { endsWith: digits.slice(-8) } }, select: { id: true, phone: true }, take: 12 });
  return [...new Set([patient.id, ...rows.filter((r) => phoneKey(r.phone) === key).map((r) => r.id)])];
}

const hhmm = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };

// PURO: ela escolheu uma das opcoes oferecidas? ("o das 9h", "14:30", "o segundo", "2")
export function pickOption(text: string, options: PresenceOption[]): PresenceOption | null {
  const t = fold(text);
  const ordinals: [RegExp, number][] = [[/\b(primeir[oa]|1)\b/, 0], [/\b(segund[oa]|2)\b/, 1], [/\b(terceir[oa]|3)\b/, 2]];
  const byTime = options.filter((o) => {
    const [h, m] = o.time.split(":");
    return new RegExp(`\\b0?${Number(h)}(:|h)?${m === "00" ? "(00)?" : m}\\b`).test(t) || new RegExp(`\\b0?${Number(h)}:${m}\\b`).test(t);
  });
  if (byTime.length === 1) return byTime[0];
  if (byTime.length === 0) for (const [re, idx] of ordinals) if (re.test(t) && options[idx]) return options[idx];
  return null;
}

export async function resolvePresence(p: { clinicId: string; patient: { id: string; phone: string }; history: HistoryMsg[]; now: Date; tz: string }): Promise<PresenceDecision> {
  const { clinicId, patient, history, now, tz } = p;
  const lastUser = history.filter((m) => m.role === "user").at(-1);
  if (!lastUser) return { kind: "none", why: "sem_mensagem_da_pessoa", confirmationLike: false, hasUpcoming: false };
  const text = lastUser.content;
  // a ultima fala que nao e do paciente, ignorando o que nao pergunta nada: o texto informativo do preparo e o nosso proprio agradecimento a uma confirmacao anterior
  const isThanks = (m: HistoryMsg) => m.role === "assistant" && !m.authorName && /^Obrigada pela confirma[cç][aã]o/.test(m.content);
  const lastNonUser = [...history].reverse().find((m) => m.role !== "user" && !(m.authorName ?? "").startsWith("Preparo da visita") && !isThanks(m));
  const answeringDisambiguation = lastNonUser?.role === "assistant" && !lastNonUser.authorName && lastNonUser.content.startsWith(DISAMBIGUATION_PREFIX);
  const confirmLike = isConfirmationReply(text);
  if (!confirmLike && !answeringDisambiguation) return { kind: "none", why: "nao_e_so_confirmacao", confirmationLike: false, hasUpcoming: false };

  const ids = await samePersonIds(clinicId, patient);
  const chatReminder = lastNonUser?.authorName === REMINDER_AUTHOR;
  const humanAsked = lastNonUser?.role === "human" && /\bconfirm\w*\b/i.test(lastNonUser.content) && /\b(agendamento|hor[aá]rio|atendimento)\b/i.test(lastNonUser.content);

  // lembretes de confirmacao registrados (persistidos), independentes de em qual conversa/linha de paciente o texto foi parar
  const since = new Date(now.getTime() - REMINDER_WINDOW_MS);
  const dispatches = await prisma.reminderDispatch.findMany({
    where: { clinicId, patientId: { in: ids }, state: { in: ["sent", "unconfirmed"] }, kind: { not: "do_dia" }, updatedAt: { gte: since }, appointmentId: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { appointmentId: true, startsAt: true, updatedAt: true },
  });
  const legacy = await prisma.reminderSent.findMany({
    where: { sentAt: { gte: since }, rule: { hoursBefore: { gte: 12 } }, appointment: { clinicId, patientId: { in: ids } } },
    select: { appointmentId: true, sentAt: true },
    take: 10,
  });
  const lastReminderAt = Math.max(0, ...dispatches.map((d) => d.updatedAt.getTime()), ...legacy.map((l) => l.sentAt.getTime()));
  // nada foi perguntado a ela DEPOIS do lembrete (nesta conversa): uma palavra fraca ("sim") so e confirmacao se o lembrete foi a ultima pergunta
  const nothingAskedSince = !lastNonUser || lastNonUser.createdAt.getTime() <= lastReminderAt;
  const persistedEvidence = lastReminderAt > 0 && nothingAskedSince;
  const strong = STRONG_RE.test(fold(text));
  const evidence = chatReminder || humanAsked || persistedEvidence || answeringDisambiguation;

  const horizon = new Date(now.getTime() + WINDOW_MS);
  // as reservas que um lembrete REGISTRADO citou valem mesmo alem do horizonte de 72 h (confirmacao de sabado enviada na quarta)
  const citedIds = [...new Set([...dispatches.map((d) => d.appointmentId), ...legacy.map((l) => l.appointmentId)].filter((x): x is string => !!x))];
  const upcoming = await prisma.appointment.findMany({
    where: { clinicId, patientId: { in: ids }, status: "confirmed", OR: [{ scheduledAt: { gte: now, lte: horizon } }, ...(citedIds.length ? [{ id: { in: citedIds }, scheduledAt: { gte: now } }] : [])] },
    include: { procedure: { select: { name: true } } },
    orderBy: { scheduledAt: "asc" },
    take: 12,
  });
  const hasUpcoming = upcoming.length > 0;
  if (!evidence) return { kind: "none", why: strong ? "sem_lembrete_registrado" : "ultima_pergunta_nao_foi_o_lembrete", confirmationLike: true as boolean, hasUpcoming };

  const toOption = (a: (typeof upcoming)[number]): PresenceOption => ({
    appointmentId: a.id, ownerPatientId: a.patientId, day: isoDateInZone(a.scheduledAt, tz), time: hhmm(a.scheduledAt, tz),
    label: formatDateTimeInZone(a.scheduledAt, tz), procedure: a.procedure.name,
  });

  // reservas a que o(s) lembrete(s) se referem, com o horario que o lembrete citou
  const referenced = new Map<string, Date | null>();
  for (const d of dispatches) if (d.appointmentId && !referenced.has(d.appointmentId)) referenced.set(d.appointmentId, d.startsAt);
  for (const l of legacy) if (!referenced.has(l.appointmentId)) referenced.set(l.appointmentId, null);

  // validas (ainda confirmadas, futuras, no mesmo horario do lembrete) x ultrapassadas (canceladas, remarcadas, passadas)
  const valid: typeof upcoming = [];
  let stale = 0;
  if (referenced.size) {
    const rows = await prisma.appointment.findMany({ where: { id: { in: [...referenced.keys()] }, clinicId }, select: { id: true, status: true, scheduledAt: true } });
    for (const [id, startsAt] of referenced) {
      const row = rows.find((r) => r.id === id);
      const u = upcoming.find((a) => a.id === id);
      if (u && (!startsAt || startsAt.getTime() === u.scheduledAt.getTime())) valid.push(u);
      else if (!row || row.status !== "confirmed" || row.scheduledAt.getTime() !== (startsAt?.getTime() ?? row.scheduledAt.getTime()) || row.scheduledAt.getTime() < now.getTime()) stale++;
    }
  }
  // sem lembrete registrado, mas com a evidencia do chat (lembrete como ultima fala / pergunta da equipe): as reservas pendentes de confirmacao nas proximas 72 h
  if (!referenced.size) for (const a of upcoming) if (!a.patientConfirmed) valid.push(a);

  const options = valid.map(toOption);
  const pending = valid.filter((a) => !a.patientConfirmed).map(toOption);

  if (answeringDisambiguation) {
    // opcoes que a pergunta de desambiguacao listou (as reservas pendentes) e a escolha dela
    const picked = pickOption(text, pending.length ? pending : options);
    if (picked) return { kind: "confirm", option: picked, already: false, confirmationLike: true, via: "desambiguacao" };
    if (!confirmLike) return { kind: "none", why: "escolha_nao_identificada", confirmationLike: true, hasUpcoming };
  }
  if (pending.length === 0) {
    if (options.length) return { kind: "confirm", option: options[0], already: true, confirmationLike: true, via: "ja_confirmada" };
    if (stale > 0) return { kind: "stale", why: "reserva_do_lembrete_cancelada_remarcada_ou_passada", confirmationLike: true };
    return { kind: "none", why: "sem_reserva_pendente", confirmationLike: true, hasUpcoming };
  }
  const days = new Set(pending.map((o) => o.day));
  if (pending.length === 1 || days.size === 1) return { kind: "confirm", option: pending[0], already: false, confirmationLike: true, via: referenced.size ? "lembrete_registrado" : "chat" };
  // varias reservas em dias diferentes: o lembrete que ela viu cita so uma?
  const cited = chatReminder || humanAsked ? pending.filter((o) => lastNonUser && lastNonUser.content.includes(o.time) && new RegExp(`${o.day.slice(8, 10)}/${o.day.slice(5, 7)}`).test(lastNonUser.content)) : [];
  if (cited.length === 1) return { kind: "confirm", option: cited[0], already: false, confirmationLike: true, via: "lembrete_no_chat" };
  // o lembrete mais recente (e so ele, num intervalo de 5 min) identifica a reserva
  const newest = dispatches[0]?.updatedAt.getTime() ?? 0;
  const latest = [...new Set(dispatches.filter((d) => d.appointmentId && d.updatedAt.getTime() >= newest - 5 * 60_000).map((d) => d.appointmentId!))];
  if (latest.length === 1) {
    const one = pending.find((o) => o.appointmentId === latest[0]);
    if (one) return { kind: "confirm", option: one, already: false, confirmationLike: true, via: "ultimo_lembrete" };
  }
  return { kind: "ambiguous", options: pending, confirmationLike: true };
}

export function disambiguationText(options: PresenceOption[]): string {
  const lines = options.slice(0, 5).map((o, i) => `${i + 1}) ${o.label} — ${o.procedure}`);
  return `${DISAMBIGUATION_PREFIX}\n\n${lines.join("\n")}\n\nÉ só me dizer o horário (ou o número). 💗`;
}
