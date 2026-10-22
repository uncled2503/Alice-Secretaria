import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { isoDateInZone, wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { maskPhone } from "../crm/leadPhones.js";
import { parsePhone, maskDigits, canonicalKey } from "../uazapi/phone.js";
import { bookingKeyOf } from "../reminders/ledger.js";
import { selectReminderCandidates, fixedReminderTime, type HeldReminder } from "../reminders/cron.js";
import { effectivePurpose, ruleAppliesOnWeekday, weekdayInZone } from "../reminders/policy.js";
import { isBirthdayToday, birthdayVerdict } from "../reminders/birthday.js";
import { loadAllPolicies, normalWindowEnd, extendedDeadline, resolveExtension, HARD_LAST_HOUR, type DispatchKind } from "./policy.js";

// ---------------------------------------------------------------------------
// ABA DISPAROS: modelo unico de leitura. Junta o que a Alice DEVIA enviar (reconstruido da FONTE: agendamentos / aniversarios) com o que os controles
// persistentes registram (ReminderDispatch / BirthdaySent), e classifica cada evento em UM estado e UM motivo. Regras:
//  - somente leitura: nada aqui envia, reserva ou grava;
//  - ACEITO pelo provedor, ENTREGUE e LIDO sao contadores SEPARADOS (nunca somados);
//  - cobertura nunca e declarada 100% quando a fonte e incompleta (so conhecemos o que foi importado para a Alice);
//  - sem prova da causa, o motivo e "sem evidencia suficiente" (nao inventamos causa).
// ---------------------------------------------------------------------------

export type DispatchStatus =
  | "programado" | "cancelado" | "encaminhado"
  | "lido" | "entregue" | "aceito" | "confirmado_equipe" | "entrega_falhou"
  | "incerto" | "falhou" | "adiado" | "barrado" | "bloqueado" | "expirado" | "nao_tentado" | "excluido" | "em_andamento" | "coberto";

export const STATUS_LABEL: Record<DispatchStatus, string> = {
  lido: "Lido", entregue: "Entregue", programado: "Programado", cancelado: "Cancelado", encaminhado: "Encaminhado à equipe (não é mensagem enviada)", aceito: "Aceito pelo WhatsApp", confirmado_equipe: "Confirmado pela equipe (sem evidência do provedor)", entrega_falhou: "Entrega falhou", incerto: "Resultado incerto", falhou: "Falhou", adiado: "Adiado",
  barrado: "Barrado pela revisão", bloqueado: "Bloqueado", expirado: "Expirado", nao_tentado: "Não tentado", excluido: "Fora (motivo legítimo)", em_andamento: "Em andamento", coberto: "Já coberto",
};

export const REASONS: Record<string, string> = {
  nao_importado: "Cadastro não importado para a Alice",
  nao_paciente: "Contato classificado como não-paciente",
  fonte_incompleta: "Fonte incompleta (não dá para afirmar)",
  nascimento_ausente: "Data de nascimento ausente ou inválida",
  telefone_ausente: "Telefone ausente",
  telefone_invalido: "Telefone inválido",
  telefone_ambiguo: "Telefone ambíguo (compartilhado)",
  regra_inativa: "Regra desligada",
  plano_ou_opt_out: "Plano, opt-out ou política bloqueia",
  fora_da_janela: "Fora da janela de envio",
  capacidade: "Limite de capacidade da rodada",
  trava_ocupada: "Outra execução estava com a trava",
  ce_indisponivel: "Clínica Experts indisponível ou inconclusivo",
  whatsapp_desconectado: "WhatsApp desconectado",
  revisao_barrou: "Revisão de envio barrou",
  falha_provedor: "Falha do provedor",
  incerto: "Resultado incerto",
  ja_enviado: "Já enviado (com evidência)",
  cancelado: "Agendamento cancelado ou encerrado",
  remarcado: "Remarcado",
  confirmado: "Paciente já confirmou",
  equipe_conversando: "Equipe conversando com a pessoa",
  tentativas_esgotadas: "Tentativas esgotadas",
  prazo_expirado: "Prazo do dia expirou",
  numero_sem_whatsapp: "Número sem WhatsApp",
  aguardando_intervalo: "Aguardando o intervalo entre tentativas",
  ainda_nao_e_hora: "Ainda não é a hora",
  sem_evidencia: "Sem evidência suficiente",
  cancelado_pela_equipe: "Cancelado pela equipe",
  outro: "Outro motivo (veja o detalhe)",
};

// Tipos da Central: os 4 originais (com politica de janela) + os que entram por ADAPTADOR sobre o controle proprio de cada fluxo (adapters.ts).
export type ItemKind = DispatchKind | "renovacao" | "retorno_combinado" | "campanha" | "pos" | "pre" | "recontato" | "retomada";
export const ITEM_KINDS: readonly ItemKind[] = ["confirmacao", "cobranca", "lembrete", "aniversario", "pos", "pre", "renovacao", "recontato", "retorno_combinado", "retomada", "campanha"];

export interface DispatchItem {
  id: string;
  source: "reminder" | "birthday" | "expected_reminder" | "expected_birthday" | "adapter";
  kind: ItemKind;
  campaignId?: string | null;
  campaignTitle?: string | null;
  origin?: string | null; // origem do cadastro/da reserva (ex.: Clinica Experts, painel, WhatsApp)
  ruleId: string | null;
  ruleName: string | null;
  patientId: string;
  patientName: string;
  phone: string; // mascarado
  professional: string | null;
  procedure: string | null;
  referenceAt: string; // ISO: horario do atendimento (lembretes) ou o dia do aniversario
  sendDay: string; // AAAA-MM-DD local do envio
  status: DispatchStatus;
  statusLabel: string;
  reason: string;
  reasonLabel: string;
  detail: string | null;
  attempts: number;
  attemptedAt: string | null;
  nextAttemptAt: string | null;
  deadlineAt: string | null;
  extendedReason: string | null;
  extended: boolean;
  destination: string | null; // mascarado
  providerId: string | null; // truncado (lista)
  providerIdFull: string | null; // identificador COMPLETO da mensagem no provedor (detalhe)
  messageText: string | null; // texto EXATO renderizado da tentativa (null = tentativa anterior ao registro do texto: nunca se reconstroi pelo template de hoje)
  deliveryState: string | null;
  recoverable: boolean; // pode ser tentado de novo HOJE (a revalidacao final acontece no envio)
  recoverableWhy: string;
  actions: string[];
}

const mask = (s: string | null | undefined): string => (s ?? "").replace(/\d{8,}/g, (d) => maskDigits(d));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const shortId = (s: string | null | undefined) => (s ? (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s) : null);

// PURO: motivo a partir do texto que o ciclo gravou (sem inventar: o que nao reconhece vira "outro" e o detalhe aparece).
export function reasonFromDetail(detail: string | null | undefined, fallback = "outro"): string {
  const d = (detail ?? "").toLowerCase();
  if (!d) return fallback;
  if (/cancelad.*equipe|cancelado pela equipe/.test(d)) return "cancelado_pela_equipe";
  if (/clinica experts|clínica experts|\bce\b|inconclusiv|indisponiv/.test(d)) return "ce_indisponivel";
  if (/desconect|whatsapp fora|connection/.test(d)) return "whatsapp_desconectado";
  if (/sem whatsapp|not on whatsapp|numero invalido|número inválido/.test(d)) return "numero_sem_whatsapp";
  if (/telefone invalido|telefone inválido/.test(d)) return "telefone_invalido";
  if (/revis|barrou|vetad/.test(d)) return "revisao_barrou";
  if (/equipe.*(atend|conversa)|pausa humana/.test(d)) return "equipe_conversando";
  if (/tempo esgotado|pode ter (saido|chegado)|sem desfecho|incerto/.test(d)) return "incerto";
  if (/esgotad/.test(d)) return "tentativas_esgotadas";
  if (/intervalo/.test(d)) return "aguardando_intervalo";
  if (/fora da janela|depois do (limite|horario)/.test(d)) return "fora_da_janela";
  if (/capacidade|limite de envios/.test(d)) return "capacidade";
  if (/opt|plano|politica|política/.test(d)) return "plano_ou_opt_out";
  if (/falha do provedor|http \d{3}|provedor/.test(d)) return "falha_provedor";
  if (/identic|ja existia|já existia|equivalente/.test(d)) return "ja_enviado";
  return fallback;
}

// PURO: estado normalizado de uma linha do controle de lembretes.
export function statusOfReminderRow(r: { state: string; deliveryState: string | null; attemptedAt: Date | null; updatedAt: Date; detail: string | null }, now: Date): { status: DispatchStatus; reason: string } {
  const reason = reasonFromDetail(r.detail);
  switch (r.state) {
    case "sent":
      if (r.deliveryState === "read") return { status: "lido", reason: "ja_enviado" };
      if (r.deliveryState === "delivered") return { status: "entregue", reason: "ja_enviado" };
      if (r.deliveryState === "staff_confirmed") return { status: "confirmado_equipe", reason: "ja_enviado" };
      if (r.deliveryState === "failed") return { status: "entrega_falhou", reason: "falha_provedor" };
      return { status: "aceito", reason: "ja_enviado" };
    case "unconfirmed": return { status: "incerto", reason: "incerto" };
    case "reserved":
      return now.getTime() - r.updatedAt.getTime() > 30 * 60_000 ? { status: "incerto", reason: "incerto" } : { status: "em_andamento", reason: "trava_ocupada" };
    case "deferred": return { status: "adiado", reason: reason === "outro" ? "ce_indisponivel" : reason };
    case "failed": return { status: "falhou", reason: reason === "outro" ? "falha_provedor" : reason };
    case "failed_permanent": return { status: "falhou", reason: reason === "outro" ? "numero_sem_whatsapp" : reason };
    case "vetoed": return { status: "barrado", reason: "revisao_barrou" };
    case "blocked": return /cancelado pela equipe/i.test(r.detail ?? "") ? { status: "cancelado", reason: "cancelado_pela_equipe" } : { status: "bloqueado", reason: reason === "outro" ? "plano_ou_opt_out" : reason };
    case "exhausted": return { status: "expirado", reason: "tentativas_esgotadas" };
    case "duplicate": return { status: "coberto", reason: "ja_enviado" };
    default: return { status: "incerto", reason: "sem_evidencia" };
  }
}

export function statusOfBirthdayRow(r: { state: string; deliveryState: string | null; attempts: number; attemptedAt: Date | null; sentAt: Date; detail: string | null }, now: Date): { status: DispatchStatus; reason: string } {
  const reason = reasonFromDetail(r.detail);
  switch (r.state) {
    case "sent":
      if (r.deliveryState === "read") return { status: "lido", reason: "ja_enviado" };
      if (r.deliveryState === "delivered") return { status: "entregue", reason: "ja_enviado" };
      if (r.deliveryState === "staff_confirmed") return { status: "confirmado_equipe", reason: "ja_enviado" };
      if (r.deliveryState === "failed") return { status: "entrega_falhou", reason: "falha_provedor" };
      return { status: "aceito", reason: "ja_enviado" };
    case "legacy": return { status: "incerto", reason: "sem_evidencia" }; // registro anterior ao controle: so prova a reserva
    case "unconfirmed": return { status: "incerto", reason: "incerto" };
    case "reserved": return now.getTime() - r.sentAt.getTime() > 30 * 60_000 ? { status: r.attemptedAt || r.attempts === 0 ? "incerto" : "adiado", reason: r.attemptedAt || r.attempts === 0 ? "incerto" : "falha_provedor" } : { status: "em_andamento", reason: "trava_ocupada" };
    case "deferred": return { status: "adiado", reason: reason === "outro" ? "equipe_conversando" : reason };
    case "failed": return { status: "falhou", reason: reason === "outro" ? "falha_provedor" : reason };
    case "failed_permanent": return /cancelado pela equipe/i.test(r.detail ?? "") ? { status: "cancelado", reason: "cancelado_pela_equipe" } : { status: "falhou", reason: "numero_sem_whatsapp" };
    case "vetoed": return { status: "barrado", reason: "revisao_barrou" };
    case "duplicate": return { status: "coberto", reason: "ja_enviado" };
    default: return { status: "incerto", reason: "sem_evidencia" };
  }
}

export type View = "hoje" | "proximos" | "atencao" | "historico";
export interface DispatchFilters {
  view?: View;
  from?: string; // AAAA-MM-DD local
  to?: string;
  kinds?: ItemKind[];
  campaignId?: string;
  status?: DispatchStatus[];
  reason?: string;
  ruleId?: string;
  q?: string;
  professionalId?: string;
  recoverableToday?: boolean;
  extended?: boolean;
  page?: number;
  itemId?: string; // busca UM item pela identidade (sem depender de pagina/limite da listagem)
  pageSize?: number;
}

export interface Counters {
  esperados: number;
  excluidos: number;
  elegiveis: number;
  nao_tentados: number;
  em_andamento: number;
  aceitos: number; // aceito pelo provedor e ainda SEM confirmacao de entrega
  confirmados_equipe: number; // a EQUIPE atestou que chegou (sem evidencia do provedor): nunca somado a aceito/entregue
  entregues: number;
  lidos: number;
  entrega_falhou: number;
  programados: number;
  cancelados: number;
  encaminhados: number;
  adiados: number;
  barrados: number;
  falhos: number;
  incertos: number;
  expirados: number;
  bloqueados: number;
  cobertos: number;
  recuperaveis_hoje: number;
}
const zeroCounters = (): Counters => ({ esperados: 0, excluidos: 0, elegiveis: 0, nao_tentados: 0, em_andamento: 0, programados: 0, cancelados: 0, encaminhados: 0, aceitos: 0, confirmados_equipe: 0, entregues: 0, lidos: 0, entrega_falhou: 0, adiados: 0, barrados: 0, falhos: 0, incertos: 0, expirados: 0, bloqueados: 0, cobertos: 0, recuperaveis_hoje: 0 });

export function countItems(items: DispatchItem[]): Counters {
  const c = zeroCounters();
  for (const i of items) {
    c.esperados++;
    if (i.status === "excluido") { c.excluidos++; continue; }
    c.elegiveis++;
    if (i.recoverable) c.recuperaveis_hoje++;
    switch (i.status) {
      case "nao_tentado": c.nao_tentados++; break;
      case "em_andamento": c.em_andamento++; break;
      case "programado": c.programados++; break;
      case "cancelado": c.cancelados++; break;
      case "encaminhado": c.encaminhados++; break;
      case "aceito": c.aceitos++; break;
      case "confirmado_equipe": c.confirmados_equipe++; break;
      case "entregue": c.entregues++; break;
      case "lido": c.lidos++; break;
      case "entrega_falhou": c.entrega_falhou++; break;
      case "adiado": c.adiados++; break;
      case "barrado": c.barrados++; break;
      case "falhou": c.falhos++; break;
      case "incerto": c.incertos++; break;
      case "expirado": c.expirados++; break;
      case "bloqueado": c.bloqueados++; break;
      case "coberto": c.cobertos++; break;
    }
  }
  return c;
}

export interface CoverageKind {
  kind: ItemKind;
  counters: Counters;
  fonteCompleta: boolean;
  fonteNota: string;
  cobertura: number | null; // % dos elegiveis que foram ACEITOS pelo provedor (ou alem). null = nao calculavel (fonte incompleta)
  porMotivo: Record<string, number>;
}

export interface DispatchView {
  geradoEm: string;
  fuso: string;
  hoje: string;
  periodo: { from: string; to: string };
  total: number;
  page: number;
  pageSize: number;
  items: DispatchItem[];
  counters: Counters;
  cobertura: CoverageKind[];
  politica: Awaited<ReturnType<typeof loadAllPolicies>>;
  motivos: Record<string, string>;
  avisos: string[];
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 31; d = addDays(d, 1)) out.push(d);
  return out;
}
const parts = (day: string) => { const [y, m, d] = day.split("-").map(Number); return { year: y, month: m, day: d }; };

export function resolvePeriod(f: DispatchFilters, today: string): { from: string; to: string } {
  const view = f.view ?? "hoje";
  let from = f.from, to = f.to;
  if (!from || !to) {
    if (view === "hoje") { from = today; to = today; }
    else if (view === "proximos") { from = addDays(today, 1); to = addDays(today, 7); }
    else if (view === "atencao") { from = addDays(today, -6); to = today; }
    else { from = addDays(today, -14); to = addDays(today, -1); }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from!) || !/^\d{4}-\d{2}-\d{2}$/.test(to!)) { from = today; to = today; }
  if (from! > to!) [from, to] = [to, from];
  if (daysBetween(from!, to!).length >= 31) to = addDays(from!, 30);
  return { from: from!, to: to! };
}

export async function buildDispatchView(clinicId: string, f: DispatchFilters = {}, nowIn?: Date): Promise<DispatchView> {
  const now = nowIn ?? new Date();
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true, uazapiDownSince: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const today = isoDateInZone(now, tz);
  const period = resolvePeriod(f, today);
  const avisos: string[] = [];
  const policies = await loadAllPolicies(clinicId);
  const hasCe = !!(await prisma.clinicaExpertsAccount.findFirst({ where: { clinicId }, select: { id: true } }).catch(() => null));
  const rules = await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const kindOfRule = (r: ReminderRule): DispatchKind => (r.parentRuleId ? "cobranca" : effectivePurpose(r) === "lembrete" ? "lembrete" : "confirmacao");

  const items: DispatchItem[] = [];
  const days = daysBetween(period.from, period.to);

  // ---------------- LEMBRETES / CONFIRMACOES / COBRANCAS ----------------
  const rows = await prisma.reminderDispatch.findMany({ where: { clinicId, sendDay: { gte: period.from, lte: period.to } }, orderBy: { createdAt: "asc" } });
  const patientIds = new Set<string>(rows.map((r) => r.patientId));
  const earlyPatients = rows.length ? await prisma.patient.findMany({ where: { id: { in: [...patientIds] } }, select: { id: true, phone: true, optedOut: true } }) : [];
  const earlyById = new Map(earlyPatients.map((p) => [p.id, p]));
  const apptIds = [...new Set(rows.map((r) => r.appointmentId).filter((x): x is string => !!x))];
  const apptRows = apptIds.length ? await prisma.appointment.findMany({ where: { id: { in: apptIds } }, include: { professional: { select: { name: true } }, procedure: { select: { name: true } } } }) : [];
  const apptMap = new Map(apptRows.map((a) => [a.id, a]));

  const policyFor = (kind: DispatchKind) => policies[kind];
  const recoverableReminder = (r: { state: string; startsAt: Date; sendDay: string; attempt: number; patientConfirmed?: boolean; apptStatus?: string }, status: DispatchStatus, kind: DispatchKind): { ok: boolean; why: string } => {
    if (!["falhou", "adiado", "nao_tentado", "barrado", "expirado", "incerto"].includes(status)) return { ok: false, why: "já tratado" };
    if (status === "incerto") return { ok: false, why: "resultado incerto: concilie antes (pode ter saído)" };
    if (r.sendDay !== today) return { ok: false, why: "o dia do envio já passou: não é recuperado em outro dia" };
    if (r.apptStatus && r.apptStatus !== "confirmed") return { ok: false, why: "agendamento cancelado/encerrado" };
    if (r.patientConfirmed) return { ok: false, why: "paciente já confirmou" };
    const lead = policyFor(kind).minLeadMin * 60_000;
    if (r.startsAt.getTime() - now.getTime() < lead) return { ok: false, why: "o atendimento está muito próximo para ainda fazer sentido" };
    const hard = zonedWallClockToUtc(tz, parts(today).year, parts(today).month, parts(today).day, HARD_LAST_HOUR, 0);
    if (now.getTime() >= hard.getTime()) return { ok: false, why: "depois do limite do dia (21h)" };
    return { ok: true, why: "elegível para recuperação hoje (será revalidado no envio)" };
  };

  const seenDispatchKey = new Set<string>();
  for (const r of rows) {
    const rule = ruleById.get(r.ruleId) ?? null;
    const kind: DispatchKind = rule ? kindOfRule(rule) : r.kind === "cobranca" ? "cobranca" : r.kind === "do_dia" ? "lembrete" : "confirmacao";
    const appt = r.appointmentId ? apptMap.get(r.appointmentId) : undefined;
    const { status, reason } = statusOfReminderRow(r, now);
    let rec = recoverableReminder({ state: r.state, startsAt: r.startsAt, sendDay: r.sendDay, attempt: r.attempt, patientConfirmed: appt?.patientConfirmed, apptStatus: appt?.status }, status, kind);
    const ep = earlyById.get(r.patientId);
    if (rec.ok && ep) {
      const pinfo = parsePhone(ep.phone);
      if (ep.optedOut) rec = { ok: false, why: "a pessoa pediu para não receber mensagens" };
      else if (!pinfo.valid) rec = { ok: false, why: "telefone inválido: corrija o cadastro antes de tentar de novo" };
      else if (r.state === "failed_permanent" && r.destination && canonicalKey(r.destination) === canonicalKey(ep.phone)) rec = { ok: false, why: "o número já foi recusado pelo WhatsApp: corrija o cadastro para tentar de novo" };
    }
    seenDispatchKey.add(`${r.bookingKey}|${r.ruleId}|${r.startsAt.getTime()}`);
    const pat = r.patientId;
    items.push({
      id: `rd:${r.id}`, source: "reminder", origin: appt ? (appt.ceBookingUuid ? "Clínica Experts" : appt.source ? `agenda (${appt.source})` : "agenda da Alice") : null, kind, ruleId: r.ruleId, ruleName: rule ? ruleLabel(rule) : null, patientId: pat, patientName: "", phone: "", professional: appt?.professional?.name ?? null, procedure: appt?.procedure?.name ?? null,
      referenceAt: r.startsAt.toISOString(), sendDay: r.sendDay, status, statusLabel: STATUS_LABEL[status], reason, reasonLabel: REASONS[reason] ?? reason, detail: r.detail ? mask(r.detail) : null,
      attempts: r.attempt, attemptedAt: iso(r.attemptedAt), nextAttemptAt: iso(r.nextAttemptAt), deadlineAt: iso(r.deadlineAt), extendedReason: r.extendedReason, extended: !!r.extendedReason,
      destination: r.destination ? maskDigits(r.destination) : null, providerId: shortId(r.providerId), providerIdFull: r.providerId ?? null, messageText: r.messageText ?? null, deliveryState: r.deliveryState, recoverable: rec.ok, recoverableWhy: rec.why, actions: actionsFor(status, rec.ok, r.state),
    });
  }

  // esperados sem linha de controle: reconstruidos dos agendamentos (fonte) por regra de calendario (confirmacao/lembrete; a cobranca depende da mae)
  const calendarRules = rules.filter((r) => r.active && !r.parentRuleId && r.dayOffset != null && r.sendHour != null);
  for (const rule of calendarRules) {
    const kind = kindOfRule(rule);
    for (const sendDay of days) {
      const target = addDays(sendDay, rule.dayOffset!);
      const wd = new Date(Date.UTC(parts(target).year, parts(target).month - 1, parts(target).day)).getUTCDay();
      if (!ruleAppliesOnWeekday(rule, wd)) continue;
      // a regra especifica de um dia da semana substitui a generica: se existe outra regra com dias que cobre esse dia, a generica nao se aplica
      if (!rule.weekdays && rules.some((o) => o.active && o.id !== rule.id && !o.parentRuleId && o.weekdays && effectivePurpose(o) === effectivePurpose(rule) && ruleAppliesOnWeekday(o, wd))) continue;
      const [ty, tm, td] = target.split("-").map(Number);
      const dayStart = zonedWallClockToUtc(tz, ty, tm, td, 0, 0);
      const nextDay = new Date(Date.UTC(ty, tm - 1, td + 1));
      const dayEnd = zonedWallClockToUtc(tz, nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0);
      const appts = await prisma.appointment.findMany({
        where: { clinicId, scheduledAt: { gte: dayStart, lt: dayEnd } },
        include: { patient: true, professional: { select: { name: true } }, procedure: { select: { name: true } } },
        orderBy: { scheduledAt: "asc" },
      });
      // so conhece a selecao "viva" do ciclo para hoje/futuro; passado e reconstruido so da fonte
      let held = new Map<string, HeldReminder>(), dueIds = new Set<string>();
      if (sendDay >= today) {
        const sel = await selectReminderCandidates(rule, now, tz, { targetDate: target, skipWindow: true, clinicRules: rules.filter((r) => r.active) }).catch(() => null);
        if (sel) { held = new Map(sel.held.map((h) => [h.appointmentId, h])); dueIds = new Set(sel.due.map((a) => a.id)); }
      }
      const winStart = fixedReminderTime(new Date(Date.UTC(ty, tm - 1, td, 15)), rule.dayOffset!, rule.sendHour!, rule.sendMinute, tz);
      // ampliacao automatica ja valendo agora? (a janela normal fechou, ha causa operacional e ainda estamos antes do prazo final)
      const extCtx = sendDay === today ? await resolveExtension(rule, kind, tz, new Date(Date.UTC(ty, tm - 1, td, 15)), now).catch(() => null) : null;
      for (const a of appts) {
        if (seenDispatchKey.has(`${bookingKeyOf(a)}|${rule.id}|${a.scheduledAt.getTime()}`)) continue;
        patientIds.add(a.patientId);
        let status: DispatchStatus = "nao_tentado";
        let reason = "sem_evidencia";
        let detail: string | null = null;
        const pi = parsePhone(a.patient.phone);
        if (a.status !== "confirmed") { status = "excluido"; reason = "cancelado"; detail = `agendamento ${a.status}`; }
        else if (a.patientConfirmed && !rule.resendIfConfirmed && effectivePurpose(rule) === "confirmacao") { status = "excluido"; reason = "confirmado"; }
        else if (a.patient.optedOut) { status = "excluido"; reason = "plano_ou_opt_out"; detail = "pediu para não receber mensagens"; }
        else if (!a.patient.phone) { reason = "telefone_ausente"; }
        else if (!pi.valid) { reason = "telefone_invalido"; detail = `telefone inválido (${pi.invalid ?? "formato"})`; }
        else if (dueIds.has(a.id)) {
          const wEnd = normalWindowEnd(rule, a.scheduledAt, tz);
          const dl = extCtx?.allowed && wEnd ? extendedDeadline(extCtx.policy, { windowEnd: wEnd, appointmentStart: a.scheduledAt, timeZone: tz }) : null;
          if (now.getTime() < winStart.getTime()) { reason = "ainda_nao_e_hora"; detail = "janela ainda não abriu"; }
          else if (!wEnd || now.getTime() < wEnd.getTime()) { reason = "capacidade"; detail = "elegível e ainda na fila de envio desta janela"; }
          else if (dl && now.getTime() < dl.getTime()) { reason = "capacidade"; detail = `janela ampliada (causa: ${extCtx!.cause}) até ${dl.toISOString()}: sai nas próximas rodadas`; }
          else { status = "expirado"; reason = "fora_da_janela"; detail = "a janela normal fechou sem tentativa registrada e não há ampliação ativa; a equipe ainda pode recuperar hoje"; }
        }
        else if (held.has(a.id)) { const h = held.get(a.id)!; reason = reasonFromDetail(h.detail, h.code === "reserva_nao_efetivada_no_ce" ? "ce_indisponivel" : "outro"); detail = h.detail; if (/remarc|alterad/.test(h.detail.toLowerCase())) reason = "remarcado"; }
        else if (sendDay < today) { reason = "sem_evidencia"; detail = "sem registro de tentativa e a janela do dia já passou (causa não comprovada)"; status = "expirado"; }
        else if (sendDay === today) {
          const end = normalWindowEnd(rule, a.scheduledAt, tz);
          if (end && now.getTime() >= end.getTime()) { status = "expirado"; reason = "fora_da_janela"; detail = "a janela normal fechou sem tentativa registrada"; }
          else { reason = "ainda_nao_e_hora"; detail = "dentro do dia; ainda sem tentativa"; }
        }
        else { reason = "ainda_nao_e_hora"; }
        const rec = recoverableReminder({ state: "none", startsAt: a.scheduledAt, sendDay, attempt: 0, patientConfirmed: a.patientConfirmed, apptStatus: a.status }, status, kind);
        const eligibleNow = rec.ok && (dueIds.has(a.id) || status === "expirado" || status === "nao_tentado") && pi.valid && !a.patient.optedOut;
        items.push({
          id: `ex:r:${rule.id}:${a.id}:${a.scheduledAt.getTime()}:${sendDay}`, source: "expected_reminder", kind, ruleId: rule.id, ruleName: ruleLabel(rule), patientId: a.patientId, patientName: displayName(a.patient.name), phone: maskPhone(a.patient.phone),
          professional: a.professional?.name ?? null, procedure: a.procedure?.name ?? null, referenceAt: a.scheduledAt.toISOString(), sendDay, status, statusLabel: STATUS_LABEL[status], reason, reasonLabel: REASONS[reason] ?? reason, detail: detail ? mask(detail) : null,
          attempts: 0, attemptedAt: null, nextAttemptAt: null, deadlineAt: null, extendedReason: null, extended: false, destination: null, providerId: null, providerIdFull: null, messageText: null, deliveryState: null,
          recoverable: eligibleNow, recoverableWhy: eligibleNow ? "elegível para recuperação hoje (será revalidado no envio)" : rec.why, actions: actionsFor(status, eligibleNow, "none"),
        });
      }
    }
  }

  // ---------------- ANIVERSARIOS ----------------
  const bdayRule = await prisma.birthdayRule.findFirst({ where: { clinicId, active: true }, orderBy: { createdAt: "asc" } });
  const allBdayPatients = await prisma.patient.findMany({ where: { clinicId, birthDate: { not: null } }, select: { id: true, name: true, phone: true, birthDate: true, optedOut: true, active: true, contactKind: true } });
  const noBirthCount = await prisma.patient.count({ where: { clinicId, birthDate: null, active: true } });
  const years = [...new Set(days.map((d) => parts(d).year))];
  const bRows = await prisma.birthdaySent.findMany({ where: { year: { in: years }, rule: { clinicId } } });
  for (const day of days) {
    const p = parts(day);
    for (const pt of allBdayPatients) {
      if (!isBirthdayToday(pt.birthDate!, p)) continue;
      const mine = bRows.filter((r) => r.patientId === pt.id && r.year === p.year);
      const best = mine.find((r) => ["sent", "unconfirmed", "legacy", "duplicate"].includes(r.state)) ?? mine[0] ?? null;
      const pi = parsePhone(pt.phone);
      let status: DispatchStatus, reason: string, detail: string | null = null, rec = { ok: false, why: "" };
      if (best) {
        ({ status, reason } = statusOfBirthdayRow(best, now));
        detail = best.detail ? mask(best.detail) : null;
        const v = birthdayVerdict(pt, mine, { maxAttempts: policies.aniversario.maxAttempts, retryGapMin: policies.aniversario.retryGapMin }, now);
        rec = day === today && ["falhou", "adiado", "barrado"].includes(status) && (v.verdict === "send" || v.verdict === "wait") && !pt.optedOut && pi.valid && !(status === "falhou" && best.state === "failed_permanent" && v.verdict !== "send")
          ? { ok: true, why: "elegível para nova tentativa hoje (será revalidado no envio)" }
          : { ok: false, why: day !== today ? "o dia do aniversário já passou" : status === "incerto" ? "resultado incerto: concilie antes" : "não recuperável agora" };
        if (day !== today && ["falhou", "adiado", "barrado", "em_andamento"].includes(status) && !best.deliveryState) { status = "expirado"; reason = reason === "ja_enviado" ? "prazo_expirado" : reason; }
      } else if (pt.contactKind !== "paciente") { status = "excluido"; reason = "nao_paciente"; detail = "classificado como não-paciente: sem automação de aniversário";
      } else if (pt.optedOut || !pt.active) { status = "excluido"; reason = "plano_ou_opt_out"; detail = pt.optedOut ? "pediu para não receber mensagens" : "paciente fora de acompanhamento"; }
      else if (!pt.phone) { status = "nao_tentado"; reason = "telefone_ausente"; }
      else if (!pi.valid) { status = "nao_tentado"; reason = "telefone_invalido"; detail = `telefone inválido (${pi.invalid ?? "formato"})`; }
      else if (!bdayRule) { status = "nao_tentado"; reason = "regra_inativa"; detail = "não há regra de aniversário ativa"; }
      else if (day > today) { status = "nao_tentado"; reason = "ainda_nao_e_hora"; }
      else if (day < today) { status = "expirado"; reason = "prazo_expirado"; detail = "sem registro de envio e o dia já passou (causa não comprovada)"; }
      else {
        const h = wallClockInZone(now, tz).hour;
        if (h < bdayRule.sendHour) { status = "nao_tentado"; reason = "ainda_nao_e_hora"; }
        else { status = "nao_tentado"; reason = "sem_evidencia"; detail = "dentro do dia, ainda sem tentativa registrada"; rec = { ok: true, why: "elegível para envio hoje (será revalidado no envio)" }; }
      }
      items.push({
        id: best ? `bd:${best.id}` : `ex:b:${pt.id}:${day}`, source: best ? "birthday" : "expected_birthday", kind: "aniversario", ruleId: bdayRule?.id ?? null, ruleName: bdayRule?.name ?? null, patientId: pt.id, patientName: displayName(pt.name), phone: maskPhone(pt.phone),
        professional: null, procedure: null, referenceAt: new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).toISOString(), sendDay: day, status, statusLabel: STATUS_LABEL[status], reason, reasonLabel: REASONS[reason] ?? reason, detail,
        attempts: best?.attempts ?? 0, attemptedAt: iso(best?.attemptedAt), nextAttemptAt: iso(best?.nextAttemptAt), deadlineAt: null, extendedReason: null, extended: false,
        destination: best?.destination ? maskDigits(best.destination) : null, providerId: shortId(best?.providerId), providerIdFull: best?.providerId ?? null, messageText: best?.messageText ?? null, deliveryState: best?.deliveryState ?? null, recoverable: rec.ok, recoverableWhy: rec.why, actions: actionsFor(status, rec.ok, best?.state ?? "none"),
      });
    }
  }

  // ADAPTADORES: renovacao, retorno combinado, campanha, pos, pre, recontato e retomadas (cada um le o SEU controle persistente; nada e duplicado)
  const { adapterItems } = await import("./adapters.js");
  for (const it of await adapterItems(clinicId, period, tz, now)) { if (!items.some((x) => x.id === it.id)) items.push(it); }

  // nomes e telefones (uma consulta so)
  const pats = patientIds.size ? await prisma.patient.findMany({ where: { id: { in: [...patientIds] } }, select: { id: true, name: true, phone: true } }) : [];
  const pmap = new Map(pats.map((p) => [p.id, p]));
  for (const it of items) if (!it.patientName) { const p = pmap.get(it.patientId); it.patientName = displayName(p?.name); it.phone = maskPhone(p?.phone); }

  for (const it of items) if (it.status === "nao_tentado" && it.reason === "ainda_nao_e_hora") { it.status = "programado"; it.statusLabel = STATUS_LABEL.programado; }

  // ---------------- FILTROS ----------------
  const view = f.view ?? "hoje";
  let list = items;
  if (f.itemId) list = list.filter((i) => i.id === f.itemId); // identidade exata: nao depende de pagina nem do limite de 200
  if (view === "atencao" && !f.status) list = list.filter((i) => ["falhou", "incerto", "expirado", "adiado", "nao_tentado", "entrega_falhou", "barrado"].includes(i.status) && !(i.status === "nao_tentado" && i.reason === "ainda_nao_e_hora"));
  if (f.kinds?.length) list = list.filter((i) => f.kinds!.includes(i.kind));
  if (f.campaignId) list = list.filter((i) => i.campaignId === f.campaignId);
  if (f.status?.length) list = list.filter((i) => f.status!.includes(i.status));
  if (f.reason) list = list.filter((i) => i.reason === f.reason);
  if (f.ruleId) list = list.filter((i) => i.ruleId === f.ruleId);
  if (f.professionalId) { const prof = await prisma.professional.findFirst({ where: { id: f.professionalId, clinicId }, select: { name: true } }); list = list.filter((i) => prof && i.professional === prof.name); }
  if (f.recoverableToday) list = list.filter((i) => i.recoverable);
  if (f.extended) list = list.filter((i) => i.extended);
  if (f.q?.trim()) {
    const q = f.q.trim().toLowerCase(), qd = q.replace(/\D/g, "");
    list = list.filter((i) => i.patientName.toLowerCase().includes(q) || (qd.length >= 3 && i.phone.replace(/\D/g, "").includes(qd)));
  }
  const prio: Record<DispatchStatus, number> = { programado: 9, cancelado: 11, encaminhado: 6, falhou: 0, incerto: 1, entrega_falhou: 1, expirado: 2, adiado: 3, nao_tentado: 4, barrado: 5, em_andamento: 6, bloqueado: 7, aceito: 8, confirmado_equipe: 8, entregue: 9, lido: 10, coberto: 11, excluido: 12 };
  list = [...list].sort((a, b) => (view === "atencao" || view === "hoje" ? prio[a.status] - prio[b.status] : 0) || a.sendDay.localeCompare(b.sendDay) * (view === "historico" ? -1 : 1) || a.referenceAt.localeCompare(b.referenceAt) || a.id.localeCompare(b.id));
  const counters = countItems(list);

  // cobertura por tipo (sobre o periodo, SEM os filtros de status: a auditoria nao muda com o filtro da lista)
  const cobertura: CoverageKind[] = (ITEM_KINDS as ItemKind[]).filter((k) => ["confirmacao", "cobranca", "lembrete", "aniversario"].includes(k) || items.some((i) => i.kind === k)).map((kind) => {
    const k = items.filter((i) => i.kind === kind);
    const c = countItems(k);
    const porMotivo: Record<string, number> = {};
    for (const i of k) if (!["aceito", "entregue", "lido", "coberto"].includes(i.status)) porMotivo[i.reason] = (porMotivo[i.reason] ?? 0) + 1;
    let fonteCompleta = true, nota = "Fonte: agendamentos importados para a Alice.";
    if (kind === "aniversario") { fonteCompleta = false; nota = `Só conhecemos aniversariantes com a data cadastrada na Alice (${noBirthCount} pessoa(s) ativa(s) sem data de nascimento). Quem existe só no sistema de agenda e não foi importado não aparece: cobertura não calculável.`; }
    else if (!["confirmacao", "cobranca", "lembrete", "aniversario"].includes(kind)) { fonteCompleta = false; nota = "Fonte: o controle próprio deste fluxo (só existe linha depois que o fluxo reservou/tentou). A Central não reconstrói o 'esperado' deste tipo: sem percentual de cobertura."; }
    else if (kind === "cobranca") { fonteCompleta = false; nota = "A cobrança depende de pedido inicial sem resposta: só aparece depois que a primeira solicitação foi tentada."; }
    else if (hasCe) { fonteCompleta = false; nota = "A agenda vem do Clínica Experts: reservas que ainda não foram importadas para a Alice não aparecem aqui. Cobertura não calculável como 100%."; }
    else nota = "Fonte: agenda da própria Alice (completa para esta clínica).";
    const cobertos = c.aceitos + c.entregues + c.lidos + c.cobertos;
    return { kind, counters: c, fonteCompleta, fonteNota: nota, cobertura: fonteCompleta && c.elegiveis > 0 ? Math.round((cobertos / c.elegiveis) * 1000) / 10 : null, porMotivo };
  });
  if (clinic.uazapiDownSince) avisos.push("O WhatsApp da clínica está desconectado: nenhum envio sai até reconectar (veja Canais).");
  if (items.length === 0) avisos.push("Nenhum evento esperado neste período.");

  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  return { geradoEm: now.toISOString(), fuso: tz, hoje: today, periodo: period, total: list.length, page, pageSize, items: list.slice((page - 1) * pageSize, page * pageSize), counters, cobertura, politica: policies, motivos: REASONS, avisos };
}

// Ids de TODOS os itens do filtro (para "selecionar todos os resultados do filtro", sem paginar). Limitado por seguranca.
export async function listFilteredIds(clinicId: string, f: DispatchFilters, now?: Date, onlyRecoverable = false): Promise<DispatchItem[]> {
  const v = await buildDispatchView(clinicId, { ...f, page: 1, pageSize: 200 }, now);
  if (v.total <= 200) return onlyRecoverable ? v.items.filter((i) => i.recoverable) : v.items;
  const all: DispatchItem[] = [...v.items];
  for (let p = 2; p <= Math.min(10, Math.ceil(v.total / 200)); p++) all.push(...(await buildDispatchView(clinicId, { ...f, page: p, pageSize: 200 }, now)).items);
  return onlyRecoverable ? all.filter((i) => i.recoverable) : all;
}

function displayName(n: string | null | undefined): string { return (n ?? "").trim() || "(sem nome)"; }
function ruleLabel(r: ReminderRule): string {
  const p = effectivePurpose(r);
  const when = r.dayOffset != null ? (r.dayOffset === 0 ? "no dia" : `${r.dayOffset} dia(s) antes`) : `${r.hoursBefore}h antes`;
  return `${r.parentRuleId ? "Cobrança" : p === "lembrete" ? "Lembrete" : "Confirmação"} · ${when}${r.weekdays ? " · dias específicos" : ""}`;
}

// Ações possíveis para o estado (a autorização continua no servidor; isto só guia a tela).
function actionsFor(status: DispatchStatus, recoverable: boolean, rawState: string): string[] {
  const a = ["detalhe", "atualizar"];
  if (recoverable) a.push("recuperar", "agendar_depois");
  if (status === "incerto") a.push("conciliar");
  if (["falhou", "adiado", "nao_tentado", "barrado", "expirado", "entrega_falhou"].includes(status)) a.push("encaminhar_humano");
  if (["falhou", "nao_tentado"].includes(status)) a.push("corrigir_cadastro", "resolver_telefone");
  if (["adiado", "falhou", "nao_tentado", "barrado"].includes(status) && rawState !== "none") a.push("cancelar_pendente");
  if (["adiado", "falhou", "nao_tentado", "barrado", "incerto"].includes(status)) a.push("reconferir_ce");
  return a;
}
