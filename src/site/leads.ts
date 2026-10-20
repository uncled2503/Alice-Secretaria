import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { prisma } from "../db/client.js";
import { canonicalBrPhone } from "../clinicaexperts/identity.js";

// ---------------------------------------------------------------------------
// CAPTACAO DE LEADS DA LANDING (pedido de demonstracao). Publico, sem sessao. Protecoes: limite por IP (minuto e hora), campo isca (honeypot), checagem de origem, tamanho dos campos,
// validacao no servidor (telefone com DDD), prevencao de duplicata (um registro por telefone; reenvio so atualiza e conta). O IP nunca e guardado em texto aberto (so um HMAC curto,
// para limitar abuso). Nenhuma mensagem e disparada para o visitante: o contato e feito pela equipe. Destino: tabela SiteLead, listada para admin em GET /api/site-leads.
// ---------------------------------------------------------------------------

export const SEGMENT_IDS = [
  "estetica", "clinicas", "saude-bem-estar", "pet", "varejo", "casa", "tecnicos", "automotivo", "educacao", "profissionais", "imoveis", "eventos", "turismo", "alimentacao", "b2b", "financeiro", "outro",
] as const;
export const VOLUME_IDS = ["ate-100", "100-500", "500-2000", "mais-2000"] as const;

export interface LeadInput {
  name: string; phone: string; company: string; segment: string; volume: string | null;
  attribution: { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; utmContent: string | null; utmTerm: string | null; gclid: string | null; fbclid: string | null; referrer: string | null; landingPath: string | null };
}

const clean = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const orNull = (v: unknown, max: number): string | null => { const s = clean(v, max); return s || null; };

// PURO: valida o corpo e devolve os campos limpos ou os erros por campo (mensagens exibidas ao visitante).
export function validateLead(body: unknown): { ok: true; value: LeadInput; phoneKey: string; phone: string } | { ok: false; fields: Record<string, string> } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const name = clean(b.name, 120);
  if (name.length < 2 || !/\p{L}/u.test(name)) fields.name = "Informe seu nome.";
  const canon = canonicalBrPhone(clean(b.phone, 30));
  if (!canon) fields.phone = "Informe o WhatsApp com DDD, por exemplo (11) 91234-5678.";
  const company = clean(b.company, 120);
  if (company.length < 2) fields.company = "Informe o nome da empresa.";
  const segment = clean(b.segment, 40);
  if (!(SEGMENT_IDS as readonly string[]).includes(segment)) fields.segment = "Escolha o segmento mais próximo.";
  const volumeRaw = clean(b.volume, 20);
  const volume = volumeRaw && (VOLUME_IDS as readonly string[]).includes(volumeRaw) ? volumeRaw : null;
  if (Object.keys(fields).length || !canon) return { ok: false, fields };
  const a = (b.attribution && typeof b.attribution === "object" ? b.attribution : {}) as Record<string, unknown>;
  const phone = `55${canon.ddd}${canon.local}`;
  return {
    ok: true, phone, phoneKey: `${canon.ddd}${canon.local}`,
    value: {
      name, phone, company, segment, volume,
      attribution: {
        utmSource: orNull(a.utm_source, 120), utmMedium: orNull(a.utm_medium, 120), utmCampaign: orNull(a.utm_campaign, 160), utmContent: orNull(a.utm_content, 160), utmTerm: orNull(a.utm_term, 160),
        gclid: orNull(a.gclid, 200), fbclid: orNull(a.fbclid, 200), referrer: orNull(a.referrer, 300), landingPath: orNull(a.landing, 300),
      },
    },
  };
}

const ipHash = (ip: string): string => crypto.createHmac("sha256", process.env.SESSION_SECRET || "alice-site-lead").update(ip).digest("hex").slice(0, 16);

// PURO: a requisicao veio do proprio site? (sem Origin = ferramenta/servidor: aceita; com Origin de outro host = recusa)
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

const limiter = (windowMs: number, limit: number) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente." },
});

export const siteLeadRouter = Router();
siteLeadRouter.post("/lead", limiter(60_000, 6), limiter(3_600_000, 25), async (req: Request, res: Response) => {
  try {
    if (!sameOrigin(req.get("origin"), req.get("host"))) { res.status(403).json({ ok: false, error: "Origem não permitida." }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // campo isca: humano nao preenche. Responde como se tivesse dado certo, sem gravar nada (nao ha como o robo distinguir).
    if (clean(body.website, 200)) { res.json({ ok: true }); return; }
    const v = validateLead(body);
    if (!v.ok) { res.status(422).json({ ok: false, fields: v.fields }); return; }
    const hash = ipHash(req.ip ?? "");
    // teto por origem (alem do limite por IP): muitas pessoas DIFERENTES enviando do mesmo lugar em 1 h = abuso
    const recent = await prisma.siteLead.count({ where: { ipHash: hash, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (recent >= 15) { res.status(429).json({ ok: false, error: "Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente." }); return; }
    const a = v.value.attribution;
    const existing = await prisma.siteLead.findUnique({ where: { phoneKey: v.phoneKey } });
    if (existing) {
      // duplicata: nao cria outro; atualiza o que faltava e conta o reenvio
      await prisma.siteLead.update({
        where: { id: existing.id },
        data: {
          submissions: { increment: 1 }, lastSubmittedAt: new Date(),
          volume: existing.volume ?? v.value.volume,
          utmSource: existing.utmSource ?? a.utmSource, utmMedium: existing.utmMedium ?? a.utmMedium, utmCampaign: existing.utmCampaign ?? a.utmCampaign,
          utmContent: existing.utmContent ?? a.utmContent, utmTerm: existing.utmTerm ?? a.utmTerm, gclid: existing.gclid ?? a.gclid, fbclid: existing.fbclid ?? a.fbclid,
          referrer: existing.referrer ?? a.referrer, landingPath: existing.landingPath ?? a.landingPath,
        },
      });
      res.json({ ok: true });
      return;
    }
    try {
      await prisma.siteLead.create({
        data: {
          phoneKey: v.phoneKey, phone: v.phone, name: v.value.name, company: v.value.company, segment: v.value.segment, volume: v.value.volume,
          utmSource: a.utmSource, utmMedium: a.utmMedium, utmCampaign: a.utmCampaign, utmContent: a.utmContent, utmTerm: a.utmTerm, gclid: a.gclid, fbclid: a.fbclid,
          referrer: a.referrer, landingPath: a.landingPath, userAgent: clean(req.get("user-agent"), 200) || null, ipHash: hash,
        },
      });
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e; // duas requisicoes juntas do mesmo telefone: a outra venceu, e tudo certo
      await prisma.siteLead.update({ where: { phoneKey: v.phoneKey }, data: { submissions: { increment: 1 }, lastSubmittedAt: new Date() } }).catch(() => undefined);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[site] falha ao gravar lead:", err instanceof Error ? err.message : err);
    res.status(500).json({ ok: false, error: "Não foi possível enviar agora." }); // nunca "sucesso" sem ter gravado
  }
});
