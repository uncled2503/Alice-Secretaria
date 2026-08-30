import { Router, type Request, type Response, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { timingSafeEqual } from "crypto";
import { prisma } from "../db/client.js";
import {
  sendText,
  connectClinic,
  disconnectClinic,
  getStatus,
  getProfilePicUrl,
  triggerHistoryImport,
  getUazapiConfig,
  saveUazapiConfig,
  verifyWebhookSignature,
  enqueueWebhook,
} from "../uazapi/client.js";
import { getFunnelStages, generateStageId } from "../crm/stages.js";
import { movePatientToKind, movePatientToRecovery, movePatientToStage } from "../crm/stageAutomation.js";
import { offerFreedSlotToWaitlist } from "../scheduling/waitlist.js";
import { patientDossier } from "../crm/dossier.js";
import { logActivity, ACTIVITY_AREAS, ACTIVITY_TYPES } from "../crm/activity.js";
import { createRuleDraft, RULE_CATEGORIES, seedDefaultRules, reseedRulesForProfile } from "../ai/rules.js";
import { BRIEFING_TEMPLATE, parseBriefing, applyBriefing, BriefingPlanSchema } from "../ai/briefing.js";
import { API_SCOPES, API_SCOPE_IDS, generateApiKey } from "./external/keys.js";
import { answerSiteQuestion, type SiteMessage } from "../ai/siteAssistant.js";
import { notifyStaff } from "../crm/notify.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { createSessionCookie, clearSessionCookie } from "./staffSession.js";

export const apiRouter = Router();

// Webhook publico da UAZAPI. Nao usa a sessao do painel: a autenticacao e
// feita por assinatura HMAC especifica da clinica e, quando presente, pelo
// token da instancia contido no payload.
apiRouter.post(
  "/uazapi/webhook/:clinicId/:signature",
  asyncRoute(async (req, res) => {
    if (!verifyWebhookSignature(req.params.clinicId, req.params.signature)) {
      res.status(401).json({ error: "Assinatura de webhook invalida" });
      return;
    }
    try {
      const result = await enqueueWebhook(req.params.clinicId, req.body);
      res.status(200).json({ ok: true, result });
    } catch (error) {
      console.error("[UAZAPI] Falha ao receber webhook:", error);
      res.status(400).json({ error: "Webhook rejeitado" });
    }
  })
);

// --- Assistente de ajuda do painel (somente usuario autenticado) ---
// Mesmo protegido por login, mantem limite por IP para conter abuso acidental
// ou uma sessao autenticada comprometida.
const assistantAskRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas perguntas em pouco tempo. Aguarde alguns minutos e tente novamente." },
});

apiRouter.post(
  "/assistant/ask",
  assistantAskRateLimit,
  asyncRoute(async (req, res) => {
    const { messages } = (req.body ?? {}) as { messages?: unknown };
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages e obrigatorio" });
      return;
    }
    const history = messages as SiteMessage[];
    try {
      const reply = await answerSiteQuestion(history);
      res.json({ reply });
    } catch (err) {
      console.error("Falha no assistente do painel:", err);
      res.status(502).json({ error: "Nao consegui responder agora. Tenta de novo em instantes." });
    }
  })
);

// Express 4 nao encaminha rejeicoes de handlers async para o error handler
// sozinho; sem isso, uma falha (ex: WhatsApp desconectado) derruba o processo
// inteiro e para o atendimento de todos os pacientes.
function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

// Resolve a clinica: contas "client" ficam SEMPRE travadas na propria clinica
// (nunca confiamos num clinicId vindo do cliente pra essas contas - e assim
// que o isolamento entre clientes da Alice e garantido). Contas "admin" usam
// ?clinicId= (GET) ou clinicId no body (POST), ou a primeira clinica cadastrada
// se nao especificado - mantem o painel interno funcionando sem selecionar nada.
async function getClinic(req: Request) {
  if (req.staff && req.staff.role !== "admin") {
    if (!req.staff.clinicId) throw new Error("Conta sem clinica associada");
    return prisma.clinic.findUniqueOrThrow({ where: { id: req.staff.clinicId } });
  }

  const clinicId = (req.query.clinicId as string | undefined) || (req.body?.clinicId as string | undefined);
  if (clinicId) return prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  return prisma.clinic.findFirstOrThrow();
}

function requireAdmin(req: Request, res: Response): boolean {
  if (req.staff?.role !== "admin") {
    res.status(403).json({ error: "Somente contas admin podem fazer isso" });
    return false;
  }
  return true;
}

// Contas "client" so podem mexer em recursos da propria clinica - usado em
// toda rota que opera por :id direto (nao passa pelo getClinic acima).
function assertClinicAccess(req: Request, res: Response, resourceClinicId: string): boolean {
  if (req.staff && req.staff.role !== "admin" && req.staff.clinicId !== resourceClinicId) {
    res.status(403).json({ error: "Sem acesso a esse recurso" });
    return false;
  }
  return true;
}

apiRouter.get(
  "/clinics",
  asyncRoute(async (req, res) => {
    const isClient = req.staff && req.staff.role !== "admin";
    const clinics = await prisma.clinic.findMany({
      where: isClient ? { id: req.staff!.clinicId! } : {},
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        whatsappPhone: true,
        timezone: true,
        workStartHour: true,
        workEndHour: true,
        workDays: true,
        active: true,
        notifyPhone: true,
        notifyEvents: true,
        assistantPersona: true,
        assistantPersonaName: true,
        assistantName: true,
        activityArea: true,
        handoffPhrase: true,
        splitLongMessages: true,
        splitMaxMessages: true,
        splitThresholdChars: true,
        requireDepositProof: true,
        servicePosture: true,
        clinicKind: true,
        evaluationFirst: true,
        allowEmojis: true,
        schedulingLink: true,
      },
    });
    const withStatus = await Promise.all(clinics.map(async (clinic) => ({ ...clinic, ...(await getStatus(clinic.id)) })));
    res.json(withStatus);
  })
);

apiRouter.put(
  "/clinics/:id",
  asyncRoute(async (req, res) => {
    if (req.staff && req.staff.role !== "admin" && req.staff.clinicId !== req.params.id) {
      res.status(403).json({ error: "Sem acesso a essa clinica" });
      return;
    }

    const b = req.body as {
      name?: string;
      whatsappPhone?: string;
      timezone?: string;
      workStartHour?: number;
      workEndHour?: number;
      workDays?: string;
      active?: boolean;
      notifyPhone?: string | null;
      notifyEvents?: string;
      assistantPersona?: string;
      assistantPersonaName?: string | null;
      assistantName?: string;
      activityArea?: string | null;
      handoffPhrase?: string | null;
      splitLongMessages?: boolean;
      splitMaxMessages?: number;
      splitThresholdChars?: number;
      requireDepositProof?: boolean;
      servicePosture?: string;
      clinicKind?: string;
      evaluationFirst?: boolean;
      allowEmojis?: boolean;
      schedulingLink?: string | null;
    };
    const { name, whatsappPhone, timezone, workStartHour, workEndHour, workDays, active, notifyPhone, notifyEvents, assistantPersona, assistantPersonaName } = b;

    // So admin bloqueia/desbloqueia - um cliente nao pode se desbloquear sozinho.
    if (active !== undefined && !requireAdmin(req, res)) return;

    const PERSONAS = ["team", "clinic_secretary", "professional_secretary"];
    if (assistantPersona !== undefined && !PERSONAS.includes(assistantPersona)) {
      res.status(400).json({ error: "assistantPersona invalido" });
      return;
    }
    if (b.servicePosture !== undefined && !["comercial", "consultivo"].includes(b.servicePosture)) {
      res.status(400).json({ error: "servicePosture invalido" });
      return;
    }
    if (b.clinicKind !== undefined && !["estetica", "medica", "ambas"].includes(b.clinicKind)) {
      res.status(400).json({ error: "clinicKind invalido" });
      return;
    }

    if (whatsappPhone !== undefined && !whatsappPhone.replace(/\D/g, "")) {
      res.status(400).json({ error: "whatsappPhone nao pode ficar vazio" });
      return;
    }

    try {
      const clinic = await prisma.clinic.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(whatsappPhone !== undefined ? { whatsappPhone: whatsappPhone.replace(/\D/g, "") } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          ...(workStartHour !== undefined ? { workStartHour } : {}),
          ...(workEndHour !== undefined ? { workEndHour } : {}),
          ...(workDays !== undefined ? { workDays } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(notifyPhone !== undefined ? { notifyPhone: notifyPhone || null } : {}),
          ...(notifyEvents !== undefined ? { notifyEvents } : {}),
          ...(assistantPersona !== undefined ? { assistantPersona } : {}),
          ...(assistantPersonaName !== undefined ? { assistantPersonaName: assistantPersonaName?.trim() || null } : {}),
          ...(b.assistantName !== undefined ? { assistantName: b.assistantName.trim() || "Alice" } : {}),
          ...(b.activityArea !== undefined ? { activityArea: b.activityArea?.trim() || null } : {}),
          ...(b.handoffPhrase !== undefined ? { handoffPhrase: b.handoffPhrase?.trim() || null } : {}),
          ...(b.splitLongMessages !== undefined ? { splitLongMessages: b.splitLongMessages } : {}),
          ...(b.splitMaxMessages !== undefined ? { splitMaxMessages: Math.min(Math.max(b.splitMaxMessages, 1), 8) } : {}),
          ...(b.splitThresholdChars !== undefined ? { splitThresholdChars: Math.min(Math.max(b.splitThresholdChars, 120), 2000) } : {}),
          ...(b.requireDepositProof !== undefined ? { requireDepositProof: b.requireDepositProof } : {}),
          ...(b.servicePosture !== undefined ? { servicePosture: b.servicePosture } : {}),
          ...(b.clinicKind !== undefined ? { clinicKind: b.clinicKind } : {}),
          ...(b.evaluationFirst !== undefined ? { evaluationFirst: b.evaluationFirst } : {}),
          ...(b.allowEmojis !== undefined ? { allowEmojis: b.allowEmojis } : {}),
          ...(b.schedulingLink !== undefined ? { schedulingLink: b.schedulingLink?.trim() || null } : {}),
        },
      });

      // Mudou o perfil de atendimento -> reajusta as regras recomendadas.
      if (b.servicePosture !== undefined || b.clinicKind !== undefined || b.evaluationFirst !== undefined) {
        await reseedRulesForProfile(clinic.id);
      }
      await logActivity({
        clinicId: clinic.id,
        type: "clinic_updated",
        area: "clinica",
        title: active === false ? "Clínica bloqueada" : active === true ? "Clínica desbloqueada" : "Dados da clínica alterados",
        description: "As configurações gerais da clínica foram atualizadas.",
        actorName: req.staff?.name ?? null,
      });
      res.json(clinic);
    } catch (err: any) {
      if (err?.code === "P2002") {
        res.status(409).json({ error: "Ja existe uma clinica cadastrada com esse numero de WhatsApp" });
        return;
      }
      throw err;
    }
  })
);

// Credenciais UAZAPI de uma clinica especifica. Estas rotas existem para o
// painel administrativo gerenciar cada instancia sem depender da clinica
// selecionada no topo. O token completo nunca volta para o navegador.
apiRouter.get(
  "/clinics/:id/uazapi",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(await getUazapiConfig(req.params.id));
  })
);

apiRouter.put(
  "/clinics/:id/uazapi",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { baseUrl, token } = req.body as { baseUrl?: string; token?: string };
    if (!baseUrl) {
      res.status(400).json({ error: "baseUrl obrigatoria" });
      return;
    }
    try {
      const result = await saveUazapiConfig(req.params.id, { baseUrl, token });
      await logActivity({
        clinicId: req.params.id,
        type: "clinic_updated",
        area: "clinica",
        title: "Conexão do WhatsApp atualizada",
        description: "As credenciais de conexão do WhatsApp da clínica foram validadas pelo painel administrativo.",
        actorName: req.staff?.name ?? null,
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao validar a UAZAPI";
      res.status(400).json({ error: message });
    }
  })
);

// So admin cria clinica nova (onboarding de um cliente novo da Alice).
apiRouter.post(
  "/clinics",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { name, whatsappPhone } = req.body as { name?: string; whatsappPhone?: string };

    if (!name || !whatsappPhone) {
      res.status(400).json({ error: "name e whatsappPhone sao obrigatorios" });
      return;
    }

    try {
      const clinic = await prisma.clinic.create({
        data: { name, whatsappPhone: whatsappPhone.replace(/\D/g, "") },
      });
      await seedDefaultRules(clinic.id);
      res.json(clinic);
    } catch (err: any) {
      if (err?.code === "P2002") {
        res.status(409).json({ error: "Ja existe uma clinica cadastrada com esse numero de WhatsApp" });
        return;
      }
      throw err;
    }
  })
);

// So admin exclui, e so se a clinica estiver vazia (sem paciente/conta de
// equipe) - evita apagar por engano uma clinica de cliente de verdade com
// historico. Clinica de teste/duplicada criada errada cai nesse caso.
apiRouter.delete(
  "/clinics/:id",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const [patientCount, staffCount] = await Promise.all([
      prisma.patient.count({ where: { clinicId: req.params.id } }),
      prisma.staffUser.count({ where: { clinicId: req.params.id } }),
    ]);
    if (patientCount > 0 || staffCount > 0) {
      res.status(400).json({ error: "So da pra excluir clinicas vazias (sem contato nem conta de equipe vinculada)" });
      return;
    }

    await prisma.$transaction([
      prisma.clinicLocation.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.funnelStage.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.followUpRule.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.reminderRule.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.postProcedureRule.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.renewalRule.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.birthdayRule.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.activityLog.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.messageTemplate.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.clinicFaq.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.playbook.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.customRule.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.procedure.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.broadcastCampaign.deleteMany({ where: { clinicId: req.params.id } }),
      prisma.clinic.delete({ where: { id: req.params.id } }),
    ]);
    res.json({ ok: true });
  })
);

// --- Unidades/enderecos da clinica (uma clinica pode ter mais de uma) ---

apiRouter.get(
  "/clinic-locations",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const locations = await prisma.clinicLocation.findMany({
      where: { clinicId: clinic.id },
      orderBy: { order: "asc" },
    });
    res.json(locations);
  })
);

apiRouter.post(
  "/clinic-locations",
  asyncRoute(async (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name) {
      res.status(400).json({ error: "name obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const last = await prisma.clinicLocation.findFirst({ where: { clinicId: clinic.id }, orderBy: { order: "desc" } });

    const location = await prisma.clinicLocation.create({
      data: { clinicId: clinic.id, name, order: (last?.order ?? -1) + 1 },
    });
    res.json(location);
  })
);

apiRouter.put(
  "/clinic-locations/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.clinicLocation.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const {
      name,
      googleMapsUrl,
      website,
      timezone,
      street,
      number,
      complement,
      neighborhood,
      city,
      state,
      zipCode,
      country,
      arrivalInstructions,
      active,
      order,
    } = req.body as Record<string, string | number | boolean | undefined>;

    const location = await prisma.clinicLocation.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name: name as string } : {}),
        ...(googleMapsUrl !== undefined ? { googleMapsUrl: (googleMapsUrl as string) || null } : {}),
        ...(website !== undefined ? { website: (website as string) || null } : {}),
        ...(timezone !== undefined ? { timezone: timezone as string } : {}),
        ...(street !== undefined ? { street: (street as string) || null } : {}),
        ...(number !== undefined ? { number: (number as string) || null } : {}),
        ...(complement !== undefined ? { complement: (complement as string) || null } : {}),
        ...(neighborhood !== undefined ? { neighborhood: (neighborhood as string) || null } : {}),
        ...(city !== undefined ? { city: (city as string) || null } : {}),
        ...(state !== undefined ? { state: (state as string) || null } : {}),
        ...(zipCode !== undefined ? { zipCode: (zipCode as string) || null } : {}),
        ...(country !== undefined ? { country: country as string } : {}),
        ...(arrivalInstructions !== undefined ? { arrivalInstructions: (arrivalInstructions as string) || null } : {}),
        ...(active !== undefined ? { active: active as boolean } : {}),
        ...(order !== undefined ? { order: order as number } : {}),
      },
    });
    res.json(location);
  })
);

apiRouter.delete(
  "/clinic-locations/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.clinicLocation.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.clinicLocation.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// Configuracao e conexao da instancia UAZAPI da clinica.
apiRouter.get(
  "/whatsapp/config",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    res.json(await getUazapiConfig(clinic.id));
  })
);

apiRouter.put(
  "/whatsapp/config",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const clinic = await getClinic(req);
    const { baseUrl, token } = req.body as { baseUrl?: string; token?: string };
    if (!baseUrl) {
      res.status(400).json({ error: "baseUrl obrigatoria" });
      return;
    }
    try {
      res.json(await saveUazapiConfig(clinic.id, { baseUrl, token }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao validar a UAZAPI";
      res.status(400).json({ error: message });
    }
  })
);

apiRouter.get(
  "/whatsapp/status",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    res.json(await getStatus(clinic.id));
  })
);

apiRouter.post(
  "/whatsapp/connect",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    try {
      await connectClinic(clinic.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Falha ao gerar o QR Code" });
    }
  })
);

apiRouter.post(
  "/whatsapp/disconnect",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    try {
      await disconnectClinic(clinic.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Falha ao desconectar" });
    }
  })
);

apiRouter.get(
  "/whatsapp/import-status",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const info = await prisma.clinic.findUniqueOrThrow({
      where: { id: clinic.id },
      select: { importStatus: true, importStats: true, importUpdatedAt: true },
    });
    res.json({
      status: info.importStatus,
      stats: info.importStats ? JSON.parse(info.importStats) : null,
      updatedAt: info.importUpdatedAt,
    });
  })
);

apiRouter.post(
  "/whatsapp/import",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    try {
      await triggerHistoryImport(clinic.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Falha ao iniciar importacao" });
    }
  })
);

apiRouter.get(
  "/dashboard/stats",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const { start, end } = req.query as { start?: string; end?: string };
    const startDate = start ? new Date(start) : new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const endDate = end ? new Date(end) : new Date();

    const [attended, appointments] = await Promise.all([
      prisma.message
        .findMany({
          where: {
            role: "user",
            createdAt: { gte: startDate, lte: endDate },
            conversation: { patient: { clinicId: clinic.id } },
          },
          select: { conversation: { select: { patientId: true } } },
          distinct: ["conversationId"],
        })
        .then((rows) => new Set(rows.map((r) => r.conversation.patientId)).size),
      prisma.appointment.findMany({
        where: { clinicId: clinic.id, scheduledAt: { gte: startDate, lte: endDate } },
        select: { scheduledAt: true, status: true },
      }),
    ]);

    const completed = appointments.filter((a) => a.status === "completed").length;
    const cancelled = appointments.filter((a) => a.status === "cancelled").length;
    const total = appointments.length;

    const dailyMap = new Map<string, number>();
    for (const a of appointments) {
      const key = a.scheduledAt.toISOString().slice(0, 10);
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
    }
    const daily: { date: string; count: number }[] = [];
    const cursor = new Date(startDate);
    cursor.setHours(0, 0, 0, 0);
    const lastDay = new Date(endDate);
    while (cursor <= lastDay && daily.length < 60) {
      const key = cursor.toISOString().slice(0, 10);
      daily.push({ date: key, count: dailyMap.get(key) ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({
      attended,
      appointmentsTotal: total,
      appointmentsCompleted: completed,
      appointmentsCancelled: cancelled,
      daily,
    });
  })
);

apiRouter.get(
  "/procedures",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const procedures = await prisma.procedure.findMany({
      where: { clinicId: clinic.id },
      orderBy: { name: "asc" },
    });
    res.json(procedures);
  })
);

type ProcedureBody = {
  name?: string;
  durationMin?: number;
  description?: string;
  price?: number | null;
  priceVariable?: boolean;
  offerInstallments?: boolean;
  maxInstallments?: number | null;
  paymentMethods?: string[];
  paymentLink?: string | null;
  goals?: string;
  benefits?: string;
  aliases?: string;
  resultTimeline?: string;
};

function procedureWriteData(body: ProcedureBody) {
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.durationMin !== undefined ? { durationMin: body.durationMin && body.durationMin > 0 ? body.durationMin : 60 } : {}),
    ...(body.description !== undefined ? { description: body.description || null } : {}),
    ...(body.price !== undefined ? { price: body.price === null ? null : Number(body.price) } : {}),
    ...(body.priceVariable !== undefined ? { priceVariable: !!body.priceVariable } : {}),
    ...(body.offerInstallments !== undefined ? { offerInstallments: !!body.offerInstallments } : {}),
    ...(body.maxInstallments !== undefined ? { maxInstallments: body.maxInstallments === null ? null : Number(body.maxInstallments) } : {}),
    ...(body.paymentMethods !== undefined ? { paymentMethods: body.paymentMethods.join(",") } : {}),
    ...(body.paymentLink !== undefined ? { paymentLink: body.paymentLink || null } : {}),
    ...(body.goals !== undefined ? { goals: body.goals || null } : {}),
    ...(body.benefits !== undefined ? { benefits: body.benefits || null } : {}),
    ...(body.aliases !== undefined ? { aliases: body.aliases || null } : {}),
    ...(body.resultTimeline !== undefined ? { resultTimeline: body.resultTimeline || null } : {}),
  };
}

apiRouter.post(
  "/procedures",
  asyncRoute(async (req, res) => {
    const body = req.body as ProcedureBody;
    if (!body.name) {
      res.status(400).json({ error: "name obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const procedure = await prisma.procedure.create({
      data: { clinicId: clinic.id, name: body.name, ...procedureWriteData(body) },
    });
    await logActivity({ clinicId: clinic.id, type: "catalog_added", area: "catalogo", title: "Serviço adicionado", description: procedure.name, actorName: req.staff?.name ?? null });
    res.json(procedure);
  })
);

apiRouter.put(
  "/procedures/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.procedure.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const procedure = await prisma.procedure.update({
      where: { id: req.params.id },
      data: procedureWriteData(req.body as ProcedureBody),
    });
    res.json(procedure);
  })
);

apiRouter.delete(
  "/procedures/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.procedure.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.procedure.delete({ where: { id: req.params.id } });
    await logActivity({ clinicId: existing.clinicId, type: "catalog_removed", area: "catalogo", title: "Serviço removido", description: existing.name, actorName: req.staff?.name ?? null });
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/products",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const products = await prisma.product.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "asc" },
    });
    res.json(products);
  })
);

apiRouter.post(
  "/products",
  asyncRoute(async (req, res) => {
    const { name, price, description, photoUrl } = req.body as {
      name?: string;
      price?: number | null;
      description?: string;
      photoUrl?: string | null;
    };
    if (!name) {
      res.status(400).json({ error: "name obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const product = await prisma.product.create({
      data: {
        clinicId: clinic.id,
        name,
        price: price === null || price === undefined ? null : Number(price),
        description: description || null,
        photoUrl: photoUrl || null,
      },
    });
    res.json(product);
  })
);

apiRouter.put(
  "/products/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { name, price, description, photoUrl } = req.body as {
      name?: string;
      price?: number | null;
      description?: string;
      photoUrl?: string | null;
    };

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(price !== undefined ? { price: price === null ? null : Number(price) } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
      },
    });
    res.json(product);
  })
);

apiRouter.delete(
  "/products/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// Diretorio de profissionais (nome, foto, bio, quais procedimentos cada um
// atende). Sem agenda/turno proprio - a atribuicao a um agendamento e
// manual, feita direto no modal de editar agendamento.
apiRouter.get(
  "/professionals",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const professionals = await prisma.professional.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "asc" },
      include: { procedures: { select: { id: true, name: true } } },
    });
    res.json(professionals);
  })
);

apiRouter.post(
  "/professionals",
  asyncRoute(async (req, res) => {
    const { name, instagram, bio, color, photoUrl, procedureIds, workDays, workStartHour, workEndHour } = req.body as {
      name?: string;
      instagram?: string;
      bio?: string;
      color?: string;
      photoUrl?: string;
      procedureIds?: string[];
      workDays?: string | null;
      workStartHour?: number | null;
      workEndHour?: number | null;
    };
    if (!name) {
      res.status(400).json({ error: "name obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const professional = await prisma.professional.create({
      data: {
        clinicId: clinic.id,
        name,
        instagram: instagram || null,
        bio: bio || null,
        color: color || null,
        photoUrl: photoUrl || null,
        workDays: workDays || null,
        workStartHour: workStartHour ?? null,
        workEndHour: workEndHour ?? null,
        ...(procedureIds ? { procedures: { connect: procedureIds.map((id) => ({ id })) } } : {}),
      },
      include: { procedures: { select: { id: true, name: true } } },
    });
    res.json(professional);
  })
);

apiRouter.put(
  "/professionals/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.professional.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { name, instagram, bio, color, photoUrl, active, procedureIds, workDays, workStartHour, workEndHour } = req.body as {
      name?: string;
      instagram?: string;
      bio?: string;
      color?: string;
      photoUrl?: string;
      active?: boolean;
      procedureIds?: string[];
      workDays?: string | null;
      workStartHour?: number | null;
      workEndHour?: number | null;
    };

    const professional = await prisma.professional.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(instagram !== undefined ? { instagram: instagram || null } : {}),
        ...(bio !== undefined ? { bio: bio || null } : {}),
        ...(color !== undefined ? { color: color || null } : {}),
        ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(workDays !== undefined ? { workDays: workDays || null } : {}),
        ...(workStartHour !== undefined ? { workStartHour: workStartHour ?? null } : {}),
        ...(workEndHour !== undefined ? { workEndHour: workEndHour ?? null } : {}),
        ...(procedureIds !== undefined ? { procedures: { set: procedureIds.map((id) => ({ id })) } } : {}),
      },
      include: { procedures: { select: { id: true, name: true } } },
    });
    res.json(professional);
  })
);

apiRouter.delete(
  "/professionals/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.professional.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.professional.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/contacts",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const patients = await prisma.patient.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "desc" },
      include: { tags: { include: { tag: { select: { id: true, label: true, color: true } } } } },
    });
    res.json(patients.map((p) => ({ ...p, tags: p.tags.map((pt) => pt.tag) })));
  })
);

// Contato manual (ex: paciente que ligou/apareceu presencialmente, sem
// nunca ter mandado mensagem pelo WhatsApp).
apiRouter.post(
  "/contacts",
  asyncRoute(async (req, res) => {
    const { name, phone } = req.body as { name?: string; phone?: string };
    if (!phone) {
      res.status(400).json({ error: "phone obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId: clinic.id, phone: phone.replace(/\D/g, "") } },
      update: { name: name || undefined },
      create: { clinicId: clinic.id, phone: phone.replace(/\D/g, ""), name: name || null },
    });
    res.json(patient);
  })
);

// Apaga o contato e tudo que depende dele (mensagens, conversas, agendamentos,
// destinatarios de campanha) - as chaves estrangeiras sao RESTRICT no banco,
// entao sem apagar essas dependencias primeiro o delete do paciente falharia.
apiRouter.delete(
  "/contacts/:id",
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id } });
    if (!assertClinicAccess(req, res, patient.clinicId)) return;

    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversation: { patientId: id } } }),
      prisma.conversation.deleteMany({ where: { patientId: id } }),
      prisma.appointment.deleteMany({ where: { patientId: id } }),
      prisma.broadcastRecipient.deleteMany({ where: { patientId: id } }),
      prisma.patient.delete({ where: { id } }),
    ]);
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/conversations",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const conversations = await prisma.conversation.findMany({
      where: { patient: { clinicId: clinic.id } },
      orderBy: { lastMessageAt: "desc" },
      include: {
        patient: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    const withAvatars = await Promise.all(
      conversations.map(async (c) => ({
        id: c.id,
        status: c.status,
        humanTakeover: c.humanTakeover,
        handoffReason: c.handoffReason,
        lastMessageAt: c.lastMessageAt,
        patient: {
          id: c.patient.id,
          name: c.patient.name,
          phone: c.patient.phone,
          birthDate: c.patient.birthDate,
          avatarUrl: await getProfilePicUrl(clinic.id, c.patient.phone),
        },
        lastMessage: c.messages[0]?.content ?? null,
      }))
    );

    res.json(withAvatars);
  })
);

apiRouter.get(
  "/conversations/:id/messages",
  asyncRoute(async (req, res) => {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { patient: true },
    });
    if (!assertClinicAccess(req, res, conversation.patient.clinicId)) return;

    const messages = await prisma.message.findMany({
      where: { conversationId: req.params.id },
      orderBy: { createdAt: "asc" },
    });
    res.json(messages);
  })
);

// Atendente assume a conversa manualmente e manda uma mensagem; Alice para de
// responder ali ate alguem devolver o controle (endpoint /resume).
apiRouter.post(
  "/conversations/:id/send",
  asyncRoute(async (req, res) => {
    const { text } = req.body as { text?: string };
    if (!text) {
      res.status(400).json({ error: "text obrigatorio" });
      return;
    }

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { patient: true },
    });
    if (!assertClinicAccess(req, res, conversation.patient.clinicId)) return;

    const authorName = req.staff?.name ?? null;

    // So loga o evento de transferencia na PRIMEIRA mensagem manual - nao a
    // cada mensagem, senao vira um evento por linha de texto.
    if (!conversation.humanTakeover) {
      await prisma.message.create({
        data: { conversationId: conversation.id, role: "system", content: "Atendimento transferido para o atendente", authorName },
      });
      const patientLabel = conversation.patient.name ?? conversation.patient.phone;
      await notifyStaff(
        conversation.patient.clinicId,
        "human_handoff",
        `Atendimento assumido manualmente: ${patientLabel}${authorName ? ` (por ${authorName})` : ""}.`
      );
      await logActivity({
        clinicId: conversation.patient.clinicId,
        type: "human_takeover",
        area: "atendimento",
        title: "Atendimento assumido por uma pessoa",
        description: `A Alice parou de responder a conversa com ${patientLabel} para a equipe continuar o atendimento.`,
        actorName: authorName,
      });
    }

    await prisma.message.create({
      data: { conversationId: conversation.id, role: "human", content: text, authorName },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { humanTakeover: true, lastMessageAt: new Date() },
    });

    try {
      await sendText(conversation.patient.clinicId, conversation.patient.phone, text);
    } catch (err) {
      console.error("Falha ao enviar mensagem via WhatsApp:", err);
      res.status(502).json({ ok: false, error: "Mensagem salva, mas falhou ao enviar pelo WhatsApp" });
      return;
    }

    res.json({ ok: true });
  })
);

// Assume o atendimento sem enviar mensagem: a Alice para de responder ali.
apiRouter.post(
  "/conversations/:id/takeover",
  asyncRoute(async (req, res) => {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { patient: true },
    });
    if (!assertClinicAccess(req, res, conversation.patient.clinicId)) return;

    if (!conversation.humanTakeover) {
      const authorName = req.staff?.name ?? null;
      const patientLabel = conversation.patient.name ?? conversation.patient.phone;
      await prisma.message.create({
        data: { conversationId: conversation.id, role: "system", content: "Atendimento transferido para o atendente", authorName },
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { humanTakeover: true } });
      await notifyStaff(
        conversation.patient.clinicId,
        "human_handoff",
        `Atendimento assumido manualmente: ${patientLabel}${authorName ? ` (por ${authorName})` : ""}.`,
      );
      await logActivity({
        clinicId: conversation.patient.clinicId,
        type: "human_takeover",
        area: "atendimento",
        title: "Atendimento assumido por uma pessoa",
        description: `A Alice parou de responder a conversa com ${patientLabel} para a equipe continuar o atendimento.`,
        actorName: authorName,
      });
    }
    res.json({ ok: true });
  })
);

apiRouter.post(
  "/conversations/:id/resume",
  asyncRoute(async (req, res) => {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { patient: true },
    });
    if (!assertClinicAccess(req, res, conversation.patient.clinicId)) return;

    await prisma.message.create({
      data: {
        conversationId: req.params.id,
        role: "system",
        content: "Atendimento transferido para a Alice",
        authorName: req.staff?.name ?? null,
      },
    });
    await prisma.conversation.update({
      where: { id: req.params.id },
      data: { humanTakeover: false },
    });
    await logActivity({
      clinicId: conversation.patient.clinicId,
      type: "human_resume",
      area: "atendimento",
      title: "Atendimento devolvido para a Alice",
      description: `A conversa com ${conversation.patient.name ?? conversation.patient.phone} voltou a ser respondida pela Alice.`,
      actorName: req.staff?.name ?? null,
    });
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/crm/board",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const [stages, patients] = await Promise.all([
      getFunnelStages(clinic.id),
      prisma.patient.findMany({
        where: { clinicId: clinic.id },
        orderBy: { createdAt: "desc" },
        include: { tags: { include: { tag: { select: { id: true, label: true, color: true } } } } },
      }),
    ]);

    const byStage = new Map<string, typeof patients>();
    for (const stage of stages) byStage.set(stage.stageId, []);
    const fallback = stages[0]?.stageId;
    for (const p of patients) {
      const bucket = byStage.get(p.funnelStage) ?? byStage.get(fallback);
      bucket?.push(p);
    }

    res.json(
      stages.map((stage) => ({
        id: stage.stageId,
        label: stage.label,
        color: stage.color,
        kind: stage.kind,
        patients: (byStage.get(stage.stageId) ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          phone: p.phone,
          tags: p.tags.map((pt) => pt.tag),
        })),
      }))
    );
  })
);

// Edita dados do contato (nome, data de nascimento pro aniversario).
apiRouter.put(
  "/patients/:id",
  asyncRoute(async (req, res) => {
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, patient.clinicId)) return;

    const { name, birthDate, email, cpf, notes, tagIds } = req.body as {
      name?: string;
      birthDate?: string | null;
      email?: string | null;
      cpf?: string | null;
      notes?: string | null;
      tagIds?: string[];
    };
    let parsedBirth: Date | null | undefined;
    if (birthDate !== undefined) {
      if (!birthDate) {
        parsedBirth = null;
      } else {
        // "YYYY-MM-DD" -> meia-noite UTC (so dia/mes importam pro aniversario)
        const d = new Date(`${birthDate}T00:00:00Z`);
        if (isNaN(d.getTime())) {
          res.status(400).json({ error: "birthDate invalido (use YYYY-MM-DD)" });
          return;
        }
        parsedBirth = d;
      }
    }

    if (Array.isArray(tagIds)) {
      const validTags = await prisma.tag.findMany({ where: { id: { in: tagIds }, clinicId: patient.clinicId }, select: { id: true } });
      const validIds = new Set(validTags.map((t) => t.id));
      await prisma.patientTag.deleteMany({ where: { patientId: patient.id } });
      if (validIds.size) {
        await prisma.patientTag.createMany({ data: [...validIds].map((tagId) => ({ patientId: patient.id, tagId })) });
      }
    }

    const updated = await prisma.patient.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name: name.trim() || null } : {}),
        ...(parsedBirth !== undefined ? { birthDate: parsedBirth } : {}),
        ...(email !== undefined ? { email: email?.trim() || null } : {}),
        ...(cpf !== undefined ? { cpf: cpf?.replace(/\D/g, "") || null } : {}),
        ...(notes !== undefined ? { notes: notes?.trim() || null } : {}),
      },
    });
    res.json({ id: updated.id, name: updated.name, birthDate: updated.birthDate });
  })
);

// Ficha completa do contato (aba "Contato no chat").
apiRouter.get(
  "/patients/:id/dossier",
  asyncRoute(async (req, res) => {
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: req.params.id }, select: { clinicId: true } });
    if (!assertClinicAccess(req, res, patient.clinicId)) return;
    res.json(await patientDossier(patient.clinicId, req.params.id));
  })
);

// --- Etiquetas ---
apiRouter.get(
  "/tags",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const tags = await prisma.tag.findMany({ where: { clinicId: clinic.id }, orderBy: { label: "asc" } });
    res.json(tags);
  })
);

apiRouter.post(
  "/tags",
  asyncRoute(async (req, res) => {
    const { label, color } = req.body as { label?: string; color?: string };
    if (!label?.trim()) {
      res.status(400).json({ error: "label obrigatorio" });
      return;
    }
    const clinic = await getClinic(req);
    try {
      const tag = await prisma.tag.create({
        data: { clinicId: clinic.id, label: label.trim().slice(0, 40), color: color || "#8b5cf6" },
      });
      res.json(tag);
    } catch (err: any) {
      if (err?.code === "P2002") {
        const existing = await prisma.tag.findFirst({ where: { clinicId: clinic.id, label: label.trim().slice(0, 40) } });
        res.json(existing);
        return;
      }
      throw err;
    }
  })
);

apiRouter.delete(
  "/tags/:id",
  asyncRoute(async (req, res) => {
    const tag = await prisma.tag.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, tag.clinicId)) return;
    await prisma.tag.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

apiRouter.post(
  "/patients/:id/stage",
  asyncRoute(async (req, res) => {
    const { stage } = req.body as { stage?: string };
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, patient.clinicId)) return;

    const result = await movePatientToStage(patient.clinicId, patient.id, String(stage ?? ""), {
      actorName: req.staff?.name ?? null,
      note: "movido no painel",
    });
    if (!result.ok) {
      const stages = await getFunnelStages(patient.clinicId);
      res.status(400).json({ error: `stage invalido, use um de: ${stages.map((s) => s.stageId).join(", ")}` });
      return;
    }
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/funnel-stages",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const stages = await getFunnelStages(clinic.id);
    res.json(stages);
  })
);

apiRouter.post(
  "/funnel-stages",
  asyncRoute(async (req, res) => {
    const { label, color, kind } = req.body as { label?: string; color?: string; kind?: string };
    if (!label || !color || !kind) {
      res.status(400).json({ error: "label, color e kind sao obrigatorios" });
      return;
    }

    const clinic = await getClinic(req);
    const existing = await getFunnelStages(clinic.id); // garante que a clinica ja tem as padrao antes de somar uma nova
    const stageId = await generateStageId(clinic.id, label);
    const maxOrder = existing.reduce((max, s) => Math.max(max, s.order), -1);

    const stage = await prisma.funnelStage.create({
      data: { clinicId: clinic.id, stageId, label, color, kind, order: maxOrder + 1 },
    });
    res.json(stage);
  })
);

apiRouter.put(
  "/funnel-stages/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.funnelStage.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { label, color, kind, order } = req.body as {
      label?: string;
      color?: string;
      kind?: string;
      order?: number;
    };

    const stage = await prisma.funnelStage.update({
      where: { id: req.params.id },
      data: {
        ...(label !== undefined ? { label } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    res.json(stage);
  })
);

// Remove uma etapa e realoca quem estava nela pra primeira etapa restante
// (evita paciente ficar com funnelStage orfao, sem coluna no board).
apiRouter.delete(
  "/funnel-stages/:id",
  asyncRoute(async (req, res) => {
    const stage = await prisma.funnelStage.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, stage.clinicId)) return;
    const remaining = await prisma.funnelStage.findMany({
      where: { clinicId: stage.clinicId, id: { not: stage.id } },
      orderBy: { order: "asc" },
    });

    if (remaining.length === 0) {
      res.status(400).json({ error: "a clinica precisa de pelo menos uma etapa no funil" });
      return;
    }

    await prisma.patient.updateMany({
      where: { clinicId: stage.clinicId, funnelStage: stage.stageId },
      data: { funnelStage: remaining[0].stageId },
    });
    await prisma.funnelStage.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/appointments",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const { start, end } = req.query as { start?: string; end?: string };

    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId: clinic.id,
        ...(start && end ? { scheduledAt: { gte: new Date(start), lte: new Date(end) } } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      include: { patient: true, procedure: true, professional: true },
    });

    res.json(
      appointments.map((a) => ({
        id: a.id,
        scheduledAt: a.scheduledAt,
        status: a.status,
        patientConfirmed: a.patientConfirmed,
        patient: { name: a.patient.name, phone: a.patient.phone },
        procedure: { id: a.procedureId, name: a.procedure.name, durationMin: a.procedure.durationMin },
        professional: a.professional ? { id: a.professional.id, name: a.professional.name, color: a.professional.color } : null,
      }))
    );
  })
);

// Agendamento manual pelo painel (ex: paciente que ligou ou apareceu na
// clinica), sem passar pela conversa com a Alice.
apiRouter.post(
  "/appointments",
  asyncRoute(async (req, res) => {
    const { patientName, patientPhone, procedureId, professionalId, scheduledAt } = req.body as {
      patientName?: string;
      patientPhone?: string;
      procedureId?: string;
      professionalId?: string | null;
      scheduledAt?: string;
    };

    if (!patientPhone || !procedureId || !scheduledAt) {
      res.status(400).json({ error: "patientPhone, procedureId e scheduledAt sao obrigatorios" });
      return;
    }

    const clinic = await getClinic(req);
    const phone = patientPhone.replace(/\D/g, "");
    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId: clinic.id, phone } },
      update: { name: patientName || undefined },
      create: { clinicId: clinic.id, phone, name: patientName || null },
    });

    const appointment = await prisma.appointment.create({
      data: { clinicId: clinic.id, patientId: patient.id, procedureId, professionalId: professionalId || null, scheduledAt: new Date(scheduledAt) },
      include: { procedure: true },
    });
    await notifyStaff(
      clinic.id,
      "new_appointment",
      `Novo agendamento: ${patient.name ?? patient.phone} - ${appointment.procedure.name} em ${appointment.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
    );
    await movePatientToKind(clinic.id, patient.id, "avaliacao_agendada", {
      actorName: req.staff?.name ?? null,
      note: "agendamento criado no painel",
    });
    await logActivity({
      clinicId: clinic.id,
      type: "appointment_booked",
      area: "agenda",
      title: "Agendamento criado",
      description: `${patient.name ?? patient.phone} — ${appointment.procedure.name} em ${appointment.scheduledAt.toLocaleString("pt-BR", { timeZone: clinic.timezone || "America/Sao_Paulo" })}.`,
      actorName: req.staff?.name ?? null,
    });
    res.json(appointment);
  })
);

// Editar/transferir um agendamento existente (procedimento, data/hora e/ou status).
apiRouter.put(
  "/appointments/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id }, include: { patient: true } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { procedureId, professionalId, scheduledAt, status, patientConfirmed } = req.body as {
      procedureId?: string;
      professionalId?: string | null;
      scheduledAt?: string;
      status?: string;
      patientConfirmed?: boolean;
    };

    const appointment = await prisma.appointment.update({
      where: { id: req.params.id },
      data: {
        ...(procedureId !== undefined ? { procedureId } : {}),
        ...(professionalId !== undefined ? { professionalId: professionalId || null } : {}),
        ...(scheduledAt !== undefined ? { scheduledAt: new Date(scheduledAt) } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(patientConfirmed !== undefined
          ? { patientConfirmed, confirmedAt: patientConfirmed ? new Date() : null }
          : {}),
      },
      include: { procedure: true },
    });

    const patientLabel = existing.patient.name ?? existing.patient.phone;
    const actorName = req.staff?.name ?? null;
    // Horario que ficou livre (cancelamento ou remarcacao) -> oferece pra lista de espera.
    const freeUpSlot = () =>
      offerFreedSlotToWaitlist({
        clinicId: existing.clinicId,
        procedureId: existing.procedureId,
        professionalId: existing.professionalId,
        freedAt: existing.scheduledAt,
      });

    if (status === "cancelled" && existing.status !== "cancelled") {
      await notifyStaff(existing.clinicId, "cancel", `Agendamento cancelado: ${patientLabel} - ${appointment.procedure.name}.`);
      await logActivity({
        clinicId: existing.clinicId, type: "appointment_cancelled", area: "agenda",
        title: "Agendamento cancelado",
        description: `${patientLabel} — ${appointment.procedure.name}.`, actorName,
      });
      // Sem outro horario futuro confirmado, o paciente volta pra recuperacao
      // (nunca "perdido" automaticamente - cancelar nao e perder).
      const upcoming = await prisma.appointment.findFirst({
        where: { patientId: existing.patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
      });
      if (!upcoming) {
        await movePatientToRecovery(existing.clinicId, existing.patientId, { actorName, note: "agendamento cancelado" });
      }
      await freeUpSlot();
    } else if (patientConfirmed === true && !existing.patientConfirmed) {
      await notifyStaff(existing.clinicId, "confirmed", `Presenca confirmada: ${patientLabel} - ${appointment.procedure.name}.`);
      await logActivity({
        clinicId: existing.clinicId, type: "appointment_confirmed", area: "agenda",
        title: "Presença confirmada pelo paciente",
        description: `${patientLabel} — ${appointment.procedure.name}.`, actorName,
      });
    } else if (status === "completed" && existing.status !== "completed") {
      await movePatientToKind(existing.clinicId, existing.patientId, "pos_procedimento", {
        actorName,
        note: `${appointment.procedure.name} concluído`,
      });
      await logActivity({
        clinicId: existing.clinicId, type: "appointment_completed", area: "agenda",
        title: "Atendimento concluído",
        description: `${patientLabel} — ${appointment.procedure.name}.`, actorName,
      });
    } else if (scheduledAt !== undefined && new Date(scheduledAt).getTime() !== existing.scheduledAt.getTime()) {
      await notifyStaff(
        existing.clinicId,
        "reschedule",
        `Agendamento remarcado: ${patientLabel} - ${appointment.procedure.name} agora em ${appointment.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
      );
      await logActivity({
        clinicId: existing.clinicId, type: "appointment_rescheduled", area: "agenda",
        title: "Agendamento remarcado",
        description: `${patientLabel} — ${appointment.procedure.name} agora em ${appointment.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
        actorName,
      });
      await freeUpSlot();
    }

    res.json(appointment);
  })
);

apiRouter.delete(
  "/appointments/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const wasFutureConfirmed = existing.status === "confirmed" && existing.scheduledAt.getTime() > Date.now();
    await prisma.appointment.delete({ where: { id: req.params.id } });
    if (wasFutureConfirmed) {
      await offerFreedSlotToWaitlist({
        clinicId: existing.clinicId,
        procedureId: existing.procedureId,
        professionalId: existing.professionalId,
        freedAt: existing.scheduledAt,
      });
    }
    res.json({ ok: true });
  })
);

// ---- Bloqueios de agenda (feriado, folga, almoco, manutencao) ----
apiRouter.get(
  "/schedule-blocks",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const blocks = await prisma.scheduleBlock.findMany({
      where: { clinicId: clinic.id },
      orderBy: { startsAt: "asc" },
      include: { professional: { select: { id: true, name: true } } },
    });
    res.json(blocks);
  })
);

apiRouter.post(
  "/schedule-blocks",
  asyncRoute(async (req, res) => {
    const { professionalId, startsAt, endsAt, reason } = req.body as {
      professionalId?: string | null;
      startsAt?: string;
      endsAt?: string;
      reason?: string;
    };
    if (!startsAt || !endsAt) {
      res.status(400).json({ error: "startsAt e endsAt sao obrigatorios" });
      return;
    }
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      res.status(400).json({ error: "intervalo invalido" });
      return;
    }

    const clinic = await getClinic(req);
    const block = await prisma.scheduleBlock.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalId || null,
        startsAt: start,
        endsAt: end,
        reason: (reason || "").slice(0, 200),
      },
      include: { professional: { select: { id: true, name: true } } },
    });
    await logActivity({
      clinicId: clinic.id, type: "schedule_block_added", area: "agenda",
      title: "Bloqueio de agenda criado",
      description: `${block.professional?.name ?? "Clínica toda"} — ${start.toLocaleString("pt-BR", { timeZone: clinic.timezone || "America/Sao_Paulo" })} até ${end.toLocaleString("pt-BR", { timeZone: clinic.timezone || "America/Sao_Paulo" })}${reason ? ` (${reason})` : ""}.`,
      actorName: req.staff?.name ?? null,
    });
    res.json(block);
  })
);

apiRouter.delete(
  "/schedule-blocks/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.scheduleBlock.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    await prisma.scheduleBlock.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// ---- Lista de espera ----
apiRouter.get(
  "/waitlist",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const entries = await prisma.waitlistEntry.findMany({
      where: { clinicId: clinic.id, status: { in: ["waiting", "notified"] } },
      orderBy: { createdAt: "asc" },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        procedure: { select: { id: true, name: true } },
        professional: { select: { id: true, name: true } },
      },
    });
    res.json(entries);
  })
);

apiRouter.post(
  "/waitlist",
  asyncRoute(async (req, res) => {
    const { patientPhone, patientName, procedureId, professionalId, preferredNote } = req.body as {
      patientPhone?: string;
      patientName?: string;
      procedureId?: string | null;
      professionalId?: string | null;
      preferredNote?: string;
    };
    if (!patientPhone) {
      res.status(400).json({ error: "patientPhone obrigatorio" });
      return;
    }
    const clinic = await getClinic(req);
    const phone = patientPhone.replace(/\D/g, "");
    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId: clinic.id, phone } },
      update: { name: patientName || undefined },
      create: { clinicId: clinic.id, phone, name: patientName || null },
    });
    const entry = await prisma.waitlistEntry.create({
      data: {
        clinicId: clinic.id,
        patientId: patient.id,
        procedureId: procedureId || null,
        professionalId: professionalId || null,
        preferredNote: (preferredNote || "").slice(0, 200),
      },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        procedure: { select: { id: true, name: true } },
        professional: { select: { id: true, name: true } },
      },
    });
    res.json(entry);
  })
);

apiRouter.put(
  "/waitlist/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    const { status } = req.body as { status?: string };
    if (!status || !["waiting", "notified", "converted", "cancelled"].includes(status)) {
      res.status(400).json({ error: "status invalido" });
      return;
    }
    await prisma.waitlistEntry.update({ where: { id: req.params.id }, data: { status } });
    res.json({ ok: true });
  })
);

apiRouter.delete(
  "/waitlist/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    await prisma.waitlistEntry.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/followup-rules",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const rules = await prisma.followUpRule.findMany({
      where: { clinicId: clinic.id },
      orderBy: { order: "asc" },
    });
    res.json(rules);
  })
);

interface FollowUpBody {
  name?: string;
  afterDays?: number;
  afterMinutes?: number;
  message?: string;
  repeatMode?: string;
  skipIfHumanTakeover?: boolean;
  skipIfUpcomingAppt?: boolean;
  sendWindowStart?: number | null;
  sendWindowEnd?: number | null;
  active?: boolean;
}

function followUpData(b: FollowUpBody) {
  return {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.afterDays !== undefined ? { afterDays: b.afterDays } : {}),
    ...(b.afterMinutes !== undefined ? { afterMinutes: b.afterMinutes } : {}),
    ...(b.message !== undefined ? { message: b.message } : {}),
    ...(b.repeatMode !== undefined ? { repeatMode: b.repeatMode === "once" ? "once" : "every_silence" } : {}),
    ...(b.skipIfHumanTakeover !== undefined ? { skipIfHumanTakeover: b.skipIfHumanTakeover } : {}),
    ...(b.skipIfUpcomingAppt !== undefined ? { skipIfUpcomingAppt: b.skipIfUpcomingAppt } : {}),
    ...(b.sendWindowStart !== undefined ? { sendWindowStart: b.sendWindowStart } : {}),
    ...(b.sendWindowEnd !== undefined ? { sendWindowEnd: b.sendWindowEnd } : {}),
    ...(b.active !== undefined ? { active: b.active } : {}),
  };
}

apiRouter.post(
  "/followup-rules",
  asyncRoute(async (req, res) => {
    const b = req.body as FollowUpBody;
    if (!b.message || (!b.afterDays && !b.afterMinutes)) {
      res.status(400).json({ error: "message e o tempo de silencio sao obrigatorios" });
      return;
    }

    const clinic = await getClinic(req);
    const last = await prisma.followUpRule.findFirst({
      where: { clinicId: clinic.id },
      orderBy: { order: "desc" },
    });

    const rule = await prisma.followUpRule.create({
      data: {
        clinicId: clinic.id,
        order: (last?.order ?? 0) + 1,
        afterDays: b.afterDays ?? 0,
        message: b.message,
        ...followUpData({ ...b, afterDays: undefined, message: undefined }),
      },
    });
    res.json(rule);
  })
);

apiRouter.put(
  "/followup-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.followUpRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const rule = await prisma.followUpRule.update({
      where: { id: req.params.id },
      data: followUpData(req.body as FollowUpBody),
    });
    res.json(rule);
  })
);

apiRouter.delete(
  "/followup-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.followUpRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.followUpSent.deleteMany({ where: { ruleId: req.params.id } });
    await prisma.followUpRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// --- Lembrete de consulta (configuravel, pode ter mais de uma regra) ---

apiRouter.get(
  "/reminder-rules",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const rules = await prisma.reminderRule.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } });
    res.json(rules);
  })
);

apiRouter.post(
  "/reminder-rules",
  asyncRoute(async (req, res) => {
    const { hoursBefore, message } = req.body as { hoursBefore?: number; message?: string };
    if (!hoursBefore || !message) {
      res.status(400).json({ error: "hoursBefore e message sao obrigatorios" });
      return;
    }

    const clinic = await getClinic(req);
    const rule = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore, message } });
    await logActivity({ clinicId: clinic.id, type: "automation_created", area: "automacoes", title: "Lembrete de consulta criado", description: `${hoursBefore}h antes da consulta.`, actorName: req.staff?.name ?? null });
    res.json(rule);
  })
);

apiRouter.put(
  "/reminder-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.reminderRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { hoursBefore, message, active } = req.body as { hoursBefore?: number; message?: string; active?: boolean };
    const rule = await prisma.reminderRule.update({
      where: { id: req.params.id },
      data: {
        ...(hoursBefore !== undefined ? { hoursBefore } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(active !== undefined ? { active } : {}),
      },
    });
    res.json(rule);
  })
);

apiRouter.delete(
  "/reminder-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.reminderRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.reminderRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// --- Pos-procedimento (cuidados/acompanhamento apos o atendimento) ---

apiRouter.get(
  "/post-procedure-rules",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const rules = await prisma.postProcedureRule.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } });
    res.json(rules);
  })
);

apiRouter.post(
  "/post-procedure-rules",
  asyncRoute(async (req, res) => {
    const { name, message, intervalValue, intervalUnit, onlyIfCompleted, procedureIds } = req.body as {
      name?: string;
      message?: string;
      intervalValue?: number;
      intervalUnit?: string;
      onlyIfCompleted?: boolean;
      procedureIds?: string[];
    };
    if (!name || !message || !intervalValue) {
      res.status(400).json({ error: "name, message e intervalValue sao obrigatorios" });
      return;
    }

    const clinic = await getClinic(req);
    const rule = await prisma.postProcedureRule.create({
      data: {
        clinicId: clinic.id,
        name,
        message,
        intervalValue,
        intervalUnit: intervalUnit === "hours" ? "hours" : "days",
        onlyIfCompleted: onlyIfCompleted ?? true,
        procedureIds: (procedureIds ?? []).join(","),
      },
    });
    res.json(rule);
  })
);

apiRouter.put(
  "/post-procedure-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.postProcedureRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { name, message, intervalValue, intervalUnit, onlyIfCompleted, procedureIds, active } = req.body as {
      name?: string;
      message?: string;
      intervalValue?: number;
      intervalUnit?: string;
      onlyIfCompleted?: boolean;
      procedureIds?: string[];
      active?: boolean;
    };

    const rule = await prisma.postProcedureRule.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(intervalValue !== undefined ? { intervalValue } : {}),
        ...(intervalUnit !== undefined ? { intervalUnit: intervalUnit === "hours" ? "hours" : "days" } : {}),
        ...(onlyIfCompleted !== undefined ? { onlyIfCompleted } : {}),
        ...(procedureIds !== undefined ? { procedureIds: procedureIds.join(",") } : {}),
        ...(active !== undefined ? { active } : {}),
      },
    });
    res.json(rule);
  })
);

apiRouter.delete(
  "/post-procedure-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.postProcedureRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.postProcedureRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// --- Renovacao (retoma o contato meses/anos depois pra renovar procedimento) ---

apiRouter.get(
  "/renewal-rules",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const rules = await prisma.renewalRule.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } });
    res.json(rules);
  })
);

interface RenewalBody {
  name?: string;
  message?: string;
  intervalValue?: number;
  intervalUnit?: string;
  onlyIfCompleted?: boolean;
  procedureIds?: string[];
  active?: boolean;
}

apiRouter.post(
  "/renewal-rules",
  asyncRoute(async (req, res) => {
    const b = req.body as RenewalBody;
    if (!b.name || !b.message || !b.intervalValue) {
      res.status(400).json({ error: "name, message e intervalValue sao obrigatorios" });
      return;
    }
    const clinic = await getClinic(req);
    const rule = await prisma.renewalRule.create({
      data: {
        clinicId: clinic.id,
        name: b.name,
        message: b.message,
        intervalValue: b.intervalValue,
        intervalUnit: b.intervalUnit === "years" ? "years" : "months",
        onlyIfCompleted: b.onlyIfCompleted ?? true,
        procedureIds: (b.procedureIds ?? []).join(","),
      },
    });
    res.json(rule);
  })
);

apiRouter.put(
  "/renewal-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.renewalRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    const b = req.body as RenewalBody;
    const rule = await prisma.renewalRule.update({
      where: { id: req.params.id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.message !== undefined ? { message: b.message } : {}),
        ...(b.intervalValue !== undefined ? { intervalValue: b.intervalValue } : {}),
        ...(b.intervalUnit !== undefined ? { intervalUnit: b.intervalUnit === "years" ? "years" : "months" } : {}),
        ...(b.onlyIfCompleted !== undefined ? { onlyIfCompleted: b.onlyIfCompleted } : {}),
        ...(b.procedureIds !== undefined ? { procedureIds: b.procedureIds.join(",") } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    res.json(rule);
  })
);

apiRouter.delete(
  "/renewal-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.renewalRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    await prisma.renewalSent.deleteMany({ where: { ruleId: req.params.id } });
    await prisma.renewalRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// --- Aniversario (parabens automatico no dia do aniversario do paciente) ---

apiRouter.get(
  "/birthday-rules",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const rules = await prisma.birthdayRule.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } });
    res.json(rules);
  })
);

interface BirthdayBody {
  name?: string;
  message?: string;
  sendHour?: number;
  active?: boolean;
}

apiRouter.post(
  "/birthday-rules",
  asyncRoute(async (req, res) => {
    const b = req.body as BirthdayBody;
    if (!b.name || !b.message) {
      res.status(400).json({ error: "name e message sao obrigatorios" });
      return;
    }
    const clinic = await getClinic(req);
    const rule = await prisma.birthdayRule.create({
      data: {
        clinicId: clinic.id,
        name: b.name,
        message: b.message,
        sendHour: b.sendHour != null && b.sendHour >= 0 && b.sendHour <= 23 ? b.sendHour : 9,
      },
    });
    res.json(rule);
  })
);

apiRouter.put(
  "/birthday-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.birthdayRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    const b = req.body as BirthdayBody;
    const rule = await prisma.birthdayRule.update({
      where: { id: req.params.id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.message !== undefined ? { message: b.message } : {}),
        ...(b.sendHour !== undefined && b.sendHour >= 0 && b.sendHour <= 23 ? { sendHour: b.sendHour } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    res.json(rule);
  })
);

apiRouter.delete(
  "/birthday-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.birthdayRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;
    await prisma.birthdaySent.deleteMany({ where: { ruleId: req.params.id } });
    await prisma.birthdayRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// --- Historico de atividades da clinica ---

apiRouter.get(
  "/activity-log/filters",
  asyncRoute(async (_req, res) => {
    res.json({
      areas: Object.entries(ACTIVITY_AREAS).map(([id, label]) => ({ id, label })),
      types: Object.entries(ACTIVITY_TYPES).map(([id, label]) => ({ id, label })),
    });
  })
);

apiRouter.get(
  "/activity-log",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const { type, area, cursor } = req.query as { type?: string; area?: string; cursor?: string };
    const take = 40;

    const where = {
      clinicId: clinic.id,
      ...(type ? { type } : {}),
      ...(area ? { area } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    ]);

    const hasMore = rows.length > take;
    const items = (hasMore ? rows.slice(0, take) : rows).map((r) => ({
      id: r.id,
      type: r.type,
      typeLabel: ACTIVITY_TYPES[r.type] ?? r.type,
      area: r.area,
      areaLabel: ACTIVITY_AREAS[r.area] ?? r.area,
      title: r.title,
      description: r.description,
      actor: r.actorName ?? "Sistema (ação automática)",
      createdAt: r.createdAt,
    }));

    res.json({ total, items, nextCursor: hasMore ? items[items.length - 1].id : null });
  })
);

apiRouter.get(
  "/broadcasts",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const campaigns = await prisma.broadcastCampaign.findMany({
      where: { clinicId: clinic.id },
      orderBy: { scheduledFor: "desc" },
      include: { recipients: true },
    });

    res.json(
      campaigns.map((c) => ({
        id: c.id,
        title: c.title,
        message: c.message,
        targetStage: c.targetStage,
        targetMode: c.targetMode,
        scheduledFor: c.scheduledFor,
        status: c.status,
        total: c.recipients.length,
        sent: c.recipients.filter((r) => r.status === "sent").length,
        failed: c.recipients.filter((r) => r.status === "failed").length,
      }))
    );
  })
);

apiRouter.post(
  "/broadcasts",
  asyncRoute(async (req, res) => {
    const { title, message, scheduledFor, targetStage, contactIds } = req.body as {
      title?: string;
      message?: string;
      scheduledFor?: string;
      targetStage?: string | null;
      contactIds?: string[];
    };

    if (!title || !message || !scheduledFor) {
      res.status(400).json({ error: "title, message e scheduledFor sao obrigatorios" });
      return;
    }
    if (!targetStage && !contactIds?.length) {
      res.status(400).json({ error: "escolha um destino: todos os contatos, uma etapa do funil ou contatos especificos" });
      return;
    }

    const clinic = await getClinic(req);
    if (targetStage) {
      const stages = await getFunnelStages(clinic.id);
      if (!stages.some((s) => s.stageId === targetStage)) {
        res.status(400).json({ error: `targetStage invalido, use um de: ${stages.map((s) => s.stageId).join(", ")}` });
        return;
      }
    }

    let validContactIds: string[] = [];
    if (contactIds?.length) {
      const patients = await prisma.patient.findMany({
        where: { id: { in: contactIds }, clinicId: clinic.id },
        select: { id: true },
      });
      validContactIds = patients.map((p) => p.id);
    }

    const targetMode = targetStage ? "stage" : validContactIds.length ? "contacts" : "all";
    const campaign = await prisma.broadcastCampaign.create({
      data: {
        clinicId: clinic.id,
        title,
        message,
        targetStage: targetStage || null,
        targetMode,
        scheduledFor: new Date(scheduledFor),
      },
    });

    if (validContactIds.length) {
      await prisma.broadcastRecipient.createMany({
        data: validContactIds.map((patientId) => ({ campaignId: campaign.id, patientId })),
      });
    }

    res.json(campaign);
  })
);

apiRouter.post(
  "/broadcasts/:id/cancel",
  asyncRoute(async (req, res) => {
    const campaign = await prisma.broadcastCampaign.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, campaign.clinicId)) return;
    if (campaign.status !== "scheduled") {
      res.status(400).json({ error: "so da pra cancelar campanhas que ainda nao comecaram a enviar" });
      return;
    }
    await prisma.broadcastCampaign.update({ where: { id: req.params.id }, data: { status: "cancelled" } });
    res.json({ ok: true });
  })
);

// ---- Briefing de configuracao (onboarding) - so administracao da Alice ----
apiRouter.get(
  "/briefing/template",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ template: BRIEFING_TEMPLATE });
  })
);

// Interpreta o briefing respondido e devolve o plano pra revisao (nao grava nada).
apiRouter.post(
  "/briefing/parse",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await getClinic(req); // valida acesso/contexto
    const { text } = req.body as { text?: string };
    const result = await parseBriefing(String(text ?? ""));
    if (!result.ok) {
      res.status(422).json({ error: result.error });
      return;
    }
    res.json({ plan: result.plan });
  })
);

// Aplica um plano ja revisado na clinica selecionada. Aditivo e idempotente.
apiRouter.post(
  "/briefing/apply",
  asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const clinic = await getClinic(req);
    const parsed = BriefingPlanSchema.safeParse(req.body?.plan);
    if (!parsed.success) {
      res.status(400).json({ error: "plano invalido" });
      return;
    }
    const summary = await applyBriefing(clinic.id, parsed.data, req.staff?.name ?? null);
    res.json(summary);
  })
);

// ---- Chaves da API Externa ----
apiRouter.get(
  "/api-keys/scopes",
  asyncRoute(async (_req, res) => {
    res.json(API_SCOPES);
  })
);

apiRouter.get(
  "/api-keys",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const keys = await prisma.apiKey.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, lookup: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true, createdByName: true },
    });
    res.json(keys.map((k) => ({ ...k, scopes: k.scopes.split(",").filter(Boolean) })));
  })
);

apiRouter.post(
  "/api-keys",
  asyncRoute(async (req, res) => {
    const { name, scopes } = req.body as { name?: string; scopes?: string[] };
    if (!name?.trim()) {
      res.status(400).json({ error: "name obrigatorio" });
      return;
    }
    const chosen = (Array.isArray(scopes) ? scopes : []).filter((s) => API_SCOPE_IDS.includes(s as (typeof API_SCOPE_IDS)[number]));
    if (chosen.length === 0) {
      res.status(400).json({ error: "selecione ao menos um escopo" });
      return;
    }
    const clinic = await getClinic(req);
    const gen = generateApiKey();
    const key = await prisma.apiKey.create({
      data: {
        clinicId: clinic.id,
        name: name.trim().slice(0, 60),
        lookup: gen.lookup,
        hash: gen.hash,
        scopes: chosen.join(","),
        createdByName: req.staff?.name ?? null,
      },
    });
    await logActivity({
      clinicId: clinic.id, type: "clinic_updated", area: "clinica",
      title: "Chave de API criada", description: `${key.name} — escopos: ${chosen.join(", ")}.`,
      actorName: req.staff?.name ?? null,
    });
    // O segredo so aparece aqui, uma vez.
    res.json({ id: key.id, name: key.name, lookup: key.lookup, scopes: chosen, secret: gen.secret });
  })
);

apiRouter.delete(
  "/api-keys/:id",
  asyncRoute(async (req, res) => {
    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, key.clinicId)) return;
    await prisma.apiKey.update({ where: { id: req.params.id }, data: { revokedAt: new Date() } });
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/rules/categories",
  asyncRoute(async (_req, res) => {
    res.json(RULE_CATEGORIES);
  })
);

apiRouter.get(
  "/rules",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    let rules = await prisma.customRule.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "desc" },
    });

    // Clinica sem nenhuma regra ainda: entra com o conjunto recomendado.
    if (rules.length === 0) {
      await seedDefaultRules(clinic.id);
      rules = await prisma.customRule.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "desc" } });
    }

    res.json(rules);
  })
);

// Recria as regras recomendadas que foram excluidas (nao duplica as que
// ja existem). Botao "Restaurar regras recomendadas" no painel.
apiRouter.post(
  "/rules/restore-defaults",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const added = await seedDefaultRules(clinic.id);
    res.json({ added });
  })
);

// Recebe o texto livre do admin, chama a IA (fora do caminho de conversa com
// paciente, entao um pouco de latencia aqui nao afeta ninguem) e devolve o
// rascunho: ou uma regra pronta pra aprovar, ou uma pergunta de esclarecimento.
apiRouter.post(
  "/rules",
  asyncRoute(async (req, res) => {
    const { text } = req.body as { text?: string };
    if (!text?.trim()) {
      res.status(400).json({ error: "text obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const rule = await createRuleDraft(clinic.id, text.trim());
    res.json(rule);
  })
);

apiRouter.post(
  "/rules/:id/approve",
  asyncRoute(async (req, res) => {
    const rule = await prisma.customRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, rule.clinicId)) return;
    if (rule.status !== "draft") {
      res.status(400).json({ error: "so da pra aprovar regras em rascunho" });
      return;
    }
    const updated = await prisma.customRule.update({ where: { id: req.params.id }, data: { status: "active" } });
    res.json(updated);
  })
);

// Cria uma regra manualmente (sem passar pela IA) - ja entra ativa.
apiRouter.post(
  "/rules/manual",
  asyncRoute(async (req, res) => {
    const { category, instruction } = req.body as { category?: string; instruction?: string };
    const validCat = RULE_CATEGORIES.some((c) => c.id === category);
    if (!validCat || !instruction?.trim()) {
      res.status(400).json({ error: "category valida e instruction sao obrigatorios" });
      return;
    }
    const clinic = await getClinic(req);
    const rule = await prisma.customRule.create({
      data: { clinicId: clinic.id, category: category!, rawInput: "(regra escrita manualmente)", instruction: instruction.trim(), status: "active" },
    });
    res.json(rule);
  })
);

apiRouter.put(
  "/rules/:id",
  asyncRoute(async (req, res) => {
    const rule = await prisma.customRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, rule.clinicId)) return;
    const { category, instruction, status } = req.body as { category?: string; instruction?: string; status?: string };
    const updated = await prisma.customRule.update({
      where: { id: req.params.id },
      data: {
        ...(category !== undefined && RULE_CATEGORIES.some((c) => c.id === category) ? { category } : {}),
        ...(instruction !== undefined ? { instruction: instruction.trim() } : {}),
        ...(status !== undefined && ["active", "draft"].includes(status) ? { status } : {}),
      },
    });
    res.json(updated);
  })
);

apiRouter.delete(
  "/rules/:id",
  asyncRoute(async (req, res) => {
    const rule = await prisma.customRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, rule.clinicId)) return;

    await prisma.customRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// ================= Personalizar Alice: mensagens prontas, FAQ, roteiros =================

apiRouter.get("/message-templates", asyncRoute(async (req, res) => {
  const clinic = await getClinic(req);
  res.json(await prisma.messageTemplate.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } }));
}));

apiRouter.post("/message-templates", asyncRoute(async (req, res) => {
  const { name, body, mode, whenToUse, active } = req.body as Record<string, any>;
  if (!name?.trim() || !body?.trim()) { res.status(400).json({ error: "name e body sao obrigatorios" }); return; }
  const clinic = await getClinic(req);
  res.json(await prisma.messageTemplate.create({
    data: { clinicId: clinic.id, name: name.trim(), body: body.trim(), mode: mode === "exact" ? "exact" : "adapt", whenToUse: whenToUse?.trim() || null, active: active ?? true },
  }));
}));

apiRouter.put("/message-templates/:id", asyncRoute(async (req, res) => {
  const existing = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!assertClinicAccess(req, res, existing.clinicId)) return;
  const { name, body, mode, whenToUse, active } = req.body as Record<string, any>;
  res.json(await prisma.messageTemplate.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(body !== undefined ? { body: String(body).trim() } : {}),
      ...(mode !== undefined ? { mode: mode === "exact" ? "exact" : "adapt" } : {}),
      ...(whenToUse !== undefined ? { whenToUse: whenToUse?.trim() || null } : {}),
      ...(active !== undefined ? { active } : {}),
    },
  }));
}));

apiRouter.delete("/message-templates/:id", asyncRoute(async (req, res) => {
  const existing = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!assertClinicAccess(req, res, existing.clinicId)) return;
  await prisma.messageTemplate.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

apiRouter.get("/faqs", asyncRoute(async (req, res) => {
  const clinic = await getClinic(req);
  res.json(await prisma.clinicFaq.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } }));
}));

apiRouter.post("/faqs", asyncRoute(async (req, res) => {
  const { question, answer, alternates, exactAnswer, active } = req.body as Record<string, any>;
  if (!question?.trim() || !answer?.trim()) { res.status(400).json({ error: "question e answer sao obrigatorios" }); return; }
  const clinic = await getClinic(req);
  res.json(await prisma.clinicFaq.create({
    data: { clinicId: clinic.id, question: question.trim(), answer: answer.trim(), alternates: (alternates ?? "").trim(), exactAnswer: !!exactAnswer, active: active ?? true },
  }));
}));

apiRouter.put("/faqs/:id", asyncRoute(async (req, res) => {
  const existing = await prisma.clinicFaq.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!assertClinicAccess(req, res, existing.clinicId)) return;
  const { question, answer, alternates, exactAnswer, active } = req.body as Record<string, any>;
  res.json(await prisma.clinicFaq.update({
    where: { id: req.params.id },
    data: {
      ...(question !== undefined ? { question: String(question).trim() } : {}),
      ...(answer !== undefined ? { answer: String(answer).trim() } : {}),
      ...(alternates !== undefined ? { alternates: String(alternates).trim() } : {}),
      ...(exactAnswer !== undefined ? { exactAnswer: !!exactAnswer } : {}),
      ...(active !== undefined ? { active } : {}),
    },
  }));
}));

apiRouter.delete("/faqs/:id", asyncRoute(async (req, res) => {
  const existing = await prisma.clinicFaq.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!assertClinicAccess(req, res, existing.clinicId)) return;
  await prisma.clinicFaq.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

apiRouter.get("/playbooks", asyncRoute(async (req, res) => {
  const clinic = await getClinic(req);
  res.json(await prisma.playbook.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "asc" } }));
}));

apiRouter.post("/playbooks", asyncRoute(async (req, res) => {
  const { name, scriptType, triggerText, goal, steps, active } = req.body as Record<string, any>;
  if (!name?.trim() || !(steps ?? "").trim()) { res.status(400).json({ error: "name e steps sao obrigatorios" }); return; }
  const clinic = await getClinic(req);
  res.json(await prisma.playbook.create({
    data: { clinicId: clinic.id, name: name.trim(), scriptType: scriptType?.trim() || "livre", triggerText: triggerText?.trim() || null, goal: goal?.trim() || null, steps: steps.trim(), active: active ?? true },
  }));
}));

apiRouter.put("/playbooks/:id", asyncRoute(async (req, res) => {
  const existing = await prisma.playbook.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!assertClinicAccess(req, res, existing.clinicId)) return;
  const { name, scriptType, triggerText, goal, steps, active } = req.body as Record<string, any>;
  res.json(await prisma.playbook.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(scriptType !== undefined ? { scriptType: String(scriptType).trim() || "livre" } : {}),
      ...(triggerText !== undefined ? { triggerText: triggerText?.trim() || null } : {}),
      ...(goal !== undefined ? { goal: goal?.trim() || null } : {}),
      ...(steps !== undefined ? { steps: String(steps).trim() } : {}),
      ...(active !== undefined ? { active } : {}),
    },
  }));
}));

apiRouter.delete("/playbooks/:id", asyncRoute(async (req, res) => {
  const existing = await prisma.playbook.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!assertClinicAccess(req, res, existing.clinicId)) return;
  await prisma.playbook.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

// --- Contas de login do painel. role="admin" (equipe da Alice) opera
// qualquer clinica; role="client" (dono da clinica, ex: Isac) fica travado
// na propria clinica em toda a API via getClinic() acima - esse e o
// isolamento real entre clientes da Alice. ---

// So login/bootstrap aceitam requisicao sem sessao - sem limite de tentativas,
// dariam pra forcar senha por tentativa e erro sem nenhum obstaculo.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente de novo." },
});

apiRouter.get("/staff/me", (req, res) => {
  res.json(req.staff ? { id: req.staff.id, name: req.staff.name, role: req.staff.role, clinicId: req.staff.clinicId } : null);
});

// So funciona enquanto NENHUMA conta admin existir ainda - resolve o
// ovo-e-a-galinha de precisar estar logado como admin pra criar a primeira
// conta admin. Se auto-desliga assim que a primeira for criada.
apiRouter.post(
  "/staff/bootstrap-admin",
  loginRateLimit,
  asyncRoute(async (req, res) => {
    const existingAdmin = await prisma.staffUser.findFirst({ where: { role: "admin" } });
    if (existingAdmin) {
      res.status(403).json({ error: "Ja existe uma conta admin - use o login normal" });
      return;
    }

    const expectedToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
    const suppliedToken = req.get("X-Bootstrap-Token") ?? "";
    if (!expectedToken) {
      res.status(503).json({ error: "ADMIN_BOOTSTRAP_TOKEN nao configurado no servidor" });
      return;
    }
    const expectedBuffer = Buffer.from(expectedToken);
    const suppliedBuffer = Buffer.from(suppliedToken);
    if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
      res.status(403).json({ error: "Token de bootstrap invalido" });
      return;
    }

    const { name, username, password } = req.body as { name?: string; username?: string; password?: string };
    if (!name || !username || !password) {
      res.status(400).json({ error: "name, username e password sao obrigatorios" });
      return;
    }
    if (password.length < 10) {
      res.status(400).json({ error: "a senha precisa ter pelo menos 10 caracteres" });
      return;
    }

    const existing = await prisma.staffUser.findUnique({ where: { username } });
    if (existing) {
      res.status(409).json({ error: "esse nome de usuario ja esta em uso" });
      return;
    }

    const staff = await prisma.staffUser.create({
      data: { clinicId: null, name, username, passwordHash: hashPassword(password), role: "admin" },
    });
    res.setHeader("Set-Cookie", createSessionCookie({ id: staff.id, name: staff.name, clinicId: null, role: "admin" }));
    res.json({ id: staff.id, name: staff.name, role: "admin" });
  })
);

apiRouter.post(
  "/staff/login",
  loginRateLimit,
  asyncRoute(async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: "username e password obrigatorios" });
      return;
    }

    const staff = await prisma.staffUser.findUnique({ where: { username } });
    if (!staff || !verifyPassword(password, staff.passwordHash)) {
      res.status(401).json({ error: "Usuario ou senha invalidos" });
      return;
    }

    const role = staff.role === "admin" ? "admin" : "client";
    if (role === "client" && staff.clinicId) {
      const clinic = await prisma.clinic.findUnique({ where: { id: staff.clinicId }, select: { active: true } });
      if (!clinic || !clinic.active) {
        res.status(403).json({ error: "Conta bloqueada temporariamente. Entre em contato com o suporte." });
        return;
      }
    }

    res.setHeader("Set-Cookie", createSessionCookie({ id: staff.id, name: staff.name, clinicId: staff.clinicId, role }));
    res.json({ id: staff.id, name: staff.name, role, clinicId: staff.clinicId });
  })
);

apiRouter.post("/staff/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.json({ ok: true });
});

apiRouter.get(
  "/staff",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const staff = await prisma.staffUser.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, username: true, role: true, createdAt: true },
    });
    res.json(staff);
  })
);

apiRouter.post(
  "/staff",
  asyncRoute(async (req, res) => {
    const { name, username, password, role: requestedRole } = req.body as {
      name?: string;
      username?: string;
      password?: string;
      role?: string;
    };
    if (!name || !username || !password) {
      res.status(400).json({ error: "name, username e password sao obrigatorios" });
      return;
    }
    if (password.length < 10) {
      res.status(400).json({ error: "a senha precisa ter pelo menos 10 caracteres" });
      return;
    }

    const callerIsAdmin = req.staff?.role === "admin";
    const role: "admin" | "client" = callerIsAdmin && requestedRole === "admin" ? "admin" : "client";

    const existing = await prisma.staffUser.findUnique({ where: { username } });
    if (existing) {
      res.status(409).json({ error: "esse nome de usuario ja esta em uso" });
      return;
    }

    // Conta admin nao pertence a uma clinica so; conta client sempre fica presa
    // a clinica resolvida por getClinic (a propria, se quem esta criando ja for
    // client; a escolhida via clinicId, se for um admin cadastrando um cliente novo).
    const clinicId = role === "admin" ? null : (await getClinic(req)).id;

    const staff = await prisma.staffUser.create({
      data: { clinicId, name, username, passwordHash: hashPassword(password), role },
      select: { id: true, name: true, username: true, role: true, createdAt: true },
    });
    res.json(staff);
  })
);

apiRouter.put(
  "/staff/:id",
  asyncRoute(async (req, res) => {
    const target = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.params.id } });
    const isSelf = req.staff?.id === target.id;
    if (req.staff?.role !== "admin" && !isSelf) {
      res.status(403).json({ error: "Sem acesso a essa conta" });
      return;
    }

    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ error: "name e obrigatorio" });
      return;
    }

    const staff = await prisma.staffUser.update({
      where: { id: target.id },
      data: { name: name.trim() },
      select: { id: true, name: true, username: true, role: true, createdAt: true },
    });
    res.json(staff);
  })
);

apiRouter.delete(
  "/staff/:id",
  asyncRoute(async (req, res) => {
    const target = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.params.id } });
    if (req.staff?.role !== "admin" && target.clinicId !== req.staff?.clinicId) {
      res.status(403).json({ error: "Sem acesso a essa conta" });
      return;
    }
    await prisma.staffUser.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);
