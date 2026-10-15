import { prisma } from "../db/client.js";
import { getFunnelStages } from "../crm/stages.js";
import { describeAd } from "./attribution.js";

// ---------------------------------------------------------------------------
// DESEMPENHO DOS ANUNCIOS. Usa SO dados reais do CRM (entradas de anuncio gravadas, classificacoes confirmadas, agendamentos, etapa de venda). Regra de
// atribuicao (explicita): o LEAD conta em cada anuncio por onde entrou no periodo; o RESULTADO (qualificado, desqualificado, agendamento, venda) conta no
// anuncio da ENTRADA MAIS RECENTE do lead dentro do periodo (a origem atribuida a conversao), uma vez so. Isto e atribuicao interna do CRM: nao e o
// numero de conversoes atribuidas pela Meta no Gerenciador de Anuncios. Custos (investimento, custo por lead...) so existiriam com a Marketing API
// (insights) liberada: nao foram misturados aqui.
// ---------------------------------------------------------------------------

export interface AdsFilters {
  start: Date;
  end: Date;
  campaign?: string; // nome da campanha (AdCatalog)
  adset?: string; // nome do conjunto (AdCatalog)
  adId?: string; // source_id
  staffId?: string; // Patient.assignedToId
  status?: "qualificado" | "desqualificado" | "em_qualificacao" | "sem_classificacao";
}

export interface AdRow {
  key: string;
  adId: string | null;
  label: string;
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
  platform: string | null;
  nameStatus: "identificado" | "pendente" | "indisponivel" | "n/a";
  note: string | null;
  leads: number;
  qualified: number;
  disqualified: number;
  scheduled: number;
  sold: number;
  qualifiedRate: number;
  disqualifiedRate: number;
  scheduledRate: number;
  soldRate: number | null; // null = sem dado de venda
  isOrganic?: boolean;
}

export interface AdsReport {
  rows: AdRow[];
  totals: { leads: number; qualified: number; disqualified: number; scheduled: number; sold: number };
  options: { campaigns: string[]; adsets: string[]; ads: { id: string; label: string }[] };
  criteria: string;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export const REPORT_CRITERIA =
  "Dados da Alice (entradas de anúncio recebidas pelo WhatsApp, classificações confirmadas, agendamentos e etapa de venda). Lead = pessoa que entrou pelo anúncio no período; cada resultado conta uma vez, no anúncio da entrada mais recente do lead no período. Não são as conversões atribuídas pela Meta no Gerenciador de Anúncios.";

export async function adsPerformance(clinicId: string, f: AdsFilters): Promise<AdsReport> {
  const [entries, catalog, stages] = await Promise.all([
    prisma.adAttribution.findMany({
      where: { clinicId, receivedAt: { gte: f.start, lte: f.end } },
      orderBy: { receivedAt: "asc" },
      take: 30000,
      select: { id: true, patientId: true, sourceId: true, headline: true, platform: true, receivedAt: true },
    }),
    prisma.adCatalog.findMany({ where: { clinicId } }),
    getFunnelStages(clinicId),
  ]);
  const cat = new Map(catalog.map((c) => [c.sourceId, c]));
  const wonStages = new Set(stages.filter((s) => s.kind === "ganho").map((s) => s.stageId));

  const patientIds = [...new Set(entries.map((e) => e.patientId))];
  const patients = new Map<string, { leadClass: string | null; funnelStage: string; assignedToId: string | null; scheduled: boolean }>();
  for (let i = 0; i < patientIds.length; i += 800) {
    const chunk = patientIds.slice(i, i + 800);
    const rows = await prisma.patient.findMany({ where: { id: { in: chunk } }, select: { id: true, leadClass: true, funnelStage: true, assignedToId: true, appointments: { where: { status: { not: "cancelled" } }, select: { id: true }, take: 1 } } });
    for (const p of rows) patients.set(p.id, { leadClass: p.leadClass, funnelStage: p.funnelStage, assignedToId: p.assignedToId, scheduled: p.appointments.length > 0 });
  }

  const keyOf = (e: { sourceId: string | null; id: string }) => e.sourceId ?? "sem-id";
  const matchesAdFilters = (e: { sourceId: string | null }) => {
    if (f.adId && e.sourceId !== f.adId) return false;
    const c = e.sourceId ? cat.get(e.sourceId) : undefined;
    if (f.campaign && c?.campaignName !== f.campaign) return false;
    if (f.adset && c?.adsetName !== f.adset) return false;
    return true;
  };
  const matchesPatient = (id: string) => {
    const p = patients.get(id);
    if (!p) return false;
    if (f.staffId && p.assignedToId !== f.staffId) return false;
    if (f.status) {
      const cls = p.leadClass ?? "sem_classificacao";
      if (cls !== f.status) return false;
    }
    return true;
  };

  const rows = new Map<string, AdRow>();
  const ensure = (e: { sourceId: string | null; headline: string | null; platform: string | null }): AdRow => {
    const key = e.sourceId ?? "sem-id";
    let r = rows.get(key);
    if (!r) {
      const d = describeAd({ sourceId: e.sourceId, headline: e.headline }, e.sourceId ? cat.get(e.sourceId) : null);
      r = { key, adId: e.sourceId, label: d.label, adName: d.adName, adsetName: d.adsetName, campaignName: d.campaignName, platform: e.platform, nameStatus: d.nameStatus, note: d.note, leads: 0, qualified: 0, disqualified: 0, scheduled: 0, sold: 0, qualifiedRate: 0, disqualifiedRate: 0, scheduledRate: 0, soldRate: null };
      rows.set(key, r);
    }
    return r;
  };

  // leads: um por pessoa em cada anuncio por onde entrou no periodo
  const seenLead = new Set<string>();
  const latestByPatient = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (!matchesAdFilters(e) || !matchesPatient(e.patientId)) continue;
    const k = `${e.patientId}|${keyOf(e)}`;
    if (!seenLead.has(k)) {
      seenLead.add(k);
      ensure(e).leads++;
    }
    latestByPatient.set(e.patientId, e); // asc: a ultima vence
  }
  // resultados: uma vez, no anuncio da entrada mais recente
  for (const [pid, e] of latestByPatient) {
    const p = patients.get(pid)!;
    const r = ensure(e);
    if (p.leadClass === "qualificado") r.qualified++;
    if (p.leadClass === "desqualificado") r.disqualified++;
    if (p.scheduled) r.scheduled++;
    if (wonStages.has(p.funnelStage)) r.sold++;
  }

  const out = [...rows.values()].map((r) => ({ ...r, qualifiedRate: pct(r.qualified, r.leads), disqualifiedRate: pct(r.disqualified, r.leads), scheduledRate: pct(r.scheduled, r.leads), soldRate: stages.some((s) => s.kind === "ganho") ? pct(r.sold, r.leads) : null })).sort((a, b) => b.leads - a.leads);
  const totals = out.reduce((t, r) => ({ leads: t.leads + r.leads, qualified: t.qualified + r.qualified, disqualified: t.disqualified + r.disqualified, scheduled: t.scheduled + r.scheduled, sold: t.sold + r.sold }), { leads: 0, qualified: 0, disqualified: 0, scheduled: 0, sold: 0 });

  const campaigns = [...new Set(catalog.map((c) => c.campaignName).filter((x): x is string => !!x))].sort();
  const adsets = [...new Set(catalog.map((c) => c.adsetName).filter((x): x is string => !!x))].sort();
  const ads = [...new Map(entries.filter((e) => e.sourceId).map((e) => [e.sourceId as string, { id: e.sourceId as string, label: describeAd({ sourceId: e.sourceId, headline: e.headline }, cat.get(e.sourceId as string)).label }])).values()];
  return { rows: out, totals, options: { campaigns, adsets, ads }, criteria: REPORT_CRITERIA };
}
