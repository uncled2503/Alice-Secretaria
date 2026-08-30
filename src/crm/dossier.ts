import { prisma } from "../db/client.js";

// Ficha completa de um contato para o painel do Chat (aba "Contato no chat"):
// dados, etiquetas, agendamentos (proximos e passados) e a linha do tempo de
// automacoes (o que ja recebeu e o que ainda vai receber).
export async function patientDossier(clinicId: string, patientId: string) {
  const patient = await prisma.patient.findFirstOrThrow({
    where: { id: patientId, clinicId },
    include: { tags: { include: { tag: true } } },
  });

  const now = new Date();

  const [upcoming, past] = await Promise.all([
    prisma.appointment.findMany({
      where: { patientId, status: "confirmed", scheduledAt: { gte: now } },
      orderBy: { scheduledAt: "asc" },
      include: { procedure: { select: { name: true } }, professional: { select: { name: true } } },
    }),
    prisma.appointment.findMany({
      where: { patientId, OR: [{ scheduledAt: { lt: now } }, { status: { in: ["completed", "cancelled"] } }] },
      orderBy: { scheduledAt: "desc" },
      take: 10,
      include: { procedure: { select: { name: true } }, professional: { select: { name: true } } },
    }),
  ]);

  const mapAppt = (a: (typeof upcoming)[number]) => ({
    id: a.id,
    scheduledAt: a.scheduledAt,
    status: a.status,
    patientConfirmed: a.patientConfirmed,
    procedure: a.procedure.name,
    professional: a.professional?.name ?? null,
  });

  // --- Automacoes: ja recebeu ---
  const [reminders, postProc, renewals, birthdays, followups, broadcastRecipients] = await Promise.all([
    prisma.reminderSent.findMany({
      where: { appointment: { patientId } },
      orderBy: { sentAt: "desc" },
      include: { rule: { select: { hoursBefore: true } }, appointment: { select: { procedure: { select: { name: true } } } } },
    }),
    prisma.postProcedureSent.findMany({
      where: { appointment: { patientId } },
      orderBy: { sentAt: "desc" },
      include: { rule: { select: { name: true } } },
    }),
    prisma.renewalSent.findMany({
      where: { appointment: { patientId } },
      orderBy: { sentAt: "desc" },
      include: { rule: { select: { name: true } } },
    }),
    prisma.birthdaySent.findMany({
      where: { patientId },
      orderBy: { sentAt: "desc" },
      include: { rule: { select: { name: true } } },
    }),
    prisma.followUpSent.findMany({
      where: { conversation: { patientId } },
      orderBy: { sentAt: "desc" },
      include: { rule: { select: { name: true, order: true } } },
    }),
    prisma.broadcastRecipient.findMany({
      where: { patientId },
      orderBy: { sentAt: "desc" },
      include: { campaign: { select: { title: true, scheduledFor: true, status: true } } },
    }),
  ]);

  const sent: { kind: string; label: string; when: Date }[] = [
    ...reminders.map((r) => ({ kind: "Lembrete", label: `Lembrete ${r.rule.hoursBefore}h antes${r.appointment.procedure ? ` — ${r.appointment.procedure.name}` : ""}`, when: r.sentAt })),
    ...postProc.map((r) => ({ kind: "Pós-procedimento", label: r.rule.name, when: r.sentAt })),
    ...renewals.map((r) => ({ kind: "Renovação", label: r.rule.name, when: r.sentAt })),
    ...birthdays.map((r) => ({ kind: "Aniversário", label: r.rule.name, when: r.sentAt })),
    ...followups.map((r) => ({ kind: "Recontato", label: r.rule.name || `Recontato ${r.rule.order}`, when: r.sentAt })),
    ...broadcastRecipients
      .filter((r) => r.status === "sent")
      .map((r) => ({ kind: "Campanha", label: r.campaign.title, when: r.sentAt ?? r.campaign.scheduledFor })),
  ].sort((a, b) => b.when.getTime() - a.when.getTime());

  // --- Automacoes: vai receber ---
  const pending: { kind: string; label: string; when: Date | null }[] = broadcastRecipients
    .filter((r) => r.status === "pending" && r.campaign.status !== "cancelled")
    .map((r) => ({ kind: "Campanha", label: r.campaign.title, when: r.campaign.scheduledFor }));

  const failed = broadcastRecipients
    .filter((r) => r.status === "failed")
    .map((r) => ({ kind: "Campanha", label: r.campaign.title, when: r.sentAt }));

  return {
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      email: patient.email,
      cpf: patient.cpf,
      notes: patient.notes,
      birthDate: patient.birthDate,
      funnelStage: patient.funnelStage,
      createdAt: patient.createdAt,
      tags: patient.tags.map((pt) => ({ id: pt.tag.id, label: pt.tag.label, color: pt.tag.color })),
    },
    appointments: { upcoming: upcoming.map(mapAppt), past: past.map(mapAppt) },
    automations: { pending, sent, failed },
  };
}
