import { parsePhone } from "../uazapi/phone.js";
import { prisma } from "../db/client.js";
import { ceRequest, isUncertain, type CeErrorKind } from "./client.js";

// ---------------------------------------------------------------------------
// IDENTIDADE DO PACIENTE NO CLINICA EXPERTS (CE). Separa a PESSOA atendida do TELEFONE usado para falar com ela:
//  - telefone igual != pessoa igual (casal/familia dividem o numero); a pessoa e o uuid do CE (e o nome, para desempatar), nunca "os ultimos 8 digitos";
//  - busca que FALHOU nao e paciente inexistente: sem criar cadastro;
//  - varios candidatos sem desempate seguro = ambiguo: nao escolhe o primeiro;
//  - o uuid de um cadastro nunca e sobrescrito por outro (nem pela importacao de uma reserva de pessoa diferente com o mesmo telefone);
//  - a criacao no CE so acontece depois de uma busca BEM-SUCEDIDA sem candidatos, e uma criacao com resultado incerto e reconciliada pela busca (nunca repetida as cegas).
// ---------------------------------------------------------------------------

export const foldName = (s: string | null | undefined): string => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const fold = foldName;

// PURO: dois nomes podem ser da MESMA pessoa? So diz "nao" quando os dois existem e o primeiro nome DIFERE (apelido de uma palavra so, como "Mari" x "Mariana", e compativel).
export function namesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = foldName(a), y = foldName(b);
  if (!x || !y) return true;
  const fx = x.split(" ")[0], fy = y.split(" ")[0];
  if (fx === fy) return true;
  return (!x.includes(" ") || !y.includes(" ")) && (fx.startsWith(fy) || fy.startsWith(fx));
}

// PURO: telefone brasileiro -> { ddd, local } canonico (celular sempre com o 9o digito: DDD + 9 + 8 digitos). Sem DDD valido = null.
export function canonicalBrPhone(raw: string | null | undefined): { ddd: string; local: string } | null {
  // a leitura de telefone vive em UM lugar (uazapi/phone.ts); aqui so a forma {ddd, local} que o CE usa (celular sempre com o 9)
  const p = parsePhone(raw);
  if (!p.valid || (p.kind !== "br_mobile" && p.kind !== "br_landline")) return null;
  return { ddd: p.ddd!, local: p.kind === "br_mobile" && p.local!.length === 8 ? `9${p.local}` : p.local! };
}

// PURO: duas formas do MESMO numero (com/sem DDI, com/sem o 9o digito). Nunca por "ultimos 8 digitos": o DDD tambem precisa bater.
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalBrPhone(a), y = canonicalBrPhone(b);
  return !!x && !!y && x.ddd === y.ddd && x.local === y.local;
}

// PURO: formas a consultar no CE (o formato gravado la e desconhecido): com DDI, sem DDI e (celular) sem o 9o digito.
export function phoneQueryForms(raw: string | null | undefined): string[] {
  const c = canonicalBrPhone(raw);
  if (!c) return [];
  const forms = [`55${c.ddd}${c.local}`, `${c.ddd}${c.local}`];
  if (c.local.length === 9) forms.push(`55${c.ddd}${c.local.slice(1)}`);
  return forms;
}

export interface CeCandidate { uuid: string; name: string | null; phone: string | null; raw?: Record<string, unknown> }
export type PatientLookup =
  | { status: "found"; candidate: CeCandidate }
  | { status: "none" }
  | { status: "ambiguous"; candidates: CeCandidate[] }
  | { status: "error"; error: string; kind: CeErrorKind };

// PURO: escolhe entre candidatos que compartilham o telefone. Um so = ele; varios = o UNICO cujo nome completo bate; senao ambiguo.
export function pickCandidate(candidates: CeCandidate[], name: string | null | undefined): PatientLookup {
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length === 1) {
    // Um so cadastro com este telefone: e ele, A MENOS que os dois nomes sejam completos e de pessoas diferentes (marido na linha da esposa): telefone igual != pessoa igual.
    const c = candidates[0];
    const full = (n: string | null | undefined) => foldName(n).split(" ").filter(Boolean).length >= 2;
    if (full(name) && full(c.name) && !namesCompatible(name, c.name)) return { status: "none" };
    return { status: "found", candidate: c };
  }
  const wanted = fold(name ?? "");
  if (wanted.split(" ").length >= 2) {
    const exact = candidates.filter((c) => fold(c.name ?? "") === wanted);
    if (exact.length === 1) return { status: "found", candidate: exact[0] };
  }
  return { status: "ambiguous", candidates };
}

// Busca no CE os cadastros com este telefone. Falha em QUALQUER consulta (sem candidato ja encontrado) = "error", nunca "none".
export async function lookupCePatient(clinicId: string, subject: { phone: string; name?: string | null }): Promise<PatientLookup> {
  const forms = phoneQueryForms(subject.phone);
  if (!forms.length) return { status: "none" };
  const seen = new Map<string, CeCandidate>();
  let failure: { error: string; kind: CeErrorKind } | null = null;
  for (const form of forms) {
    const res = await ceRequest<{ data?: unknown }>(clinicId, "/patients", { query: { phone: form, per_page: 50 } });
    if (!res.ok) { failure = { error: res.error, kind: res.kind }; break; }
    const list = (res.data as { data?: unknown } | null)?.data;
    if (!Array.isArray(list)) { failure = { error: "resposta de /patients sem a lista `data`", kind: "invalid_response" }; break; }
    for (const p of list as Record<string, unknown>[]) {
      const uuid = typeof p.uuid === "string" ? p.uuid : null;
      const phone = typeof p.phone === "string" ? p.phone : null;
      if (uuid && samePhone(phone, subject.phone) && !seen.has(uuid)) seen.set(uuid, { uuid, name: typeof p.name === "string" ? p.name : null, phone, raw: p });
    }
    if (seen.size) break; // achou pela primeira forma que respondeu com candidatos: nao precisa tentar as outras
  }
  if (failure && seen.size === 0) return { status: "error", ...failure };
  return pickCandidate([...seen.values()], subject.name);
}

export interface EnsureResult { ok: boolean; uuid?: string; reason?: string; created?: boolean; ambiguous?: CeCandidate[]; uncertain?: boolean }

// Alguem JA usa este uuid do CE no cadastro local? (nunca ligar o mesmo uuid a duas pessoas locais)
async function uuidClaimedByOther(clinicId: string, uuid: string, self: { patientId?: string; attendeeId?: string }): Promise<boolean> {
  const p = await prisma.patient.findFirst({ where: { clinicId, ceUuid: uuid, ...(self.patientId ? { id: { not: self.patientId } } : {}) }, select: { id: true } });
  if (p) return true;
  const a = await prisma.attendee.findFirst({ where: { clinicId, ceUuid: uuid, ...(self.attendeeId ? { id: { not: self.attendeeId } } : {}) }, select: { id: true } });
  return !!a;
}

// Garante o uuid da PESSOA ATENDIDA no CE (paciente de WhatsApp ou acompanhante), sem criar duplicata e sem trocar de pessoa.
export async function ensureCePatient(
  clinicId: string,
  subject: { kind: "patient"; id: string; name: string | null; phone: string; ceUuid: string | null } | { kind: "attendee"; id: string; name: string; phone: string; ceUuid: string | null },
): Promise<EnsureResult> {
  if (subject.ceUuid) return { ok: true, uuid: subject.ceUuid };
  const self = subject.kind === "patient" ? { patientId: subject.id } : { attendeeId: subject.id };
  const save = async (uuid: string) => {
    if (await uuidClaimedByOther(clinicId, uuid, self)) return false;
    if (subject.kind === "patient") await prisma.patient.update({ where: { id: subject.id }, data: { ceUuid: uuid } });
    else await prisma.attendee.update({ where: { id: subject.id }, data: { ceUuid: uuid } });
    return true;
  };

  const found = await lookupCePatient(clinicId, { phone: subject.phone, name: subject.name });
  if (found.status === "found") {
    // O cadastro achado ja e de OUTRA pessoa local (mesmo telefone, outra pessoa): nao vincula.
    if (!(await save(found.candidate.uuid))) return { ok: false, reason: "o cadastro encontrado no Clinica Experts ja pertence a outra pessoa aqui (telefone compartilhado): confirme qual e a pessoa" };
    return { ok: true, uuid: found.candidate.uuid };
  }
  if (found.status === "ambiguous") return { ok: false, reason: `mais de um cadastro no Clinica Experts com este telefone (${found.candidates.length}) e o nome nao desempata: escolha o paciente la`, ambiguous: found.candidates };
  if (found.status === "error") return { ok: false, reason: `nao consegui consultar os pacientes do Clinica Experts (${found.error})` }; // busca que falhou NAO e paciente inexistente: nada e criado

  // Busca ok e SEM candidatos: so entao cria.
  const digits = (canonicalBrPhone(subject.phone) ? `55${canonicalBrPhone(subject.phone)!.ddd}${canonicalBrPhone(subject.phone)!.local}` : subject.phone.replace(/\D/g, ""));
  const created = await ceRequest<{ data?: { uuid?: string } }>(clinicId, "/patients", {
    method: "POST",
    body: { name: subject.name?.trim() || `Paciente ${digits}`, phone: `+${digits}`, origin: "Alice (WhatsApp)" },
  });
  if (created.ok) {
    const uuid = (created.data as { data?: { uuid?: string } } | null)?.data?.uuid;
    if (uuid && typeof uuid === "string") { await save(uuid); return { ok: true, uuid, created: true }; }
  }
  // Criacao sem confirmacao (rede, tempo esgotado, 5xx, resposta sem uuid): RECONCILIA pela busca antes de qualquer nova tentativa.
  if (created.ok || isUncertain(created)) {
    const again = await lookupCePatient(clinicId, { phone: subject.phone, name: subject.name });
    if (again.status === "found" && (await save(again.candidate.uuid))) return { ok: true, uuid: again.candidate.uuid, created: true };
    return { ok: false, uncertain: true, reason: "nao deu pra confirmar se o cadastro do paciente foi criado no Clinica Experts; nada foi recriado" };
  }
  return { ok: false, reason: `o Clinica Experts recusou o cadastro do paciente (${(created as { error: string }).error})` };
}
