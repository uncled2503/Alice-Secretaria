import { prisma } from "../db/client.js";
import { decryptSecret } from "../meta/secretBox.js";
import { graphVersionOf } from "../meta/capi.js";

// ---------------------------------------------------------------------------
// ATRIBUICAO DE ANUNCIOS (Click-to-WhatsApp). Captura o objeto `referral` que a Meta anexa na mensagem que nasce de um anuncio e guarda, uma linha por
// entrada atribuivel, o que veio DE VERDADE: source_id (ID do anuncio), source_type, ctwa_clid, headline, body, source_url... O webhook NAO traz o nome do
// anuncio/conjunto/campanha: eles sao buscados depois na Marketing API (AdCatalog) e, se isso nao for possivel, fica so o ID e o aviso "nome ainda
// nao identificado". Nunca se infere anuncio por palavra-chave ou mensagem padrao: sem source_id nem ctwa_clid nao existe atribuicao.
// ---------------------------------------------------------------------------

export interface AdReferral {
  ctwaClid?: string;
  sourceId?: string;
  sourceType?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  rawKeys?: string; // nomes dos campos recebidos (diagnostico)
  // legado (rotulos que o painel ja usava): nao sao nomes oficiais de anuncio/campanha
  adCampaignName?: string;
  adsetName?: string;
  adName?: string;
}

// PURO: so e anuncio quando a Meta mandou o ID do anuncio ou o ID do clique. URL sozinha nao basta.
export function isValidAdReferral(r: AdReferral | undefined | null): r is AdReferral {
  if (!r) return false;
  return !!(r.sourceId?.trim() || r.ctwaClid?.trim());
}

// PURO: plataforma so quando a URL de referencia deixa claro (instagram.com / facebook.com / fb.me / fb.com). Senao null (= "Meta Ads").
export function platformFromUrl(url: string | null | undefined): "instagram" | "facebook" | null {
  const u = (url ?? "").toLowerCase();
  if (!u) return null;
  if (/(^|[/.])instagram\.com|(^|[/.])instagr\.am/.test(u)) return "instagram";
  if (/(^|[/.])facebook\.com|(^|[/.])fb\.me|(^|[/.])fb\.com|(^|[/.])fb\.watch/.test(u)) return "facebook";
  return null;
}

const clip = (s: string | undefined, n: number) => (s ? s.trim().slice(0, n) || null : null);

export interface CaptureResult {
  id: string;
  entryKind: "first" | "new_ad" | "new_click";
  created: boolean;
}

// Grava a entrada de anuncio do lead. Idempotente (mesma mensagem, mesmo clique) e NUNCA lanca. Chamar na PRIMEIRA mensagem (os metadados podem nao vir nas
// seguintes) e em qualquer mensagem que traga um referral novo.
export async function captureAdReferral(p: {
  clinicId: string;
  patientId: string;
  conversationId?: string | null;
  externalId?: string | null;
  referral?: AdReferral | null;
  receivedAt?: Date;
}): Promise<CaptureResult | null> {
  try {
    const r = p.referral;
    if (!isValidAdReferral(r)) return null;
    const externalId = p.externalId?.trim() || null;
    if (externalId) {
      const same = await prisma.adAttribution.findUnique({ where: { clinicId_messageExternalId: { clinicId: p.clinicId, messageExternalId: externalId } }, select: { id: true, entryKind: true } });
      if (same) return { id: same.id, entryKind: same.entryKind as CaptureResult["entryKind"], created: false }; // webhook reprocessado
    }

    const sourceId = clip(r.sourceId, 80);
    const ctwaClid = clip(r.ctwaClid, 400);
    const prev = await prisma.adAttribution.findFirst({ where: { patientId: p.patientId }, orderBy: { receivedAt: "desc" }, select: { id: true, sourceId: true, ctwaClid: true, receivedAt: true, entryKind: true } });
    // o mesmo clique chegando de novo (outra mensagem trazendo o mesmo referral) nao e entrada nova
    if (prev && ctwaClid && prev.ctwaClid === ctwaClid) return { id: prev.id, entryKind: prev.entryKind as CaptureResult["entryKind"], created: false };
    if (prev && !ctwaClid && sourceId && prev.sourceId === sourceId && Date.now() - prev.receivedAt.getTime() < 24 * 3_600_000) return { id: prev.id, entryKind: prev.entryKind as CaptureResult["entryKind"], created: false };

    const entryKind: CaptureResult["entryKind"] = !prev ? "first" : prev.sourceId && sourceId && prev.sourceId !== sourceId ? "new_ad" : "new_click";
    const cfg = await prisma.metaConfig.findUnique({ where: { clinicId: p.clinicId }, select: { wabaId: true } });
    let row;
    try {
      row = await prisma.adAttribution.create({
        data: {
          clinicId: p.clinicId,
          patientId: p.patientId,
          conversationId: p.conversationId ?? null,
          messageExternalId: externalId,
          receivedAt: p.receivedAt ?? new Date(),
          sourceId,
          sourceType: clip(r.sourceType, 40),
          ctwaClid,
          headline: clip(r.headline, 300),
          body: clip(r.body, 600),
          sourceUrl: clip(r.sourceUrl, 500),
          mediaType: clip(r.mediaType, 40),
          platform: platformFromUrl(r.sourceUrl),
          wabaId: cfg?.wabaId ?? null,
          rawKeys: clip(r.rawKeys, 300),
          entryKind,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return null; // corrida: outra gravacao da mesma mensagem ja entrou
      throw err;
    }
    if (sourceId) {
      await prisma.adCatalog.upsert({ where: { clinicId_sourceId: { clinicId: p.clinicId, sourceId } }, update: {}, create: { clinicId: p.clinicId, sourceId } });
      void resolveAdName(p.clinicId, sourceId).catch(() => {}); // nome do anuncio na Marketing API: melhor esforco, nunca bloqueia a mensagem
    }
    return { id: row.id, entryKind, created: true };
  } catch (err) {
    console.error("[anuncios] falha ao registrar a origem do lead:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nomes do anuncio, conjunto e campanha (Marketing API). O token da API de Conversoes pode nao ter permissao de leitura de anuncios (ads_read): nesse caso o
// ID fica guardado e o painel mostra "nome ainda nao identificado". Tentativas espacadas (6 h) e limitadas.
// ---------------------------------------------------------------------------

const NAME_RETRY_MS = 6 * 3_600_000;
const NAME_MAX_ATTEMPTS = 6;

export interface NameLookup {
  ok: boolean;
  adName?: string;
  adsetName?: string;
  campaignName?: string;
  error?: string;
  permanent?: boolean;
}

export async function fetchAdNames(token: string, graphVersion: string, sourceId: string): Promise<NameLookup> {
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(sourceId)}?fields=${encodeURIComponent("name,adset{name},campaign{name}")}&access_token=${encodeURIComponent(token)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `rede: ${err.name}` : "falha de rede" };
  }
  const body = (await res.json().catch(() => null)) as { name?: string; adset?: { name?: string }; campaign?: { name?: string }; error?: { code?: number; message?: string } } | null;
  if (res.ok && body && !body.error) {
    return { ok: true, adName: body.name, adsetName: body.adset?.name, campaignName: body.campaign?.name };
  }
  const code = body?.error?.code;
  // 10/200/190/100 = permissao/token/objeto: nao adianta insistir sem mudar a configuracao
  const permanent = res.status === 400 || res.status === 401 || res.status === 403 || code === 10 || code === 200 || code === 190 || code === 100;
  return { ok: false, permanent, error: `HTTP ${res.status}${code ? ` (code ${code})` : ""}: ${(body?.error?.message ?? "").slice(0, 160)}` };
}

export async function resolveAdName(clinicId: string, sourceId: string, opts: { force?: boolean } = {}): Promise<NameLookup | null> {
  const cfg = await prisma.metaConfig.findUnique({ where: { clinicId } });
  if (!cfg?.accessTokenEnc) return null; // sem token: fica "nome ainda nao identificado"
  const cat = await prisma.adCatalog.upsert({ where: { clinicId_sourceId: { clinicId, sourceId } }, update: {}, create: { clinicId, sourceId } });
  if (cat.status === "resolved" && !opts.force) return { ok: true, adName: cat.adName ?? undefined, adsetName: cat.adsetName ?? undefined, campaignName: cat.campaignName ?? undefined };
  if (!opts.force) {
    if (cat.attempts >= NAME_MAX_ATTEMPTS) return null;
    if (cat.checkedAt && Date.now() - cat.checkedAt.getTime() < NAME_RETRY_MS) return null;
  }
  let token: string;
  try {
    token = decryptSecret(cfg.accessTokenEnc);
  } catch {
    return null;
  }
  const r = await fetchAdNames(token, graphVersionOf(cfg), sourceId);
  await prisma.adCatalog.update({
    where: { id: cat.id },
    data: r.ok
      ? { status: "resolved", adName: r.adName ?? null, adsetName: r.adsetName ?? null, campaignName: r.campaignName ?? null, error: null, checkedAt: new Date(), attempts: { increment: 1 } }
      : { status: r.permanent ? "unavailable" : "pending", error: (r.error ?? "").slice(0, 300), checkedAt: new Date(), attempts: { increment: 1 } },
  });
  return r;
}

// Botao "Buscar nomes dos anuncios" e job horario: tenta de novo o que ficou sem nome.
export async function resolvePendingAdNames(clinicId: string | null, opts: { force?: boolean; limit?: number } = {}): Promise<{ tried: number; resolved: number; unavailable: number }> {
  const rows = await prisma.adCatalog.findMany({
    where: { ...(clinicId ? { clinicId } : {}), status: { not: "resolved" } },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
  let resolved = 0;
  let unavailable = 0;
  let tried = 0;
  for (const row of rows) {
    const r = await resolveAdName(row.clinicId, row.sourceId, { force: opts.force });
    if (!r) continue;
    tried++;
    if (r.ok) resolved++;
    else unavailable++;
  }
  return { tried, resolved, unavailable };
}

// Descricao pro painel: nome oficial quando existe; senao o titulo do anuncio (headline) e o ID, com o aviso de que o nome ainda nao foi identificado.
export function describeAd(a: { sourceId: string | null; headline: string | null }, cat: { adName: string | null; adsetName: string | null; campaignName: string | null; status: string } | null | undefined) {
  const nameKnown = !!cat?.adName;
  return {
    adId: a.sourceId,
    adName: cat?.adName ?? null,
    adsetName: cat?.adsetName ?? null,
    campaignName: cat?.campaignName ?? null,
    headline: a.headline,
    nameStatus: nameKnown ? ("identificado" as const) : cat?.status === "unavailable" ? ("indisponivel" as const) : ("pendente" as const),
    label: cat?.adName || a.headline || (a.sourceId ? `Anúncio ${a.sourceId}` : "Anúncio sem ID"),
    note: nameKnown ? null : "Nome do anúncio ainda não identificado (só o ID chegou do WhatsApp; a Marketing API não respondeu ou não está liberada).",
  };
}
