import { prisma } from "../db/client.js";
import { classifyReminder } from "./restoreReminders.js";
import { bookingKeyOf, acquireDispatch, finishDispatch, dispatchKind, sendDayOf, type DispatchKey } from "../reminders/ledger.js";
import { localDayBounds } from "../reminders/firstOfDay.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { sendText, isPermanentSendError, isAmbiguousSendError, isSendDeferred, connectionUsable } from "../uazapi/client.js";
import { verifyBookingLive, applyLiveVerdict } from "../clinicaexperts/liveCheck.js";
import { isPlaceholderProcedure, stripProcedureLines } from "../clinicaexperts/placeholderProcedure.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { maskPhone } from "../crm/leadPhones.js";
import { isoDateInZone, wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { auditarEnviosLisboa } from "./lisboaAuditoriaEnvios.js";
import { REVISION } from "../version.js";

// ---------------------------------------------------------------------------
// INCIDENTE DA LISBOA, 20/10/2026: pacientes de hoje sem a confirmacao antecipada (dia anterior, 8h-11h) e/ou sem a mensagem do dia (7h-8h).
// PREVIA POR PADRAO: nao envia, nao grava, nao consome tentativa e nao reabre etapa. A EXECUCAO so acontece com `executar` E `autorizado` (a autorizacao e uma decisao
// de uma pessoa, nao deste codigo), e antes de CADA envio tudo e revalidado com o banco de agora.
//
// O que a previa NUNCA faz: tratar a existencia de uma linha no banco como prova de envio ou de entrega ("aceito pelo provedor" != "entregue": o sistema nao recebe recibo
// de entrega das mensagens automaticas); reenviar resultado incerto; mandar duas mensagens equivalentes (a antecipada que falhou ontem e a do dia de hoje contam como UMA: o
// texto da antecipada diz "amanha" e hoje nao serve; hoje vale so a mensagem do dia); cobrar confirmacao de quem ja confirmou; mexer em horarios, cadencias ou politicas.
// ---------------------------------------------------------------------------

export const RECOVERY_MIN_LEAD_MS = 60 * 60_000; // faltando menos que isso, a mensagem do dia perdeu a pertinencia
export const RECOVERY_FIRST_HOUR = 7; // nunca antes das 7h locais (mesma regra do envio normal)
export const RECOVERY_LAST_HOUR = 20; // nem depois das 20h
const STALE_RESERVED_MS = 30 * 60_000;

export type EnvioEstado = "nenhum" | "aceito_pelo_provedor" | "incerto" | "veto" | "retencao" | "falha_definitiva" | "falha_tentara_de_novo" | "bloqueado_plano" | "duplicado" | "em_andamento" | "esgotado";
export type Acao = "enviar" | "nao_enviar" | "conferir_humano";

export interface LinhaRecuperacao {
  agendamento: string;
  pessoa: string; // primeiro nome + final do telefone
  reserva: string; // "CE <uuid curto>" | "local"
  horario: string; // dd/mm hh:mm (fuso da clinica)
  procedimento: string;
  faltou: string[]; // quais mensagens esperadas nao tem NENHUMA evidencia de envio aceito
  vencimento: Record<string, string>; // por tipo: janela e se ja fechou
  confirmacaoDePresenca: string;
  envioPorTipo: Record<string, { estado: EnvioEstado; detalhe: string }>;
  causa: { texto: string; comprovada: boolean };
  acao: Acao;
  motivo: string;
}

export interface PreviaRecuperacao {
  somenteLeitura: boolean;
  clinica: string;
  fuso: string;
  dia: string;
  agora: string;
  revisaoDoCodigo: string;
  tipo: "do_dia" | "dia_seguinte";
  regras: string[];
  jobs: { janela: string; rodadasRegistradas: number; resumo: Record<string, number> }[];
  whatsapp: { desconectadoDesde: string | null; motivo: string | null };
  totais: { agendamentosDoDia: number; enviar: number; nao_enviar: number; conferir_humano: number; porMotivo: Record<string, number> };
  linhas: LinhaRecuperacao[];
  pos: { fluxo: string; totais: Record<string, number>; candidatos: unknown[]; observacoes: string[] } | null;
  limites: string[];
}

export interface ResultadoExecucao {
  executado: true;
  tentados: number;
  aceitosPeloProvedor: number;
  naoEnviados: { agendamento: string; motivo: string }[];
  incertos: string[];
  falhas: string[];
}

const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "(sem nome)";
const hhmm = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };
const ddmm = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.day).padStart(2, "0")}/${String(w.month).padStart(2, "0")}`; };
const stamp = (d: Date, tz: string) => `${ddmm(d, tz)} ${hhmm(d, tz)}`;

const AFFIRM_RE = /\b(confirm\w*|confirmad[oa]|ok|certo|combinado|sim|estarei|estaremos|vou sim|presente|ate (la|amanha|logo)|pode ser)\b|👍|✅|🙏/i;
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// PURO: a resposta da paciente confirma a presenca? (leitura conservadora: qualquer outra coisa vira "respondeu, conferir")
export function looksLikeConfirmation(text: string): boolean {
  const t = fold(text).replace(/[^a-z0-9 👍✅🙏]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80) return false;
  if (/\b(nao|cancel\w*|desmarc\w*|remarc\w*|mudar|trocar|nao vou|nao posso|impossivel)\b/.test(t)) return false;
  return AFFIRM_RE.test(t);
}

type ApptRow = Awaited<ReturnType<typeof carregarAgendamentos>>[number];

async function carregarAgendamentos(clinicId: string, from: Date, to: Date) {
  return prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", scheduledAt: { gte: from, lt: to } },
    include: { patient: true, procedure: true, professional: true },
    orderBy: { scheduledAt: "asc" },
  });
}

function estadoDe(state: string, detail: string | null): { estado: EnvioEstado; detalhe: string } {
  const d = detail ?? "";
  switch (state) {
    case "sent": return { estado: "aceito_pelo_provedor", detalhe: "aceito pelo provedor; entrega NAO confirmada (nao ha recibo de entrega)" };
    case "unconfirmed": return { estado: "incerto", detalhe: `resultado incerto (pode ter chegado; nunca reenviado as cegas)${d ? `: ${d.slice(0, 80)}` : ""}` };
    case "vetoed": return { estado: "veto", detalhe: `a revisao por IA barrou${d ? `: ${d.slice(0, 120)}` : ""}` };
    case "deferred": return { estado: "retencao", detalhe: `retida/adiada sem consumir${d ? `: ${d.slice(0, 120)}` : ""}` };
    case "failed_permanent": return { estado: "falha_definitiva", detalhe: `falha definitiva${d ? `: ${d.slice(0, 120)}` : ""}` };
    case "failed": return { estado: "falha_tentara_de_novo", detalhe: `falha de envio (nada saiu)${d ? `: ${d.slice(0, 120)}` : ""}` };
    case "blocked": return { estado: "bloqueado_plano", detalhe: "envio automatico bloqueado para a clinica (plano)" };
    case "duplicate": return { estado: "duplicado", detalhe: "texto identico ja enviado ha pouco a esta pessoa" };
    case "reserved": return { estado: "em_andamento", detalhe: "reservado sem desfecho (em andamento ou processo interrompido)" };
    case "exhausted": return { estado: "esgotado", detalhe: `tentativas esgotadas${d ? `: ${d.slice(0, 120)}` : ""}` };
    default: return { estado: "nenhum", detalhe: `estado ${state}` };
  }
}

interface Contexto {
  clinicId: string;
  tz: string;
  agora: Date;
  doDia: { id: string; message: string; pauseMinSec: number; pauseMaxSec: number } | null;
  diaSeguinte: { id: string; message: string } | null;
  inicioHoje: Date;
}

// Avalia UM agendamento com o banco de agora (usada pela previa e, de novo, imediatamente antes de cada envio).
async function avaliar(ctx: Contexto, appt: ApptRow, tipo: "do_dia" | "dia_seguinte"): Promise<LinhaRecuperacao> {
  const { tz, agora } = ctx;
  const key = bookingKeyOf(appt);
  const dispatches = await prisma.reminderDispatch.findMany({ where: { clinicId: ctx.clinicId, bookingKey: key, startsAt: appt.scheduledAt }, orderBy: { createdAt: "asc" } });
  const sentRows = await prisma.reminderSent.findMany({ where: { appointmentId: appt.id }, select: { ruleId: true, sentAt: true } });
  const desde = new Date(ctx.inicioHoje.getTime() - 30 * 3_600_000); // desde ontem de manha
  const msgs = await prisma.message.findMany({
    where: { conversation: { patientId: appt.patientId }, createdAt: { gte: desde } },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, authorName: true, createdAt: true, deliveryStatus: true },
  });
  const conv = await prisma.conversation.findFirst({ where: { patientId: appt.patientId }, orderBy: { lastMessageAt: "desc" }, select: { humanTakeover: true } });

  const envioPorTipo: LinhaRecuperacao["envioPorTipo"] = {};
  const kindOf = (ruleId: string): string | null => (ctx.doDia && ruleId === ctx.doDia.id ? "do_dia" : ctx.diaSeguinte && ruleId === ctx.diaSeguinte.id ? "dia_seguinte" : null);
  for (const d of dispatches) {
    const k = d.kind === "do_dia" || d.kind === "dia_seguinte" ? d.kind : kindOf(d.ruleId);
    if (!k) continue;
    const e = estadoDe(d.state, d.detail);
    const prev = envioPorTipo[k];
    // o melhor desfecho vence: aceito > incerto > o resto
    const rank = (x: EnvioEstado) => (x === "aceito_pelo_provedor" ? 3 : x === "incerto" ? 2 : x === "nenhum" ? 0 : 1);
    if (!prev || rank(e.estado) >= rank(prev.estado)) envioPorTipo[k] = e;
  }
  for (const s of sentRows) {
    const k = kindOf(s.ruleId);
    if (k && !envioPorTipo[k]) envioPorTipo[k] = { estado: "aceito_pelo_provedor", detalhe: "registro de lembrete enviado (ReminderSent) sem linha de controle; entrega NAO confirmada" };
  }
  for (const k of ["dia_seguinte", "do_dia"] as const) if (!envioPorTipo[k]) envioPorTipo[k] = { estado: "nenhum", detalhe: "sem nenhum registro de envio para esta reserva" };

  // evidencia no chat (a mensagem existe no historico), por tipo de texto
  const naoPessoa = msgs.filter((m) => m.role !== "user" && m.deliveryStatus !== "failed" && m.deliveryStatus !== "failed_permanent");
  const chatDoDia = naoPessoa.filter((m) => m.createdAt >= ctx.inicioHoje && classifyReminder(m.content) === "do_dia");
  const chatAntecipada = naoPessoa.filter((m) => m.createdAt < ctx.inicioHoje && classifyReminder(m.content) === "dia_seguinte");
  if (envioPorTipo.do_dia.estado === "nenhum" && chatDoDia.length) envioPorTipo.do_dia = { estado: "aceito_pelo_provedor", detalhe: `mensagem equivalente no chat (${stamp(chatDoDia[0].createdAt, tz)}, ${chatDoDia[0].authorName ?? "equipe/Alice"}); entrega NAO confirmada` };
  if (envioPorTipo.dia_seguinte.estado === "nenhum" && chatAntecipada.length) envioPorTipo.dia_seguinte = { estado: "aceito_pelo_provedor", detalhe: `mensagem equivalente no chat (${stamp(chatAntecipada[0].createdAt, tz)}, ${chatAntecipada[0].authorName ?? "equipe/Alice"}); entrega NAO confirmada` };

  // confirmacao de presenca
  const lastAuto = [...naoPessoa].reverse().find((m) => classifyReminder(m.content) !== null);
  const respostas = lastAuto ? msgs.filter((m) => m.role === "user" && m.createdAt > lastAuto.createdAt) : msgs.filter((m) => m.role === "user");
  let confirmacao = "nenhuma";
  let confirmou = false;
  let respondeuOutra = false;
  if (appt.patientConfirmed) { confirmacao = "paciente confirmou (marcacao no agendamento)"; confirmou = true; }
  else if (respostas.some((r) => looksLikeConfirmation(r.content))) {
    const r = respostas.find((x) => looksLikeConfirmation(x.content))!;
    confirmacao = `resposta da paciente parece confirmar (${stamp(r.createdAt, tz)}): "${r.content.replace(/\s+/g, " ").slice(0, 40)}"`;
    confirmou = true;
  } else if (respostas.length) {
    confirmacao = `a paciente respondeu algo que NAO parece confirmacao (${stamp(respostas[0].createdAt, tz)}): conferir`;
    respondeuOutra = true;
  }

  // janelas / vencimentos
  const w = (dayOffset: number, h1: number, h2: number) => {
    const base = isoDateInZone(appt.scheduledAt, tz).split("-").map(Number);
    const dia = new Date(Date.UTC(base[0], base[1] - 1, base[2] - dayOffset));
    const a = zonedWallClockToUtc(tz, dia.getUTCFullYear(), dia.getUTCMonth() + 1, dia.getUTCDate(), h1, 0);
    const b = zonedWallClockToUtc(tz, dia.getUTCFullYear(), dia.getUTCMonth() + 1, dia.getUTCDate(), h2, 0);
    return `${stamp(a, tz)} a ${hhmm(b, tz)} (${agora.getTime() >= b.getTime() ? "JANELA JA FECHADA" : agora.getTime() < a.getTime() ? "ainda nao abriu" : "aberta"})`;
  };
  const vencimento: Record<string, string> = { dia_seguinte: w(1, 8, 11), do_dia: w(0, 7, 8) };

  const faltou = (["dia_seguinte", "do_dia"] as const).filter((k) => envioPorTipo[k].estado === "nenhum" || ["veto", "retencao", "falha_definitiva", "falha_tentara_de_novo", "esgotado", "bloqueado_plano", "duplicado"].includes(envioPorTipo[k].estado));

  // causa
  const causa = { texto: "a investigar", comprovada: false };
  const estados = Object.values(envioPorTipo).map((x) => x.estado);
  if (estados.includes("veto")) { causa.texto = "a revisao por IA barrou a mensagem (motivo no Diario de atividades)"; causa.comprovada = true; }
  else if (estados.includes("retencao")) { causa.texto = `mensagem retida/adiada: ${(Object.values(envioPorTipo).find((x) => x.estado === "retencao"))!.detalhe}`; causa.comprovada = true; }
  else if (estados.includes("falha_definitiva") || estados.includes("falha_tentara_de_novo")) { causa.texto = "falha de envio registrada pelo provedor"; causa.comprovada = true; }
  else if (estados.includes("esgotado")) { causa.texto = "tentativas de conferir o Clinica Experts esgotadas dentro da janela"; causa.comprovada = true; }
  else if (estados.includes("incerto")) { causa.texto = "resultado incerto (timeout no provedor): pode ter chegado"; causa.comprovada = true; }
  else if (appt.createdAt.getTime() > zonedWallClockToUtc(tz, ...(() => { const b = isoDateInZone(appt.scheduledAt, tz).split("-").map(Number); const d = new Date(Date.UTC(b[0], b[1] - 1, b[2] - 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 11, 0] as [number, number, number, number, number]; })()).getTime()) {
    causa.texto = `a reserva foi criada/importada em ${stamp(appt.createdAt, tz)}, DEPOIS do fim da janela da confirmacao antecipada (11h do dia anterior): so entra na reposicao se ficar 2h antes e sem nenhuma mensagem da Alice desde a criacao`;
    causa.comprovada = true;
  }

  // acao
  let acao: Acao = "enviar";
  let motivo = "mensagem do dia ausente e sem evidencia de envio equivalente";
  const nao = (m: string) => { acao = "nao_enviar"; motivo = m; };
  const humano = (m: string) => { acao = "conferir_humano"; motivo = m; };
  const hora = wallClockInZone(agora, tz).hour;
  if (tipo === "dia_seguinte") nao("o texto da confirmacao antecipada diz 'amanha': para um atendimento de HOJE vale so a mensagem do dia (nao se envia as duas para compensar)");
  else if (!ctx.doDia) humano("a clinica nao tem regra ativa da mensagem do dia (dayOffset 0)");
  else if (appt.scheduledAt.getTime() - agora.getTime() < RECOVERY_MIN_LEAD_MS) nao(appt.scheduledAt.getTime() <= agora.getTime() ? "o horario ja passou" : "faltam menos de 60 min: a mensagem perdeu a pertinencia");
  else if (hora < RECOVERY_FIRST_HOUR || hora >= RECOVERY_LAST_HOUR) nao(`fora do horario de comunicacao (${RECOVERY_FIRST_HOUR}h-${RECOVERY_LAST_HOUR}h, hora local ${hora}h)`);
  else if (appt.patient.optedOut) nao("a pessoa pediu para nao receber mensagens");
  else if (envioPorTipo.do_dia.estado === "aceito_pelo_provedor") nao("a mensagem do dia ja consta como aceita pelo provedor (nao se reenvia; entrega nao confirmada, conferir no chat se precisar)");
  else if (envioPorTipo.do_dia.estado === "incerto") humano("resultado incerto da mensagem do dia: pode ter chegado; nao reenviar as cegas");
  else if (envioPorTipo.do_dia.estado === "em_andamento") {
    const d = dispatches.find((x) => x.state === "reserved");
    if (d && agora.getTime() - d.updatedAt.getTime() > STALE_RESERVED_MS) humano("reserva sem desfecho (processo interrompido no envio): pode ter saido");
    else nao("outra execucao esta enviando agora");
  }
  else if (envioPorTipo.do_dia.estado === "veto") humano("a revisao por IA barrou a mensagem do dia: decidir se o motivo ainda vale");
  else if (envioPorTipo.do_dia.estado === "falha_definitiva") humano("falha definitiva (numero sem WhatsApp?): confirmar por outro meio");
  else if (envioPorTipo.do_dia.estado === "bloqueado_plano") nao("envio automatico bloqueado para esta clinica (plano)");
  else if (envioPorTipo.do_dia.estado === "duplicado") nao("o provedor ja enviou texto identico a esta pessoa ha pouco");
  else if (confirmou) nao("a paciente JA confirmou presenca: nao se cobra confirmacao de novo (avaliar a parte se a clinica quer outro lembrete informativo)");
  else if (respondeuOutra) humano("a paciente respondeu algo que nao parece confirmacao");
  else if (conv?.humanTakeover || msgs.some((m) => m.role === "human" && agora.getTime() - m.createdAt.getTime() < 3 * 3_600_000)) humano("equipe conversando com a paciente nas ultimas horas (ou atendimento humano ativo)");
  else if (isPlaceholderProcedure(appt.procedure)) { motivo = "mensagem do dia ausente (reserva sem procedimento: o texto sai sem a linha do procedimento)"; }

  return {
    agendamento: appt.id,
    pessoa: `${first(appt.patient.name)} (${maskPhone(appt.patient.phone)})`,
    reserva: appt.ceBookingUuid ? `CE ${appt.ceBookingUuid.slice(0, 8)}` : "local",
    horario: stamp(appt.scheduledAt, tz),
    procedimento: isPlaceholderProcedure(appt.procedure) ? "(reserva sem procedimento)" : appt.procedure.name,
    faltou, vencimento, confirmacaoDePresenca: confirmacao, envioPorTipo, causa, acao, motivo,
  };
}

async function montarContexto(clinicId: string, agora: Date, dia: string): Promise<{ ctx: Contexto; clinica: { name: string; timezone: string | null; uazapiDownSince: Date | null; uazapiDownReason: string | null }; regras: string[] }> {
  const clinica = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, timezone: true, uazapiDownSince: true, uazapiDownReason: true } });
  const tz = clinica.timezone || "America/Sao_Paulo";
  const rules = await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const ativas = rules.filter((r) => r.active && !r.parentRuleId);
  const tipoDe = (r: (typeof rules)[number]) => (r.dayOffset === 0 ? "do_dia" : r.dayOffset === 1 ? "dia_seguinte" : classifyReminder(r.message));
  const doDia = ativas.find((r) => tipoDe(r) === "do_dia") ?? null;
  const diaSeguinte = ativas.find((r) => tipoDe(r) === "dia_seguinte") ?? null;
  const [y, m, d] = dia.split("-").map(Number);
  const regras = rules.map((r) => `${r.active ? "LIGADA" : "DESLIGADA"} ${r.parentRuleId ? "(cobranca)" : tipoDe(r) ?? "nao classificada"}: ${r.dayOffset != null && r.sendHour != null ? `dia -${r.dayOffset}, ${r.sendHour}h-${r.sendEndHour ?? "?"}h` : `${r.hoursBefore}h antes`}; pausa ${r.pauseMinSec}-${r.pauseMaxSec}s`);
  return {
    clinica,
    regras,
    ctx: {
      clinicId, tz, agora,
      doDia: doDia ? { id: doDia.id, message: doDia.message, pauseMinSec: doDia.pauseMinSec, pauseMaxSec: doDia.pauseMaxSec } : null,
      diaSeguinte: diaSeguinte ? { id: diaSeguinte.id, message: diaSeguinte.message } : null,
      inicioHoje: zonedWallClockToUtc(tz, y, m, d, 0, 0),
    },
  };
}

// PREVIA (somente leitura): o que falta, por que, e o que seria feito.
export async function previaRecuperacaoLembretes(clinicId: string, opts: { dia?: string; agora?: Date; tipo?: "do_dia" | "dia_seguinte" } = {}): Promise<PreviaRecuperacao> {
  const agora = opts.agora ?? new Date();
  const tipo = opts.tipo ?? "do_dia";
  const clinicRow = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinicRow.timezone || "America/Sao_Paulo";
  const dia = opts.dia ?? isoDateInZone(agora, tz);
  const { ctx, clinica, regras } = await montarContexto(clinicId, agora, dia);
  const { start, end } = localDayBounds(ctx.inicioHoje, tz);
  const appts = await carregarAgendamentos(clinicId, start, end);

  // uma mensagem por pessoa por dia: so o primeiro horario do dia dispara; os demais ficam cobertos
  const primeiroDoDia = new Map<string, string>();
  for (const a of appts) if (!primeiroDoDia.has(a.patientId)) primeiroDoDia.set(a.patientId, a.id);

  const linhas: LinhaRecuperacao[] = [];
  for (const a of appts) {
    const l = await avaliar(ctx, a, tipo);
    if (primeiroDoDia.get(a.patientId) !== a.id && l.acao !== "nao_enviar") { l.acao = "nao_enviar"; l.motivo = "coberta pela mensagem do primeiro horario do dia desta pessoa (uma mensagem por pessoa por dia)"; }
    linhas.push(l);
  }

  // prova de execucao dos jobs nas janelas (AutomationRun existe desde a revisao que passou a grava-lo: ausencia de linha NAO prova que o job nao rodou)
  const janelas: { nome: string; from: Date; to: Date }[] = [
    { nome: "antecipada (dia anterior 08h-11h)", from: new Date(zonedWallClockToUtc(tz, ...ymd(dia, -1), 8, 0)), to: new Date(zonedWallClockToUtc(tz, ...ymd(dia, -1), 11, 0)) },
    { nome: "do dia (07h-08h)", from: new Date(zonedWallClockToUtc(tz, ...ymd(dia, 0), 7, 0)), to: new Date(zonedWallClockToUtc(tz, ...ymd(dia, 0), 8, 0)) },
  ];
  const jobs: PreviaRecuperacao["jobs"] = [];
  for (const j of janelas) {
    const runs = await prisma.automationRun.findMany({ where: { job: "lembretes", clinicId, startedAt: { gte: j.from, lt: j.to } }, select: { reasons: true } });
    const resumo: Record<string, number> = {};
    for (const r of runs) { try { for (const [k, v] of Object.entries(JSON.parse(r.reasons ?? "{}") as Record<string, number>)) resumo[k] = (resumo[k] ?? 0) + v; } catch { /* resumo ilegivel */ } }
    jobs.push({ janela: j.nome, rodadasRegistradas: runs.length, resumo });
  }
  const jamais = await prisma.automationRun.count({ where: { job: "lembretes", clinicId } });
  if (jamais === 0) jobs.push({ janela: "(historico)", rodadasRegistradas: 0, resumo: { "sem_nenhum_registro_de_rodada_de_lembretes": 1 } });

  // causa "a investigar" ganha o contexto do que o job registrou
  for (const l of linhas) {
    if (!l.causa.comprovada && l.faltou.length) {
      const jd = jobs.find((x) => x.janela.startsWith("do dia"));
      const ja = jobs.find((x) => x.janela.startsWith("antecipada"));
      const partes: string[] = [];
      if (ja) partes.push(`antecipada: ${ja.rodadasRegistradas} rodada(s) registrada(s) na janela${ja.rodadasRegistradas ? ` (${Object.entries(ja.resumo).map(([k, v]) => `${k}=${v}`).join(", ") || "sem detalhe"})` : ""}`);
      if (jd) partes.push(`do dia: ${jd.rodadasRegistradas} rodada(s) registrada(s) na janela${jd.rodadasRegistradas ? ` (${Object.entries(jd.resumo).map(([k, v]) => `${k}=${v}`).join(", ") || "sem detalhe"})` : ""}`);
      l.causa.texto = `a investigar. Registro das rodadas: ${partes.join("; ")}${clinica.uazapiDownSince ? `; WhatsApp marcado como desconectado desde ${stamp(clinica.uazapiDownSince, tz)}` : ""}`;
    }
  }

  const porMotivo: Record<string, number> = {};
  for (const l of linhas) porMotivo[`${l.acao}: ${l.motivo}`] = (porMotivo[`${l.acao}: ${l.motivo}`] ?? 0) + 1;

  const audit = await auditarEnviosLisboa(clinicId, { agora, dia }).catch(() => null);
  const posFluxo = audit?.fluxos.find((f) => /^Pos-procedimento/.test(f.fluxo));
  return {
    somenteLeitura: true,
    clinica: clinica.name, fuso: tz, dia, agora: stamp(agora, tz), revisaoDoCodigo: REVISION.split(":")[0], tipo,
    regras, jobs,
    whatsapp: { desconectadoDesde: clinica.uazapiDownSince ? clinica.uazapiDownSince.toISOString() : null, motivo: clinica.uazapiDownReason },
    totais: { agendamentosDoDia: linhas.length, enviar: linhas.filter((l) => l.acao === "enviar").length, nao_enviar: linhas.filter((l) => l.acao === "nao_enviar").length, conferir_humano: linhas.filter((l) => l.acao === "conferir_humano").length, porMotivo },
    linhas,
    pos: posFluxo ? { fluxo: posFluxo.fluxo, totais: posFluxo.totais as Record<string, number>, candidatos: posFluxo.candidatos, observacoes: posFluxo.observacoes } : null,
    limites: [
      "'aceito pelo provedor' NAO e 'entregue': o sistema nao recebe recibo de entrega das mensagens automaticas. So o aparelho/provedor prova entrega.",
      "Ausencia de AutomationRun nao prova que o job nao rodou (o resumo de rodada so existe nas revisoes que o gravam); presenca de linha de controle nao prova envio (veja o estado).",
      "A previa nao consulta o Clinica Experts (nem o WhatsApp): a execucao confere cada reserva ao vivo antes de enviar.",
      "Produzido contra o banco ao qual este comando esta conectado: so descreve a Lisboa de producao se rodar contra o banco de producao.",
    ],
  };
}

function ymd(dia: string, offset: number): [number, number, number] {
  const [y, m, d] = dia.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + offset));
  return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()];
}

// EXECUCAO: so com `executar` E `autorizado`. Cada envio revalida tudo com o banco de agora; o controle persistente (ReminderDispatch, atomico) impede duplicar com o cron.
export async function executarRecuperacaoLembretes(
  clinicId: string,
  opts: { dia?: string; agora?: () => Date; executar: boolean; autorizado: boolean; apenas?: string[]; sleep?: (ms: number) => Promise<void> },
): Promise<ResultadoExecucao> {
  if (!opts.executar || !opts.autorizado) throw new Error("Execucao recusada: exige `executar` E `autorizado` (autorizacao explicita de uma pessoa). Sem isso o comando so gera a previa.");
  const clock = opts.agora ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clinicRow = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinicRow.timezone || "America/Sao_Paulo";
  const dia = opts.dia ?? isoDateInZone(clock(), tz);
  const out: ResultadoExecucao = { executado: true, tentados: 0, aceitosPeloProvedor: 0, naoEnviados: [], incertos: [], falhas: [] };

  const previa = await previaRecuperacaoLembretes(clinicId, { dia, agora: clock(), tipo: "do_dia" });
  const alvos = previa.linhas.filter((l) => l.acao === "enviar" && (!opts.apenas || opts.apenas.includes(l.agendamento)));
  const info = await getClinicTemplateInfo(clinicId);

  for (const alvo of alvos) {
    const agora = clock();
    const { ctx } = await montarContexto(clinicId, agora, dia);
    if (!ctx.doDia) { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: "sem regra da mensagem do dia" }); continue; }
    // REVALIDACAO com o estado de agora
    const appt = await prisma.appointment.findUnique({ where: { id: alvo.agendamento }, include: { patient: true, procedure: true, professional: true } });
    if (!appt || appt.status !== "confirmed") { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: "a reserva nao esta mais confirmada" }); continue; }
    const linha = await avaliar(ctx, appt, "do_dia");
    if (linha.acao !== "enviar") { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: `revalidacao: ${linha.motivo}` }); continue; }
    const conn = await connectionUsable(clinicId).catch(() => ({ usable: true as const, since: null, reason: null }));
    if (!conn.usable) { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: "WhatsApp desconectado: nada foi tentado" }); continue; }
    // reserva no Clinica Experts: conferida ao vivo (cancelada/trocada/inconclusiva = nao envia)
    if (appt.ceBookingUuid) {
      const verdict = await verifyBookingLive(appt, tz);
      const action = await applyLiveVerdict(appt, verdict, appt.patient.name ?? "paciente");
      if (action !== "send") { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: `Clinica Experts: ${action === "skip" ? "reserva cancelada/atendida/horario trocado" : "conferencia inconclusiva (nada enviado, nada consumido)"}` }); continue; }
    }
    const rule = await prisma.reminderRule.findUnique({ where: { id: ctx.doDia.id } });
    if (!rule || !rule.active) { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: "a regra da mensagem do dia foi desligada" }); continue; }
    const noProcedure = isPlaceholderProcedure(appt.procedure);
    const text = renderMessageTemplate(noProcedure ? stripProcedureLines(rule.message) : rule.message, {
      patientName: appt.patient.name, patientPhone: appt.patient.phone, clinicName: info.name,
      locationName: info.primaryLocation?.name, locationAddress: info.primaryLocation?.fullAddress,
      procedureName: noProcedure ? "seu atendimento" : appt.procedure.name, professionalName: appt.professional?.name, when: appt.scheduledAt, timeZone: tz,
    });
    const key: DispatchKey = { clinicId, bookingKey: bookingKeyOf(appt), appointmentId: appt.id, patientId: appt.patientId, ruleId: rule.id, kind: dispatchKind(rule), startsAt: appt.scheduledAt, sendDay: sendDayOf(agora, tz) };
    const acq = await acquireDispatch(key, agora);
    if (!acq.ok) { out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: `controle de envio: ${acq.why}${acq.state ? ` (${acq.state})` : ""}` }); continue; }
    try { await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } }); }
    catch { await finishDispatch(acq.id, "duplicate", "registro de lembrete ja existia"); out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: "registro de lembrete ja existia" }); continue; }

    out.tentados++;
    try {
      const outcome = await sendText(clinicId, appt.patient.phone, text, { kind: "lembrete" });
      if (outcome === "sent") {
        await finishDispatch(acq.id, "sent", "recuperacao 20/10 (autorizada)");
        await recordAutomatedMessage(appt.patientId, text, "Lembrete de consulta");
        out.aceitosPeloProvedor++;
      } else {
        await finishDispatch(acq.id, outcome, `sendText=${outcome}`);
        if (outcome === "vetoed" || outcome === "duplicate" || outcome === "blocked") await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } }).catch(() => undefined);
        out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: `envio nao realizado (${outcome})` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSendDeferred(err)) { await finishDispatch(acq.id, "deferred", msg); await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } }); out.naoEnviados.push({ agendamento: alvo.agendamento, motivo: "WhatsApp/revisao indisponivel: nada saiu, nada consumido" }); }
      else if (isPermanentSendError(err)) { await finishDispatch(acq.id, "failed_permanent", msg); out.falhas.push(`${alvo.pessoa}: numero sem WhatsApp`); }
      else if (isAmbiguousSendError(err)) { await finishDispatch(acq.id, "unconfirmed", msg); out.incertos.push(`${alvo.pessoa}: resultado incerto (nao reenviado)`); }
      else { await finishDispatch(acq.id, "failed", msg); await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } }); out.falhas.push(`${alvo.pessoa}: ${msg.slice(0, 80)}`); }
    }
    await sleep((ctx.doDia.pauseMinSec + Math.random() * Math.max(0, ctx.doDia.pauseMaxSec - ctx.doDia.pauseMinSec)) * 1000);
  }
  return out;
}

// CLI. Padrao = PREVIA (somente leitura):
//   node dist/maintenance/lisboaRecuperacaoLembretes.js [--dia=AAAA-MM-DD] [--tipo=do_dia|dia_seguinte] [--clinica="Lisboa Beauty Center"]
// Execucao real (so com autorizacao explicita): acrescentar  --executar --autorizado  (e opcionalmente --apenas=id1,id2)
if (process.argv[1] && /lisboaRecuperacaoLembretes\.js$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const nome = arg("clinica") ?? "Lisboa Beauty Center";
  const tipo = arg("tipo") === "dia_seguinte" ? "dia_seguinte" : "do_dia";
  prisma.clinic.findFirst({ where: { name: nome } })
    .then(async (c) => {
      if (!c) throw new Error(`Clinica "${nome}" nao encontrada.`);
      if (flag("executar")) {
        const r = await executarRecuperacaoLembretes(c.id, { dia: arg("dia"), executar: true, autorizado: flag("autorizado"), apenas: arg("apenas")?.split(",") });
        console.log(JSON.stringify(r, null, 2));
      } else console.log(JSON.stringify(await previaRecuperacaoLembretes(c.id, { dia: arg("dia"), tipo }), null, 2));
    })
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
