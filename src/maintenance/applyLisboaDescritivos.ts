import { prisma } from "../db/client.js";
import { normName } from "./applyLisboaServicos.js";
import { DESCRITIVOS, PENDENTES_VALIDACAO, descricaoFinal } from "./lisboaDescritivosData.js";

// Aplica os descritivos comerciais (material do MKT, 14/10/2026) nos procedimentos que a Lisboa JA tem.
//  - Casamento so por NOME IGUAL (sem acento, maiusculas nem pontuacao): "Criolipolise Abdomen (2 placas)" nao pega o
//    procedimento "Criolipolise Abdomen" de outro numero de placas.
//  - So PREENCHE descricao VAZIA; nunca sobrescreve o que a clinica ja escreveu. Nao mexe em duracao, valor nem em mais nada.
//  - Procedimento interno (internalOnly) nao recebe: a Alice nao o oferece.
export interface DescritivosResult {
  dryRun: boolean;
  total: number; // descritivos do documento carregados
  matched: number; // casaram com algum procedimento
  filled: number; // procedimentos que receberam descricao
  alreadyFilled: number; // casaram mas ja tinham descricao (ficam como estao)
  unmatched: string[]; // do documento, sem procedimento com esse nome
  pending: string[]; // nao carregados: o documento pede validacao da equipe
}

export async function applyLisboaDescritivos(clinicId: string, opts: { dryRun: boolean }): Promise<DescritivosResult> {
  const procs = await prisma.procedure.findMany({ where: { clinicId, internalOnly: false }, select: { id: true, name: true, description: true } });
  const byKey = new Map<string, typeof procs>();
  for (const p of procs) byKey.set(normName(p.name), [...(byKey.get(normName(p.name)) ?? []), p]);

  const claimed = new Set<string>();
  const updates: { id: string; description: string }[] = [];
  const unmatched: string[] = [];
  let matched = 0;
  let alreadyFilled = 0;
  for (const d of DESCRITIVOS) {
    const found = (byKey.get(normName(d.name)) ?? []).filter((p) => !claimed.has(p.id));
    if (!found.length) {
      unmatched.push(d.name);
      continue;
    }
    matched++;
    for (const p of found) {
      claimed.add(p.id);
      if ((p.description ?? "").trim()) alreadyFilled++;
      else updates.push({ id: p.id, description: descricaoFinal(d) });
    }
  }
  if (!opts.dryRun) for (const u of updates) await prisma.procedure.update({ where: { id: u.id }, data: { description: u.description } });
  return { dryRun: opts.dryRun, total: DESCRITIVOS.length, matched, filled: updates.length, alreadyFilled, unmatched, pending: PENDENTES_VALIDACAO };
}
