import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import { notifyStaff } from "./notify.js";

// ---------------------------------------------------------------------------
// PACOTE DE SESSOES (checklist mestre, Fases 2/3). DIAGNOSTICO DA FONTE: o cliente do Clinica Experts neste repositorio (src/clinicaexperts) NAO le nem escreve saldo/consumo de sessoes, e nao
// ha endpoint documentado conhecido para isso; por isso NADA aqui e inferido do CE. A FONTE E INTERNA E EXPLICITA: a equipe registra o pacote contratado e cada sessao usada (PackageUsage). Sem
// registro nao ha saldo, nao ha aviso e nenhum numero e inventado. Os avisos vao para a EQUIPE (nenhum texto promocional ao paciente foi aprovado).
// ---------------------------------------------------------------------------
export const PACKAGE_IDLE_DAYS = 10;

export interface PackageRow { id: string; patientId: string; name: string; totalSessions: number; status: string; startsAt: Date; expiresAt: Date | null; usages: { usedAt: Date }[] }

export function balanceOf(p: Pick<PackageRow, "totalSessions" | "usages">): { usadas: number; restantes: number } {
  const usadas = p.usages.length;
  return { usadas, restantes: Math.max(0, p.totalSessions - usadas) };
}

export async function createPackage(clinicId: string, input: { patientId: string; name: string; totalSessions: number; procedureId?: string | null; expiresAt?: string | null; notes?: string | null }, actorName: string | null): Promise<{ ok: boolean; message: string; id?: string }> {
  const total = Math.round(Number(input.totalSessions));
  if (!Number.isFinite(total) || total < 1 || total > 100) return { ok: false, message: "Quantidade de sessões inválida (1 a 100)." };
  const name = (input.name ?? "").trim().slice(0, 120);
  if (!name) return { ok: false, message: "Informe o nome do pacote." };
  const patient = await prisma.patient.findFirst({ where: { id: input.patientId, clinicId }, select: { id: true } });
  if (!patient) return { ok: false, message: "Contato não encontrado nesta clínica." };
  let expiresAt: Date | null = null;
  if (input.expiresAt) { expiresAt = new Date(input.expiresAt); if (Number.isNaN(expiresAt.getTime())) return { ok: false, message: "Validade inválida." }; }
  const row = await prisma.patientPackage.create({ data: { clinicId, patientId: patient.id, name, totalSessions: total, procedureId: input.procedureId ?? null, expiresAt, notes: input.notes?.slice(0, 300) ?? null, createdBy: actorName } });
  await logActivity({ clinicId, patientId: patient.id, type: "package", area: "atendimento", title: `Pacote registrado: ${name} (${total} sessões)`, actorName });
  return { ok: true, message: "Pacote registrado (fonte interna).", id: row.id };
}

// Registra UMA sessao usada. Nao deixa passar do contratado (saldo nunca negativo) e conclui o pacote ao zerar. Concorrencia: confere o total depois de gravar e desfaz o excesso.
export async function registerUsage(clinicId: string, packageId: string, input: { appointmentId?: string | null; note?: string | null }, actorName: string | null, now = new Date()): Promise<{ ok: boolean; message: string; restantes?: number }> {
  const pkg = await prisma.patientPackage.findFirst({ where: { id: packageId, clinicId }, include: { usages: true } });
  if (!pkg) return { ok: false, message: "Pacote não encontrado nesta clínica." };
  if (pkg.status !== "ativo") return { ok: false, message: `O pacote está ${pkg.status}.` };
  if (pkg.usages.length >= pkg.totalSessions) return { ok: false, message: "Todas as sessões contratadas já foram registradas." };
  if (input.appointmentId && pkg.usages.some((u) => u.appointmentId === input.appointmentId)) return { ok: false, message: "Este atendimento já foi registrado como sessão deste pacote." };
  const usage = await prisma.packageUsage.create({ data: { packageId, usedAt: now, appointmentId: input.appointmentId ?? null, recordedBy: actorName, note: input.note?.slice(0, 200) ?? null } });
  const count = await prisma.packageUsage.count({ where: { packageId } });
  if (count > pkg.totalSessions) { await prisma.packageUsage.delete({ where: { id: usage.id } }); return { ok: false, message: "Outra pessoa registrou a última sessão ao mesmo tempo: nada foi duplicado." }; }
  const restantes = pkg.totalSessions - count;
  if (restantes === 0) await prisma.patientPackage.updateMany({ where: { id: packageId, status: "ativo" }, data: { status: "concluido" } });
  await logActivity({ clinicId, patientId: pkg.patientId, type: "package", area: "atendimento", title: `Sessão registrada: ${pkg.name} (restam ${restantes})`, actorName });
  return { ok: true, message: restantes === 0 ? "Última sessão registrada: pacote concluído." : `Sessão registrada. Restam ${restantes}.`, restantes };
}

export type PackageAlertKind = "restam_2" | "restam_1" | "ultima_sessao" | "parado_10_dias" | "vencendo";
export interface PackageAlert { packageId: string; patientId: string; name: string; kind: PackageAlertKind; restantes: number; detail: string }

// PURO: alertas de UM pacote. `hasFutureBooking` = a pessoa tem agendamento confirmado futuro.
export function packageAlerts(p: PackageRow, hasFutureBooking: boolean, now: Date): PackageAlert[] {
  const { restantes } = balanceOf(p);
  const out: PackageAlert[] = [];
  const base = { packageId: p.id, patientId: p.patientId, name: p.name, restantes };
  const last = p.usages.length ? Math.max(...p.usages.map((u) => u.usedAt.getTime())) : null;
  if (p.status === "ativo") {
    if (restantes === 2) out.push({ ...base, kind: "restam_2", detail: "restam 2 sessões: avisar o fim do protocolo e sugerir reavaliação/continuidade" });
    if (restantes === 1) out.push({ ...base, kind: "restam_1", detail: "resta 1 sessão (a última): combinar reavaliação/continuidade" });
    const ref = last ?? p.startsAt.getTime();
    if (restantes > 0 && now.getTime() - ref > PACKAGE_IDLE_DAYS * 86_400_000 && !hasFutureBooking) out.push({ ...base, kind: "parado_10_dias", detail: `há mais de ${PACKAGE_IDLE_DAYS} dias sem sessão, com ${restantes} restante(s) e sem agendamento futuro` });
    if (restantes > 0 && p.expiresAt && p.expiresAt.getTime() - now.getTime() <= 14 * 86_400_000 && p.expiresAt.getTime() > now.getTime()) out.push({ ...base, kind: "vencendo", detail: `o pacote vence em ${Math.ceil((p.expiresAt.getTime() - now.getTime()) / 86_400_000)} dia(s) com ${restantes} sessão(ões) restante(s)` });
  }
  if (p.status === "concluido" && last && now.getTime() - last <= 7 * 86_400_000) out.push({ ...base, kind: "ultima_sessao", detail: "a última sessão foi concluída há poucos dias: pedir feedback e combinar reavaliação/manutenção/novo objetivo" });
  return out;
}

export async function clinicPackageAlerts(clinicId: string, now = new Date()): Promise<PackageAlert[]> {
  const pkgs = await prisma.patientPackage.findMany({ where: { clinicId, status: { in: ["ativo", "concluido"] } }, include: { usages: { select: { usedAt: true } } } });
  const out: PackageAlert[] = [];
  for (const p of pkgs) {
    const future = (await prisma.appointment.count({ where: { patientId: p.patientId, status: "confirmed", scheduledAt: { gte: now } } })) > 0;
    out.push(...packageAlerts(p, future, now));
  }
  return out;
}

// Job diario: avisa a EQUIPE uma vez por pacote+alerta (marcador no Diario; sem texto ao paciente).
export async function runPackageAlertJob(now = new Date(), only?: { clinicId?: string }): Promise<number> {
  const clinics = await prisma.clinic.findMany({ where: { active: true, ...(only?.clinicId ? { id: only.clinicId } : {}) }, select: { id: true } });
  let sent = 0;
  for (const c of clinics) {
    for (const a of await clinicPackageAlerts(c.id, now)) {
      const marker = `[pacote:${a.packageId}:${a.kind}:${a.restantes}]`;
      if (await prisma.activityLog.findFirst({ where: { clinicId: c.id, type: "package_alert", description: { contains: marker } }, select: { id: true } })) continue;
      const pat = await prisma.patient.findUnique({ where: { id: a.patientId }, select: { name: true, phone: true } });
      const result = await notifyStaff(c.id, "automation_failed", `📦 Pacote "${a.name}" de ${pat?.name ?? pat?.phone ?? "contato"}: ${a.detail}.`);
      // so marca como avisado quando o aviso foi ACEITO pelo provedor (senao tenta de novo no proximo dia)
      if (result === "sent") { await logActivity({ clinicId: c.id, patientId: a.patientId, type: "package_alert", area: "atendimento", title: `Aviso de pacote: ${a.kind}`, description: `${a.detail} ${marker}`, actorName: null }); sent++; }
    }
  }
  return sent;
}

// Diario, 9h (Brasilia = 12h UTC). Avisa a EQUIPE; nao escreve para o paciente.
import { scheduleLocked } from "../jobs/lock.js";
export function startPackageAlertJob(): void {
  scheduleLocked("pacotes-avisos", "0 12 * * *", async () => { await runPackageAlertJob(); });
}
