import { prisma } from "../db/client.js";
import { isoDateInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// Etiqueta de origem do lead (CRM): "Lead <campanha/anuncio> | dd/mm/aaaa". Nasce quando o contato entra pela primeira vez
// e serve pra filtrar/segmentar no CRM e nos relatorios. Ligada por clinica (Clinic.tagLeadOrigin). A etiqueta nativa do
// WhatsApp (Business) depende de endpoint da UAZAPI que ainda nao foi validado, por isso o equivalente fica aqui no sistema.
// ---------------------------------------------------------------------------

const MAX_LABEL = 40; // limite de Tag.label no painel

export function leadTagLabel(origin: { adName?: string | null; adCampaignName?: string | null; fromAd: boolean }, isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const date = `${d}/${m}/${y}`;
  const raw = (origin.adName || origin.adCampaignName || (origin.fromAd ? "Anúncio" : "Orgânico")).replace(/\s+/g, " ").trim();
  const suffix = ` | ${date}`;
  const prefix = "Lead ";
  const room = MAX_LABEL - prefix.length - suffix.length;
  const source = raw.length > room ? `${raw.slice(0, Math.max(1, room - 1)).trimEnd()}…` : raw;
  return `${prefix}${source}${suffix}`;
}

export async function tagNewLead(
  clinicId: string,
  patientId: string,
  origin: { adName?: string | null; adCampaignName?: string | null; fromAd: boolean },
): Promise<void> {
  try {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { tagLeadOrigin: true, timezone: true } });
    if (!clinic?.tagLeadOrigin) return;
    const label = leadTagLabel(origin, isoDateInZone(new Date(), clinic.timezone || "America/Sao_Paulo"));
    const tag = await prisma.tag.upsert({
      where: { clinicId_label: { clinicId, label } },
      update: {},
      create: { clinicId, label, color: origin.fromAd ? "#f97316" : "#64748b" },
    });
    await prisma.patientTag.upsert({
      where: { patientId_tagId: { patientId, tagId: tag.id } },
      update: {},
      create: { patientId, tagId: tag.id },
    });
  } catch (err) {
    console.error("[etiqueta de origem] falhou:", err);
  }
}
