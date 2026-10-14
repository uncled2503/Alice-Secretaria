import { prisma } from "../db/client.js";
import { scheduleLocked } from "../jobs/lock.js";
import { ceRequest } from "./client.js";

// ---------------------------------------------------------------------------
// ANIVERSARIO dos pacientes/leads vindo do Clinica Experts (pedido da Lisboa, 14/10/2026): a Alice so dispara parabens para quem tem
// Patient.birthDate. O CE guarda a data de nascimento no cadastro do paciente; aqui ela e lida (so PREENCHE quando a Alice ainda nao tem,
// nunca sobrescreve o que a equipe digitou) e a automacao de aniversario passa a funcionar para a base inteira.
// O nome do campo na API do CE nao esta documentado aqui: aceitamos os nomes usuais e o relatorio mostra quais campos o CE devolveu.
// ---------------------------------------------------------------------------

const BIRTH_KEYS = ["birth_date", "birthdate", "birthday", "date_of_birth", "dob", "born_at", "birth", "data_nascimento", "nascimento", "aniversario", "birth_day"];

// PURO: data de nascimento em varios formatos -> Date (meia-noite UTC, so dia/mes importam) ou null se invalida/implausivel.
export function parseCeBirthDate(raw: unknown, now = new Date()): Date | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!text) return null;
  let y: number, m: number, d: number;
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  if (mm) [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) [d, m, y] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 1920 || y > now.getUTCFullYear()) return null; // "0001-01-01", "1900-01-01" e datas futuras sao lixo de cadastro
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 31/02 etc.
  return date;
}

// PURO: acha o campo de nascimento no objeto do paciente do CE.
export function birthFieldOf(obj: unknown): { key: string | null; raw: unknown } {
  if (!obj || typeof obj !== "object") return { key: null, raw: null };
  const rec = obj as Record<string, unknown>;
  for (const k of BIRTH_KEYS) if (rec[k] != null && rec[k] !== "") return { key: k, raw: rec[k] };
  const loose = Object.keys(rec).find((k) => /birth|nasc|anivers|^dob$/i.test(k) && rec[k] != null && rec[k] !== "");
  return loose ? { key: loose, raw: rec[loose] } : { key: null, raw: null };
}

// PURO: a mesma pessoa com o telefone com e sem o 9o digito cai na mesma chave (DDD + ultimos 8 digitos).
export function phoneKey(phone: string | null | undefined): string | null {
  let d = (phone ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length < 10) return null;
  return d.slice(0, 2) + d.slice(-8);
}

interface CePatient {
  uuid?: string;
  name?: string | null;
  phone?: string | null;
  [k: string]: unknown;
}

export interface BirthdaySyncResult {
  dryRun: boolean;
  read: number; // pacientes lidos no CE
  withBirth: number; // com data de nascimento valida
  invalidBirth: number; // tinham valor mas invalido/implausivel
  matched: number; // existem na Alice (por telefone ou vinculo)
  toFill: number; // a Alice ainda nao tinha a data (sao preenchidos)
  alreadyHad: number; // a Alice ja tinha (ficam como estao)
  notInAlice: number; // com data, mas ainda nao sao contatos da Alice
  fieldsSeen: string[]; // campos que o CE devolveu (para achar o nome certo se nada casar)
  birthKey: string | null;
  error?: string;
}

async function fetchCePatients(clinicId: string): Promise<CePatient[] | null> {
  const out: CePatient[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await ceRequest<{ data: CePatient[]; meta?: { last_page?: number } }>(clinicId, "/patients", { query: { per_page: 1000, page } });
    if (!res.ok) return null;
    out.push(...(res.data.data ?? []));
    if (!res.data.meta?.last_page || page >= res.data.meta.last_page) break;
  }
  return out;
}

// Le os pacientes do CE e preenche a data de nascimento dos contatos da Alice que ainda nao tem. dryRun so conta.
export async function syncBirthdaysFromCe(clinicId: string, opts: { dryRun: boolean }): Promise<BirthdaySyncResult> {
  const result: BirthdaySyncResult = { dryRun: opts.dryRun, read: 0, withBirth: 0, invalidBirth: 0, matched: 0, toFill: 0, alreadyHad: 0, notInAlice: 0, fieldsSeen: [], birthKey: null };
  const cePatients = await fetchCePatients(clinicId);
  if (!cePatients) return { ...result, error: "Nao consegui ler os pacientes do Clinica Experts (veja o erro na tela)." };
  result.read = cePatients.length;
  result.fieldsSeen = Object.keys(cePatients[0] ?? {});

  const mine = await prisma.patient.findMany({ where: { clinicId }, select: { id: true, phone: true, birthDate: true, ceUuid: true } });
  const byUuid = new Map(mine.filter((p) => p.ceUuid).map((p) => [p.ceUuid as string, p]));
  const byPhone = new Map<string, (typeof mine)[number]>();
  for (const p of mine) {
    const k = phoneKey(p.phone);
    if (k && !byPhone.has(k)) byPhone.set(k, p);
  }

  const updates: { id: string; birthDate: Date; ceUuid?: string }[] = [];
  const done = new Set<string>();
  for (const cp of cePatients) {
    const field = birthFieldOf(cp);
    if (field.key == null) continue;
    result.birthKey ??= field.key;
    const birth = parseCeBirthDate(field.raw);
    if (!birth) {
      result.invalidBirth++;
      continue;
    }
    result.withBirth++;
    const k = phoneKey(cp.phone);
    const mineP = (cp.uuid ? byUuid.get(cp.uuid) : undefined) ?? (k ? byPhone.get(k) : undefined);
    if (!mineP) {
      result.notInAlice++;
      continue;
    }
    if (done.has(mineP.id)) continue;
    done.add(mineP.id);
    result.matched++;
    if (mineP.birthDate) result.alreadyHad++;
    else {
      result.toFill++;
      updates.push({ id: mineP.id, birthDate: birth, ...(!mineP.ceUuid && cp.uuid ? { ceUuid: cp.uuid } : {}) });
    }
  }
  if (!opts.dryRun) {
    for (const u of updates) {
      // so preenche se continua vazio (a equipe pode ter digitado entre a leitura e agora)
      await prisma.patient.updateMany({ where: { id: u.id, birthDate: null }, data: { birthDate: u.birthDate, ...(u.ceUuid ? { ceUuid: u.ceUuid } : {}) } });
    }
  }
  return result;
}

// Todo dia as 5h30: preenche aniversarios novos (cadastros feitos no CE desde ontem).
export function startCeBirthdayJob(): void {
  scheduleLocked("aniversarios-clinica-experts", "30 5 * * *", async () => {
    const accounts = await prisma.clinicaExpertsAccount.findMany({ select: { clinicId: true } });
    for (const a of accounts) {
      try {
        const r = await syncBirthdaysFromCe(a.clinicId, { dryRun: false });
        if (r.error) console.error(`[clinicaexperts] aniversarios ${a.clinicId}: ${r.error}`);
        else if (r.toFill) console.log(`[clinicaexperts] aniversarios ${a.clinicId}: ${r.toFill} data(s) de nascimento preenchida(s)`);
      } catch (err) {
        console.error("[clinicaexperts] aniversarios:", err);
      }
    }
  });
}
