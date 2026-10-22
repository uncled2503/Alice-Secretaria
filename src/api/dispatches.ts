import { Router, type Request, type Response, type RequestHandler } from "express";
import { prisma } from "../db/client.js";
import { buildDispatchView, REASONS, STATUS_LABEL, ITEM_KINDS, type DispatchFilters, type DispatchStatus, type ItemKind, type View } from "../dispatch/model.js";
import { DISPATCH_KINDS, POLICY_DEFAULTS, effectivePolicy, loadAllPolicies, validHHMM, type DispatchKind } from "../dispatch/policy.js";
import {
  cancelPending, correctRegistration, createRecoveryRun, dispatchDetail, handoffToHuman, jobsHealth, listRuns, previewRecovery, reconcileItem, resolvePhone, runControl, scheduleLater, loadItem, type Actor,
} from "../dispatch/actions.js";
import { logActivity } from "../crm/activity.js";

// ---------------------------------------------------------------------------
// API da aba DISPAROS. Escopo de clinica SEMPRE no servidor: conta "client" fica presa na propria clinica (clinicId vindo do cliente e ignorado); "admin" escolhe por ?clinicId=.
// Todas as acoes gravam no Diario (quem fez, o que, em qual item). Protecao contra repeticao: limite por clinica e por rota.
// ---------------------------------------------------------------------------
export const dispatchesRouter = Router();

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { handler(req, res).catch(next); };
}

async function scope(req: Request, res: Response): Promise<{ clinicId: string; actor: Actor } | null> {
  const s = req.staff;
  if (!s) { res.status(401).json({ error: "Login necessario" }); return null; }
  let clinicId: string | null;
  if (s.role !== "admin") clinicId = s.clinicId; // cliente: nunca confia no que veio na requisicao
  else clinicId = (req.query.clinicId as string | undefined) || (req.body?.clinicId as string | undefined) || (await prisma.clinic.findFirst({ select: { id: true } }))?.id || null;
  if (!clinicId) { res.status(403).json({ error: "Conta sem clinica associada" }); return null; }
  const exists = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
  if (!exists) { res.status(404).json({ error: "Clinica nao encontrada" }); return null; }
  return { clinicId, actor: { id: s.id, name: s.name || (s.role === "admin" ? "Administrador" : "Equipe") } };
}

// limite simples por clinica+rota (anti duplo clique / script): N chamadas por janela
const hits = new Map<string, number[]>();
function limited(clinicId: string, route: string, max: number, windowMs: number): boolean {
  const key = `${clinicId}|${route}`;
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  return false;
}
export function resetDispatchLimitsForTests(): void { hits.clear(); }

function filtersFrom(src: Record<string, unknown>): DispatchFilters {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const view = str(src.view);
  const kinds = list(src.kinds).filter((k): k is ItemKind => (ITEM_KINDS as readonly string[]).includes(k));
  const status = list(src.status).filter((s): s is DispatchStatus => s in STATUS_LABEL);
  return {
    view: view && ["hoje", "proximos", "atencao", "historico"].includes(view) ? (view as View) : undefined,
    from: str(src.from), to: str(src.to), kinds: kinds.length ? kinds : undefined, status: status.length ? status : undefined,
    reason: str(src.reason) && str(src.reason)! in REASONS ? str(src.reason) : undefined, ruleId: str(src.ruleId), campaignId: str(src.campaignId), q: str(src.q), professionalId: str(src.professionalId),
    recoverableToday: src.recoverableToday === true || src.recoverableToday === "1" || src.recoverableToday === "true",
    extended: src.extended === true || src.extended === "1" || src.extended === "true",
    page: Number(src.page) > 0 ? Number(src.page) : undefined, pageSize: Number(src.pageSize) > 0 ? Number(src.pageSize) : undefined,
  };
}

dispatchesRouter.get("/", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  const view = await buildDispatchView(sc.clinicId, filtersFrom(req.query as Record<string, unknown>));
  const campaigns = await prisma.broadcastCampaign.findMany({ where: { clinicId: sc.clinicId }, orderBy: { scheduledFor: "desc" }, take: 30, select: { id: true, title: true } });
  const [runs, jobs, rules, professionals] = await Promise.all([
    listRuns(sc.clinicId, 5), jobsHealth(sc.clinicId),
    prisma.reminderRule.findMany({ where: { clinicId: sc.clinicId }, select: { id: true, dayOffset: true, hoursBefore: true, parentRuleId: true, purpose: true, message: true, weekdays: true, active: true }, orderBy: { createdAt: "asc" } }),
    prisma.professional.findMany({ where: { clinicId: sc.clinicId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ ...view, runs, jobs, regras: rules.map((r) => ({ id: r.id, ativa: r.active, rotulo: `${r.parentRuleId ? "Cobrança" : r.purpose === "lembrete" ? "Lembrete" : "Confirmação"} · ${r.dayOffset != null ? (r.dayOffset === 0 ? "no dia" : `${r.dayOffset} dia(s) antes`) : `${r.hoursBefore}h antes`}` })), profissionais: professionals, campanhas: campaigns, tipos: ITEM_KINDS, statusLabels: STATUS_LABEL });
}));

dispatchesRouter.get("/export.csv", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  if (limited(sc.clinicId, "export", 6, 60_000)) { res.status(429).json({ error: "Muitas exportações seguidas. Aguarde um instante." }); return; }
  const v = await buildDispatchView(sc.clinicId, { ...filtersFrom(req.query as Record<string, unknown>), page: 1, pageSize: 200 });
  const rows = [...v.items];
  for (let p = 2; p <= Math.min(10, Math.ceil(v.total / 200)); p++) rows.push(...(await buildDispatchView(sc.clinicId, { ...filtersFrom(req.query as Record<string, unknown>), page: p, pageSize: 200 })).items);
  const esc = (s: unknown) => { let t = String(s ?? ""); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ["dia", "tipo", "pessoa", "telefone", "origem", "referencia", "estado", "motivo", "detalhe", "tentativas", "ultima_tentativa", "proxima_tentativa", "entrega", "recuperavel_hoje"];
  const lines = [head.join(";"), ...rows.map((i) => [i.sendDay, i.kind, i.patientName, i.phone, i.origin, i.referenceAt, i.statusLabel, i.reasonLabel, i.detail, i.attempts, i.attemptedAt, i.nextAttemptAt, i.deliveryState, i.recoverable ? "sim" : "nao"].map(esc).join(";"))];
  await logActivity({ clinicId: sc.clinicId, type: "dispatch_action", area: "automacoes", title: "Disparos exportados", description: `${rows.length} linha(s) (telefones mascarados)`, actorName: sc.actor.name });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="disparos-${v.periodo.from}_${v.periodo.to}.csv"`);
  res.send("﻿" + lines.join("\r\n"));
}));

dispatchesRouter.get("/policy", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  res.json({ politica: await loadAllPolicies(sc.clinicId), padroes: POLICY_DEFAULTS, tetoDuroHora: 21 });
}));

dispatchesRouter.put("/policy/:kind", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  const kind = req.params.kind as DispatchKind;
  if (!(DISPATCH_KINDS as readonly string[]).includes(kind)) { res.status(400).json({ error: "Tipo inválido" }); return; }
  const b = req.body ?? {};
  if (b.extendUntil !== undefined && !validHHMM(b.extendUntil)) { res.status(400).json({ error: "Horário limite inválido (use HH:MM)." }); return; }
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  for (const k of ["maxExtendMin", "minLeadMin", "maxAttempts", "retryGapMin", "maxPerRun"]) { const n = num(b[k]); if (n !== undefined && !Number.isFinite(n)) { res.status(400).json({ error: `Valor inválido em ${k}` }); return; } }
  // valores efetivos dentro dos limites seguros: o que gravamos ja e o que vale
  const eff = effectivePolicy(kind, { extendEnabled: typeof b.extendEnabled === "boolean" ? b.extendEnabled : undefined, extendUntil: b.extendUntil, maxExtendMin: num(b.maxExtendMin), minLeadMin: num(b.minLeadMin), maxAttempts: num(b.maxAttempts), retryGapMin: num(b.retryGapMin), maxPerRun: num(b.maxPerRun) });
  const data = { extendEnabled: eff.extendEnabled, extendUntil: eff.extendUntil, maxExtendMin: eff.maxExtendMin, minLeadMin: eff.minLeadMin, maxAttempts: eff.maxAttempts, retryGapMin: eff.retryGapMin, maxPerRun: eff.maxPerRun, updatedBy: sc.actor.name };
  await prisma.dispatchPolicy.upsert({ where: { clinicId_kind: { clinicId: sc.clinicId, kind } }, create: { clinicId: sc.clinicId, kind, ...data }, update: data });
  await logActivity({ clinicId: sc.clinicId, type: "dispatch_action", area: "automacoes", title: "Política de janela alterada", description: `${kind}: ampliação ${eff.extendEnabled ? `até ${eff.extendUntil} (máx. ${eff.maxExtendMin} min)` : "desligada"}; antecedência mínima ${eff.minLeadMin} min; ${eff.maxAttempts} tentativa(s)`, actorName: sc.actor.name });
  res.json({ ok: true, politica: (await loadAllPolicies(sc.clinicId))[kind] });
}));

dispatchesRouter.get("/item", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  const d = await dispatchDetail(sc.clinicId, String(req.query.id ?? ""));
  if (!d) { res.status(404).json({ error: "Item não encontrado nesta clínica" }); return; }
  res.json(d);
}));

dispatchesRouter.post("/recovery/preview", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  if (limited(sc.clinicId, "preview", 20, 60_000)) { res.status(429).json({ error: "Muitas prévias seguidas. Aguarde um instante." }); return; }
  const b = req.body ?? {};
  res.json(await previewRecovery(sc.clinicId, { ids: Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === "string") : undefined, filters: b.filters ? filtersFrom(b.filters) : undefined, allFiltered: b.allFiltered === true }));
}));

dispatchesRouter.post("/recovery", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  if (limited(sc.clinicId, "recovery", 3, 30_000)) { res.status(429).json({ error: "Já existe uma recuperação sendo criada. Aguarde alguns segundos antes de tentar de novo." }); return; }
  const b = req.body ?? {};
  const out = await createRecoveryRun(sc.clinicId, { ids: Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === "string") : undefined, filters: b.filters ? filtersFrom(b.filters) : undefined, allFiltered: b.allFiltered === true }, sc.actor, typeof b.note === "string" ? b.note : null);
  res.status(out.queued > 0 ? 202 : 200).json(out);
}));

dispatchesRouter.get("/runs", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  res.json({ runs: await listRuns(sc.clinicId, 20) });
}));

dispatchesRouter.post("/runs/:id/:action", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  const action = req.params.action;
  if (!["pause", "resume", "cancel"].includes(action)) { res.status(400).json({ error: "Ação inválida" }); return; }
  const out = await runControl(sc.clinicId, req.params.id, action as "pause" | "resume" | "cancel", sc.actor);
  res.status(out.ok ? 200 : 409).json(out);
}));

// Acoes individuais: { id, action, ... }
dispatchesRouter.post("/action", asyncRoute(async (req, res) => {
  const sc = await scope(req, res); if (!sc) return;
  if (limited(sc.clinicId, "action", 30, 60_000)) { res.status(429).json({ error: "Muitas ações seguidas. Aguarde um instante." }); return; }
  const b = req.body ?? {};
  const id = String(b.id ?? "");
  const action = String(b.action ?? "");
  const note = typeof b.note === "string" ? b.note : "";
  const item = await loadItem(sc.clinicId, id);
  if (!item) { res.status(404).json({ error: "Item não encontrado nesta clínica" }); return; }
  let out: { ok: boolean; message: string; [k: string]: unknown };
  switch (action) {
    case "atualizar": out = { ok: true, message: "Atualizado.", item }; break;
    case "conciliar": out = await reconcileItem(sc.clinicId, id, sc.actor, b.decision === "enviado" ? "enviado" : "nao_enviado", note); break;
    case "cancelar_pendente": out = await cancelPending(sc.clinicId, id, sc.actor); break;
    case "agendar_depois": out = await scheduleLater(sc.clinicId, id, Number(b.minutes) || 60, sc.actor); break;
    case "encaminhar_humano": out = await handoffToHuman(sc.clinicId, id, sc.actor, note); break;
    case "corrigir_cadastro": out = await correctRegistration(sc.clinicId, item.patientId, String(b.phone ?? ""), sc.actor); break;
    case "resolver_telefone": out = await resolvePhone(sc.clinicId, item.patientId, sc.actor); break;
    case "recuperar": { const r = await createRecoveryRun(sc.clinicId, { ids: [id] }, sc.actor, note || "recuperação individual"); out = { ok: r.queued > 0, message: r.queued > 0 ? "Na fila: o envio é revalidado antes de sair." : r.skipped[0]?.motivo ?? "Não elegível.", runId: r.runId }; break; }
    default: res.status(400).json({ error: "Ação desconhecida" }); return;
  }
  res.status(out.ok ? 200 : 409).json(out);
}));
