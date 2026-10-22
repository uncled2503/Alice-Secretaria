import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isSendDeferred, deferralInfo, isPermanentSendError, isAmbiguousSendError, type SendReport } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { RunRecorder } from "../crm/automationRuns.js";
import { parsePhone, canonicalKey } from "../uazapi/phone.js";
import { loadPolicy, HARD_LAST_HOUR, type PolicyValues } from "../dispatch/policy.js";
import type { BirthdayRule, BirthdaySent, Patient } from "@prisma/client";

// { hour, month (1-12), day } na timezone informada, no instante `at`.
function localParts(at: Date, timeZone: string): { hour: number; month: number; day: number; year: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), month: Number(parts.month), day: Number(parts.day), year: Number(parts.year) };
}

// ---------------------------------------------------------------------------
// ANIVERSARIO (relato da Lisboa, 19/10 e 21/10/2026: "nem os aniversariantes"). Regras desta versao:
//  - a mensagem sai a partir de rule.sendHour ate o fim do expediente de comunicacao do MESMO dia (BIRTHDAY_LAST_HOUR); com causa OPERACIONAL comprovada (job que nao rodou, WhatsApp fora,
//    falha recuperavel, fila acima da capacidade) a janela se AMPLIA ate o limite da politica (padrao 21h, teto duro 21h). Passou o dia = perdeu a pertinencia e NAO e recuperada no dia seguinte;
//  - cada tentativa fica REGISTRADA (BirthdaySent: reserved -> sent | unconfirmed | failed_permanent | duplicate | deferred | failed | vetoed), com destino, id do provedor e motivo; barrada/adiada/falha
//    comum NAO consomem o aniversario (tentam de novo, com intervalo e teto) e continuam VISIVEIS (antes a linha era apagada e o motivo se perdia);
//  - RESERVA x TENTATIVA: "reserved" sem attemptedAt (e criada por esta versao) prova que o provedor NAO foi chamado: e liberada. Com attemptedAt (ou registro anterior a este controle) o resultado e INCERTO: nunca reenvia;
//  - "mensagem identica ja enviada" so conta como cobertura com EVIDENCIA (a mensagem existe no chat); sem evidencia vira nova tentativa;
//  - falha definitiva por numero invalido/sem WhatsApp libera nova tentativa SE o telefone do cadastro mudou (corrigido no painel), ainda no dia correto;
//  - o instante e re-lido a cada pessoa (rodada longa nao envia fora do dia/horario) e o erro de UMA pessoa nunca interrompe as demais;
//  - telefone: leitura central (uazapi/phone.ts); numero que nao fecha NAO e enviado e fica visivel como "telefone invalido".
// ---------------------------------------------------------------------------
export const BIRTHDAY_LAST_HOUR = 20; // ultima hora (exclusiva) da janela NORMAL de parabens
const STALE_RESERVED_MS = 30 * 60_000;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// PURO: hoje (dia/mes/ano no fuso da clinica) e o aniversario desta data de nascimento? A data e guardada como meia-noite UTC e lida em UTC (nunca desloca o dia). Quem nasceu em
// 29/02 comemora em 29/02 nos anos bissextos e em 28/02 nos demais (decisao documentada; sem isso essa pessoa ficaria 3 anos sem parabens).
export function isBirthdayToday(birth: Date, today: { year: number; month: number; day: number }): boolean {
  const bm = birth.getUTCMonth() + 1, bd = birth.getUTCDate();
  if (bm === today.month && bd === today.day) return true;
  return bm === 2 && bd === 29 && !isLeap(today.year) && today.month === 2 && today.day === 28;
}

// PURO: so telefone que fecha como numero (brasileiro ou internacional valido) recebe.
export const birthdayPhoneOk = (phone: string): boolean => parsePhone(phone).valid;

// Estados que CONTAM como "ja coberto neste ano" (nao ha nova tentativa).
const COVERED = ["sent", "unconfirmed", "legacy", "duplicate"];
// Estados que podem ser tentados de novo (com intervalo e teto).
const RETRYABLE = ["deferred", "failed", "vetoed", "reserved"];

export interface BirthdayCandidate {
  patient: Patient;
  rule: BirthdayRule;
  row: BirthdaySent | null;
  verdict: "send" | "covered" | "wait" | "exhausted" | "final_same_phone" | "invalid_phone" | "same_phone_covered";
  reason: string;
}

// PURO: o que fazer com esta pessoa NESTE ano, dadas as linhas ja registradas (de qualquer regra da clinica) e o telefone de hoje.
export function birthdayVerdict(p: { phone: string }, rows: BirthdaySent[], policy: Pick<PolicyValues, "maxAttempts" | "retryGapMin">, now: Date): { verdict: BirthdayCandidate["verdict"]; reason: string; row: BirthdaySent | null } {
  const info = parsePhone(p.phone);
  if (!info.valid) return { verdict: "invalid_phone", reason: `telefone invalido (${info.invalid})`, row: rows[0] ?? null };
  const covered = rows.find((r) => COVERED.includes(r.state));
  if (covered) return { verdict: "covered", reason: `ja coberto neste ano (${covered.state})`, row: covered };
  const phoneKeyNow = canonicalKey(p.phone);
  const final = rows.find((r) => r.state === "failed_permanent");
  if (final) {
    const sameAsBefore = !final.destination || canonicalKey(final.destination) === phoneKeyNow;
    // numero corrigido depois da falha definitiva: nova tentativa (ainda no dia); mesmo numero: nao insiste
    if (sameAsBefore) return { verdict: "final_same_phone", reason: "falha definitiva com este mesmo telefone (corrija o cadastro para tentar de novo)", row: final };
    return { verdict: "send", reason: "telefone do cadastro mudou depois da falha definitiva: nova tentativa", row: final };
  }
  const retry = rows.find((r) => RETRYABLE.includes(r.state));
  if (retry) {
    if (retry.attempts >= policy.maxAttempts) return { verdict: "exhausted", reason: `tentativas esgotadas (${retry.attempts})`, row: retry };
    if (retry.state !== "reserved" && retry.nextAttemptAt && retry.nextAttemptAt.getTime() > now.getTime()) return { verdict: "wait", reason: `proxima tentativa ${retry.nextAttemptAt.toISOString()}`, row: retry };
    return { verdict: "send", reason: `nova tentativa (${retry.state})`, row: retry };
  }
  return { verdict: "send", reason: "ainda nao recebeu neste ano", row: null };
}

export interface BirthdayDelivery { state: string; detail: string; rowId: string | null; attempted: boolean }

// Envia UM aniversario (usado pela rodada e pela recuperacao do painel): reserva atomica -> tentativa registrada -> desfecho como aconteceu. Nunca lanca (erro vira resultado).
export async function deliverBirthday(rule: BirthdayRule, patient: Patient, tz: string, clock: () => Date, opts: { extendedReason?: string | null; clinicInfo?: Awaited<ReturnType<typeof getClinicTemplateInfo>> } = {}): Promise<BirthdayDelivery> {
  const { month, day, year, hour } = localParts(clock(), tz);
  // REVALIDACAO imediata: e hoje o aniversario? o dia/horario ainda valem?
  const fresh = await prisma.patient.findUnique({ where: { id: patient.id }, select: { birthDate: true, optedOut: true, active: true, phone: true, name: true } });
  if (!fresh?.birthDate || !isBirthdayToday(fresh.birthDate, { year, month, day })) return { state: "skipped", detail: "hoje nao e o aniversario (ou a data mudou)", rowId: null, attempted: false };
  if (fresh.optedOut || !fresh.active) return { state: "skipped", detail: fresh.optedOut ? "pediu para nao receber mensagens" : "paciente fora de acompanhamento", rowId: null, attempted: false };
  if (hour >= HARD_LAST_HOUR) return { state: "skipped", detail: "depois do limite do dia: o parabens perdeu a pertinencia", rowId: null, attempted: false };

  const policy = await loadPolicy(rule.clinicId, "aniversario");
  const now = clock();
  // RESERVA/REIVINDICACAO atomica (indice unico patientId+ruleId+year; reivindicar comparando updatedAt): dois processos nunca enviam o mesmo aniversario
  let rowId: string;
  let attempt = 1;
  const existing = await prisma.birthdaySent.findUnique({ where: { patientId_ruleId_year: { patientId: patient.id, ruleId: rule.id, year } } });
  if (!existing) {
    try {
      const row = await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year, state: "reserved", attempts: 1, sentAt: now } });
      rowId = row.id;
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") return { state: "skipped", detail: "ja reservado por outra execucao", rowId: null, attempted: false };
      throw e;
    }
  } else {
    if (!RETRYABLE.includes(existing.state) && !(existing.state === "failed_permanent")) return { state: "skipped", detail: `ja tratado (${existing.state})`, rowId: existing.id, attempted: false };
    const claimed = await prisma.birthdaySent.updateMany({ where: { id: existing.id, state: existing.state, updatedAt: existing.updatedAt }, data: { state: "reserved", attempts: { increment: 1 }, attemptedAt: null, sentAt: now } });
    if (claimed.count !== 1) return { state: "skipped", detail: "outra execucao reivindicou primeiro", rowId: existing.id, attempted: false };
    rowId = existing.id;
    attempt = existing.attempts + 1;
  }
  const info = opts.clinicInfo ?? (await getClinicTemplateInfo(rule.clinicId));
  const text = renderMessageTemplate(rule.message, {
    patientName: fresh.name, patientPhone: fresh.phone, clinicName: info.name, locationName: info.primaryLocation?.name, locationAddress: info.primaryLocation?.fullAddress, birthDate: fresh.birthDate,
  });
  // Desfecho da tentativa. Retencao SEM chamada ao provedor (pausa humana, revisao, duplicidade sem evidencia) NAO gasta o teto de tentativas: so conta quem chegou a chamar o provedor.
  const settle = async (data: Partial<{ state: string; detail: string; nextAttemptAt: Date | null; deliveryState: string | null; destination: string | null; providerId: string | null }>) => {
    const cur = await prisma.birthdaySent.findUnique({ where: { id: rowId }, select: { attemptedAt: true, attempts: true } });
    const release = (data.state === "deferred" || data.state === "vetoed") && !cur?.attemptedAt && (cur?.attempts ?? 0) > 0;
    return prisma.birthdaySent.updateMany({ where: { id: rowId, state: { in: ["reserved", "deferred", "failed", "vetoed"] } }, data: { ...data, ...(data.detail ? { detail: data.detail.slice(0, 300) } : {}), ...(release ? { attempts: { decrement: 1 } } : {}), updatedAt: new Date() } });
  };
  const retryAt = new Date(now.getTime() + policy.retryGapMin * 60_000);
  let report: SendReport | null = null;
  try {
    const outcome = await sendText(rule.clinicId, fresh.phone, text, {
      kind: "aniversario",
      // IMEDIATAMENTE antes do provedor: a tentativa passa a constar (reserved SEM isto = o provedor NAO foi chamado)
      beforeProvider: async () => { await prisma.birthdaySent.update({ where: { id: rowId }, data: { attemptedAt: new Date() } }); },
      report: (r) => { report = r; },
    });
    if (outcome === "sent") {
      const rep = report as SendReport | null;
      await settle({ state: "sent", detail: opts.extendedReason ? `enviado em janela estendida (${opts.extendedReason})` : "enviado", deliveryState: "accepted", destination: rep?.destination ?? null, providerId: rep?.providerId ?? null });
      await recordAutomatedMessage(patient.id, text, rule.name || "Aniversário automático").catch((err) => console.error("[aniversario] mensagem aceita, mas o registro no chat falhou (NAO reenvia):", err instanceof Error ? err.message : err));
      return { state: "sent", detail: "aceito pelo provedor", rowId, attempted: true };
    }
    if (outcome === "duplicate") {
      // so conta como cobertura com EVIDENCIA: a mensagem identica existe no chat desta pessoa nas ultimas 24 h
      const evidence = await prisma.message.findFirst({ where: { role: "assistant", content: text, createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) }, conversation: { patientId: patient.id } }, select: { id: true } });
      if (evidence) { await settle({ state: "duplicate", detail: `mensagem identica ja registrada no chat (${evidence.id})` }); return { state: "duplicate", detail: "coberto por mensagem identica registrada", rowId, attempted: false }; }
      await settle({ state: "deferred", detail: "duplicidade apontada so pela memoria do processo, sem a mensagem no chat: nova tentativa", nextAttemptAt: retryAt });
      return { state: "deferred", detail: "duplicidade sem evidencia", rowId, attempted: false };
    }
    if (outcome === "vetoed") { await settle({ state: "vetoed", detail: "a revisao por IA barrou a mensagem (motivo no Diario de atividades); tenta de novo dentro do dia", nextAttemptAt: retryAt }); return { state: "vetoed", detail: "revisao barrou", rowId, attempted: false }; }
    await settle({ state: "failed", detail: "envio automatico bloqueado pelo plano", nextAttemptAt: null });
    return { state: "blocked", detail: "plano", rowId, attempted: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const attemptedRow = await prisma.birthdaySent.findUnique({ where: { id: rowId }, select: { attemptedAt: true } });
    if (isSendDeferred(err)) { await settle({ state: "deferred", detail: deferralInfo(err).reason, nextAttemptAt: retryAt }); return { state: "deferred", detail: deferralInfo(err).tag, rowId, attempted: false }; }
    if (isPermanentSendError(err)) { await settle({ state: "failed_permanent", detail: `numero invalido/sem WhatsApp: ${msg.slice(0, 120)}`, destination: parsePhone(fresh.phone).destination }); return { state: "failed_permanent", detail: "numero_sem_whatsapp", rowId, attempted: !!attemptedRow?.attemptedAt }; }
    if (isAmbiguousSendError(err)) { await prisma.birthdaySent.updateMany({ where: { id: rowId }, data: { state: "unconfirmed", detail: "tempo esgotado no provedor: pode ter chegado; NAO reenviado", updatedAt: new Date() } }); return { state: "unconfirmed", detail: "envio_nao_confirmado", rowId, attempted: true }; }
    await settle({ state: "failed", detail: `falha do provedor antes de aceitar: ${msg.slice(0, 120)}`, nextAttemptAt: retryAt });
    console.error(`Falha ao enviar aniversario (regra ${rule.id}) para ...${fresh.phone.slice(-4)} (tentativa ${attempt}):`, msg);
    return { state: "failed", detail: "envio_falhou_tentara_de_novo", rowId, attempted: !!attemptedRow?.attemptedAt };
  }
}

// Libera/encerra reservas que ficaram sem desfecho: SEM attemptedAt (e desta versao) = nada foi enviado -> libera; com attemptedAt ou registro anterior ao controle = incerta.
async function settleStaleReservations(clinicId: string, now: Date): Promise<{ released: number; uncertain: number }> {
  const cutoff = new Date(now.getTime() - STALE_RESERVED_MS);
  const base = { state: "reserved", sentAt: { lt: cutoff }, rule: { clinicId } } as const;
  const released = await prisma.birthdaySent.updateMany({ where: { ...base, attempts: { gte: 1 }, attemptedAt: null }, data: { state: "deferred", detail: "reserva abandonada ANTES de chamar o provedor (sem tentativa registrada): liberada para nova tentativa", nextAttemptAt: null } });
  const uncertain = await prisma.birthdaySent.updateMany({ where: { ...base, OR: [{ attempts: 0 }, { attemptedAt: { not: null } }] }, data: { state: "unconfirmed", detail: "reserva sem desfecho depois de iniciada a chamada (ou registro anterior ao controle): pode ter saido; nao reenviado" } });
  return { released: released.count, uncertain: uncertain.count };
}

// Resumo do que a PROPRIA selecao decidiu para a clinica hoje (a aba Disparos usa a mesma funcao para listar quem e elegivel e por que nao).
export async function birthdayCandidatesToday(clinicId: string, now: Date, tz: string): Promise<{ today: { year: number; month: number; day: number; hour: number }; candidates: BirthdayCandidate[]; rules: BirthdayRule[] }> {
  const parts = localParts(now, tz);
  const rules = await prisma.birthdayRule.findMany({ where: { clinicId, active: true }, orderBy: { createdAt: "asc" } });
  const rule = rules[0];
  if (!rule) return { today: parts, candidates: [], rules };
  const policy = await loadPolicy(clinicId, "aniversario");
  const patients = await prisma.patient.findMany({ where: { clinicId, birthDate: { not: null }, optedOut: false, active: true }, orderBy: { createdAt: "asc" } });
  const todays = patients.filter((p) => isBirthdayToday(p.birthDate!, parts));
  const rows = todays.length ? await prisma.birthdaySent.findMany({ where: { year: parts.year, patientId: { in: todays.map((p) => p.id) } } }) : [];
  const seenPhone = new Set<string>();
  const covered = rows.filter((r) => COVERED.includes(r.state));
  for (const c of covered) { const pt = todays.find((p) => p.id === c.patientId); const k = pt ? canonicalKey(pt.phone) : null; if (k) seenPhone.add(k); }
  const out: BirthdayCandidate[] = [];
  for (const p of todays) {
    const mine = rows.filter((r) => r.patientId === p.id);
    const v = birthdayVerdict(p, mine, policy, now);
    let verdict = v.verdict, reason = v.reason;
    const k = canonicalKey(p.phone);
    if (verdict === "send" && k && seenPhone.has(k) && !mine.some((r) => COVERED.includes(r.state))) { verdict = "same_phone_covered"; reason = "o mesmo telefone ja recebe (ou recebeu) o parabens neste ano"; }
    else if (verdict === "send" && k) seenPhone.add(k);
    out.push({ patient: p, rule, row: v.row, verdict, reason });
  }
  return { today: parts, candidates: out, rules };
}

export async function runBirthdayCycle(now?: Date, only?: { clinicId?: string }): Promise<{ sent: number }> {
  const clock = () => now ?? new Date();
  const rules = await prisma.birthdayRule.findMany({
    where: { active: true, clinic: PAID_CLINIC_WHERE, ...(only?.clinicId ? { clinicId: only.clinicId } : {}) },
    include: { clinic: { select: { timezone: true } } },
  });
  const recorders = new Map<string, RunRecorder>();
  const rec = (clinicId: string) => {
    let r = recorders.get(clinicId);
    if (!r) recorders.set(clinicId, (r = new RunRecorder("aniversario", clinicId, clock())));
    return r;
  };
  let sentTotal = 0;
  let failure: unknown = null;
  // Uma clinica por vez (cada uma com o proprio fuso, teto e politica); o erro de uma clinica/pessoa nunca interrompe as demais.
  const byClinic = new Map<string, typeof rules>();
  for (const rule of rules) byClinic.set(rule.clinicId, [...(byClinic.get(rule.clinicId) ?? []), rule]);
  for (const [clinicId, clinicRules] of byClinic) {
    const r = rec(clinicId);
    try {
      const rule = clinicRules[0]; // uma mensagem de aniversario por PESSOA por ano na clinica (qualquer regra): a primeira regra ativa
      const tz = rule.clinic.timezone || "America/Sao_Paulo";
      const t0 = clock();
      const { hour } = localParts(t0, tz);
      if (hour < rule.sendHour) { r.add("ignorado", "antes_da_hora_de_envio"); continue; }
      const policy = await loadPolicy(clinicId, "aniversario");
      const stale = await settleStaleReservations(clinicId, t0);
      for (let i = 0; i < stale.released; i++) r.add("adiado", "reserva_abandonada_liberada");
      for (let i = 0; i < stale.uncertain; i++) r.add("incerto", "reserva_sem_desfecho");

      const { candidates } = await birthdayCandidatesToday(clinicId, t0, tz);
      const sendable = candidates.filter((c) => c.verdict === "send");
      for (const c of candidates) if (c.verdict !== "send") r.add("ignorado", c.verdict === "invalid_phone" ? "telefone_invalido" : c.verdict === "same_phone_covered" ? "mesmo_telefone_ja_recebe_hoje" : c.verdict === "covered" ? "ja_coberto_neste_ano" : c.verdict === "wait" ? "aguardando_intervalo_entre_tentativas" : c.verdict);
      r.candidates += candidates.length;
      // JANELA: normal ate BIRTHDAY_LAST_HOUR; depois so com CAUSA OPERACIONAL comprovada, ate o limite da politica (teto duro HARD_LAST_HOUR). Pendente por falha/capacidade = causa.
      let extendedReason: string | null = null;
      if (hour >= BIRTHDAY_LAST_HOUR) {
        const [uh, um] = policy.extendUntil.split(":").map(Number);
        const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "2-digit" }).format(t0));
        const untilOk = policy.extendEnabled && (hour < Math.min(uh, HARD_LAST_HOUR) || (hour === uh && uh < HARD_LAST_HOUR && minute < um));
        if (!untilOk || hour >= HARD_LAST_HOUR) { r.add("ignorado", sendable.length ? "depois_do_horario_de_envio_do_dia_expirado" : "depois_do_horario_de_envio_do_dia"); if (sendable.length) await alertExpiredBirthdays(clinicId, sendable.length); continue; }
        if (sendable.length === 0) continue;
        extendedReason = await birthdayExtensionCause(clinicId, rule.sendHour, t0, tz);
        if (!extendedReason) { r.add("ignorado", "depois_do_horario_de_envio_do_dia_expirado"); await alertExpiredBirthdays(clinicId, sendable.length); continue; }
      }
      r.eligible += sendable.length;
      if (sendable.length === 0) continue;

      // FILA sem starvation: quem nunca foi tentado primeiro; teto por rodada da politica (a capacidade e visivel e o restante segue na proxima hora)
      sendable.sort((a, b) => (a.row?.attempts ?? 0) - (b.row?.attempts ?? 0) || a.patient.createdAt.getTime() - b.patient.createdAt.getTime());
      const clinicInfo = await getClinicTemplateInfo(clinicId);
      let sentHere = 0;
      for (const c of sendable) {
        if (sentHere >= policy.maxPerRun) { r.add("adiado", "limite_de_capacidade_da_rodada"); continue; }
        try {
          const res = await deliverBirthday(rule, c.patient, tz, clock, { extendedReason, clinicInfo });
          if (res.state === "sent") { r.add("enviado", extendedReason ? "aniversario_janela_estendida" : "aniversario"); sentTotal++; sentHere++; }
          else if (res.state === "duplicate") r.add("ignorado", "mensagem_identica_ja_registrada");
          else if (res.state === "vetoed") r.add("vetado", "revisao_de_envio_tenta_de_novo_dentro_do_dia");
          else if (res.state === "deferred") r.add("adiado", res.detail);
          else if (res.state === "failed_permanent") r.add("falha", res.detail);
          else if (res.state === "unconfirmed") r.add("incerto", res.detail);
          else if (res.state === "blocked") r.add("ignorado", "envio_bloqueado_pelo_plano");
          else if (res.state === "skipped") r.add("ignorado", res.detail.slice(0, 50));
          else r.add("falha", res.detail);
        } catch (err) {
          // erro INESPERADO de uma pessoa (banco, etc.): registra e segue com as demais
          r.add("falha", "erro_inesperado_na_pessoa");
          console.error(`[aniversario] erro ao tratar uma pessoa da clinica ${clinicId}; as demais seguem:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      failure = failure ?? err;
      r.add("falha", "erro_na_clinica");
      console.error(`[aniversario] a clinica ${clinicId} falhou; as demais seguem:`, err instanceof Error ? err.message : err);
    }
  }
  // uma linha por clinica com regra ativa, MESMO sem aniversariantes: e o que prova que o job rodou
  for (const rule of rules) rec(rule.clinicId);
  for (const r of recorders.values()) await r.save(failure ? "erro" : "ok", failure ?? undefined, clock());
  return { sent: sentTotal };
}

// Causa operacional do aniversario: o job nao rodou na janela normal, houve falha/adiamento, WhatsApp fora, ou ha pendentes por falha recuperavel. Sem causa, nao se amplia.
async function birthdayExtensionCause(clinicId: string, sendHour: number, now: Date, tz: string): Promise<string | null> {
  const [y, m, d] = [localParts(now, tz).year, localParts(now, tz).month, localParts(now, tz).day];
  const dayStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 3_600_000); // aproximacao conservadora do inicio do dia local (ate 3h de folga): so conta rodadas do mesmo dia
  const runs = await prisma.automationRun.findMany({ where: { job: "aniversario", clinicId, startedAt: { gte: dayStart, lt: now } }, select: { reasons: true, outcome: true } });
  const expected = Math.max(1, BIRTHDAY_LAST_HOUR - sendHour);
  if (runs.length < Math.ceil(expected / 2)) return "job_nao_rodou_na_janela";
  if (runs.some((r) => r.outcome === "erro" || /adiado|falha|incerto|vetado|limite_de_capacidade/.test(r.reasons ?? ""))) return "falhas_ou_capacidade";
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { uazapiDownSince: true } });
  if (clinic?.uazapiDownSince) return "whatsapp_fora";
  return null;
}

async function alertExpiredBirthdays(clinicId: string, n: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const marker = `[aniversario-expirado:${day}]`;
  const exists = await prisma.activityLog.findFirst({ where: { clinicId, type: "birthday_expired", description: { contains: marker } }, select: { id: true } });
  if (exists) return;
  const { logActivity } = await import("../crm/activity.js");
  const { notifyStaff } = await import("../crm/notify.js");
  await logActivity({ clinicId, type: "birthday_expired", area: "automacoes", title: "Parabéns que não saíram no dia", description: `${n} aniversariante(s) ficaram sem a mensagem e o dia acabou (não é recuperada no dia seguinte). ${marker}`, actorName: null });
  await notifyStaff(clinicId, "automation_failed", `⚠️ ${n} aniversariante(s) de hoje ficaram sem a mensagem de parabéns e o prazo do dia acabou. Se quiser, mande uma mensagem manual.`).catch(() => undefined);
}

// Roda de hora em hora (minuto 5): cada rodada tenta quem faz aniversario hoje e ainda nao esta coberto neste ano (BirthdaySent trava por paciente/regra/ano).
export function startBirthdayJob(): void {
  scheduleLocked("aniversario", "5 * * * *", async () => {
    await runBirthdayCycle();
  });
}
