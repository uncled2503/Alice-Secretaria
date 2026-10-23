import type { SpecialDate } from "@prisma/client";
import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import { offerMissing, offersLine, offersPrompt, type OfferItem } from "./offers.js";

// ---------------------------------------------------------------------------
// DATAS ESPECIAIS / CAMPANHAS / RECESSO. A Alice so conhece uma data APROVADA, so durante a vigencia e NUNCA inventa condicao, preco, desconto, vaga, texto promocional ou data de
// retorno: o que a clinica nao informou fica como DEPENDENCIA explicita (campo vazio) e o prompt diz isso a Alice. Passou da vigencia = a data deixa de ser citada.
// Desde o lote 2 (22/10) cada data e uma OFERTA estruturada (crm/offers.ts): itens com preco/pagamento/parcelas, divulgacao x validade, origem, modo de resposta e versoes.
// ---------------------------------------------------------------------------
export interface SpecialDateSeed {
  kind: "campanha" | "recesso";
  name: string;
  startsOn: string;
  endsOn?: string | null;
  services: string;
  items?: OfferItem[];
  conditionText?: string | null; // orientacao de conduta (nao e preco)
  responseMode?: "alice" | "equipe";
  notes?: string | null;
}

// Checklist de 22/10 (secao 14) - SUBSTITUIDO pelo calendario 2026 abaixo. Mantido so como dado historico (testes da mecanica generica).
export const LISBOA_DATAS_2026_ANTIGO: SpecialDateSeed[] = [
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

const exp47 = (servico: string, observacao: string): OfferItem => ({ servico, precoCentavos: 4700, pagamento: "normal", parcelavel: false, observacao });
const hipro = (limitPapada: number | null): OfferItem[] => [
  { servico: "HIPRO Papada", precoCentavos: 49700, pagamento: "normal", parcelasMax: limitPapada, parcelavel: true },
  { servico: "HIPRO Full Face", precoCentavos: 99700, pagamento: "normal", parcelasMax: 9, parcelavel: true },
  { servico: "HIPRO Full Face + Papada", precoCentavos: 139700, pagamento: "normal", parcelasMax: 10, parcelavel: true },
];

// CALENDARIO 2026 DA LISBOA (pedido de 22/10/2026; substitui o anterior). Somente o que foi informado: o que falta fica vazio e aparece como pendencia.
export const LISBOA_CALENDARIO_2026: SpecialDateSeed[] = [
  { kind: "campanha", name: "Ritual Mãos & Pés de Seda", startsOn: "2026-10-26", endsOn: "2026-10-31", services: "Ritual Mãos & Pés de Seda (30 min)", items: [exp47("Ritual Mãos & Pés de Seda", "experiência de 30 min; agendamento direto; não parcelável")] },
  { kind: "campanha", name: "Remoção de tatuagem, micropigmentação e Black Peel", startsOn: "2026-10-27", services: "Remoção de tatuagem; micropigmentação; Black Peel", items: [
    { servico: "Black Peel", precoCentavos: 8700, pagamento: "pix", parcelavel: false, observacao: "somente Pix" },
    { servico: "Remoção de tatuagem", precoCentavos: null, observacao: "somente o valor cadastrado do procedimento" },
    { servico: "Remoção de micropigmentação", precoCentavos: null, observacao: "somente o valor cadastrado do procedimento" },
  ] },
  { kind: "campanha", name: "Pernas Leves Express", startsOn: "2026-11-02", endsOn: "2026-11-07", services: "Pernas Leves Express", items: [exp47("Pernas Leves Express", "experiência; não parcelável")] },
  { kind: "campanha", name: "Relax Cabeça & Pescoço", startsOn: "2026-11-09", endsOn: "2026-11-14", services: "Relax Cabeça & Pescoço", items: [exp47("Relax Cabeça & Pescoço", "experiência; não parcelável")] },
  { kind: "campanha", name: "HIPRO Day", startsOn: "2026-11-10", services: "HIPRO", items: hipro(3) },
  { kind: "campanha", name: "Spa dos Pés Express", startsOn: "2026-11-16", endsOn: "2026-11-21", services: "Spa dos Pés Express", items: [exp47("Spa dos Pés Express", "experiência; não parcelável")] },
  { kind: "campanha", name: "VIP Week / Black November", startsOn: "2026-11-23", endsOn: "2026-11-28", services: "VIP Week / Black November", responseMode: "equipe", notes: "cada oferta precisa estar cadastrada por completo; respostas pela equipe (a Alice fica em silêncio nas conversas da campanha)" },
  { kind: "campanha", name: "Glow Colo & Pescoço", startsOn: "2026-11-23", endsOn: "2026-11-28", services: "Glow Colo & Pescoço", items: [exp47("Glow Colo & Pescoço", "experiência; não parcelável")] },
  { kind: "campanha", name: "Lavieen Day", startsOn: "2026-11-24", services: "Lavieen", items: [{ servico: "Lavieen 3 sessões", procedimento: "Lavieen", precoCentavos: 59700, pagamento: "normal", parcelasMax: 5, parcelavel: true, observacao: "3 sessões" }] },
  { kind: "campanha", name: "Remoção de tatuagem", startsOn: "2026-11-26", services: "Remoção de tatuagem", items: [{ servico: "Remoção de tatuagem", precoCentavos: null, observacao: "somente a condição cadastrada" }] },
  { kind: "campanha", name: "Bumbum Express / Corrente Russa", startsOn: "2026-11-30", endsOn: "2026-12-05", services: "Bumbum Express / Corrente Russa", items: [exp47("Bumbum Express / Corrente Russa", "experiência; não parcelável; não prometer volume")] },
  { kind: "campanha", name: "Barriguinha Leve", startsOn: "2026-12-07", endsOn: "2026-12-12", services: "Barriguinha Leve", items: [exp47("Barriguinha Leve", "experiência; não parcelável; não prometer perda de gordura")] },
  { kind: "campanha", name: "HIPRO Day", startsOn: "2026-12-08", services: "HIPRO (última data especial antes do recesso)", items: hipro(null) },
  { kind: "campanha", name: "Pés & Pernas Leves Pré-Festas", startsOn: "2026-12-14", endsOn: "2026-12-19", services: "Pés & Pernas Leves Pré-Festas", items: [exp47("Pés & Pernas Leves Pré-Festas", "experiência; não parcelável")] },
  { kind: "campanha", name: "Lavieen Day", startsOn: "2026-12-16", services: "Lavieen (última data especial de Lavieen antes do recesso)", notes: "somente a condição APROVADA para dezembro; a de novembro não passa sozinha (se for mantida: 3 sessões por R$ 597 em até 5x)" },
  { kind: "campanha", name: "Remoção de tatuagem + Black Peel", startsOn: "2026-12-17", services: "Remoção de tatuagem; Black Peel (última data especial do ano)", items: [
    { servico: "Remoção de tatuagem", precoCentavos: null, observacao: "somente a condição cadastrada vigente" },
    { servico: "Black Peel", precoCentavos: null, observacao: "somente a condição cadastrada vigente (o Pix de R$ 87 de outubro NÃO vale)" },
  ] },
  { kind: "campanha", name: "Agenda Pré-Festas", startsOn: "2026-11-01", endsOn: "2026-12-22", services: "Agenda Pré-Festas (novembro e dezembro)", conditionText: "Não é promoção de preço único. Pergunte a data do evento, o que a pessoa quer tratar e a região; não prometa resultado para a data.", notes: "período exato dentro de nov/dez a confirmar pela clínica" },
  { kind: "campanha", name: "Cartão-Presente de Natal", startsOn: "2026-11-01", services: "Cartão-Presente de Natal", items: [
    { servico: "Cartão-presente R$ 150", precoCentavos: 15000, pagamento: "normal", parcelavel: false, observacao: "crédito de R$ 200" },
    { servico: "Cartão-presente R$ 250", precoCentavos: 25000, pagamento: "normal", parcelavel: false, observacao: "crédito de R$ 350" },
    { servico: "Cartão-presente R$ 500", precoCentavos: 50000, pagamento: "normal", parcelavel: false, observacao: "crédito de R$ 700" },
  ], conditionText: "Comprador e presenteado são pessoas diferentes; registre os dois. O crédito é sobre o valor PAGO.", notes: "PENDENTE: período de venda, validade, regras de uso e restrições (startsOn é só a chave técnica até a clínica informar)" },
  { kind: "campanha", name: "Meu Projeto 2027", startsOn: "2026-12-18", endsOn: "2026-12-22", services: "Meu Projeto 2027", conditionText: "Colete nome, telefone, prioridade, procedimento de interesse e preferência de dia; registre na lista de espera. Não prometa condição para 2027." },
  { kind: "recesso", name: "Início do recesso", startsOn: "2026-12-23", services: "", notes: "retorno não informado; interessados vão para a lista de janeiro; reservas no período são alertadas, nunca canceladas sozinhas" },
];
export const LISBOA_DATAS_2026 = LISBOA_CALENDARIO_2026;

export interface SpecialDateLine { id: string | null; kind: string; name: string; startsOn: string; status: string; acao: "criar" | "manter" | "atualizar" | "substituir" | "divergente"; faltando: string[]; detalhe?: string }

const seedData = (s: SpecialDateSeed) => ({
  endsOn: s.endsOn ?? null, services: s.services, items: s.items ? JSON.stringify(s.items) : null, conditionText: s.conditionText ?? null,
  responseMode: s.responseMode ?? "alice", notes: s.notes ?? null,
});

// Prepara (cria como RASCUNHO, idempotente) o calendario: cria o que falta; ATUALIZA rascunho que mudou (com historico); marca como SUBSTITUIDA a data em rascunho que saiu do
// calendario; data APROVADA nunca e mexida (diverge = a clinica decide). Nao aprova nada e nao inventa nenhum campo.
export async function prepararDatasEspeciais(clinicId: string, opts: { dryRun?: boolean; actorName?: string | null; seeds?: SpecialDateSeed[]; substituirAusentes?: boolean } = {}): Promise<{ somentePrevia: boolean; linhas: SpecialDateLine[] }> {
  const dryRun = opts.dryRun !== false;
  const seeds = opts.seeds ?? LISBOA_CALENDARIO_2026;
  const linhas: SpecialDateLine[] = [];
  const existing = await prisma.specialDate.findMany({ where: { clinicId } });
  const keyOf = (x: { kind: string; name: string; startsOn: string }) => `${x.kind}|${x.name}|${x.startsOn}`;
  const seedKeys = new Set(seeds.map(keyOf));
  for (const s of seeds) {
    const ex = existing.find((e) => keyOf(e) === keyOf(s));
    const data = seedData(s);
    if (!ex) {
      let id: string | null = null;
      if (!dryRun) {
        const row = await prisma.specialDate.create({ data: { clinicId, kind: s.kind, name: s.name, startsOn: s.startsOn, status: "rascunho", ...data } });
        id = row.id;
        await prisma.specialDateRevision.create({ data: { clinicId, specialDateId: row.id, version: row.version, snapshot: JSON.stringify({ origem: "calendario", ...s }), changedBy: opts.actorName ?? null } });
      }
      linhas.push({ id, kind: s.kind, name: s.name, startsOn: s.startsOn, status: "rascunho", acao: "criar", faltando: offerMissing({ kind: s.kind, endsOn: data.endsOn, conditionText: data.conditionText, items: data.items, validUntil: null }) });
      continue;
    }
    const differs = (Object.keys(data) as (keyof typeof data)[]).some((k) => (ex as Record<string, unknown>)[k] !== data[k] && !(data[k] == null && (ex as Record<string, unknown>)[k] == null) && !(k === "services" && !s.services));
    if (!differs) { linhas.push({ id: ex.id, kind: s.kind, name: s.name, startsOn: s.startsOn, status: ex.status, acao: "manter", faltando: offerMissing(ex) }); continue; }
    if (ex.status !== "rascunho") { linhas.push({ id: ex.id, kind: s.kind, name: s.name, startsOn: s.startsOn, status: ex.status, acao: "divergente", faltando: offerMissing(ex), detalhe: "já aprovada/encerrada com conteúdo diferente do calendário: não é alterada sozinha (a clínica decide)" }); continue; }
    if (!dryRun) {
      const row = await prisma.specialDate.update({ where: { id: ex.id }, data });
      await prisma.specialDateRevision.create({ data: { clinicId, specialDateId: ex.id, version: row.version, snapshot: JSON.stringify({ origem: "calendario_atualizado", ...s }), changedBy: opts.actorName ?? null } });
    }
    linhas.push({ id: ex.id, kind: s.kind, name: s.name, startsOn: s.startsOn, status: "rascunho", acao: "atualizar", faltando: offerMissing({ ...ex, ...data }) });
  }
  if (opts.substituirAusentes !== false && !opts.seeds) {
    for (const ex of existing.filter((e) => !seedKeys.has(keyOf(e)) && e.status !== "substituida")) {
      if (ex.status !== "rascunho") { linhas.push({ id: ex.id, kind: ex.kind, name: ex.name, startsOn: ex.startsOn, status: ex.status, acao: "divergente", faltando: [], detalhe: "fora do calendário novo, mas já aprovada/encerrada: não é alterada sozinha (a clínica decide)" }); continue; }
      const sub = seeds.find((s) => s.kind === ex.kind && s.name.startsWith(ex.name.split(" ")[0]) && s.startsOn.slice(0, 7) === ex.startsOn.slice(0, 7));
      if (!dryRun) await prisma.specialDate.update({ where: { id: ex.id }, data: { status: "substituida", notes: `${ex.notes ? `${ex.notes} | ` : ""}substituída pelo calendário 2026 (22/10)${sub ? `: agora ${sub.name} em ${sub.startsOn}` : ""}` } });
      linhas.push({ id: ex.id, kind: ex.kind, name: ex.name, startsOn: ex.startsOn, status: "substituida", acao: "substituir", faltando: [], detalhe: sub ? `substituída por ${sub.name} em ${sub.startsOn}` : "não consta no calendário novo" });
    }
  }
  if (!dryRun && linhas.some((l) => l.acao !== "manter" && l.acao !== "divergente")) {
    const n = (a: string) => linhas.filter((l) => l.acao === a).length;
    await logActivity({ clinicId, type: "automation_updated", area: "automacoes", title: "Calendário de datas especiais preparado (rascunho)", description: `${n("criar")} criada(s), ${n("atualizar")} atualizada(s), ${n("substituir")} substituída(s); nada aprovado. Pendências da clínica aparecem em cada data.`, actorName: opts.actorName ?? null }).catch(() => undefined);
  }
  return { somentePrevia: dryRun, linhas };
}

// PURO (compatibilidade): o que a Alice sabe HOJE (so datas aprovadas, so dentro da vigencia), sem politica de parcelamento nem evidencia de origem.
export function specialDatesPrompt(dates: Pick<SpecialDate, "kind" | "name" | "startsOn" | "endsOn" | "services" | "conditionText" | "status">[], today: string): string {
  return offersPrompt(dates.map((d, i) => ({ id: `d${i}`, clinicId: "", version: 1, promoteFrom: null, promoteUntil: null, validUntil: null, items: null, benefits: null, quantityLimit: null, audience: null, origin: "todos", adSourceIds: null, responseMode: "alice", approvedTexts: null, ...d })), today, null, null);
}

export async function specialDatesLine(clinicId: string, timezone: string, now = new Date(), patientId?: string): Promise<string> {
  return offersLine(clinicId, timezone, now, patientId);
}
