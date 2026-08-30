import express, { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { prisma } from "../../db/client.js";
import { resolveApiKey } from "./keys.js";
import { getFunnelStages } from "../../crm/stages.js";
import { movePatientToStage } from "../../crm/stageAutomation.js";
import { findAvailableSlots, checkSpecificTime, createBooking, professionalsForProcedure } from "../../scheduling/slots.js";
import { formatInZone } from "../../scheduling/time.js";
import { offerFreedSlotToWaitlist } from "../../scheduling/waitlist.js";

export const externalApiRouter = Router();
externalApiRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
externalApiRouter.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Erros: sempre { error: { code, message } }
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

function wrap(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Autenticacao por chave
// ---------------------------------------------------------------------------
const authenticate: RequestHandler = (req, res, next) => {
  resolveApiKey(req.headers.authorization)
    .then((key) => {
      if (!key) {
        res.status(401).json({ error: { code: "unauthorized", message: "Chave de API ausente ou inválida." } });
        return;
      }
      req.apiKey = key;
      next();
    })
    .catch(next);
};

function requireScope(scope: string): RequestHandler {
  return (req, res, next) => {
    if (!req.apiKey?.scopes.includes(scope)) {
      res.status(403).json({ error: { code: "forbidden", message: `A chave não tem o escopo "${scope}".` } });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limit por chave: 60/min e 1000/h
// ---------------------------------------------------------------------------
const limitMsg = { error: { code: "rate_limited", message: "Limite de requisições atingido. Tente novamente em instantes." } };
// keyGenerator so roda depois do authenticate, entao req.apiKey sempre existe.
const byKey = (req: Request) => req.apiKey?.id ?? "unauthenticated";
const perMinute = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, message: limitMsg, keyGenerator: byKey, validate: { keyGeneratorIpFallback: false } });
const perHour = rateLimit({ windowMs: 3_600_000, limit: 1000, standardHeaders: false, legacyHeaders: false, message: limitMsg, keyGenerator: byKey, validate: { keyGeneratorIpFallback: false } });

// ---------------------------------------------------------------------------
// Idempotencia: repete a resposta de um POST/PATCH com o mesmo Idempotency-Key
// ---------------------------------------------------------------------------
const idempotency: RequestHandler = async (req, res, next) => {
  if (req.method !== "POST" && req.method !== "PATCH") return next();
  const key = String(req.headers["idempotency-key"] ?? "").trim();
  if (!key || !req.apiKey) return next();

  const existing = await prisma.apiIdempotencyKey.findUnique({
    where: { apiKeyId_key: { apiKeyId: req.apiKey.id, key } },
  });
  if (existing) {
    res.status(existing.statusCode).set("Idempotency-Replayed", "true").json(JSON.parse(existing.body));
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (req.apiKey && res.statusCode < 500) {
      prisma.apiIdempotencyKey
        .create({ data: { apiKeyId: req.apiKey.id, key, statusCode: res.statusCode, body: JSON.stringify(body) } })
        .catch(() => {});
    }
    return originalJson(body);
  }) as Response["json"];
  next();
};

externalApiRouter.use(authenticate, perMinute, perHour, idempotency);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clinicId(req: Request): string {
  return req.apiKey!.clinicId;
}

async function getClinicRow(req: Request) {
  return prisma.clinic.findUniqueOrThrow({ where: { id: clinicId(req) } });
}

function contactOut(p: {
  id: string; name: string | null; phone: string; email: string | null; cpf: string | null;
  notes: string | null; birthDate: Date | null; funnelStage: string; createdAt: Date;
  tags?: { tag: { id: string; label: string; color: string } }[];
}) {
  return {
    id: p.id,
    name: p.name,
    phone: p.phone,
    email: p.email,
    cpf: p.cpf,
    notes: p.notes,
    birth_date: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
    funnel_stage: p.funnelStage,
    tags: (p.tags ?? []).map((t) => ({ id: t.tag.id, label: t.tag.label, color: t.tag.color })),
    created_at: p.createdAt.toISOString(),
  };
}

function apptOut(a: {
  id: string; scheduledAt: Date; status: string; patientConfirmed: boolean; procedureId: string;
  procedure: { name: string }; professional: { id: string; name: string } | null; patient: { id: string; name: string | null; phone: string };
}, tz: string) {
  return {
    id: a.id,
    start: a.scheduledAt.toISOString(),
    start_local: formatInZone(a.scheduledAt, tz),
    status: a.status,
    patient_confirmed: a.patientConfirmed,
    procedure: { id: a.procedureId, name: a.procedure.name },
    professional: a.professional ? { id: a.professional.id, name: a.professional.name } : null,
    contact: { id: a.patient.id, name: a.patient.name, phone: a.patient.phone },
  };
}

// ===========================================================================
// IDENTIDADE
// ===========================================================================
externalApiRouter.get(
  "/me",
  requireScope("identity.read"),
  wrap(async (req, res) => {
    const c = await getClinicRow(req);
    res.json({
      clinic: {
        id: c.id,
        name: c.name,
        timezone: c.timezone,
        work_days: c.workDays,
        work_start_hour: c.workStartHour,
        work_end_hour: c.workEndHour,
      },
      key: { name: req.apiKey!.name, scopes: req.apiKey!.scopes },
    });
  }),
);

// ===========================================================================
// CONTATOS
// ===========================================================================
externalApiRouter.get(
  "/contacts",
  requireScope("contacts.read"),
  wrap(async (req, res) => {
    const search = String(req.query.search ?? "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const cursor = String(req.query.cursor ?? "").trim();

    const where = {
      clinicId: clinicId(req),
      ...(search ? { OR: [{ name: { contains: search } }, { phone: { contains: search.replace(/\D/g, "") } }] } : {}),
    };
    const rows = await prisma.patient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { tags: { include: { tag: true } } },
    });
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    res.json({ data: data.map(contactOut), next_cursor: hasMore ? data[data.length - 1].id : null });
  }),
);

externalApiRouter.get(
  "/contacts/:id",
  requireScope("contacts.read"),
  wrap(async (req, res) => {
    const p = await prisma.patient.findFirst({
      where: { id: req.params.id, clinicId: clinicId(req) },
      include: { tags: { include: { tag: true } } },
    });
    if (!p) fail(404, "not_found", "Contato não encontrado.");
    res.json(contactOut(p));
  }),
);

externalApiRouter.post(
  "/contacts",
  requireScope("contacts.write"),
  wrap(async (req, res) => {
    const b = req.body as { name?: string; phone?: string; email?: string; cpf?: string; notes?: string; birth_date?: string; tags?: string[] };
    const phone = String(b.phone ?? "").replace(/\D/g, "");
    if (!phone || phone.length < 10) fail(422, "invalid_request", "phone é obrigatório (com DDI e DDD, só números).");

    let birthDate: Date | null | undefined;
    if (b.birth_date !== undefined) {
      if (!b.birth_date) birthDate = null;
      else {
        const d = new Date(`${b.birth_date}T00:00:00Z`);
        if (isNaN(d.getTime())) fail(422, "invalid_request", "birth_date inválido (use AAAA-MM-DD).");
        birthDate = d;
      }
    }

    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId: clinicId(req), phone } },
      update: {
        ...(b.name !== undefined ? { name: b.name.trim() || null } : {}),
        ...(b.email !== undefined ? { email: b.email.trim() || null } : {}),
        ...(b.cpf !== undefined ? { cpf: String(b.cpf).replace(/\D/g, "") || null } : {}),
        ...(b.notes !== undefined ? { notes: b.notes.trim() || null } : {}),
        ...(birthDate !== undefined ? { birthDate } : {}),
      },
      create: {
        clinicId: clinicId(req),
        phone,
        name: b.name?.trim() || null,
        email: b.email?.trim() || null,
        cpf: b.cpf ? String(b.cpf).replace(/\D/g, "") : null,
        notes: b.notes?.trim() || null,
        birthDate: birthDate ?? null,
      },
    });

    if (Array.isArray(b.tags)) {
      const labels = b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
      const tagIds: string[] = [];
      for (const label of labels) {
        const tag = await prisma.tag.upsert({
          where: { clinicId_label: { clinicId: clinicId(req), label } },
          update: {},
          create: { clinicId: clinicId(req), label },
        });
        tagIds.push(tag.id);
      }
      await prisma.patientTag.deleteMany({ where: { patientId: patient.id } });
      if (tagIds.length) await prisma.patientTag.createMany({ data: tagIds.map((tagId) => ({ patientId: patient.id, tagId })) });
    }

    const full = await prisma.patient.findUniqueOrThrow({ where: { id: patient.id }, include: { tags: { include: { tag: true } } } });
    res.status(201).json(contactOut(full));
  }),
);

externalApiRouter.patch(
  "/contacts/:id",
  requireScope("contacts.write"),
  wrap(async (req, res) => {
    const p = await prisma.patient.findFirst({ where: { id: req.params.id, clinicId: clinicId(req) } });
    if (!p) fail(404, "not_found", "Contato não encontrado.");
    const b = req.body as { name?: string; email?: string; cpf?: string; notes?: string; birth_date?: string | null };

    let birthDate: Date | null | undefined;
    if (b.birth_date !== undefined) {
      if (!b.birth_date) birthDate = null;
      else {
        const d = new Date(`${b.birth_date}T00:00:00Z`);
        if (isNaN(d.getTime())) fail(422, "invalid_request", "birth_date inválido (use AAAA-MM-DD).");
        birthDate = d;
      }
    }

    const updated = await prisma.patient.update({
      where: { id: p.id },
      data: {
        ...(b.name !== undefined ? { name: b.name.trim() || null } : {}),
        ...(b.email !== undefined ? { email: b.email.trim() || null } : {}),
        ...(b.cpf !== undefined ? { cpf: String(b.cpf).replace(/\D/g, "") || null } : {}),
        ...(b.notes !== undefined ? { notes: b.notes.trim() || null } : {}),
        ...(birthDate !== undefined ? { birthDate } : {}),
      },
      include: { tags: { include: { tag: true } } },
    });
    res.json(contactOut(updated));
  }),
);

// ===========================================================================
// CRM
// ===========================================================================
externalApiRouter.get(
  "/crm/stages",
  requireScope("crm.read"),
  wrap(async (req, res) => {
    const stages = await getFunnelStages(clinicId(req));
    res.json({ data: stages.map((s) => ({ id: s.stageId, label: s.label, color: s.color, kind: s.kind, order: s.order })) });
  }),
);

externalApiRouter.get(
  "/crm/board",
  requireScope("crm.read"),
  wrap(async (req, res) => {
    const [stages, patients] = await Promise.all([
      getFunnelStages(clinicId(req)),
      prisma.patient.findMany({ where: { clinicId: clinicId(req) }, orderBy: { createdAt: "desc" }, include: { tags: { include: { tag: true } } } }),
    ]);
    const fallback = stages[0]?.stageId;
    res.json({
      data: stages.map((s) => ({
        id: s.stageId,
        label: s.label,
        kind: s.kind,
        contacts: patients
          .filter((p) => (stages.some((x) => x.stageId === p.funnelStage) ? p.funnelStage === s.stageId : s.stageId === fallback))
          .map(contactOut),
      })),
    });
  }),
);

externalApiRouter.post(
  "/contacts/:id/stage",
  requireScope("crm.write"),
  wrap(async (req, res) => {
    const p = await prisma.patient.findFirst({ where: { id: req.params.id, clinicId: clinicId(req) } });
    if (!p) fail(404, "not_found", "Contato não encontrado.");
    const stage = String((req.body as { stage?: string }).stage ?? "");
    const result = await movePatientToStage(clinicId(req), p.id, stage, { note: `via API (${req.apiKey!.name})` });
    if (!result.ok) fail(422, "invalid_request", result.error ?? "Etapa inválida.");
    res.json({ ok: true, stage, label: result.label });
  }),
);

// ===========================================================================
// CATALOGO
// ===========================================================================
externalApiRouter.get(
  "/procedures",
  requireScope("catalog.read"),
  wrap(async (req, res) => {
    const rows = await prisma.procedure.findMany({ where: { clinicId: clinicId(req) }, orderBy: { name: "asc" } });
    res.json({
      data: rows.map((p) => ({
        id: p.id,
        name: p.name,
        duration_min: p.durationMin,
        price: p.price,
        price_variable: p.priceVariable,
        payment_methods: p.paymentMethods ? p.paymentMethods.split(",").filter(Boolean) : [],
        description: p.description,
      })),
    });
  }),
);

externalApiRouter.get(
  "/products",
  requireScope("catalog.read"),
  wrap(async (req, res) => {
    const rows = await prisma.product.findMany({ where: { clinicId: clinicId(req), active: true }, orderBy: { name: "asc" } });
    res.json({ data: rows.map((p) => ({ id: p.id, name: p.name, price: p.price, description: p.description })) });
  }),
);

externalApiRouter.get(
  "/professionals",
  requireScope("professionals.read"),
  wrap(async (req, res) => {
    const rows = await prisma.professional.findMany({
      where: { clinicId: clinicId(req), active: true },
      orderBy: { name: "asc" },
      include: { procedures: { select: { id: true, name: true } } },
    });
    res.json({
      data: rows.map((p) => ({
        id: p.id,
        name: p.name,
        bio: p.bio,
        instagram: p.instagram,
        procedures: p.procedures.map((x) => ({ id: x.id, name: x.name })),
      })),
    });
  }),
);

// ===========================================================================
// AGENDA
// ===========================================================================
externalApiRouter.get(
  "/appointments",
  requireScope("agenda.read"),
  wrap(async (req, res) => {
    const c = await getClinicRow(req);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 30 * 864e5);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) fail(422, "invalid_request", "from/to inválidos (use ISO 8601).");
    const status = String(req.query.status ?? "").trim();

    const rows = await prisma.appointment.findMany({
      where: {
        clinicId: c.id,
        scheduledAt: { gte: from, lte: to },
        ...(status ? { status } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      take: 500,
      include: { procedure: { select: { name: true } }, professional: { select: { id: true, name: true } }, patient: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ data: rows.map((a) => apptOut(a, c.timezone)) });
  }),
);

externalApiRouter.get(
  "/availability",
  requireScope("agenda.read"),
  wrap(async (req, res) => {
    const c = await getClinicRow(req);
    const procedureId = String(req.query.procedure_id ?? "").trim();
    const procedure = procedureId
      ? await prisma.procedure.findFirst({ where: { id: procedureId, clinicId: c.id } })
      : null;
    if (!procedure) fail(422, "invalid_request", "procedure_id é obrigatório e deve ser um procedimento da clínica.");

    const professionalId = String(req.query.professional_id ?? "").trim();
    const professionalIds = professionalId
      ? [professionalId]
      : (await professionalsForProcedure(c.id, procedure.id)).map((p) => p.id);
    const days = Math.min(Math.max(Number(req.query.days) || 10, 1), 30);

    const slots = await findAvailableSlots(c.id, procedure.id, { professionalIds, daysAhead: days, limit: 40 });
    res.json({
      data: slots.map((s) => ({
        start: s.start.toISOString(),
        start_local: formatInZone(s.start, c.timezone),
        professional: s.professionalId ? { id: s.professionalId, name: s.professionalName } : null,
      })),
    });
  }),
);

externalApiRouter.post(
  "/appointments",
  requireScope("agenda.write"),
  wrap(async (req, res) => {
    const c = await getClinicRow(req);
    const b = req.body as { contact?: { phone?: string; name?: string }; procedure_id?: string; professional_id?: string | null; start?: string };
    const phone = String(b.contact?.phone ?? "").replace(/\D/g, "");
    if (!phone) fail(422, "invalid_request", "contact.phone é obrigatório.");
    if (!b.procedure_id) fail(422, "invalid_request", "procedure_id é obrigatório.");
    if (!b.start) fail(422, "invalid_request", "start é obrigatório (ISO 8601).");
    const start = new Date(b.start);
    if (isNaN(start.getTime())) fail(422, "invalid_request", "start inválido.");

    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId: c.id, phone } },
      update: { name: b.contact?.name?.trim() || undefined },
      create: { clinicId: c.id, phone, name: b.contact?.name?.trim() || null },
    });

    const booking = await createBooking({
      clinicId: c.id,
      patientId: patient.id,
      procedureId: b.procedure_id,
      professionalId: b.professional_id ?? null,
      startUtc: start,
    });
    if (!booking.ok) {
      const map: Record<string, string> = {
        conflict: "Já existe agendamento nesse horário.",
        blocked: "A agenda está bloqueada nesse horário.",
        outside_hours: "Fora do horário de atendimento.",
        closed_day: "A clínica não atende nesse dia.",
        past: "O horário já passou.",
        procedure_not_found: "Procedimento não encontrado.",
        invalid_datetime: "Data/hora inválida.",
      };
      fail(booking.error === "conflict" ? 409 : 422, booking.error, map[booking.error] ?? "Não foi possível agendar.");
    }

    const full = await prisma.appointment.findUniqueOrThrow({
      where: { id: booking.appointmentId },
      include: { procedure: { select: { name: true } }, professional: { select: { id: true, name: true } }, patient: { select: { id: true, name: true, phone: true } } },
    });
    res.status(201).json(apptOut(full, c.timezone));
  }),
);

externalApiRouter.patch(
  "/appointments/:id",
  requireScope("agenda.write"),
  wrap(async (req, res) => {
    const c = await getClinicRow(req);
    const existing = await prisma.appointment.findFirst({ where: { id: req.params.id, clinicId: c.id } });
    if (!existing) fail(404, "not_found", "Agendamento não encontrado.");
    const b = req.body as { status?: string; start?: string; professional_id?: string | null };

    if (b.status && !["confirmed", "completed", "cancelled"].includes(b.status)) {
      fail(422, "invalid_request", 'status deve ser "confirmed", "completed" ou "cancelled".');
    }
    let start: Date | undefined;
    if (b.start !== undefined) {
      start = new Date(b.start);
      if (isNaN(start.getTime())) fail(422, "invalid_request", "start inválido.");
    }

    const updated = await prisma.appointment.update({
      where: { id: existing.id },
      data: {
        ...(b.status ? { status: b.status } : {}),
        ...(start ? { scheduledAt: start } : {}),
        ...(b.professional_id !== undefined ? { professionalId: b.professional_id || null } : {}),
      },
      include: { procedure: { select: { name: true } }, professional: { select: { id: true, name: true } }, patient: { select: { id: true, name: true, phone: true } } },
    });

    if (b.status === "cancelled" && existing.status !== "cancelled") {
      await offerFreedSlotToWaitlist({ clinicId: c.id, procedureId: existing.procedureId, professionalId: existing.professionalId, freedAt: existing.scheduledAt });
    }
    res.json(apptOut(updated, c.timezone));
  }),
);

// ---------------------------------------------------------------------------
// 404 + error handler do escopo /external
// ---------------------------------------------------------------------------
externalApiRouter.use((_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Endpoint não encontrado." } });
});

externalApiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2025") {
    res.status(404).json({ error: { code: "not_found", message: "Registro não encontrado." } });
    return;
  }
  console.error("Erro na API externa:", err);
  res.status(500).json({ error: { code: "internal", message: "Erro interno." } });
});
