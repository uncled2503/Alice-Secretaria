import { prisma } from "../db/client.js";
import { wallClockInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// TELEFONES DOS LEADS NO RELATORIO DIARIO (pedido da Lisboa, 19/10/2026). So vai para o destino interno que JA recebe o relatorio (Clinic.notifyPhone, evento "daily_report_phones"
// marcado nas notificacoes da clinica: nenhuma outra clinica muda). Regras:
//  - lead do dia = pessoa cujo primeiro contato (cadastro) caiu no dia da CLINICA; UMA linha por pessoa, mesmo com varias mensagens (o numero de mensagens aparece na linha);
//  - o telefone e o CADASTRADO: so formatado quando tem o formato brasileiro completo (55 + DDD + numero); formato fora do padrao aparece como esta cadastrado, marcado, sem completar nem corrigir;
//    sem telefone: "telefone nao cadastrado";
//  - a lista e COMPLETA: se passar do tamanho de uma mensagem, e dividida em partes numeradas (parte i/k), cada uma com o total;
//  - o texto leva dado pessoal: nunca vai para log tecnico nem para pagina publica (quem registra log usa maskPhone).
// ---------------------------------------------------------------------------

export interface DayLead {
  patientId: string;
  name: string | null;
  phone: string | null;
  messages: number; // mensagens da pessoa no periodo
  firstAt: Date;
  optedOut: boolean;
}

// PURO: so o final do numero, para log tecnico.
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d ? `...${d.slice(-4)}` : "(sem telefone)";
}

// PURO: telefone como cadastrado. Formato brasileiro completo vira "+55 (11) 99999-9999"; qualquer outro formato aparece como esta (so digitos), marcado. Vazio = null.
export function formatLeadPhone(raw: string | null | undefined): { text: string; standard: boolean } | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  const m = /^55(\d{2})(9?\d{4})(\d{4})$/.exec(d);
  if (m) return { text: `+55 (${m[1]}) ${m[2]}-${m[3]}`, standard: true };
  return { text: `${d} (formato fora do padrão, como cadastrado)`, standard: false };
}

export async function collectDayLeads(clinicId: string, from: Date, to: Date): Promise<DayLead[]> {
  const patients = await prisma.patient.findMany({
    where: { clinicId, createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, phone: true, createdAt: true, optedOut: true },
  });
  if (patients.length === 0) return [];
  const counts = await prisma.message.groupBy({
    by: ["conversationId"],
    where: { role: "user", createdAt: { gte: from, lt: to }, conversation: { patientId: { in: patients.map((p) => p.id) } } },
    _count: { _all: true },
  });
  const convs = await prisma.conversation.findMany({ where: { id: { in: counts.map((c) => c.conversationId) } }, select: { id: true, patientId: true } });
  const byConv = new Map(convs.map((c) => [c.id, c.patientId]));
  const perPatient = new Map<string, number>();
  for (const c of counts) {
    const pid = byConv.get(c.conversationId);
    if (pid) perPatient.set(pid, (perPatient.get(pid) ?? 0) + c._count._all);
  }
  // uma linha por pessoa (a consulta ja e por paciente; o Map garante que duas conversas da mesma pessoa somam em uma linha)
  const seen = new Set<string>();
  const out: DayLead[] = [];
  for (const p of patients) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ patientId: p.id, name: p.name?.trim() || null, phone: p.phone?.trim() || null, messages: perPatient.get(p.id) ?? 0, firstAt: p.createdAt, optedOut: p.optedOut });
  }
  return out;
}

// PURO: mensagens do relatorio (uma ou mais partes). A lista e sempre completa; cada parte cabe em `maxChars`.
export function buildLeadPhoneMessages(leads: DayLead[], opts: { dateLabel: string; timeZone: string; maxChars?: number }): string[] {
  const maxChars = opts.maxChars ?? 3200;
  const total = leads.length;
  const noPhone = leads.filter((l) => !formatLeadPhone(l.phone)).length;
  const hhmm = (d: Date) => { const w = wallClockInZone(d, opts.timeZone); return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };
  const lines = leads.map((l, i) => {
    const ph = formatLeadPhone(l.phone);
    const interactions = l.messages > 0 ? `${l.messages} mensagem(ns) hoje` : "sem mensagem hoje";
    return `${i + 1}. ${l.name ?? "Sem nome"} — ${ph ? ph.text : "telefone não cadastrado"} — ${interactions} · 1º contato ${hhmm(l.firstAt)}${l.optedOut ? " · pediu para não receber mensagens" : ""}`;
  });
  const intro = `Lista interna, não encaminhe. Uma linha por pessoa (várias mensagens da mesma pessoa contam em uma linha só).${noPhone ? ` Sem telefone cadastrado: ${noPhone}.` : ""}`;
  if (total === 0) return [`📞 *Leads do dia ${opts.dateLabel}* — nenhum lead novo hoje.`];

  // divide em partes sem passar do limite; a quantidade de partes precisa ser conhecida antes de montar os cabecalhos
  const bodyLimit = maxChars - 160; // folga para cabecalho e introducao
  const chunks: string[][] = [[]];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > bodyLimit && chunks.at(-1)!.length > 0) { chunks.push([]); size = 0; }
    chunks.at(-1)!.push(line);
    size += line.length + 1;
  }
  const k = chunks.length;
  return chunks.map((c, i) => {
    const header = `📞 *Leads do dia ${opts.dateLabel}* — ${total} lead(s)${k > 1 ? ` (parte ${i + 1}/${k})` : ""}`;
    return [header, intro, "", ...c].join("\n");
  });
}

export function leadPhoneReportEnabled(notifyEvents: string): boolean {
  return notifyEvents.split(",").map((e) => e.trim()).includes("daily_report_phones");
}
