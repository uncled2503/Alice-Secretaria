import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { connectionUsable } from "../uazapi/client.js";
import { maskPhone } from "../crm/leadPhones.js";
import { isoDateInZone, wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { deliverReminder, fixedReminderTime, selectReminderCandidates, type HeldReminder } from "./cron.js";
import { bookingKeyOf } from "./ledger.js";
import { localDayBounds } from "./firstOfDay.js";
import { effectivePurpose, formatWeekdays, ruleAppliesOnWeekday, weekdayInZone, WEEKDAY_NAMES } from "./policy.js";

// ---------------------------------------------------------------------------
// CONFIRMACAO DE UM DIA ESCOLHIDO: PREVIA e EXECUCAO CONTROLADA. Serve a "antecipar a confirmacao do proximo sabado" (a clinica quer a solicitacao ANTES da janela normal da regra) e a
// recuperar uma solicitacao que a janela perdeu. Nao e outro agendador: usa a MESMA selecao (selectReminderCandidates) e a MESMA via de envio (deliverReminder) do ciclo automatico,
// com o mesmo controle persistente de duplicidade (ReminderDispatch/ReminderSent) - rodar isto e depois o ciclo automatico nunca manda duas vezes.
//
// PREVIA: somente leitura. Mostra a data EXPLICITA, quantos agendamentos existem, quantos seriam elegiveis e, para cada um, o motivo. Nao envia, nao reserva, nao grava, nao consulta
// o Clinica Experts (a execucao confere cada reserva AO VIVO antes de enviar).
// EXECUCAO: quem chama ja decidiu (dono da conta); com teto por chamada e revalidacao de cada pessoa com o banco de agora.
// ---------------------------------------------------------------------------

export type LineVerdict = "elegivel" | "nao_elegivel" | "ja_atendida_por_esta_etapa";
export interface ConfirmationLine {
  appointmentId: string;
  pessoa: string; // primeiro nome + final do telefone
  horario: string; // HH:MM (fuso da clinica)
  procedimento: string;
  estado: string; // status do agendamento
  confirmouPresenca: boolean;
  veredito: LineVerdict;
  motivo: string;
}
export interface ConfirmationsPreview {
  somenteLeitura: true;
  clinica: string;
  fuso: string;
  geradoEm: string;
  dataDoAtendimento: string; // AAAA-MM-DD (data local, EXPLICITA)
  diaDaSemana: string;
  regra: { id: string; descricao: string; real: boolean; ativa: boolean; janelaNormal: string; origem: string } | null;
  avisos: string[];
  totais: { agendamentosNaData: number; confirmados: number; elegiveis: number; naoElegiveis: number; jaAtendidos: number; canceladosOuEncerrados: number; remarcados: number; reservasNaoEfetivadas: number };
  porMotivo: Record<string, number>;
  linhas: ConfirmationLine[];
  limites: string[];
}

const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "(sem nome)";
const hhmm = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };
const stamp = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.day).padStart(2, "0")}/${String(w.month).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };

// PURO: a data local (AAAA-MM-DD) do PROXIMO dia da semana pedido, sempre depois de hoje (se hoje ja e esse dia, e o da semana que vem). Resolvida pelo relogio e pelo fuso da clinica.
export function nextDateOfWeekday(now: Date, tz: string, weekday: number): string {
  const [y, m, d] = isoDateInZone(now, tz).split("-").map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  const delta = ((weekday - today.getUTCDay() + 7) % 7) || 7;
  const t = new Date(today.getTime() + delta * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// A regra de CONFIRMACAO (mae) que vale para esse dia da semana: a especifica do dia vence a generica. null = nenhuma.
export function confirmationRuleFor(rules: ReminderRule[], weekday: number): ReminderRule | null {
  const cands = rules.filter((r) => r.active && !r.parentRuleId && effectivePurpose(r) === "confirmacao" && ruleAppliesOnWeekday(r, weekday));
  return cands.find((r) => r.weekdays) ?? cands[0] ?? null;
}

export interface PreviewOpts {
  now?: Date;
  data?: string; // AAAA-MM-DD; sem isso, o proximo `diaDaSemana`
  diaDaSemana?: number; // 6 = sabado (padrao quando nao ha data)
  regra?: ReminderRule; // regra candidata (ex.: a do plano ainda nao criada); sem isso, a regra real que vale para o dia
}

export async function previewConfirmationsFor(clinicId: string, opts: PreviewOpts = {}): Promise<ConfirmationsPreview> {
  const now = opts.now ?? new Date();
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, timezone: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const data = opts.data ?? nextDateOfWeekday(now, tz, opts.diaDaSemana ?? 6);
  const wd = weekdayOfDate(data);
  const rules = await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const real = confirmationRuleFor(rules, wd);
  const rule = opts.regra ?? real;
  const avisos: string[] = [];
  const [y, m, d] = data.split("-").map(Number);
  const { start, end } = localDayBounds(zonedWallClockToUtc(tz, y, m, d, 12, 0), tz);

  const all = await prisma.appointment.findMany({
    where: { clinicId, scheduledAt: { gte: start, lt: end } },
    include: { patient: true, attendee: true, procedure: true },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  const base: ConfirmationsPreview = {
    somenteLeitura: true, clinica: clinic.name, fuso: tz, geradoEm: stamp(now, tz), dataDoAtendimento: data, diaDaSemana: WEEKDAY_NAMES[wd], regra: null, avisos,
    totais: { agendamentosNaData: all.length, confirmados: 0, elegiveis: 0, naoElegiveis: 0, jaAtendidos: 0, canceladosOuEncerrados: 0, remarcados: 0, reservasNaoEfetivadas: 0 },
    porMotivo: {}, linhas: [],
    limites: [
      "Previa: nada foi enviado, nada foi reservado nem gravado.",
      "Nao consulta o Clinica Experts nem o WhatsApp: a execucao confere cada reserva ao vivo antes de enviar (cancelada/trocada/inconclusiva = nao envia).",
      "'Elegivel' = passa em todas as regras de selecao; a revisao por IA do envio e a conexao do WhatsApp ainda decidem na hora. 'Aceito pelo provedor' nunca e 'entregue'.",
      "Produzida contra o banco ao qual este comando esta conectado: so descreve a clinica de producao se rodar contra o banco de producao.",
    ],
  };
  if (!rule) {
    avisos.push(`Nenhuma regra de confirmação ativa vale para ${WEEKDAY_NAMES[wd]}.`);
    return base;
  }
  const win = rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null
    ? `${stamp(fixedReminderTime(zonedWallClockToUtc(tz, y, m, d, 12, 0), rule.dayOffset, rule.sendHour, rule.sendMinute, tz), tz)} a ${hhmm(fixedReminderTime(zonedWallClockToUtc(tz, y, m, d, 12, 0), rule.dayOffset, rule.sendEndHour, 0, tz), tz)}`
    : "(sem janela de calendário: regra inválida para confirmação)";
  const real_ = !!real && real.id === rule.id;
  base.regra = { id: rule.id, descricao: `${rule.weekdays ? `só ${formatWeekdays(rule.weekdays)}` : "todos os dias"}; ${rule.dayOffset} dia(s) antes`, real: real_, ativa: rule.active, janelaNormal: win, origem: real_ ? "regra cadastrada" : "regra do plano ainda não criada (simulação)" };
  if (!real_) avisos.push("A regra usada nesta prévia ainda NÃO existe no cadastro: é a proposta do plano. Aplique o plano (com aprovação) antes de qualquer execução.");

  const selection = await selectReminderCandidates(rule, now, tz, { targetDate: data, skipWindow: true, clinicRules: [...rules.filter((r) => r.active && r.id !== rule.id), rule] });
  const dueIds = new Set(selection.due.map((a) => a.id));
  const held = new Map<string, HeldReminder>(selection.held.map((h) => [h.appointmentId, h]));
  const bookingKeys = all.map(bookingKeyOf);
  const sent = await prisma.reminderSent.findMany({ where: { appointmentId: { in: all.map((a) => a.id) } }, select: { appointmentId: true, ruleId: true } });
  const dispatches = bookingKeys.length ? await prisma.reminderDispatch.findMany({ where: { clinicId, bookingKey: { in: bookingKeys }, state: { in: ["sent", "unconfirmed", "reserved"] } }, select: { bookingKey: true, startsAt: true, kind: true, state: true } }) : [];

  const count = (code: string) => { base.porMotivo[code] = (base.porMotivo[code] ?? 0) + 1; };
  for (const a of all) {
    const line = (veredito: LineVerdict, motivo: string): ConfirmationLine => ({
      appointmentId: a.id, pessoa: `${first(a.attendee?.name ?? a.patient.name)} (${maskPhone(a.patient.phone)})`, horario: hhmm(a.scheduledAt, tz), procedimento: a.procedure.name,
      estado: a.status, confirmouPresenca: a.patientConfirmed, veredito, motivo,
    });
    let l: ConfirmationLine;
    if (a.scheduleChangedAt) base.totais.remarcados++;
    if (a.status !== "confirmed") {
      base.totais.canceladosOuEncerrados++;
      l = line("nao_elegivel", `agendamento ${a.status === "cancelled" ? "cancelado" : a.status === "no_show" ? "com falta registrada" : a.status === "completed" ? "já concluído" : a.status}: não recebe mensagem`);
      count(`cancelado_ou_encerrado:${a.status}`);
    } else {
      base.totais.confirmados++;
      const mine = sent.some((s) => s.appointmentId === a.id && s.ruleId === rule.id);
      const equivalent = dispatches.find((x) => x.bookingKey === bookingKeyOf(a) && x.startsAt.getTime() === a.scheduledAt.getTime() && x.kind !== "do_dia" && x.kind !== "cobranca");
      const h = held.get(a.id);
      if (mine || equivalent) {
        base.totais.jaAtendidos++;
        l = line("ja_atendida_por_esta_etapa", mine ? "já recebeu esta solicitação (aceita pelo provedor; entrega não confirmada)" : `já recebeu uma confirmação equivalente (${equivalent!.kind}, ${equivalent!.state})`);
        count("ja_recebeu");
      } else if (dueIds.has(a.id)) {
        base.totais.elegiveis++;
        l = line("elegivel", "passa em todas as regras de seleção (ainda sujeita à conferência ao vivo no Clínica Experts, à revisão do envio e à conexão do WhatsApp)");
        count("elegivel");
      } else if (h) {
        if (h.code === "reserva_nao_efetivada_no_ce") base.totais.reservasNaoEfetivadas++;
        base.totais.naoElegiveis++;
        l = line("nao_elegivel", h.detail);
        count(h.code);
      } else {
        base.totais.naoElegiveis++;
        l = line("nao_elegivel", "fora do escopo desta regra");
        count("fora_do_escopo");
      }
    }
    base.linhas.push(l);
  }
  const awaitingWindow = rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null;
  if (awaitingWindow) {
    const from = fixedReminderTime(zonedWallClockToUtc(tz, y, m, d, 12, 0), rule.dayOffset!, rule.sendHour!, rule.sendMinute, tz);
    const to = fixedReminderTime(zonedWallClockToUtc(tz, y, m, d, 12, 0), rule.dayOffset!, rule.sendEndHour!, 0, tz);
    if (now.getTime() < from.getTime()) avisos.push(`A janela normal desta regra ainda não abriu (abre ${stamp(from, tz)}): quem está elegível AGORA receberia a solicitação ANTECIPADA se for autorizado; senão sai sozinha na janela.`);
    else if (now.getTime() >= to.getTime()) avisos.push(`A janela normal desta regra já fechou (${stamp(to, tz)}): o ciclo automático NÃO envia para os que ficaram sem; só a recuperação controlada autorizada ou a reposição de quem foi agendado depois.`);
    else avisos.push("A janela normal desta regra está ABERTA agora: o ciclo automático envia sozinho; não é preciso antecipar.");
  }
  return base;
}

export interface ExecuteOpts {
  now?: () => Date;
  data: string;
  regraId: string;
  executar?: boolean; // (legado, ignorado: chamar a execucao ja e a decisao)
  autorizado?: boolean; // (legado, ignorado)
  apenas?: string[];
  limite?: number; // teto de envios por chamada (padrao 30)
  sleep?: (ms: number) => Promise<void>;
  origem?: string;
}
export interface ExecuteResult {
  executado: true;
  dataDoAtendimento: string;
  selecionados: number;
  tentados: number;
  detalhe: { agendamento: string; resultado: string }[];
  avisos: string[];
}

// EXECUCAO CONTROLADA. Cada pessoa passa pela mesma via do ciclo automatico (deliverReminder): estado fresco, conferencia ao vivo no CE, reserva atomica, envio, desfecho como aconteceu.
// Janela ignorada de proposito (e o objetivo); tudo o mais vale. Nunca reenvia resultado incerto e nunca acumula: uma etapa por pessoa.
export async function executeConfirmationsFor(clinicId: string, opts: ExecuteOpts): Promise<ExecuteResult> {
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const rule = await prisma.reminderRule.findFirst({ where: { id: opts.regraId, clinicId } });
  const out: ExecuteResult = { executado: true, dataDoAtendimento: opts.data, selecionados: 0, tentados: 0, detalhe: [], avisos: [] };
  if (!rule || !rule.active) throw new Error("A regra não existe nesta clínica ou está desligada: nada foi enviado.");
  if (rule.parentRuleId) throw new Error("A execução controlada vale para a solicitação principal; a cobrança segue o ciclo automático.");
  if (!ruleAppliesOnWeekday(rule, weekdayOfDate(opts.data))) throw new Error("A regra não vale para o dia da semana desta data: nada foi enviado.");

  const rules = await prisma.reminderRule.findMany({ where: { clinicId, active: true } });
  const sel = await selectReminderCandidates(rule, clock(), tz, { targetDate: opts.data, skipWindow: true, clinicRules: rules });
  const due = sel.due.filter((a) => !opts.apenas || opts.apenas.includes(a.id)).sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  out.selecionados = due.length;
  const limite = Math.min(opts.limite ?? 30, 60);
  const conn = await connectionUsable(clinicId).catch(() => ({ usable: true as const, since: null, reason: null }));
  if (!conn.usable) { out.avisos.push("WhatsApp desconectado: nada foi tentado."); return out; }
  const info = await getClinicTemplateInfo(clinicId);
  const env = { clock, tz, clinicInfo: info, stat: { deferred: 0, exhausted: 0, reasons: new Set<string>() }, ceDown: new Map<string, string>(), ceFailures: new Map<string, number>() };
  for (const appt of due) {
    if (out.tentados >= limite) { out.avisos.push(`Teto de ${limite} envios por chamada atingido: o restante fica para outra chamada autorizada.`); break; }
    const attempted = await deliverReminder(env, rule, appt, { ignoreWindow: true, pause: false, origin: opts.origem ?? "antecipada/recuperada (autorizada)" });
    const row = await prisma.reminderDispatch.findFirst({ where: { bookingKey: bookingKeyOf(appt), ruleId: rule.id, startsAt: appt.scheduledAt }, select: { state: true, detail: true } });
    out.detalhe.push({ agendamento: appt.id, resultado: row ? `${row.state}${row.detail ? ` (${row.detail})` : ""}` : attempted ? "tentado" : "não enviado (revalidação)" });
    if (attempted) {
      out.tentados++;
      await sleep((rule.pauseMinSec + Math.random() * Math.max(0, rule.pauseMaxSec - rule.pauseMinSec)) * 1000);
    }
  }
  return out;
}
