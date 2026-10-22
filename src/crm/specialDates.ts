import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import { isoDateInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// DATAS ESPECIAIS / CAMPANHAS / RECESSO (checklist 22/10, secao 14). A Alice so conhece uma data APROVADA, so durante a vigencia e NUNCA inventa condicao, preco, desconto, vaga, texto
// promocional ou data de retorno: o que a clinica nao informou fica como DEPENDENCIA explicita (campo vazio) e o prompt diz isso a Alice. Passou da vigencia = a data simplesmente
// deixa de ser citada (nada de urgencia de campanha vencida).
// ---------------------------------------------------------------------------
export interface SpecialDateSeed { kind: "campanha" | "recesso"; name: string; startsOn: string; services: string }

// Datas e servicos extraidos do checklist de 22/10/2026 (secao 14). Nada alem disso.
export const LISBOA_DATAS_2026: SpecialDateSeed[] = [
  { kind: "campanha", name: "HIPRO Day", startsOn: "2026-10-22", services: "HIPRO" },
  { kind: "campanha", name: "Remoção de tatuagem, micropigmentação e Black Peel", startsOn: "2026-10-27", services: "Remoção de tatuagem; micropigmentação; Black Peel" },
  { kind: "campanha", name: "HIPRO Day", startsOn: "2026-11-10", services: "HIPRO" },
  { kind: "campanha", name: "Lavieen Day", startsOn: "2026-11-17", services: "Lavieen" },
  { kind: "campanha", name: "Remoção de tatuagem", startsOn: "2026-11-24", services: "Remoção de tatuagem" },
  { kind: "campanha", name: "HIPRO Day", startsOn: "2026-12-08", services: "HIPRO (última data especial antes do recesso)" },
  { kind: "campanha", name: "Lavieen Day", startsOn: "2026-12-16", services: "Lavieen (última data especial de Lavieen antes do recesso)" },
  { kind: "campanha", name: "Remoção de tatuagem + Black Peel", startsOn: "2026-12-17", services: "Remoção de tatuagem; Black Peel (última data especial do ano)" },
  { kind: "recesso", name: "Início do recesso", startsOn: "2026-12-23", services: "" },
];

export interface SpecialDateLine { id: string | null; kind: string; name: string; startsOn: string; status: string; acao: "criar" | "manter"; faltando: string[] }

function missingFields(d: { kind: string; endsOn: string | null; conditionText: string | null }): string[] {
  if (d.kind === "recesso") return d.endsOn ? [] : ["data de retorno do recesso (depende da clínica)"];
  const out: string[] = [];
  if (!d.conditionText?.trim()) out.push("condição/valor vigente da campanha (depende da clínica)");
  if (!d.endsOn) out.push("validade (até quando vale a condição)");
  return out;
}

// Prepara (cria como RASCUNHO, idempotente) as datas do checklist. Nao aprova, nao inventa nenhum campo.
export async function prepararDatasEspeciais(clinicId: string, opts: { dryRun?: boolean; actorName?: string | null; seeds?: SpecialDateSeed[] } = {}): Promise<{ somentePrevia: boolean; linhas: SpecialDateLine[] }> {
  const dryRun = opts.dryRun !== false;
  const linhas: SpecialDateLine[] = [];
  for (const s of opts.seeds ?? LISBOA_DATAS_2026) {
    const ex = await prisma.specialDate.findUnique({ where: { clinicId_kind_name_startsOn: { clinicId, kind: s.kind, name: s.name, startsOn: s.startsOn } } });
    if (ex) { linhas.push({ id: ex.id, kind: s.kind, name: s.name, startsOn: s.startsOn, status: ex.status, acao: "manter", faltando: missingFields(ex) }); continue; }
    let id: string | null = null;
    if (!dryRun) id = (await prisma.specialDate.create({ data: { clinicId, kind: s.kind, name: s.name, startsOn: s.startsOn, services: s.services, status: "rascunho" } })).id;
    linhas.push({ id, kind: s.kind, name: s.name, startsOn: s.startsOn, status: "rascunho", acao: "criar", faltando: missingFields({ kind: s.kind, endsOn: null, conditionText: null }) });
  }
  if (!dryRun && linhas.some((l) => l.acao === "criar")) await logActivity({ clinicId, type: "automation_updated", area: "automacoes", title: "Datas especiais e recesso preparados (rascunho)", description: `${linhas.filter((l) => l.acao === "criar").length} data(s) criada(s) como rascunho, sem condição, sem validade e sem retorno do recesso: a clínica precisa informar.`, actorName: opts.actorName ?? null });
  return { somentePrevia: dryRun, linhas };
}

// PURO: o que a Alice sabe HOJE (so datas aprovadas, so dentro da vigencia). Devolve "" quando nao ha nada vigente.
export function specialDatesPrompt(dates: { kind: string; name: string; startsOn: string; endsOn: string | null; services: string; conditionText: string | null; status: string }[], today: string): string {
  const lines: string[] = [];
  for (const d of dates) {
    if (d.status !== "aprovada") continue;
    if (d.kind === "campanha") {
      const last = d.endsOn ?? d.startsOn; // sem validade informada: vale so no proprio dia
      if (today < d.startsOn || today > last) continue; // fora da vigencia (inclui "campanha vencida")
      const cond = d.conditionText?.trim()
        ? `Condição vigente informada pela clínica (use SOMENTE esta, sem acrescentar nada): ${d.conditionText.trim()}`
        : "A condição/valor desta data NÃO está cadastrada: NÃO cite preço, desconto, vaga, brinde nem prazo; diga que a equipe confirma a condição e siga o fluxo normal (entender a necessidade, avaliação quando fizer sentido).";
      lines.push(`- HOJE É A DATA ESPECIAL "${d.name}"${d.services ? ` (serviços: ${d.services})` : ""}. ${cond} Não prometa resultado nem número de sessões; confirme horários só pela agenda real. Não crie urgência além da vigência (${last.split("-").reverse().join("/")}).`);
    } else if (d.kind === "recesso") {
      const last = d.endsOn;
      if (today < d.startsOn || (last && today > last)) continue;
      lines.push(`- RECESSO DA CLÍNICA em vigor desde ${d.startsOn.split("-").reverse().join("/")}${last ? ` até ${last.split("-").reverse().join("/")}` : " (a data de retorno NÃO foi informada: não invente; diga que a equipe informa)"}. Não prometa atendimento imediato nem ofereça horários dentro do recesso; registre o interesse da pessoa para o retorno e passe para a equipe.`);
    }
  }
  return lines.length ? `\nDATAS ESPECIAIS E RECESSO (só valem enquanto vigentes; nada além disto):\n${lines.join("\n")}` : "";
}

export async function specialDatesLine(clinicId: string, timezone: string, now = new Date()): Promise<string> {
  const today = isoDateInZone(now, timezone || "America/Sao_Paulo");
  const rows = await prisma.specialDate.findMany({ where: { clinicId, status: "aprovada", startsOn: { lte: today } }, orderBy: { startsOn: "asc" } }).catch(() => []);
  return specialDatesPrompt(rows, today);
}
