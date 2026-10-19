import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// MODO DE EXECUCAO DAS RETOMADAS E DO CONVITE DE INDICACAO (19/10/2026): "normal" ou "restrito".
// Restrito = validacao controlada: so os contatos de teste autorizados (pacientes DESTA clinica), no maximo `testMaxSends` envios. Regras que nao admitem excecao:
//  - lista vazia, invalida, de outra clinica, ou limite ausente/invalido => NADA e enviado (nunca "sem lista = todos");
//  - qualquer valor de runMode que nao seja "normal" e tratado como restrito invalido => bloqueia (falha fechada);
//  - a checagem e refeita NA HORA do envio (checkResumeSend) e tambem dentro de sendText: vale para a rodada, para nova tentativa e para chamada direta.
// ---------------------------------------------------------------------------

export type RunMode = "normal" | "restrito";
export type GuardedFlow = "avaliacao_cancelada" | "avaliacao_sem_fechamento" | "indicacao";
export const GUARDED_FLOWS: GuardedFlow[] = ["avaliacao_cancelada", "avaliacao_sem_fechamento", "indicacao"];
export const MAX_TEST_SENDS = 20;
export const MAX_TEST_CONTACTS = 20;

export interface GuardFields {
  runMode: string;
  testPatientIds: string | null;
  testMaxSends: number | null;
  testStartedAt: Date | null;
}

export type Restriction =
  | { mode: "normal" }
  | { mode: "restrito"; valid: true; patientIds: string[]; maxSends: number; startedAt: Date }
  | { mode: "restrito"; valid: false; problem: string };

export function readRestriction(c: GuardFields | null | undefined): Restriction {
  if (!c || c.runMode === "normal") return { mode: "normal" };
  if (c.runMode !== "restrito") return { mode: "restrito", valid: false, problem: `modo de execucao desconhecido (${String(c.runMode).slice(0, 20)}): bloqueado por seguranca` };
  let ids: unknown;
  try { ids = c.testPatientIds ? JSON.parse(c.testPatientIds) : null; } catch { ids = null; }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string" && x.trim())) return { mode: "restrito", valid: false, problem: "lista de contatos de teste vazia ou invalida" };
  const unique = [...new Set(ids as string[])];
  if (unique.length > MAX_TEST_CONTACTS) return { mode: "restrito", valid: false, problem: `contatos de teste demais (maximo ${MAX_TEST_CONTACTS})` };
  const max = c.testMaxSends;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_TEST_SENDS) return { mode: "restrito", valid: false, problem: `limite de envios do teste ausente ou invalido (1 a ${MAX_TEST_SENDS})` };
  if (!c.testStartedAt) return { mode: "restrito", valid: false, problem: "inicio do teste nao registrado" };
  return { mode: "restrito", valid: true, patientIds: unique, maxSends: max, startedAt: c.testStartedAt };
}

export const modeOf = (r: Restriction): RunMode => (r.mode === "normal" ? "normal" : "restrito");

export async function guardFieldsOf(clinicId: string, flow: GuardedFlow): Promise<GuardFields | null> {
  return prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow } }, select: { runMode: true, testPatientIds: true, testMaxSends: true, testStartedAt: true } });
}

// Quantos envios o TESTE ja fez (so decisoes tomadas no modo restrito, desde o inicio do teste).
export async function testSendsSoFar(clinicId: string, flow: GuardedFlow, startedAt: Date, countReserved: boolean): Promise<number> {
  return prisma.followUpDispatch.count({
    where: { clinicId, flow, runMode: "restrito", decidedAt: { gte: startedAt }, state: { in: countReserved ? ["sent", "unconfirmed", "reserved"] : ["sent", "unconfirmed"] } },
  });
}

export interface SendPermit {
  allowed: boolean;
  mode: RunMode;
  code?: string;
  detail?: string;
}

const digits = (s: string) => s.replace(/\D/g, "");

// Pode enviar AGORA a esta pessoa? Le a configuracao do banco a cada chamada (nao confia em copia anterior).
// `flows`: os fluxos que podem estar por tras do envio; TODOS os que estiverem restritos precisam permitir.
export async function checkResumeSend(clinicId: string, flows: GuardedFlow[], target: { patientId?: string; phone?: string }, opts: { countReserved: boolean }): Promise<SendPermit> {
  let mode: RunMode = "normal";
  for (const flow of flows) {
    const r = readRestriction(await guardFieldsOf(clinicId, flow));
    if (r.mode === "normal") continue;
    mode = "restrito";
    if (!r.valid) return { allowed: false, mode, code: "restricao_invalida", detail: r.problem };
    // a pessoa precisa ser uma das autorizadas E pertencer a esta clinica (e o telefone, quando informado, ser o dela)
    const patient = target.patientId
      ? await prisma.patient.findFirst({ where: { id: target.patientId, clinicId }, select: { id: true, phone: true } })
      : target.phone
        ? await prisma.patient.findFirst({ where: { clinicId, phone: digits(target.phone), id: { in: r.patientIds } }, select: { id: true, phone: true } })
        : null;
    if (!patient || !r.patientIds.includes(patient.id)) return { allowed: false, mode, code: "fora_da_selecao_de_teste", detail: "a pessoa nao esta entre os contatos de teste autorizados" };
    if (target.phone && digits(target.phone) !== digits(patient.phone)) return { allowed: false, mode, code: "fora_da_selecao_de_teste", detail: "o telefone nao e o do contato autorizado" };
    const done = await testSendsSoFar(clinicId, flow, r.startedAt, opts.countReserved);
    if (done >= r.maxSends) return { allowed: false, mode, code: "limite_do_teste_atingido", detail: `o teste ja fez ${done} de ${r.maxSends} envios` };
  }
  return { allowed: true, mode };
}

// Resolve telefones autorizados em pacientes DA CLINICA (exatos). Nenhuma aproximacao: telefone sem paciente correspondente e erro (nada e criado nem adivinhado).
export async function resolveTestContacts(clinicId: string, phones: string[]): Promise<{ ok: true; patients: { id: string; name: string | null; phoneLast4: string }[] } | { ok: false; error: string }> {
  const wanted = [...new Set(phones.map(digits).filter(Boolean))];
  if (wanted.length === 0) return { ok: false, error: "informe pelo menos um telefone de contato de teste" };
  if (wanted.length > MAX_TEST_CONTACTS) return { ok: false, error: `contatos de teste demais (maximo ${MAX_TEST_CONTACTS})` };
  const rows = await prisma.patient.findMany({ where: { clinicId, phone: { in: wanted } }, select: { id: true, name: true, phone: true } });
  const missing = wanted.filter((w) => !rows.some((r) => r.phone === w));
  if (missing.length) return { ok: false, error: `sem paciente nesta clinica com o telefone final ${missing.map((m) => m.slice(-4)).join(", ")}: o contato de teste precisa ja existir (ele mesmo manda uma mensagem antes)` };
  return { ok: true, patients: rows.map((r) => ({ id: r.id, name: r.name, phoneLast4: r.phone.slice(-4) })) };
}
