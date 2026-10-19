import { prisma } from "../db/client.js";
import { REVISION } from "../version.js";

// ---------------------------------------------------------------------------
// DIAGNOSTICO DAS AUTOMACOES: cada rodada de um job grava UMA linha por clinica (AutomationRun) com o que viu e o que fez. Assim, "o recontato nao
// saiu" deixa de ser um palpite: da pra distinguir "o job nao rodou" de "rodou sem candidatas", "todas foram excluidas (por que)", "a IA barrou" e
// "o provedor falhou". Nada aqui guarda conteudo de conversa nem dado pessoal: so contagens e codigos de motivo.
// ---------------------------------------------------------------------------

export type RunKind = "enviado" | "adiado" | "ignorado" | "vetado" | "falha" | "incerto";

export class RunRecorder {
  candidates = 0;
  eligible = 0;
  private counts: Record<RunKind, number> = { enviado: 0, adiado: 0, ignorado: 0, vetado: 0, falha: 0, incerto: 0 };
  private reasons = new Map<string, number>();
  readonly startedAt: Date;
  mode: string | null = null; // modo de execucao da rodada (normal | restrito), quando o job tem esse conceito

  constructor(readonly job: string, readonly clinicId: string | null, now = new Date()) {
    this.startedAt = now;
  }

  // `reason` = codigo curto (ex.: "ignorado:aguardando_janela", "adiado:juiz_indisponivel")
  add(kind: RunKind, reason: string): void {
    this.counts[kind]++;
    const key = `${kind}:${reason}`;
    this.reasons.set(key, (this.reasons.get(key) ?? 0) + 1);
  }

  get sent(): number {
    return this.counts.enviado;
  }

  snapshot() {
    return { candidates: this.candidates, eligible: this.eligible, ...this.counts, reasons: Object.fromEntries([...this.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) };
  }

  async save(outcome: "ok" | "erro", error?: unknown, finishedAt = new Date()): Promise<void> {
    const s = this.snapshot();
    try {
      await prisma.automationRun.create({
        data: {
          job: this.job,
          clinicId: this.clinicId,
          startedAt: this.startedAt,
          finishedAt,
          outcome,
          candidates: s.candidates,
          eligible: s.eligible,
          sent: s.enviado,
          deferred: s.adiado,
          ignored: s.ignorado,
          vetoed: s.vetado,
          failed: s.falha,
          uncertain: s.incerto,
          reasons: JSON.stringify(s.reasons),
          mode: this.mode,
          error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 300) : null,
          version: REVISION.split(":")[0],
        },
      });
    } catch (err) {
      console.error(`[diagnostico] nao consegui gravar a rodada de "${this.job}":`, err instanceof Error ? err.message : err);
    }
  }
}

const KEEP_DAYS = 14;
export async function pruneAutomationRuns(now = new Date()): Promise<number> {
  const r = await prisma.automationRun.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - KEEP_DAYS * 24 * 3_600_000) } } });
  return r.count;
}

// PURO: a proxima vez que um job de cron "*/N * * * *" ou "M * * * *" roda, a partir de `now` (so os formatos que a Alice usa).
export function nextCronRun(expression: string, now: Date): Date | null {
  const [min, ...rest] = expression.trim().split(/\s+/);
  if (rest.join(" ") !== "* * * *") return null;
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  const step = /^\*\/(\d+)$/.exec(min);
  if (min === "*") return new Date(t.getTime() + 60_000);
  for (let i = 1; i <= 120; i++) {
    const c = new Date(t.getTime() + i * 60_000);
    const m = c.getUTCMinutes();
    if (step ? m % Number(step[1]) === 0 : /^\d+$/.test(min) ? m === Number(min) : false) return c;
  }
  return null;
}

export interface JobSpec {
  job: string;
  label: string;
  cron: string;
}

// Os jobs que o diagnostico acompanha (nome interno = o do scheduleLocked / do RunRecorder).
export const TRACKED_JOBS: JobSpec[] = [
  { job: "recontato", label: "Recontatos (cascata por silêncio)", cron: "*/15 * * * *" },
  { job: "retomada-avaliacao-cancelada", label: "Retomada de avaliações canceladas", cron: "*/15 * * * *" },
  { job: "retomada-avaliacao-sem-fechamento", label: "Retomada de avaliações sem fechamento (pessoas marcadas pela equipe)", cron: "*/15 * * * *" },
  { job: "pesquisa-satisfacao", label: "Pesquisa de satisfação (no máximo 1 a cada 15 dias por pessoa)", cron: "*/15 * * * *" },
  { job: "convite-indicacao", label: "Convite de indicação (mensagem separada, depois da nota alta)", cron: "*/15 * * * *" },
];

export interface JobDiagnosis {
  job: string;
  label: string;
  cron: string;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  state: "nunca_rodou" | "nao_rodou_no_prazo" | "rodou_sem_candidatas" | "todas_excluidas" | "rodou_e_enviou" | "rodou_sem_enviar" | "erro";
  candidates: number;
  eligible: number;
  sent: number;
  deferred: number;
  ignored: number;
  vetoed: number;
  failed: number;
  uncertain: number;
  topReasons: { reason: string; count: number }[];
  window: { from: Date; to: Date };
}

// O que cada job fez no periodo [from, to) para a clinica (somando as rodadas), e o estado em linguagem direta.
export async function diagnoseJobs(clinicId: string, from: Date, to: Date, now = new Date()): Promise<JobDiagnosis[]> {
  const out: JobDiagnosis[] = [];
  for (const spec of TRACKED_JOBS) {
    const runs = await prisma.automationRun.findMany({ where: { job: spec.job, clinicId, startedAt: { gte: from, lt: to } }, orderBy: { startedAt: "desc" }, take: 500 });
    const last = await prisma.automationRun.findFirst({ where: { job: spec.job, clinicId }, orderBy: { startedAt: "desc" }, select: { startedAt: true, outcome: true } });
    const sum = (k: "candidates" | "eligible" | "sent" | "deferred" | "ignored" | "vetoed" | "failed" | "uncertain") => runs.reduce((a, r) => a + r[k], 0);
    const reasons = new Map<string, number>();
    for (const r of runs) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(r.reasons ?? "{}") as Record<string, number>)) reasons.set(k, (reasons.get(k) ?? 0) + v);
      } catch { /* linha antiga/ilegivel */ }
    }
    const candidates = sum("candidates");
    const sent = sum("sent");
    const staleMs = 3 * 15 * 60_000;
    let state: JobDiagnosis["state"];
    if (!last) state = "nunca_rodou";
    else if (runs.length === 0 || now.getTime() - last.startedAt.getTime() > staleMs) state = "nao_rodou_no_prazo";
    else if (runs.some((r) => r.outcome === "erro") && sent === 0) state = "erro";
    else if (candidates === 0) state = "rodou_sem_candidatas";
    else if (sum("eligible") === 0) state = "todas_excluidas";
    else state = sent > 0 ? "rodou_e_enviou" : "rodou_sem_enviar";
    out.push({
      job: spec.job, label: spec.label, cron: spec.cron,
      lastRunAt: last?.startedAt ?? null,
      nextRunAt: nextCronRun(spec.cron, now),
      state, candidates, eligible: sum("eligible"), sent,
      deferred: sum("deferred"), ignored: sum("ignored"), vetoed: sum("vetoed"), failed: sum("failed"), uncertain: sum("uncertain"),
      topReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
      window: { from, to },
    });
  }
  return out;
}

export const STATE_LABEL: Record<JobDiagnosis["state"], string> = {
  nunca_rodou: "nunca rodou",
  nao_rodou_no_prazo: "NÃO rodou no prazo (servidor parado, copia sem a concessão ou job travado)",
  rodou_sem_candidatas: "rodou, sem candidatas",
  todas_excluidas: "rodou, todas as candidatas foram excluídas",
  rodou_e_enviou: "rodou e enviou",
  rodou_sem_enviar: "rodou, tinha elegíveis, mas nada saiu (adiado/vetado/falha)",
  erro: "rodou com ERRO",
};
