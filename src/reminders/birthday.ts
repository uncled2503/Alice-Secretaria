import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isSendDeferred, deferralInfo, isPermanentSendError, isAmbiguousSendError } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { RunRecorder } from "../crm/automationRuns.js";

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

      // birthDate guardado como UTC meia-noite; comparar dia/mes ignorando ano.
      const patients = await prisma.patient.findMany({
        where: {
          clinicId: rule.clinicId,
          birthDate: { not: null },
          optedOut: false, // quem pediu pra parar nao recebe mensagem automatica
          birthdaySent: { none: { ruleId: rule.id, year } },
        },
      });
      const birthdayToday = patients.filter((p) => {
        const b = p.birthDate!;
        return b.getUTCMonth() + 1 === month && b.getUTCDate() === day;
      });
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

        try {
          const outcome = await sendText(rule.clinicId, patient.phone, text, { kind: "aniversario" });
          if (outcome === "sent") {
            await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year } });
            await recordAutomatedMessage(patient.id, text, rule.name || "Aniversário automático");
            r.add("enviado", "aniversario");
            sentTotal++;
          } else if (outcome === "duplicate") {
            await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year } }); // a mesma mensagem ja saiu: nao repete
            r.add("ignorado", "mensagem_identica_ja_enviada");
          } else if (outcome === "vetoed") {
            r.add("vetado", "revisao_de_envio_tenta_de_novo_na_proxima_hora"); // nao consome o aniversario; o veredito em cache evita repetir a chamada a IA
          } else {
            r.add("ignorado", "envio_bloqueado_pelo_plano");
          }
        } catch (err) {
          if (isSendDeferred(err)) {
            r.add("adiado", deferralInfo(err).tag); // WhatsApp fora / revisao fora / equipe conversando: tenta de novo na proxima hora, ainda dentro do dia
          } else if (isPermanentSendError(err)) {
            await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year } }).catch(() => undefined); // numero sem WhatsApp: nao insiste
            r.add("falha", "numero_sem_whatsapp");
          } else if (isAmbiguousSendError(err)) {
            await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year } }).catch(() => undefined); // pode ter chegado: nunca reenvia as cegas
            r.add("incerto", "envio_nao_confirmado");
          } else {
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
