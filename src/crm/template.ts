import { prisma } from "../db/client.js";

// Variaveis compartilhadas por mensagens programadas, lembrete de consulta e
// pos-procedimento - {nome} continua funcionando (compatibilidade com
// campanhas antigas), e so um alias de {primeiro_nome}.
export interface TemplateContext {
  patientName: string | null;
  patientPhone: string;
  clinicName: string;
  locationName?: string | null;
  locationAddress?: string | null;
  procedureName?: string | null;
  professionalName?: string | null;
  when?: Date | null;
  birthDate?: Date | null;
}

export function renderMessageTemplate(template: string, ctx: TemplateContext): string {
  const fullName = ctx.patientName?.trim() ?? "";
  const firstName = fullName.split(" ")[0] ?? "";
  const when = ctx.when ?? new Date();

  return template
    .replace(/\{nome\}/gi, firstName)
    .replace(/\{primeiro_nome\}/gi, firstName)
    .replace(/\{nome_completo\}/gi, fullName)
    .replace(/\{telefone\}/gi, ctx.patientPhone)
    .replace(/\{endereco\}/gi, ctx.locationAddress ?? "")
    .replace(/\{unidade\}/gi, ctx.locationName ?? ctx.clinicName)
    .replace(/\{procedimento\}/gi, ctx.procedureName ?? "")
    .replace(/\{profissional\}/gi, ctx.professionalName ?? "")
    .replace(/\{data_hora\}/gi, when.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))
    .replace(/\{hora\}/gi, when.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }))
    .replace(/\{aniversario\}/gi, ctx.birthDate ? `${String(ctx.birthDate.getUTCDate()).padStart(2, "0")}/${String(ctx.birthDate.getUTCMonth() + 1).padStart(2, "0")}` : "")
    .trim();
}

export interface ClinicTemplateInfo {
  name: string;
  primaryLocation: { name: string; fullAddress: string } | null;
}

export async function getClinicTemplateInfo(clinicId: string): Promise<ClinicTemplateInfo> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const location = await prisma.clinicLocation.findFirst({
    where: { clinicId, active: true },
    orderBy: { order: "asc" },
  });

  if (!location) return { name: clinic.name, primaryLocation: null };

  const parts = [location.street, location.number, location.neighborhood, location.city, location.state]
    .filter(Boolean)
    .join(", ");
  return { name: clinic.name, primaryLocation: { name: location.name, fullAddress: parts } };
}
