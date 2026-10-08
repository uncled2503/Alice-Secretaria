import { prisma } from "../db/client.js";
import { LISBOA_SERVICOS, type LisboaServico } from "./lisboaServicosData.js";

// Aplica o catalogo de servicos da planilha da Lisboa nos procedimentos que a
// clinica JA TEM (os ~341 vindos do Clinica Experts). Regras:
//  - So mexe em procedimento cujo NOME bate com um servico da planilha.
//  - So PREENCHE campo vazio; nunca sobrescreve o que a clinica ja escreveu.
//  - Nao altera duracao, valor, preco variavel nem parcelamento (a planilha nao
//    trouxe valor; a duracao real e a do Clinica Experts).
//  - O resto dos procedimentos fica exatamente como esta.

export const normName = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Chaves de comparacao de um nome da planilha: o nome inteiro, sem o trecho entre
// parenteses e so o trecho entre parenteses (ex.: "Escleroterapia (Secagem de Vasinhos)").
export function nameKeys(name: string): string[] {
  const keys = new Set<string>([normName(name)]);
  const noParen = normName(name.replace(/\([^)]*\)/g, " "));
  if (noParen) keys.add(noParen);
  const inner = /\(([^)]*)\)/.exec(name)?.[1];
  if (inner && normName(inner)) keys.add(normName(inner));
  return [...keys];
}

type Field = "description" | "goals" | "benefits" | "aliases" | "resultTimeline" | "paymentMethods" | "pixKey";

export interface ServicoMatch {
  sheet: string;
  matches: { id: string; name: string; fill: Field[] }[];
  suggestions: string[]; // so quando nao casou: nomes parecidos pra conferir
}

export interface ServicosResult {
  dryRun: boolean;
  sheetTotal: number;
  matchedSheet: number; // servicos da planilha que casaram com algum procedimento
  proceduresTouched: number; // procedimentos que receberam pelo menos um campo
  proceduresUntouched: number; // todos os outros da clinica: ficam como estao
  fieldsFilled: Record<Field, number>;
  unmatched: { sheet: string; suggestions: string[] }[];
  detail: ServicoMatch[];
}

function isEmpty(v: string | null | undefined): boolean {
  return v == null || v.trim() === "";
}

export async function applyLisboaServicos(clinicId: string, opts: { dryRun: boolean; servicos?: LisboaServico[] }): Promise<ServicosResult> {
  const servicos = opts.servicos ?? LISBOA_SERVICOS;
  const procs = await prisma.procedure.findMany({ where: { clinicId } });

  const byKey = new Map<string, typeof procs>();
  for (const p of procs) {
    const k = normName(p.name);
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }

  const fieldsFilled: Record<Field, number> = { description: 0, goals: 0, benefits: 0, aliases: 0, resultTimeline: 0, paymentMethods: 0, pixKey: 0 };
  const detail: ServicoMatch[] = [];
  const unmatched: ServicosResult["unmatched"] = [];
  const touched = new Set<string>();
  const updates: { id: string; data: Record<string, string> }[] = [];
  const claimed = new Set<string>(); // procedimento ja atribuido a um servico (evita aplicar 2 textos no mesmo)

  for (const sv of servicos) {
    const found = new Map<string, (typeof procs)[number]>();
    for (const key of nameKeys(sv.name)) for (const p of byKey.get(key) ?? []) found.set(p.id, p);
    const matches: ServicoMatch["matches"] = [];

    for (const p of found.values()) {
      if (claimed.has(p.id)) continue; // o primeiro servico da planilha que casa fica com ele
      claimed.add(p.id);
      const data: Record<string, string> = {};
      const fill: Field[] = [];
      const want: Record<Field, string> = {
        description: sv.description,
        goals: sv.goals.join("\n"),
        benefits: sv.benefits.join("\n"),
        aliases: sv.aliases.join(", "),
        resultTimeline: sv.resultTimeline,
        paymentMethods: sv.paymentMethods.join(","),
        pixKey: sv.pixKey,
      };
      for (const f of Object.keys(want) as Field[]) {
        const current = p[f] as string | null;
        if (isEmpty(current) && !isEmpty(want[f])) {
          data[f] = want[f];
          fill.push(f);
          fieldsFilled[f]++;
        }
      }
      matches.push({ id: p.id, name: p.name, fill });
      if (fill.length) {
        touched.add(p.id);
        updates.push({ id: p.id, data });
      }
    }

    if (matches.length) {
      detail.push({ sheet: sv.name, matches, suggestions: [] });
    } else {
      const base = nameKeys(sv.name)[0];
      const suggestions = procs
        .filter((p) => {
          const k = normName(p.name);
          return k.length >= 5 && base.length >= 5 && (k.includes(base) || base.includes(k));
        })
        .slice(0, 3)
        .map((p) => p.name);
      unmatched.push({ sheet: sv.name, suggestions });
      detail.push({ sheet: sv.name, matches: [], suggestions });
    }
  }

  if (!opts.dryRun) {
    for (const u of updates) await prisma.procedure.update({ where: { id: u.id }, data: u.data });
  }

  return {
    dryRun: opts.dryRun,
    sheetTotal: servicos.length,
    matchedSheet: servicos.length - unmatched.length,
    proceduresTouched: touched.size,
    proceduresUntouched: procs.length - touched.size,
    fieldsFilled,
    unmatched,
    detail,
  };
}
