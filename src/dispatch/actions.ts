import os from "node:os";
import { prisma } from "../db/client.js";
import { isoDateInZone, wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { connectionUsable } from "../uazapi/client.js";
import { logActivity } from "../crm/activity.js";
import { notifyStaff } from "../crm/notify.js";
import { deliverReminder, selectReminderCandidates } from "../reminders/cron.js";
import { bookingKeyOf, MAX_SEND_ATTEMPTS, finishDispatch } from "../reminders/ledger.js";
import { deliverBirthday, birthdayCandidatesToday } from "../reminders/birthday.js";
import { parsePhone, canonicalKey } from "../uazapi/phone.js";
import { saveResolution } from "../uazapi/phoneRegistry.js";
import { buildDispatchView, listFilteredIds, REASONS, type DispatchFilters, type DispatchItem } from "./model.js";
import { loadPolicy, HARD_LAST_HOUR, type DispatchKind } from "./policy.js";
import { scheduleLocked } from "../jobs/lock.js";

// ---------------------------------------------------------------------------
// ACOES DA ABA DISPAROS. Nada aqui e outro "motor" de envio: recuperar/tentar de novo chama a MESMA via do ciclo automatico (deliverReminder / deliverBirthday), que revalida o estado de
// agora, confere o Clinica Experts, reserva de forma atomica no controle persistente e registra o desfecho como aconteceu. Por isso cron, painel e execucao em lote nunca mandam duas vezes.
//
// Recuperacao em lote = DispatchRun persistido (fila): o HTTP so cria a fila e devolve; quem envia e o worker (concessao com dono/validade, renovada a cada item; reinicio devolve o que ficou).
// ---------------------------------------------------------------------------

export interface Actor { id?: string | null; name: string }
const OWNER = `${os.hostname()}:${process.pid}`;
const LEASE_MS = 3 * 60_000;
export const RUN_MAX_ITEMS = 100;
// O HTTP so cria a fila; o worker do minuto (e este "empurrao" logo apos criar) e quem envia. Os testes desligam o empurrao para controlar o relogio.
let autoKick = true;
export function setDispatchAutoKick(on: boolean): void { autoKick = on; }
const kick = () => { if (autoKick) setImmediate(() => processDispatchRuns().catch((e) => console.error("[disparos] worker:", e instanceof Error ? e.message : e))); };

function audit(clinicId: string, actor: Actor, title: string, description: string, patientId?: string | null): Promise<void> {
  return logActivity({ clinicId, type: "dispatch_action", area: "automacoes", title, description, actorName: actor.name, patientId: patientId ?? null });
}

interface Parsed { src: "rd" | "bd" | "exr" | "exb"; a: string; b?: string; startsAt?: number; day?: string }
export function parseItemId(id: string): Parsed | null {
  const p = id.split(":");
  if (p[0] === "rd" && p[1]) return { src: "rd", a: p[1] };
  if (p[0] === "bd" && p[1]) return { src: "bd", a: p[1] };
  if (p[0] === "ex" && p[1] === "r" && p.length >= 6) return { src: "exr", a: p[2], b: p[3], startsAt: Number(p[4]), day: p.slice(5).join(":") };
  if (p[0] === "ex" && p[1] === "b" && p.length >= 4) return { src: "exb", a: p[2], day: p.slice(3).join(":") };
  return null;
}

// Garante que o item pertence a clinica (isolamento no servidor) e devolve a linha atual do painel.
export async function loadItem(clinicId: string, id: string, now = new Date()): Promise<DispatchItem | null> {
  const p = parseItemId(id);
  if (!p) return null;
  let day: string | undefined = p.day;
  if (p.src === "rd") { const r = await prisma.reminderDispatch.findFirst({ where: { id: p.a, clinicId }, select: { sendDay: true } }); if (!r) return null; day = r.sendDay; }
  if (p.src === "bd") {
    const b = await prisma.birthdaySent.findFirst({ where: { id: p.a, rule: { clinicId } }, include: { patient: { select: { birthDate: true } } } });
    if (!b?.patient.birthDate) return null;
    const bd = b.patient.birthDate;
    day = `${b.year}-${String(bd.getUTCMonth() + 1).padStart(2, "0")}-${String(bd.getUTCDate()).padStart(2, "0")}`;
    if (bd.getUTCMonth() === 1 && bd.getUTCDate() === 29) { const alt = `${b.year}-02-28`; const v0 = await buildDispatchView(clinicId, { from: day, to: day, pageSize: 200 }, now).catch(() => null); if (!v0?.items.some((i) => i.id === id)) day = alt; }
  }
  if (!day) return null;
  const v = await buildDispatchView(clinicId, { from: day, to: day, pageSize: 200 }, now);
  return v.items.find((i) => i.id === id) ?? null;
}

// ------------------------------------------------------------------ detalhe
export async function dispatchDetail(clinicId: string, id: string, now = new Date()) {
  const item = await loadItem(clinicId, id, now);
  if (!item) return null;
  const p = parseItemId(id)!;
  const timeline: { at: string; what: string }[] = [];
  let text: string | null = null;
  let who: string | null = null;
  if (p.src === "rd") {
    const r = await prisma.reminderDispatch.findUnique({ where: { id: p.a } });
    if (r) {
      timeline.push({ at: r.createdAt.toISOString(), what: `Reservado (tentativa ${r.attempt}) para este atendimento` });
      if (r.attemptedAt) timeline.push({ at: r.attemptedAt.toISOString(), what: "Chamada ao WhatsApp iniciada" });
      if (r.deliveryAt) timeline.push({ at: r.deliveryAt.toISOString(), what: `Provedor informou: ${r.deliveryState}` });
      timeline.push({ at: r.updatedAt.toISOString(), what: `Estado: ${r.state}${r.detail ? ` — ${r.detail}` : ""}` });
      const near = r.attemptedAt ?? r.updatedAt;
      const msg = await prisma.message.findFirst({ where: { role: "assistant", conversation: { patientId: r.patientId }, createdAt: { gte: new Date(near.getTime() - 15 * 60_000), lte: new Date(near.getTime() + 15 * 60_000) } }, orderBy: { createdAt: "asc" }, select: { content: true } });
      text = msg?.content ?? null;
      who = /painel|autorizad|recuper/i.test(r.detail ?? "") ? "equipe (painel)" : "automático";
    }
  } else if (p.src === "bd") {
    const b = await prisma.birthdaySent.findUnique({ where: { id: p.a }, include: { rule: { select: { message: true } } } });
    if (b) {
      timeline.push({ at: b.sentAt.toISOString(), what: `Reservado (tentativa ${b.attempts})` });
      if (b.attemptedAt) timeline.push({ at: b.attemptedAt.toISOString(), what: "Chamada ao WhatsApp iniciada" });
      if (b.deliveryAt) timeline.push({ at: b.deliveryAt.toISOString(), what: `Provedor informou: ${b.deliveryState}` });
      timeline.push({ at: b.updatedAt.toISOString(), what: `Estado: ${b.state}${b.detail ? ` — ${b.detail}` : ""}` });
      text = b.rule.message;
      who = "automático";
    }
  }
  const acts = await prisma.activityLog.findMany({ where: { clinicId, type: { in: ["dispatch_action", "dispatch_capacity_risk"] }, patientId: item.patientId }, orderBy: { createdAt: "desc" }, take: 8, select: { createdAt: true, title: true, description: true, actorName: true } });
  for (const a of acts) timeline.push({ at: a.createdAt.toISOString(), what: `${a.title}${a.actorName ? ` (${a.actorName})` : ""}` });
  timeline.sort((x, y) => x.at.localeCompare(y.at));
  const pat = await prisma.patient.findFirst({ where: { id: item.patientId, clinicId }, select: { phone: true } });
  const pi = pat ? parsePhone(pat.phone) : null;
  return {
    item, text, who, timeline,
    telefone: pi ? { tipo: pi.kind, valido: pi.valid, motivos: pi.reasons, destinoOriginal: item.phone, destinoUsado: item.destination, alternativaEstrutural: !!pi.alternate } : null,
    motivoTexto: REASONS[item.reason] ?? item.reason,
  };
}

// ------------------------------------------------------------------ acoes individuais
export async function reconcileItem(clinicId: string, id: string, actor: Actor, decision: "enviado" | "nao_enviado", note: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
  const p = parseItemId(id);
  if (!p || (p.src !== "rd" && p.src !== "bd")) return { ok: false, message: "Só dá para conciliar um envio que já tem registro." };
  const detail = `conciliado por ${actor.name}: ${decision === "enviado" ? "confirmou que chegou" : "confirmou que NÃO saiu"}${note ? ` (${note.slice(0, 120)})` : ""}`;
  if (p.src === "rd") {
    const r = await prisma.reminderDispatch.findFirst({ where: { id: p.a, clinicId } });
    if (!r) return { ok: false, message: "Registro não encontrado." };
    if (!["unconfirmed", "reserved"].includes(r.state)) return { ok: false, message: "Só se concilia um resultado incerto." };
    if (decision === "enviado") await prisma.reminderDispatch.update({ where: { id: r.id }, data: { state: "sent", detail, deliveryState: r.deliveryState ?? "accepted" } });
    else await prisma.reminderDispatch.update({ where: { id: r.id }, data: { state: "failed", attempt: Math.min(r.attempt, MAX_SEND_ATTEMPTS - 1), detail, updatedAt: new Date(now.getTime() - 3_600_000) } });
    await audit(clinicId, actor, "Envio conciliado", `${id}: ${detail}`, r.patientId);
  } else {
    const b = await prisma.birthdaySent.findFirst({ where: { id: p.a, rule: { clinicId } } });
    if (!b) return { ok: false, message: "Registro não encontrado." };
    if (!["unconfirmed", "reserved", "legacy"].includes(b.state)) return { ok: false, message: "Só se concilia um resultado incerto." };
    if (decision === "enviado") await prisma.birthdaySent.update({ where: { id: b.id }, data: { state: "sent", detail, deliveryState: b.deliveryState ?? "accepted" } });
    else await prisma.birthdaySent.update({ where: { id: b.id }, data: { state: "failed", attempts: Math.min(b.attempts, 2), nextAttemptAt: null, detail } });
    await audit(clinicId, actor, "Envio conciliado", `${id}: ${detail}`, b.patientId);
  }
  return { ok: true, message: decision === "enviado" ? "Registrado como enviado (por conferência da equipe)." : "Registrado como NÃO enviado: pode ser recuperado hoje." };
}

export async function cancelPending(clinicId: string, id: string, actor: Actor): Promise<{ ok: boolean; message: string }> {
  const item = await loadItem(clinicId, id);
  if (!item) return { ok: false, message: "Item não encontrado nesta clínica." };
  if (["aceito", "entregue", "lido", "incerto", "coberto"].includes(item.status)) return { ok: false, message: "Esse envio já saiu (ou é incerto): não dá para cancelar." };
  const p = parseItemId(id)!;
  const detail = `cancelado pela equipe (${actor.name})`;
  if (p.src === "rd") await prisma.reminderDispatch.updateMany({ where: { id: p.a, clinicId, state: { in: ["deferred", "failed", "vetoed"] } }, data: { state: "blocked", detail } });
  else if (p.src === "bd") await prisma.birthdaySent.updateMany({ where: { id: p.a, rule: { clinicId }, state: { in: ["deferred", "failed", "vetoed"] } }, data: { state: "failed_permanent", detail, nextAttemptAt: null } });
  else if (p.src === "exr") {
    const appt = await prisma.appointment.findFirst({ where: { id: p.b!, clinicId } });
    if (!appt) return { ok: false, message: "Agendamento não encontrado." };
    const rule = await prisma.reminderRule.findFirst({ where: { id: p.a, clinicId } });
    if (!rule) return { ok: false, message: "Regra não encontrada." };
    await prisma.reminderDispatch.create({ data: { clinicId, bookingKey: bookingKeyOf(appt), appointmentId: appt.id, patientId: appt.patientId, ruleId: rule.id, kind: item.kind === "cobranca" ? "cobranca" : item.kind === "lembrete" ? "do_dia" : "dia_seguinte", startsAt: appt.scheduledAt, sendDay: p.day!, state: "blocked", detail } }).catch(() => undefined);
  } else if (p.src === "exb") {
    const rule = await prisma.birthdayRule.findFirst({ where: { clinicId, active: true } });
    if (!rule) return { ok: false, message: "Não há regra de aniversário ativa." };
    await prisma.birthdaySent.create({ data: { patientId: p.a, ruleId: rule.id, year: Number(p.day!.slice(0, 4)), state: "failed_permanent", detail, attempts: 0 } }).catch(() => undefined);
  }
  await audit(clinicId, actor, "Envio pendente cancelado", `${id}: ${detail}`, item.patientId);
  return { ok: true, message: "Cancelado: a Alice não vai enviar esta mensagem." };
}

export async function scheduleLater(clinicId: string, id: string, minutes: number, actor: Actor, now = new Date()): Promise<{ ok: boolean; message: string }> {
  const item = await loadItem(clinicId, id, now);
  if (!item) return { ok: false, message: "Item não encontrado nesta clínica." };
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const t = isoDateInZone(now, tz).split("-").map(Number);
  const hard = zonedWallClockToUtc(tz, t[0], t[1], t[2], HARD_LAST_HOUR, 0);
  const at = new Date(now.getTime() + Math.min(Math.max(minutes, 5), 480) * 60_000);
  if (at.getTime() >= hard.getTime()) return { ok: false, message: "Esse horário passa do limite do dia (21h): não agendado." };
  if (item.sendDay !== isoDateInZone(now, tz)) return { ok: false, message: "Só dá para reprogramar dentro do mesmo dia do envio." };
  const p = parseItemId(id)!;
  if (p.src === "rd") await prisma.reminderDispatch.updateMany({ where: { id: p.a, clinicId, state: { in: ["deferred", "failed"] } }, data: { nextAttemptAt: at, updatedAt: new Date(now.getTime() - 0) } });
  else if (p.src === "bd") await prisma.birthdaySent.updateMany({ where: { id: p.a, rule: { clinicId }, state: { in: ["deferred", "failed", "vetoed"] } }, data: { nextAttemptAt: at } });
  else return { ok: false, message: "Item ainda sem registro de tentativa: use Recuperar." };
  await audit(clinicId, actor, "Envio reprogramado", `${id}: próxima tentativa ${at.toISOString()}`, item.patientId);
  return { ok: true, message: `Reprogramado para ${at.toISOString()}.` };
}

export async function handoffToHuman(clinicId: string, id: string, actor: Actor, note: string): Promise<{ ok: boolean; message: string }> {
  const item = await loadItem(clinicId, id);
  if (!item) return { ok: false, message: "Item não encontrado nesta clínica." };
  await notifyStaff(clinicId, "human_handoff", `📌 Disparo para a equipe: ${item.patientName} (${item.phone}) — ${item.statusLabel}: ${item.reasonLabel}${note ? `. ${note.slice(0, 160)}` : ""}`).catch(() => undefined);
  await audit(clinicId, actor, "Disparo encaminhado para a equipe", `${id}: ${item.statusLabel} / ${item.reasonLabel}`, item.patientId);
  return { ok: true, message: "A equipe foi avisada." };
}

// Corrige o telefone do cadastro (validado). Reavalia o item sem reenvio imediato: o proximo ciclo/recuperacao decide, e o historico nao e apagado.
export async function correctRegistration(clinicId: string, patientId: string, rawPhone: string, actor: Actor): Promise<{ ok: boolean; message: string }> {
  const info = parsePhone(rawPhone);
  if (!info.valid || !info.destination) return { ok: false, message: `Telefone inválido (${info.invalid ?? "formato"}): nada foi alterado.` };
  const dest = info.destination;
  const pat = await prisma.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true, phone: true } });
  if (!pat) return { ok: false, message: "Paciente não encontrado nesta clínica." };
  const other = await prisma.patient.findFirst({ where: { clinicId, phone: dest, id: { not: pat.id } }, select: { id: true } });
  if (other) return { ok: false, message: "Esse número já pertence a outro cadastro (telefone compartilhado): resolva na ficha antes de alterar." };
  await prisma.patient.update({ where: { id: pat.id }, data: { phone: dest } });
  await audit(clinicId, actor, "Telefone do cadastro corrigido", `de ${pat.phone.slice(0, 2)}…${pat.phone.slice(-4)} para ${dest.slice(0, 2)}…${dest.slice(-4)} (validado como ${info.kind})`, pat.id);
  return { ok: true, message: "Telefone corrigido. O envio será reavaliado no próximo ciclo ou na recuperação — nada é reenviado agora." };
}

// Resolve o destino de um telefone suspeito escolhendo a alternativa estruturalmente valida (com/sem o 9). Nao envia nada.
export async function resolvePhone(clinicId: string, patientId: string, actor: Actor): Promise<{ ok: boolean; message: string; options: string[] }> {
  const pat = await prisma.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true, phone: true } });
  if (!pat) return { ok: false, message: "Paciente não encontrado nesta clínica.", options: [] };
  const info = parsePhone(pat.phone);
  if (!info.valid || !info.destination) return { ok: false, message: `Telefone inválido (${info.invalid ?? "formato"}): corrija o cadastro.`, options: [] };
  if (!info.alternate) return { ok: true, message: "O número só tem uma forma válida: não há o que resolver.", options: [info.destination] };
  await saveResolution(clinicId, pat.phone, info.alternate, "painel", `escolhido por ${actor.name}`, pat.id);
  await audit(clinicId, actor, "Destino do telefone resolvido", `usar a forma alternativa do número (final ${info.alternate.slice(-4)})`, pat.id);
  return { ok: true, message: "Destino alternativo registrado: os próximos envios usam essa forma. Nada foi reenviado agora.", options: [info.destination, info.alternate] };
}

// ------------------------------------------------------------------ recuperacao em lote (fila persistida)
export interface RecoveryPreview {
  somenteLeitura: true;
  geradoEm: string;
  total: number;
  elegiveis: { id: string; paciente: string; telefone: string; tipo: string; motivo: string }[];
  excluidos: { id: string; paciente: string; motivo: string }[];
  limite: number;
  avisos: string[];
}

async function resolveSelection(clinicId: string, sel: { ids?: string[]; filters?: DispatchFilters; allFiltered?: boolean }, now: Date): Promise<DispatchItem[]> {
  if (sel.allFiltered && sel.filters) return listFilteredIds(clinicId, sel.filters, now, false);
  const ids = [...new Set(sel.ids ?? [])].slice(0, 500);
  const out: DispatchItem[] = [];
  for (const id of ids) { const it = await loadItem(clinicId, id, now); if (it) out.push(it); }
  return out;
}

export async function previewRecovery(clinicId: string, sel: { ids?: string[]; filters?: DispatchFilters; allFiltered?: boolean }, now = new Date()): Promise<RecoveryPreview> {
  const items = await resolveSelection(clinicId, sel.allFiltered ? { ...sel, filters: { ...sel.filters, recoverableToday: false } } : sel, now);
  const elegiveis: RecoveryPreview["elegiveis"] = [], excluidos: RecoveryPreview["excluidos"] = [];
  for (const it of items) {
    if (it.recoverable) elegiveis.push({ id: it.id, paciente: it.patientName, telefone: it.phone, tipo: it.kind, motivo: it.reasonLabel });
    else excluidos.push({ id: it.id, paciente: it.patientName, motivo: it.recoverableWhy || it.statusLabel });
  }
  const avisos: string[] = [];
  if (elegiveis.length > RUN_MAX_ITEMS) avisos.push(`A fila aceita no máximo ${RUN_MAX_ITEMS} itens por recuperação; os demais ficam para uma nova.`);
  avisos.push("Prévia: nada foi enviado. Cada item é revalidado no momento do envio (cancelou, confirmou, remarcou ou já recebeu = sai da fila).");
  return { somenteLeitura: true, geradoEm: now.toISOString(), total: items.length, elegiveis: elegiveis.slice(0, RUN_MAX_ITEMS), excluidos, limite: RUN_MAX_ITEMS, avisos };
}

function refKeyOf(clinicId: string, it: DispatchItem): string {
  const p = parseItemId(it.id)!;
  const ref = p.src === "exr" ? p.b! : p.src === "exb" ? p.a : it.patientId;
  return [clinicId, it.kind, it.kind === "aniversario" ? it.patientId : ref, it.kind === "aniversario" ? it.sendDay : it.referenceAt, it.ruleId ?? "-"].join("|");
}

export async function createRecoveryRun(clinicId: string, sel: { ids?: string[]; filters?: DispatchFilters; allFiltered?: boolean }, actor: Actor, note: string | null, now = new Date()): Promise<{ runId: string; queued: number; skipped: { id: string; motivo: string }[] }> {
  const items = await resolveSelection(clinicId, sel, now);
  const skipped: { id: string; motivo: string }[] = [];
  const toQueue: DispatchItem[] = [];
  for (const it of items) {
    if (!it.recoverable) { skipped.push({ id: it.id, motivo: it.recoverableWhy || it.statusLabel }); continue; }
    if (toQueue.length >= RUN_MAX_ITEMS) { skipped.push({ id: it.id, motivo: "acima do limite de itens por recuperação" }); continue; }
    toQueue.push(it);
  }
  const run = await prisma.dispatchRun.create({ data: { clinicId, createdBy: actor.name, note: note?.slice(0, 200) ?? null, state: "queued", requested: items.length, allowed: toQueue.length } });
  let queued = 0;
  for (const it of toQueue) {
    const p = parseItemId(it.id)!;
    const refKey = refKeyOf(clinicId, it);
    try {
      await prisma.dispatchRunItem.create({
        data: { runId: run.id, clinicId, kind: it.kind, ref: it.kind === "aniversario" ? it.patientId : p.src === "exr" ? p.b! : (await prisma.reminderDispatch.findUnique({ where: { id: p.a }, select: { appointmentId: true } }))?.appointmentId ?? it.patientId, ruleId: it.ruleId, startsAt: it.kind === "aniversario" ? null : new Date(it.referenceAt), refKey, activeKey: refKey },
      });
      queued++;
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") skipped.push({ id: it.id, motivo: "já está em outra recuperação em andamento (duplo clique / outro usuário)" });
      else throw e;
    }
  }
  if (queued === 0) await prisma.dispatchRun.update({ where: { id: run.id }, data: { state: "completed", finishedAt: now } });
  await audit(clinicId, actor, "Recuperação de disparos criada", `fila ${run.id}: ${queued} item(ns) de ${items.length} selecionado(s)${note ? ` — ${note.slice(0, 80)}` : ""}`);
  if (queued > 0) kick();
  return { runId: run.id, queued, skipped };
}

export async function runControl(clinicId: string, runId: string, action: "pause" | "resume" | "cancel", actor: Actor, now = new Date()): Promise<{ ok: boolean; message: string }> {
  const run = await prisma.dispatchRun.findFirst({ where: { id: runId, clinicId } });
  if (!run) return { ok: false, message: "Fila não encontrada nesta clínica." };
  if (["completed", "cancelled"].includes(run.state)) return { ok: false, message: "Essa fila já terminou." };
  if (action === "pause") await prisma.dispatchRun.update({ where: { id: runId }, data: { state: "paused" } });
  else if (action === "resume") { if (run.state !== "paused") return { ok: false, message: "A fila não está pausada." }; await prisma.dispatchRun.update({ where: { id: runId }, data: { state: "queued" } }); kick(); }
  else {
    await prisma.dispatchRunItem.updateMany({ where: { runId, state: "pending" }, data: { state: "cancelled", activeKey: null, finishedAt: now, reason: "cancelado pela equipe" } });
    await prisma.dispatchRun.update({ where: { id: runId }, data: { state: "cancelled", finishedAt: now } });
  }
  await audit(clinicId, actor, "Fila de recuperação", `fila ${runId}: ${action}`);
  return { ok: true, message: action === "pause" ? "Fila pausada: o que já saiu não é desfeito." : action === "resume" ? "Fila retomada." : "Fila cancelada: o que ainda não saiu não será enviado." };
}

export async function listRuns(clinicId: string, take = 10) {
  const runs = await prisma.dispatchRun.findMany({ where: { clinicId }, orderBy: { createdAt: "desc" }, take, include: { items: { select: { state: true, result: true, reason: true } } } });
  return runs.map((r) => {
    const by: Record<string, number> = {};
    for (const i of r.items) by[i.state] = (by[i.state] ?? 0) + 1;
    const results: Record<string, number> = {};
    for (const i of r.items) if (i.result) results[i.result] = (results[i.result] ?? 0) + 1;
    return { id: r.id, state: r.state, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, requested: r.requested, allowed: r.allowed, itens: by, resultados: results, total: r.items.length };
  });
}

// ------------------------------------------------------------------ worker
async function takeLease(runId: string, now: Date): Promise<boolean> {
  const taken = await prisma.dispatchRun.updateMany({
    where: { id: runId, state: { in: ["queued", "running"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseHolder: OWNER }] },
    data: { leaseHolder: OWNER, leaseUntil: new Date(now.getTime() + LEASE_MS), state: "running", startedAt: now },
  });
  return taken.count === 1;
}
const renewLease = (runId: string, now: Date) => prisma.dispatchRun.updateMany({ where: { id: runId, leaseHolder: OWNER }, data: { leaseUntil: new Date(now.getTime() + LEASE_MS) } });

export interface WorkerOpts { now?: () => Date; sleep?: (ms: number) => Promise<void>; maxItems?: number }

export async function processDispatchRuns(opts: WorkerOpts = {}): Promise<{ processed: number }> {
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let processed = 0;
  // 1) devolve o que ficou "running" de um processo que caiu (concessao vencida): o controle persistente impede reenvio duplo
  const t0 = clock();
  const stale = await prisma.dispatchRun.findMany({ where: { state: "running", leaseUntil: { lt: t0 } }, select: { id: true } });
  for (const s of stale) {
    const items = await prisma.dispatchRunItem.findMany({ where: { runId: s.id, state: "running" } });
    for (const it of items) await prisma.dispatchRunItem.update({ where: { id: it.id }, data: it.attempts >= 3 ? { state: "failed", activeKey: null, reason: "processo caiu durante o envio e as tentativas acabaram", finishedAt: t0 } : { state: "pending", reason: "retomado depois de reinício" } });
  }
  const runs = await prisma.dispatchRun.findMany({ where: { state: { in: ["queued", "running"] } }, orderBy: { createdAt: "asc" }, take: 5 });
  for (const run of runs) {
    if (!(await takeLease(run.id, clock()))) continue;
    try {
      processed += await processRun(run.id, run.clinicId, clock, sleep, opts.maxItems);
    } finally {
      await prisma.dispatchRun.updateMany({ where: { id: run.id, leaseHolder: OWNER }, data: { leaseHolder: null, leaseUntil: null } });
    }
  }
  return { processed };
}

async function processRun(runId: string, clinicId: string, clock: () => Date, sleep: (ms: number) => Promise<void>, maxItems?: number): Promise<number> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const conn = await connectionUsable(clinicId, clock()).catch(() => ({ usable: true as const, since: null, reason: null }));
  let done = 0;
  const cap = maxItems ?? 12;
  const info = await getClinicTemplateInfo(clinicId);
  const env = { clock, tz, clinicInfo: info, stat: { deferred: 0, exhausted: 0, reasons: new Set<string>() }, ceDown: new Map<string, string>(), ceFailures: new Map<string, number>() };
  while (done < cap) {
    const fresh = await prisma.dispatchRun.findUnique({ where: { id: runId }, select: { state: true } });
    if (!fresh || fresh.state !== "running") break; // pausada/cancelada no meio: para ja
    const item = await prisma.dispatchRunItem.findFirst({ where: { runId, state: "pending", OR: [{ nextAt: null }, { nextAt: { lte: clock() } }] }, orderBy: { id: "asc" } });
    if (!item) break;
    const claimed = await prisma.dispatchRunItem.updateMany({ where: { id: item.id, state: "pending" }, data: { state: "running", startedAt: clock(), attempts: { increment: 1 } } });
    if (claimed.count !== 1) continue;
    let result = "skipped", reason = "";
    try {
      if (!conn.usable) { result = "deferred"; reason = "whatsapp_desconectado"; }
      else ({ result, reason } = await executeItem(item, clinicId, tz, env, clock));
    } catch (err) {
      result = "failed"; reason = `erro inesperado: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`;
    }
    if (result === "deferred" && reason === "whatsapp_desconectado") {
      await prisma.dispatchRunItem.update({ where: { id: item.id }, data: { state: "pending", reason, nextAt: new Date(clock().getTime() + 5 * 60_000) } });
      break;
    }
    await prisma.dispatchRunItem.update({ where: { id: item.id }, data: { state: result === "failed" ? "failed" : "done", result, reason: reason.slice(0, 200), activeKey: null, finishedAt: clock() } });
    await renewLease(runId, clock());
    done++;
    if (["sent", "unconfirmed"].includes(result)) await sleep(1500 + Math.random() * 2500);
  }
  const left = await prisma.dispatchRunItem.count({ where: { runId, state: { in: ["pending", "running"] } } });
  if (left === 0) await prisma.dispatchRun.update({ where: { id: runId }, data: { state: "completed", finishedAt: clock() } });
  return done;
}

type Env = Parameters<typeof deliverReminder>[0];

// Revalida e envia UM item pela via normal. Devolve o desfecho como aconteceu.
async function executeItem(item: { kind: string; ref: string; ruleId: string | null; startsAt: Date | null }, clinicId: string, tz: string, env: Env, clock: () => Date): Promise<{ result: string; reason: string }> {
  const now = clock();
  const today = isoDateInZone(now, tz);
  const hard = zonedWallClockToUtc(tz, ...(today.split("-").map(Number) as [number, number, number]), HARD_LAST_HOUR, 0);
  if (now.getTime() >= hard.getTime()) return { result: "skipped", reason: "depois do limite do dia (21h)" };
  const kind = item.kind as DispatchKind;
  if (kind === "aniversario") {
    const rule = await prisma.birthdayRule.findFirst({ where: { clinicId, active: true }, orderBy: { createdAt: "asc" } });
    if (!rule) return { result: "skipped", reason: "não há regra de aniversário ativa" };
    const { candidates } = await birthdayCandidatesToday(clinicId, now, tz);
    const c = candidates.find((x) => x.patient.id === item.ref);
    if (!c) return { result: "skipped", reason: "hoje não é o aniversário (ou a pessoa saiu da lista)" };
    if (!["send", "wait"].includes(c.verdict)) return { result: "skipped", reason: c.reason };
    const res = await deliverBirthday(rule, c.patient, tz, clock, { extendedReason: "recuperacao_manual", clinicInfo: env.clinicInfo });
    return { result: res.state === "blocked" ? "skipped" : res.state, reason: res.detail };
  }
  const rule = item.ruleId ? await prisma.reminderRule.findFirst({ where: { id: item.ruleId, clinicId } }) : null;
  if (!rule || !rule.active) return { result: "skipped", reason: "regra desligada ou removida" };
  const appt = await prisma.appointment.findFirst({ where: { id: item.ref, clinicId }, select: { id: true, scheduledAt: true, status: true, patientConfirmed: true, ceBookingUuid: true } });
  if (!appt) return { result: "skipped", reason: "agendamento não existe mais" };
  if (item.startsAt && appt.scheduledAt.getTime() !== item.startsAt.getTime()) return { result: "skipped", reason: "o horário mudou depois da prévia (nova versão do horário)" };
  if (appt.status !== "confirmed") return { result: "skipped", reason: `agendamento ${appt.status}` };
  const pol = await loadPolicy(clinicId, kind);
  if (appt.scheduledAt.getTime() - now.getTime() < pol.minLeadMin * 60_000) return { result: "skipped", reason: "o atendimento está perto demais para fazer sentido" };
  const target = isoDateInZone(appt.scheduledAt, tz);
  const rules = await prisma.reminderRule.findMany({ where: { clinicId, active: true } });
  const sel = await selectReminderCandidates(rule, now, tz, { targetDate: target, skipWindow: true, clinicRules: rules });
  const due = sel.due.find((a) => a.id === appt.id);
  if (!due) { const h = sel.held.find((x) => x.appointmentId === appt.id); return { result: "skipped", reason: h ? h.detail : "não é mais elegível (já recebeu, confirmou, cancelou ou mudou)" }; }
  // libera o controle persistente quando a falha foi recuperavel/definitiva e a equipe quis tentar de novo (o historico fica; so o estado volta a "failed")
  const key = bookingKeyOf(appt);
  const row = await prisma.reminderDispatch.findFirst({ where: { bookingKey: key, ruleId: rule.id, startsAt: appt.scheduledAt } });
  if (row && ["failed_permanent", "exhausted", "vetoed", "deferred", "failed"].includes(row.state)) {
    // numero que deu "sem WhatsApp" so tenta de novo se o cadastro mudou
    if (row.state === "failed_permanent" && row.destination && canonicalKey(row.destination) === canonicalKey(due.patient.phone)) return { result: "skipped", reason: "falha definitiva com este mesmo telefone: corrija o cadastro" };
    await prisma.reminderDispatch.update({ where: { id: row.id }, data: { state: "failed", attempt: Math.min(row.attempt, MAX_SEND_ATTEMPTS - 1), detail: "liberado para nova tentativa pela equipe (painel)", updatedAt: new Date(now.getTime() - 3_600_000) } });
  }
  const attempted = await deliverReminder(env, rule, due, { ignoreWindow: true, pause: false, origin: "recuperacao pelo painel" });
  const after = await prisma.reminderDispatch.findFirst({ where: { bookingKey: key, ruleId: rule.id, startsAt: appt.scheduledAt }, select: { state: true, detail: true } });
  if (!attempted) return { result: "skipped", reason: after ? `já tratado antes do envio (${after.state}${after.detail ? `: ${after.detail}` : ""})` : "não enviado na revalidação" };
  if (!after) return { result: "sent", reason: "" };
  return { result: after.state === "sent" ? "sent" : after.state === "unconfirmed" ? "unconfirmed" : after.state === "vetoed" ? "vetoed" : ["deferred", "failed", "failed_permanent"].includes(after.state) ? (after.state === "failed_permanent" ? "failed" : after.state) : "skipped", reason: after.detail ?? after.state };
}

// ------------------------------------------------------------------ job
export function startDispatchRunJob(): void {
  scheduleLocked("disparos", "* * * * *", async () => { await processDispatchRuns(); }, { ttlMs: 10 * 60_000 });
}

// Saude dos jobs (auditoria de reinicios/execucoes): ultima rodada, duracao, resultado e a proxima esperada.
export async function jobsHealth(clinicId: string, now = new Date()) {
  const defs: { job: string; label: string; everyMin: number }[] = [
    { job: "lembretes", label: "Confirmações e lembretes", everyMin: 15 },
    { job: "aniversario", label: "Aniversários", everyMin: 60 },
  ];
  const out = [];
  for (const d of defs) {
    const last = await prisma.automationRun.findFirst({ where: { job: d.job, clinicId }, orderBy: { startedAt: "desc" } });
    const lastOk = await prisma.automationRun.findFirst({ where: { job: d.job, clinicId, outcome: "ok" }, orderBy: { startedAt: "desc" } });
    const late = !last || now.getTime() - last.startedAt.getTime() > d.everyMin * 60_000 * 2.5;
    out.push({
      job: d.job, label: d.label, ultimaRodada: last?.startedAt.toISOString() ?? null, duracaoMs: last ? last.finishedAt.getTime() - last.startedAt.getTime() : null, resultado: last?.outcome ?? null,
      erro: last?.error ? last.error.slice(0, 120) : null, ultimaOk: lastOk?.startedAt.toISOString() ?? null, proximaEsperada: last ? new Date(last.startedAt.getTime() + d.everyMin * 60_000).toISOString() : null,
      atrasado: late, observacao: late ? "Sem rodada recente: pode ter parado ou reiniciado. A ampliação de janela cobre o dia, dentro dos limites da política." : null,
    });
  }
  void wallClockInZone;
  return out;
}
