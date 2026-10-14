import { prisma } from "../db/client.js";
import { ceRequest } from "./client.js";
import { isInternalProcedure } from "./sync.js";
import { procKey } from "./procKey.js";

// ---------------------------------------------------------------------------
// PROCEDIMENTO SEM VINCULO (alerta "N agendamento(s) do Clinica Experts NAO vao receber a confirmacao"): a reserva e de um
// procedimento que ainda nao existe no cadastro da Alice (criado no CE depois do ultimo "Sincronizar catalogo", ou item
// interno como "Retoque"/"Cortesia", que o catalogo nunca importa). Sem procedimento a reserva era descartada e a pessoa
// ficava sem confirmacao. Agora a importacao cria/vincula so o que falta:
//  - procedimento vendavel: entra no cadastro normal (como o "Sincronizar catalogo" faria);
//  - item interno ou arquivado no CE: entra como `internalOnly` (a Alice nao oferece nem agenda, mas a reserva importada
//    recebe a confirmacao);
//  - item que e so etiqueta de origem (Lead, Instagram, Indicacao...): nao e procedimento, continua sem importar.
// ---------------------------------------------------------------------------

export interface CeProcedure {
  id: number;
  name: string;
  duration: number;
  price: number;
  active: boolean;
}

const TAG_LIKE_RE = /\blead\b|indica[cç][aã]o|instagram|plataforma|ficha|^\s*nada\s*$/i;

// PURO: o que fazer com um procedimento do CE que nao existe aqui.
export function planProcedure(cp: Pick<CeProcedure, "name" | "active">): "normal" | "internal" | "skip" {
  if (TAG_LIKE_RE.test(cp.name)) return "skip";
  if (!cp.active || isInternalProcedure(cp.name)) return "internal";
  return "normal";
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

const cache = new Map<string, { at: number; procs: CeProcedure[] }>();

export async function listCeProcedures(clinicId: string): Promise<CeProcedure[] | null> {
  const hit = cache.get(clinicId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.procs;
  const out: CeProcedure[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await ceRequest<{ data: CeProcedure[]; meta?: { last_page?: number } }>(clinicId, "/procedures", { query: { per_page: 1000, page } });
    if (!res.ok) return null;
    out.push(...(res.data.data ?? []));
    if (!res.data.meta?.last_page || page >= res.data.meta.last_page) break;
  }
  cache.set(clinicId, { at: Date.now(), procs: out });
  return out;
}

export interface LinkResult {
  created: number;
  internal: number;
  linked: number;
  names: Map<number, string>; // id do CE -> nome (os que o CE devolveu)
}

// Cria/vincula, no cadastro da Alice, os procedimentos do CE que as reservas novas usam e que ainda nao existem aqui.
export async function linkMissingProcedures(clinicId: string, ceIds: number[], ceProcs: CeProcedure[]): Promise<LinkResult> {
  const result: LinkResult = { created: 0, internal: 0, linked: 0, names: new Map(ceProcs.map((p) => [p.id, p.name])) };
  const existing = await prisma.procedure.findMany({ where: { clinicId }, select: { id: true, name: true, ceId: true } });
  for (const id of new Set(ceIds)) {
    const cp = ceProcs.find((p) => p.id === id);
    if (!cp || existing.some((a) => a.ceId === id)) continue;

    const sameName = existing.find((a) => a.ceId == null && procKey(a.name) === procKey(cp.name));
    if (sameName) {
      await prisma.procedure.update({ where: { id: sameName.id }, data: { ceId: id } });
      sameName.ceId = id;
      result.linked++;
      continue;
    }

    const kind = planProcedure(cp);
    if (kind === "skip") continue;
    // Mesmos campos do "Sincronizar catalogo": a "Avaliacao" e gratuita (preco 0 nao e "depende de avaliacao").
    const isFreeEvaluation = /^avalia/.test(norm(cp.name)) && cp.price <= 0;
    const reais = isFreeEvaluation ? 0 : cp.price > 0 ? Math.round(cp.price) / 100 : null; // a API manda em centavos
    const created = await prisma.procedure.create({
      data: {
        clinicId,
        name: cp.name,
        ceId: id,
        durationMin: cp.duration > 0 ? cp.duration : 30,
        price: kind === "internal" ? null : reais,
        priceVariable: kind === "internal" ? true : reais == null,
        aliases: isFreeEvaluation ? "avaliação gratuita, avaliação estética, avaliação" : null,
        description: isFreeEvaluation ? "Avaliação estética personalizada e gratuita para entender a queixa, os objetivos e traçar as possibilidades de tratamento." : null,
        offerInstallments: false,
        paymentMethods: "",
        internalOnly: kind === "internal",
      },
    });
    existing.push({ id: created.id, name: created.name, ceId: id });
    if (kind === "internal") result.internal++;
    else result.created++;
  }
  return result;
}
