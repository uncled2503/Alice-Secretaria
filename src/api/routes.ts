import { Router, type Request, type Response, type RequestHandler } from "express";
import { prisma } from "../db/client.js";
import { sendText, connectClinic, disconnectClinic, getStatus, getQrDataUrl, getProfilePicUrl } from "../whatsapp/manager.js";
import { getFunnelStages, generateStageId } from "../crm/stages.js";
import { createRuleDraft, RULE_CATEGORIES } from "../ai/rules.js";
import { notifyStaff } from "../crm/notify.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { createSessionCookie, clearSessionCookie } from "./staffSession.js";

export const apiRouter = Router();

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
      },
    });
    res.json(clinics.map((c) => ({ ...c, ...getStatus(c.id) })));
  })
);

apiRouter.put(
  "/clinics/:id",
  asyncRoute(async (req, res) => {
    if (req.staff && req.staff.role !== "admin" && req.staff.clinicId !== req.params.id) {
      res.status(403).json({ error: "Sem acesso a essa clinica" });
      return;
    }

    const { name, timezone, workStartHour, workEndHour, workDays, active, notifyPhone, notifyEvents } = req.body as {
      name?: string;
      timezone?: string;
      workStartHour?: number;
      workEndHour?: number;
      workDays?: string;
      active?: boolean;
      notifyPhone?: string | null;
      notifyEvents?: string;
    };

    // So admin bloqueia/desbloqueia - um cliente nao pode se desbloquear sozinho.
    if (active !== undefined && !requireAdmin(req, res)) return;

    const clinic = await prisma.clinic.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(workStartHour !== undefined ? { workStartHour } : {}),
        ...(workEndHour !== undefined ? { workEndHour } : {}),
        ...(workDays !== undefined ? { workDays } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(notifyPhone !== undefined ? { notifyPhone: notifyPhone || null } : {}),
        ...(notifyEvents !== undefined ? { notifyEvents } : {}),
      },
    });
    res.json(clinic);
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

    const clinic = await prisma.clinic.create({
      data: { name, whatsappPhone: whatsappPhone.replace(/\D/g, "") },
    });
    res.json(clinic);
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

// Conexao do WhatsApp direto pelo painel (sem depender de gateway externo).
apiRouter.get(
  "/whatsapp/status",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const status = getStatus(clinic.id);
    const qr = status.connecting ? await getQrDataUrl(clinic.id) : null;
    res.json({ ...status, qr });
  })
);

apiRouter.post(
  "/whatsapp/connect",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    await connectClinic(clinic.id);
    res.json({ ok: true });
  })
);

apiRouter.post(
  "/whatsapp/disconnect",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    await disconnectClinic(clinic.id);
    res.json({ ok: true });
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

apiRouter.post(
  "/procedures",
  asyncRoute(async (req, res) => {
    const { name, durationMin, description } = req.body as {
      name?: string;
      durationMin?: number;
      description?: string;
    };
    if (!name) {
      res.status(400).json({ error: "name obrigatorio" });
      return;
    }

    const clinic = await getClinic(req);
    const procedure = await prisma.procedure.create({
      data: {
        clinicId: clinic.id,
        name,
        durationMin: durationMin && durationMin > 0 ? durationMin : 60,
        description: description || null,
      },
    });
    res.json(procedure);
  })
);

apiRouter.put(
  "/procedures/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.procedure.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { name, durationMin, description } = req.body as {
      name?: string;
      durationMin?: number;
      description?: string;
    };

    const procedure = await prisma.procedure.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(durationMin !== undefined ? { durationMin } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
      },
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
    });
    res.json(patients);
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
        lastMessageAt: c.lastMessageAt,
        patient: {
          id: c.patient.id,
          name: c.patient.name,
          phone: c.patient.phone,
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
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/crm/board",
  asyncRoute(async (req, res) => {
    const clinic = await getClinic(req);
    const [stages, patients] = await Promise.all([
      getFunnelStages(clinic.id),
      prisma.patient.findMany({ where: { clinicId: clinic.id }, orderBy: { createdAt: "desc" } }),
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
        })),
      }))
    );
  })
);

apiRouter.post(
  "/patients/:id/stage",
  asyncRoute(async (req, res) => {
    const { stage } = req.body as { stage?: string };
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, patient.clinicId)) return;
    const stages = await getFunnelStages(patient.clinicId);

    if (!stage || !stages.some((s) => s.stageId === stage)) {
      res.status(400).json({ error: `stage invalido, use um de: ${stages.map((s) => s.stageId).join(", ")}` });
      return;
    }

    await prisma.patient.update({ where: { id: req.params.id }, data: { funnelStage: stage } });
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
      include: { patient: true, procedure: true },
    });

    res.json(
      appointments.map((a) => ({
        id: a.id,
        scheduledAt: a.scheduledAt,
        status: a.status,
        patient: { name: a.patient.name, phone: a.patient.phone },
        procedure: { id: a.procedureId, name: a.procedure.name, durationMin: a.procedure.durationMin },
      }))
    );
  })
);

// Agendamento manual pelo painel (ex: paciente que ligou ou apareceu na
// clinica), sem passar pela conversa com a Alice.
apiRouter.post(
  "/appointments",
  asyncRoute(async (req, res) => {
    const { patientName, patientPhone, procedureId, scheduledAt } = req.body as {
      patientName?: string;
      patientPhone?: string;
      procedureId?: string;
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
      data: { clinicId: clinic.id, patientId: patient.id, procedureId, scheduledAt: new Date(scheduledAt) },
      include: { procedure: true },
    });
    await notifyStaff(
      clinic.id,
      "new_appointment",
      `Novo agendamento: ${patient.name ?? patient.phone} - ${appointment.procedure.name} em ${appointment.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
    );
    res.json(appointment);
  })
);

// Editar/transferir um agendamento existente (procedimento, data/hora e/ou status).
apiRouter.put(
  "/appointments/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id }, include: { patient: true } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { procedureId, scheduledAt, status } = req.body as {
      procedureId?: string;
      scheduledAt?: string;
      status?: string;
    };

    const appointment = await prisma.appointment.update({
      where: { id: req.params.id },
      data: {
        ...(procedureId !== undefined ? { procedureId } : {}),
        ...(scheduledAt !== undefined ? { scheduledAt: new Date(scheduledAt) } : {}),
        ...(status !== undefined ? { status } : {}),
      },
      include: { procedure: true },
    });

    const patientLabel = existing.patient.name ?? existing.patient.phone;
    if (status === "cancelled" && existing.status !== "cancelled") {
      await notifyStaff(existing.clinicId, "cancel", `Agendamento cancelado: ${patientLabel} - ${appointment.procedure.name}.`);
    } else if (scheduledAt !== undefined && new Date(scheduledAt).getTime() !== existing.scheduledAt.getTime()) {
      await notifyStaff(
        existing.clinicId,
        "reschedule",
        `Agendamento remarcado: ${patientLabel} - ${appointment.procedure.name} agora em ${appointment.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
      );
    }

    res.json(appointment);
  })
);

apiRouter.delete(
  "/appointments/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.appointment.delete({ where: { id: req.params.id } });
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

apiRouter.post(
  "/followup-rules",
  asyncRoute(async (req, res) => {
    const { afterDays, message } = req.body as { afterDays?: number; message?: string };
    if (!afterDays || !message) {
      res.status(400).json({ error: "afterDays e message sao obrigatorios" });
      return;
    }

    const clinic = await getClinic(req);
    const last = await prisma.followUpRule.findFirst({
      where: { clinicId: clinic.id },
      orderBy: { order: "desc" },
    });

    const rule = await prisma.followUpRule.create({
      data: { clinicId: clinic.id, order: (last?.order ?? 0) + 1, afterDays, message },
    });
    res.json(rule);
  })
);

apiRouter.put(
  "/followup-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.followUpRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    const { afterDays, message, active } = req.body as {
      afterDays?: number;
      message?: string;
      active?: boolean;
    };

    const rule = await prisma.followUpRule.update({
      where: { id: req.params.id },
      data: {
        ...(afterDays !== undefined ? { afterDays } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(active !== undefined ? { active } : {}),
      },
    });
    res.json(rule);
  })
);

apiRouter.delete(
  "/followup-rules/:id",
  asyncRoute(async (req, res) => {
    const existing = await prisma.followUpRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, existing.clinicId)) return;

    await prisma.followUpRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
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
    const { title, message, scheduledFor, targetStage } = req.body as {
      title?: string;
      message?: string;
      scheduledFor?: string;
      targetStage?: string | null;
    };

    if (!title || !message || !scheduledFor) {
      res.status(400).json({ error: "title, message e scheduledFor sao obrigatorios" });
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

    const campaign = await prisma.broadcastCampaign.create({
      data: {
        clinicId: clinic.id,
        title,
        message,
        targetStage: targetStage || null,
        scheduledFor: new Date(scheduledFor),
      },
    });
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
    const rules = await prisma.customRule.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(rules);
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

apiRouter.delete(
  "/rules/:id",
  asyncRoute(async (req, res) => {
    const rule = await prisma.customRule.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!assertClinicAccess(req, res, rule.clinicId)) return;

    await prisma.customRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

// --- Contas de login do painel. role="admin" (equipe da Alice) opera
// qualquer clinica; role="client" (dono da clinica, ex: Isac) fica travado
// na propria clinica em toda a API via getClinic() acima - esse e o
// isolamento real entre clientes da Alice. ---

apiRouter.get("/staff/me", (req, res) => {
  res.json(req.staff ? { id: req.staff.id, name: req.staff.name, role: req.staff.role, clinicId: req.staff.clinicId } : null);
});

// So funciona enquanto NENHUMA conta admin existir ainda - resolve o
// ovo-e-a-galinha de precisar estar logado como admin pra criar a primeira
// conta admin. Se auto-desliga assim que a primeira for criada.
apiRouter.post(
  "/staff/bootstrap-admin",
  asyncRoute(async (req, res) => {
    const existingAdmin = await prisma.staffUser.findFirst({ where: { role: "admin" } });
    if (existingAdmin) {
      res.status(403).json({ error: "Ja existe uma conta admin - use o login normal" });
      return;
    }

    const { name, username, password } = req.body as { name?: string; username?: string; password?: string };
    if (!name || !username || !password) {
      res.status(400).json({ error: "name, username e password sao obrigatorios" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "a senha precisa ter pelo menos 6 caracteres" });
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
    if (password.length < 6) {
      res.status(400).json({ error: "a senha precisa ter pelo menos 6 caracteres" });
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
