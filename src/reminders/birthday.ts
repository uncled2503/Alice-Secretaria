import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isSendDeferred, deferralInfo, isPermanentSendError, isAmbiguousSendError } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { RunRecorder } from "../crm/automationRuns.js";
import { canonicalBrPhone } from "../clinicaexperts/identity.js";

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
// ANIVERSARIO (relato da Lisboa, 19/10/2026: "nem os aniversariantes do dia"). Antes o job so agia NA HORA exata (rule.sendHour) e gravava BirthdaySent (= "ja mandei neste ano") mesmo
// quando a mensagem foi barrada, adiada ou falhou: uma rodada que nao rodou naquela hora, uma pausa porque a equipe estava conversando ou uma falha do provedor perdiam o aniversario do ano.
// Agora:
//  - a mensagem pode sair a partir de rule.sendHour ATE o fim do expediente de comunicacao do MESMO dia (BIRTHDAY_LAST_HOUR); passou o dia, perdeu a pertinencia e NAO e recuperada no dia seguinte;
//  - BirthdaySent so e gravado quando a mensagem SAIU (ou saiu sem confirmacao do provedor: nunca reenvia as cegas), ou quando e definitivo (numero sem WhatsApp, mensagem identica ja enviada);
//    barrada, adiada (equipe conversando / revisao ou WhatsApp fora) e falha comum NAO consomem o aniversario e tentam de novo na proxima hora;
//  - o dia e o da CLINICA (fuso); sem nome utilizavel a saudacao e neutra (template);
//  - cada rodada deixa um resumo por clinica (AutomationRun "aniversario"): da para provar se o job rodou e o que decidiu.
// ---------------------------------------------------------------------------
export const BIRTHDAY_LAST_HOUR = 20; // ultima hora (exclusiva) em que ainda faz sentido mandar parabens
const STALE_RESERVED_MS = 30 * 60_000;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// PURO: hoje (dia/mes/ano no fuso da clinica) e o aniversario desta data de nascimento? A data e guardada como meia-noite UTC e lida em UTC (nunca desloca o dia). Quem nasceu em
// 29/02 comemora em 29/02 nos anos bissextos e em 28/02 nos demais (decisao documentada; sem isso essa pessoa ficaria 3 anos sem parabens).
export function isBirthdayToday(birth: Date, today: { year: number; month: number; day: number }): boolean {
  const bm = birth.getUTCMonth() + 1, bd = birth.getUTCDate();
  if (bm === today.month && bd === today.day) return true;
  return bm === 2 && bd === 29 && !isLeap(today.year) && today.month === 2 && today.day === 28;
}

// PURO: so telefone brasileiro valido recebe (DDI+DDD+numero).
export const birthdayPhoneOk = (phone: string): boolean => canonicalBrPhone(phone) !== null;

export async function runBirthdayCycle(now = new Date(), only?: { clinicId?: string }): Promise<{ sent: number }> {
  const rules = await prisma.birthdayRule.findMany({
    where: { active: true, clinic: PAID_CLINIC_WHERE, ...(only?.clinicId ? { clinicId: only.clinicId } : {}) },
    include: { clinic: { select: { timezone: true } } },
  });
  const recorders = new Map<string, RunRecorder>();
  const rec = (clinicId: string) => {
    let r = recorders.get(clinicId);
    if (!r) recorders.set(clinicId, (r = new RunRecorder("aniversario", clinicId, now)));
    return r;
  };
  let sentTotal = 0;
  let failure: unknown = null;
  try {
    for (const rule of rules) {
      const r = rec(rule.clinicId);
      const tz = rule.clinic.timezone || "America/Sao_Paulo";
      const { hour, month, day, year } = localParts(now, tz);
      if (hour < rule.sendHour) { r.add("ignorado", "antes_da_hora_de_envio"); continue; }
      if (hour >= BIRTHDAY_LAST_HOUR) { r.add("ignorado", "depois_do_horario_de_envio_do_dia"); continue; }

      // reserva que ficou sem desfecho (processo caiu no envio): pode ter saido, NUNCA reenvia
      await prisma.birthdaySent.updateMany({ where: { state: "reserved", sentAt: { lt: new Date(now.getTime() - STALE_RESERVED_MS) }, rule: { clinicId: rule.clinicId } }, data: { state: "unconfirmed" } });

      // birthDate guardado como UTC meia-noite; comparar dia/mes ignorando ano. Uma mensagem de aniversario por PESSOA por ano na clinica (qualquer regra): criar uma regra nova no
      // mesmo dia ou editar a mensagem nao manda de novo; quem ja tem registro (inclusive os antigos "legacy") fica de fora.
      const patients = await prisma.patient.findMany({
        where: {
          clinicId: rule.clinicId,
          birthDate: { not: null },
          optedOut: false, // quem pediu pra parar nao recebe mensagem automatica
          active: true, // paciente fora de acompanhamento nao recebe automacao
          birthdaySent: { none: { year } },
        },
        orderBy: { createdAt: "asc" },
      });
      const all = patients.filter((p) => isBirthdayToday(p.birthDate!, { year, month, day }));
      // sem telefone valido nao ha como mandar; e o MESMO numero em duas formas (com/sem 9) ou em dois cadastros recebe UMA mensagem so
      const seenPhone = new Set<string>();
      // telefones que JA receberam parabens neste ano (outro cadastro do mesmo numero, ou a rodada anterior): nao recebem de novo
      const jaReceberam = await prisma.birthdaySent.findMany({ where: { year, patient: { clinicId: rule.clinicId } }, select: { patient: { select: { phone: true } } } });
      for (const s of jaReceberam) {
        const c = canonicalBrPhone(s.patient.phone);
        if (c) seenPhone.add(`${c.ddd}${c.local}`);
      }
      const birthdayToday = [] as typeof all;
      for (const p of all) {
        const c = canonicalBrPhone(p.phone);
        if (!c) { r.add("ignorado", "telefone_invalido"); continue; }
        const k = `${c.ddd}${c.local}`;
        if (seenPhone.has(k)) { r.add("ignorado", "mesmo_telefone_ja_recebe_hoje"); continue; }
        seenPhone.add(k);
        birthdayToday.push(p);
      }
      r.candidates += birthdayToday.length;
      if (birthdayToday.length === 0) continue;
      r.eligible += birthdayToday.length;

      const clinicInfo = await getClinicTemplateInfo(rule.clinicId);
      for (const patient of birthdayToday) {
        const text = renderMessageTemplate(rule.message, {
          patientName: patient.name,
          patientPhone: patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
          birthDate: patient.birthDate,
        });

        // RESERVA antes de enviar (indice unico no banco: vale entre processos e reinicios). Duas rodadas ao mesmo tempo nao mandam duas vezes; um processo que cai no meio deixa
        // "reserved", que vira "unconfirmed" (pode ter saido) e nunca e reenviado.
        let reservedId: string;
        try {
          reservedId = (await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year, state: "reserved" } })).id;
        } catch (e) {
          if ((e as { code?: string })?.code === "P2002") { r.add("ignorado", "ja_reservado_ou_enviado"); continue; }
          throw e;
        }
        const release = () => prisma.birthdaySent.deleteMany({ where: { id: reservedId, state: "reserved" } }); // nada saiu: libera para tentar de novo na proxima hora
        const settle = (state: string) => prisma.birthdaySent.updateMany({ where: { id: reservedId }, data: { state } });
        try {
          const outcome = await sendText(rule.clinicId, patient.phone, text, { kind: "aniversario" });
          if (outcome === "sent") {
            await settle("sent");
            await recordAutomatedMessage(patient.id, text, rule.name || "Aniversário automático");
            r.add("enviado", "aniversario");
            sentTotal++;
          } else if (outcome === "duplicate") {
            await settle("sent"); // a mesma mensagem ja saiu: nao repete
            r.add("ignorado", "mensagem_identica_ja_enviada");
          } else if (outcome === "vetoed") {
            await release();
            r.add("vetado", "revisao_de_envio_tenta_de_novo_na_proxima_hora"); // nao consome o aniversario; o veredito em cache evita repetir a chamada a IA
          } else {
            await release();
            r.add("ignorado", "envio_bloqueado_pelo_plano");
          }
        } catch (err) {
          if (isSendDeferred(err)) {
            await release();
            r.add("adiado", deferralInfo(err).tag); // WhatsApp fora / revisao fora / equipe conversando: tenta de novo na proxima hora, ainda dentro do dia
          } else if (isPermanentSendError(err)) {
            await settle("failed_permanent"); // numero sem WhatsApp: nao insiste
            r.add("falha", "numero_sem_whatsapp");
          } else if (isAmbiguousSendError(err)) {
            await settle("unconfirmed"); // pode ter chegado: nunca reenvia as cegas
            r.add("incerto", "envio_nao_confirmado");
          } else {
            await release();
            r.add("falha", "envio_falhou_tentara_de_novo");
            console.error(`Falha ao enviar aniversario (regra ${rule.id}) para ...${patient.phone.slice(-4)}:`, err instanceof Error ? err.message : err);
          }
        }
      }
    }
  } catch (err) {
    failure = err;
    console.error("[aniversario] a rodada falhou:", err instanceof Error ? err.message : err);
  } finally {
    // uma linha por clinica com regra ativa, MESMO sem aniversariantes: e o que prova que o job rodou
    for (const rule of rules) rec(rule.clinicId);
    for (const r of recorders.values()) await r.save(failure ? "erro" : "ok", failure ?? undefined);
  }
  return { sent: sentTotal };
}

// Roda de hora em hora (minuto 5): cada rodada tenta quem faz aniversario hoje e ainda nao recebeu essa regra neste ano (BirthdaySent trava por paciente/regra/ano).
export function startBirthdayJob(): void {
  scheduleLocked("aniversario", "5 * * * *", async () => {
    await runBirthdayCycle();
  });
}
