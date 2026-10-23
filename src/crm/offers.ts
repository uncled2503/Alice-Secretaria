import type { SpecialDate } from "@prisma/client";
import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import { isoDateInZone } from "../scheduling/time.js";
import { describeSplit, formatBRL, installmentPromptLine, maxInstallmentsFor, splitInstallments, type InstallmentPolicy } from "../commerce/installments.js";

// ---------------------------------------------------------------------------
// MOTOR DE OFERTAS / CAMPANHAS POR EMPRESA (lote 2, 22/10/2026). Evolui a "data especial" (SpecialDate) que ja existia - sem nova fonte de verdade:
//   - periodo de DIVULGACAO (promoteFrom..promoteUntil) x VALIDADE COMERCIAL (validUntil: ultimo dia em que a condicao pode ser fechada) x datas do SERVICO (startsOn..endsOn);
//   - itens com preco em centavos, pagamento (normal | so Pix), limite de parcelas da oferta e "nao parcelavel"; brindes/quantidade so se cadastrados;
//   - ORIGEM: todos | anuncio (a pessoa veio de anuncio, opcionalmente de anuncios especificos) | organico. Origem desconhecida/sem evidencia = sem a condicao restrita;
//   - modo de resposta: alice | equipe (a equipe atende: a Alice fica em silencio e passa para a equipe);
//   - versao + historico (SpecialDateRevision); aprovar exige cadastro completo e sem conflito com outra oferta aprovada do mesmo servico no mesmo periodo;
//   - a condicao combinada fica gravada na reserva (offerId/offerVersion/offerTerms): vencer depois NAO muda o que foi combinado; nada passa sozinho de um mes para o outro.
// ---------------------------------------------------------------------------
export interface OfferItem { servico: string; procedimento?: string | null; precoCentavos: number | null; pagamento?: "normal" | "pix"; parcelasMax?: number | null; parcelavel?: boolean; observacao?: string | null }
export type OfferRow = Pick<SpecialDate, "id" | "clinicId" | "kind" | "name" | "startsOn" | "endsOn" | "services" | "conditionText" | "status" | "version" | "promoteFrom" | "promoteUntil" | "validUntil" | "items" | "benefits" | "quantityLimit" | "audience" | "origin" | "adSourceIds" | "responseMode" | "approvedTexts">;

export function parseItems(raw: string | null | undefined): OfferItem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && typeof (x as OfferItem).servico === "string") as OfferItem[]) : [];
  } catch { return []; }
}

// PURO: as tres janelas de uma oferta (datas locais AAAA-MM-DD).
export function offerWindows(d: Pick<OfferRow, "startsOn" | "endsOn" | "promoteFrom" | "promoteUntil" | "validUntil">) {
  const valid = d.validUntil ?? d.endsOn ?? d.startsOn;
  return { promoteFrom: d.promoteFrom ?? d.startsOn, promoteUntil: d.promoteUntil ?? valid, validUntil: valid, serviceFrom: d.startsOn, serviceUntil: d.endsOn ?? d.startsOn };
}
export function isPromoting(d: OfferRow, today: string): boolean { const w = offerWindows(d); return d.status === "aprovada" && today >= w.promoteFrom && today <= w.promoteUntil; }
export function isCommerciallyValid(d: OfferRow, today: string): boolean { const w = offerWindows(d); return d.status === "aprovada" && today >= w.promoteFrom && today <= w.validUntil; }

// PURO: o que falta para a oferta poder ser aprovada (nada e presumido).
export function offerMissing(d: Pick<OfferRow, "kind" | "endsOn" | "conditionText" | "items" | "validUntil">): string[] {
  if (d.kind === "recesso") return d.endsOn ? [] : ["data de retorno do recesso (depende da clínica)"];
  const out: string[] = [];
  const items = parseItems(d.items);
  if (!items.length && !d.conditionText?.trim()) out.push("condição/valor vigente da campanha (depende da clínica)");
  for (const it of items) if (it.precoCentavos == null && !it.observacao?.trim()) out.push(`valor de "${it.servico}" (ou observação de que vale o valor cadastrado)`);
  if (!d.validUntil && !d.endsOn) out.push("validade (até quando vale a condição)");
  return out;
}

// PURO: conflito = outra oferta APROVADA com o mesmo servico, validade sobreposta e preco diferente.
export function offerConflicts(d: OfferRow, others: OfferRow[]): string[] {
  const out: string[] = [];
  const w = offerWindows(d);
  const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  for (const o of others) {
    if (o.id === d.id || o.status !== "aprovada" || o.kind !== "campanha") continue;
    const ow = offerWindows(o);
    if (ow.promoteFrom > w.validUntil || w.promoteFrom > ow.validUntil) continue;
    if (d.origin !== "todos" && o.origin !== "todos" && d.origin !== o.origin) continue; // anuncio x organico podem ter precos diferentes (nunca misturados na conversa)
    for (const a of parseItems(d.items)) for (const b of parseItems(o.items)) {
      if (norm(a.servico) !== norm(b.servico)) continue;
      if (a.precoCentavos !== b.precoCentavos || (a.pagamento ?? "normal") !== (b.pagamento ?? "normal") || (a.parcelasMax ?? null) !== (b.parcelasMax ?? null)) out.push(`"${a.servico}" já tem outra condição aprovada no mesmo período ("${o.name}" ${o.startsOn})`);
    }
  }
  return out;
}

// A pessoa e elegivel pela ORIGEM? anuncio = tem atribuicao de anuncio (dos anuncios da oferta, se listados) dentro da divulgacao; organico = nenhuma atribuicao de anuncio no periodo.
export interface OriginEvidence { adSourceIds: string[]; hasAd: boolean }
export async function originEvidence(clinicId: string, patientId: string | undefined, since: Date): Promise<OriginEvidence | null> {
  if (!patientId) return null;
  const rows = await prisma.adAttribution.findMany({ where: { clinicId, patientId, receivedAt: { gte: since } }, select: { sourceId: true } }).catch(() => null);
  if (!rows) return null;
  return { adSourceIds: rows.map((r) => r.sourceId).filter((x): x is string => !!x), hasAd: rows.length > 0 };
}
export function originAllows(d: Pick<OfferRow, "origin" | "adSourceIds">, ev: OriginEvidence | null): boolean {
  if (d.origin === "todos") return true;
  if (!ev) return false; // origem desconhecida: a condicao restrita nao e oferecida
  if (d.origin === "anuncio") {
    const list = (d.adSourceIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return list.length ? ev.adSourceIds.some((s) => list.includes(s)) : ev.hasAd;
  }
  if (d.origin === "organico") return !ev.hasAd;
  return false;
}

const policyOf = (c: { installmentMax: number | null; installmentMinCents: number | null }): InstallmentPolicy | null =>
  c.installmentMax != null && c.installmentMax >= 1 ? { maxInstallments: c.installmentMax, minInstallmentCents: c.installmentMinCents ?? 0 } : null;

// PURO: termos de UM item (o que a Alice pode dizer e o que fica gravado na reserva).
export function itemTerms(it: OfferItem, policy: InstallmentPolicy | null): string {
  if (it.precoCentavos == null) return `${it.servico}: ${it.observacao?.trim() || "sem valor especial cadastrado"} (use SOMENTE o valor cadastrado do procedimento; não crie condição)`;
  const price = formatBRL(it.precoCentavos);
  const pix = it.pagamento === "pix";
  let parc: string;
  if (pix) parc = "somente Pix, sem parcelamento";
  else if (it.parcelavel === false) parc = "não parcelável";
  else if (policy) parc = installmentPromptLine({ totalCents: it.precoCentavos, offerMax: it.parcelasMax ?? null }, policy);
  else parc = it.parcelasMax ? `até ${it.parcelasMax}x sem juros` : "parcelamento: só o cadastrado do procedimento";
  return `${it.servico}: ${price} (${parc})${it.observacao ? ` — ${it.observacao}` : ""}`;
}

// PURO: bloco do prompt com as ofertas/datas vigentes HOJE para ESTA pessoa.
export function offersPrompt(dates: OfferRow[], today: string, policy: InstallmentPolicy | null, ev: OriginEvidence | null): string {
  const lines: string[] = [];
  for (const d of dates) {
    if (d.status !== "aprovada") continue;
    if (d.kind === "recesso") {
      const last = d.endsOn;
      if (today < d.startsOn || (last && today > last)) continue;
      lines.push(`- RECESSO DA CLÍNICA em vigor desde ${d.startsOn.split("-").reverse().join("/")}${last ? ` até ${last.split("-").reverse().join("/")}` : " (a data de retorno NÃO foi informada: não invente; diga que a equipe informa)"}. Não prometa atendimento imediato nem ofereça horários dentro do recesso; não ofereça campanhas; registre o interesse da pessoa para o retorno (lista de espera) e passe para a equipe.`);
      continue;
    }
    if (!isPromoting(d, today)) continue;
    const w = offerWindows(d);
    const valid = isCommerciallyValid(d, today);
    if (!originAllows(d, ev)) continue; // origem diferente/desconhecida: a condicao NAO e citada (nunca misturar anuncio x organico)
    if (d.responseMode === "equipe") { lines.push(`- "${d.name}": campanha atendida pela EQUIPE. Não negocie nem informe condição; passe para a equipe.`); continue; }
    const items = parseItems(d.items);
    const terms = valid
      ? items.length
        ? `Condições APROVADAS (use SOMENTE estas, exatamente): ${items.map((it) => itemTerms(it, policy)).join("; ")}.`
        : d.conditionText?.trim()
          ? `Condição vigente informada pela clínica (use SOMENTE esta, sem acrescentar nada): ${d.conditionText.trim()}`
          : "A condição/valor desta data NÃO está cadastrada: NÃO cite preço, desconto, vaga, brinde nem prazo; diga que a equipe confirma a condição."
      : "A validade comercial desta condição TERMINOU: não ofereça mais a condição (só os valores normais do cadastro).";
    const extras = [
      d.benefits?.trim() ? `Brinde/benefício aprovado: ${d.benefits.trim()}.` : "Não há brinde cadastrado: não ofereça brinde.",
      d.quantityLimit != null ? `Quantidade limitada informada pela clínica: ${d.quantityLimit}.` : "Não fale em 'últimas vagas', 'vagas limitadas' ou estoque.",
      d.conditionText?.trim() && items.length ? `Orientação da clínica: ${d.conditionText.trim()}` : "",
    ].filter(Boolean).join(" ");
    const when = w.serviceFrom === w.serviceUntil ? w.serviceFrom.split("-").reverse().join("/") : `${w.serviceFrom.split("-").reverse().join("/")} a ${w.serviceUntil.split("-").reverse().join("/")}`;
    lines.push(`- "${d.name}" (atendimentos em ${when}; condição fechável até ${w.validUntil.split("-").reverse().join("/")})${d.services ? ` — serviços: ${d.services}` : ""}. ${terms} ${extras} Não prometa resultado nem número de sessões além do cadastrado; horários só pela agenda real. Não crie urgência além da validade.`);
  }
  return lines.length ? `\nDATAS ESPECIAIS, OFERTAS E RECESSO (só valem enquanto vigentes; nada além disto; nunca misture condições de campanhas diferentes):\n${lines.join("\n")}` : "";
}

export async function offersLine(clinicId: string, timezone: string, now = new Date(), patientId?: string): Promise<string> {
  const today = isoDateInZone(now, timezone || "America/Sao_Paulo");
  const [rows, clinic] = await Promise.all([
    prisma.specialDate.findMany({ where: { clinicId, status: "aprovada" }, orderBy: { startsOn: "asc" } }).catch(() => [] as SpecialDate[]),
    prisma.clinic.findUnique({ where: { id: clinicId }, select: { installmentMax: true, installmentMinCents: true } }).catch(() => null),
  ]);
  if (!rows.length) return "";
  const needsOrigin = rows.some((r) => r.origin !== "todos");
  const earliest = rows.reduce((m, r) => (offerWindows(r).promoteFrom < m ? offerWindows(r).promoteFrom : m), today);
  const ev = needsOrigin ? await originEvidence(clinicId, patientId, new Date(`${earliest}T00:00:00-03:00`)) : null;
  return offersPrompt(rows, today, clinic ? policyOf(clinic) : null, ev);
}

// Oferta em modo EQUIPE que se aplica a esta pessoa agora (veio de um anuncio listado na oferta, dentro da divulgacao): a Alice fica em silencio e passa para a equipe.
export async function teamOfferFor(clinicId: string, patientId: string, timezone: string, now = new Date()): Promise<OfferRow | null> {
  const today = isoDateInZone(now, timezone || "America/Sao_Paulo");
  const rows = await prisma.specialDate.findMany({ where: { clinicId, status: "aprovada", responseMode: "equipe", kind: "campanha" } }).catch(() => [] as SpecialDate[]);
  for (const d of rows) {
    if (!isPromoting(d, today)) continue;
    const list = (d.adSourceIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) continue; // sem anuncios listados nao ha como saber se a conversa e da campanha: nao silencia ninguem por suposicao
    const ev = await originEvidence(clinicId, patientId, new Date(`${offerWindows(d).promoteFrom}T00:00:00-03:00`));
    if (ev && ev.adSourceIds.some((s) => list.includes(s))) return d;
  }
  return null;
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
// PURO: o item da oferta que corresponde a um procedimento (pelo nome do procedimento indicado no item, ou pelo nome do servico).
export function itemForProcedure(items: OfferItem[], procedureName: string): OfferItem | null {
  const p = norm(procedureName);
  return items.find((it) => (it.procedimento && norm(it.procedimento) === p) || norm(it.servico) === p) ?? null;
}

// Grava na reserva a condicao comercial vigente e elegivel para o procedimento (uma vez; nunca sobrescreve o que ja foi combinado). Devolve os termos gravados.
export async function recordAgreedOffer(appointmentId: string, now = new Date()): Promise<string | null> {
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { id: true, clinicId: true, patientId: true, offerId: true, procedure: { select: { name: true } }, clinic: { select: { timezone: true, installmentMax: true, installmentMinCents: true } } } });
  if (!a || a.offerId) return null;
  const today = isoDateInZone(now, a.clinic.timezone || "America/Sao_Paulo");
  const rows = await prisma.specialDate.findMany({ where: { clinicId: a.clinicId, status: "aprovada", kind: "campanha", responseMode: "alice" } });
  for (const d of rows) {
    if (!isCommerciallyValid(d, today)) continue;
    const it = itemForProcedure(parseItems(d.items), a.procedure.name);
    if (!it || it.precoCentavos == null) continue;
    const ev = d.origin === "todos" ? null : await originEvidence(a.clinicId, a.patientId, new Date(`${offerWindows(d).promoteFrom}T00:00:00-03:00`));
    if (!originAllows(d, ev)) continue;
    const terms = `${d.name} (v${d.version}): ${itemTerms(it, policyOf(a.clinic))}`.slice(0, 600);
    const r = await prisma.appointment.updateMany({ where: { id: a.id, offerId: null }, data: { offerId: d.id, offerVersion: d.version, offerTerms: terms } });
    return r.count === 1 ? terms : null;
  }
  return null;
}

// Alteracao de uma oferta com historico: cada mudanca de conteudo de uma oferta JA APROVADA gera nova versao (a reserva guarda a versao combinada).
const SNAP_FIELDS = ["name", "kind", "startsOn", "endsOn", "services", "conditionText", "status", "promoteFrom", "promoteUntil", "validUntil", "items", "benefits", "quantityLimit", "audience", "origin", "adSourceIds", "responseMode", "approvedTexts"] as const;
export type OfferPatch = Partial<Pick<SpecialDate, (typeof SNAP_FIELDS)[number]>>;
export async function updateOffer(id: string, patch: OfferPatch, actor: string | null): Promise<{ ok: true; row: SpecialDate } | { ok: false; error: string; faltando?: string[]; conflitos?: string[] }> {
  const row = await prisma.specialDate.findUnique({ where: { id } });
  if (!row) return { ok: false, error: "Data não encontrada" };
  if (patch.items !== undefined && patch.items !== null) {
    try { const v = JSON.parse(patch.items); if (!Array.isArray(v)) throw new Error("x"); } catch { return { ok: false, error: "items deve ser um JSON array" }; }
  }
  const next = { ...row, ...patch } as SpecialDate;
  if (next.status === "aprovada") {
    const faltando = offerMissing(next);
    if (faltando.length) return { ok: false, error: "Cadastro incompleto: não pode ser aprovada", faltando };
    const others = await prisma.specialDate.findMany({ where: { clinicId: row.clinicId, status: "aprovada", id: { not: row.id } } });
    const conflitos = offerConflicts(next, others);
    if (conflitos.length) return { ok: false, error: "Conflito com outra condição aprovada", conflitos };
  }
  const changed = SNAP_FIELDS.some((k) => k !== "status" && patch[k] !== undefined && patch[k] !== (row as Record<string, unknown>)[k]);
  const bump = changed && row.status === "aprovada";
  const updated = await prisma.specialDate.update({ where: { id }, data: { ...patch, ...(bump ? { version: { increment: 1 } } : {}), ...(patch.status === "aprovada" && row.status !== "aprovada" ? { approvedBy: actor ?? "equipe" } : {}) } });
  await prisma.specialDateRevision.create({ data: { clinicId: row.clinicId, specialDateId: id, version: updated.version, snapshot: JSON.stringify(Object.fromEntries(SNAP_FIELDS.map((k) => [k, (updated as Record<string, unknown>)[k]]))), changedBy: actor } });
  await logActivity({ clinicId: row.clinicId, type: "automation_updated", area: "automacoes", title: `Oferta/data atualizada: ${row.name}`, description: `${patch.status && patch.status !== row.status ? `status ${row.status} → ${patch.status}; ` : ""}versão ${updated.version}${bump ? " (nova versão: reservas já combinadas mantêm a anterior)" : ""}`, actorName: actor }).catch(() => undefined);
  return { ok: true, row: updated };
}

// Recesso: reservas ATIVAS dentro do recesso (a clinica decide; nada e cancelado sozinho).
export async function recessConflicts(clinicId: string): Promise<{ recesso: string | null; reservas: { id: string; scheduledAt: string; paciente: string }[] }> {
  const r = await prisma.specialDate.findFirst({ where: { clinicId, kind: "recesso", status: { in: ["aprovada", "rascunho"] } }, orderBy: { startsOn: "desc" } });
  if (!r) return { recesso: null, reservas: [] };
  const start = new Date(`${r.startsOn}T00:00:00-03:00`);
  const end = r.endsOn ? new Date(`${r.endsOn}T23:59:59-03:00`) : null;
  const rows = await prisma.appointment.findMany({ where: { clinicId, status: "confirmed", scheduledAt: { gte: start, ...(end ? { lte: end } : {}) } }, select: { id: true, scheduledAt: true, patient: { select: { name: true } } }, orderBy: { scheduledAt: "asc" }, take: 500 });
  return { recesso: `${r.startsOn}${r.endsOn ? ` a ${r.endsOn}` : " (retorno não informado)"}`, reservas: rows.map((x) => ({ id: x.id, scheduledAt: x.scheduledAt.toISOString(), paciente: x.patient.name ?? "" })) };
}

// Cartao-presente: so com faixa cadastrada na oferta (pago -> credito); validade e restricoes so as cadastradas.
export function giftTierFor(items: OfferItem[], paidCents: number): { creditCents: number } | null {
  for (const it of items) {
    const m = /cr[eé]dito\s*(?:de)?\s*R?\$?\s*([\d.]+)(?:,(\d{2}))?/i.exec(it.observacao ?? "");
    if (it.precoCentavos === paidCents && m) return { creditCents: Number(m[1].replace(/\./g, "")) * 100 + Number(m[2] ?? 0) };
  }
  return null;
}
// Valores (em reais) que uma resposta pode citar por causa das ofertas vigentes e da politica de parcelamento: precos dos itens aprovados e cada parcela calculada
// (inclusive a parcela com ajuste de centavos), mais as parcelas dos procedimentos pela politica da clinica. Usado pela conferencia de numeros citados.
export async function approvedOfferNumbers(clinicId: string, timezone: string, now = new Date()): Promise<number[]> {
  const today = isoDateInZone(now, timezone || "America/Sao_Paulo");
  const [rows, clinic, procs] = await Promise.all([
    prisma.specialDate.findMany({ where: { clinicId, status: "aprovada", kind: "campanha" } }),
    prisma.clinic.findUnique({ where: { id: clinicId }, select: { installmentMax: true, installmentMinCents: true } }),
    prisma.procedure.findMany({ where: { clinicId, internalOnly: false, price: { not: null }, offerInstallments: true }, select: { price: true, maxInstallments: true } }),
  ]);
  const policy = clinic ? policyOf(clinic) : null;
  const out: number[] = [];
  const parcels = (totalCents: number, offerMax: number | null) => {
    if (!policy) return;
    const plan = maxInstallmentsFor({ totalCents, offerMax }, policy);
    for (let n = 2; n <= plan.max; n++) for (const c of splitInstallments({ totalCents, offerMax }, policy, n).parcels) out.push(c / 100);
  };
  for (const d of rows) {
    if (!isCommerciallyValid(d, today)) continue;
    for (const it of parseItems(d.items)) {
      if (it.precoCentavos == null) continue;
      out.push(it.precoCentavos / 100);
      if (it.pagamento !== "pix" && it.parcelavel !== false) parcels(it.precoCentavos, it.parcelasMax ?? null);
    }
  }
  for (const p of procs) parcels(Math.round((p.price ?? 0) * 100), p.maxInstallments ?? null);
  return [...new Set(out)];
}
export { maxInstallmentsFor, splitInstallments, describeSplit };
