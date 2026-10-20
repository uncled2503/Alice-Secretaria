import { scheduleLocked } from "../jobs/lock.js";
import { pruneAiUsage } from "./usageStats.js";

// Todo dia (04:10, Brasilia): soma no agregado diario as linhas por tentativa mais antigas que AI_USAGE_KEEP_DAYS e as apaga. A falha daqui nunca afeta o atendimento.
export function startAiUsageJob(): void {
  scheduleLocked("medicao-ia-agregar", "10 4 * * *", async () => {
    try {
      const r = await pruneAiUsage();
      if (r.rolledUp) console.log(`[medicao-ia] ${r.rolledUp} linha(s) antigas somadas no agregado diario`);
    } catch (err) {
      console.error("[medicao-ia] agregacao diaria falhou:", err instanceof Error ? err.message : err);
    }
  }, { timezone: "America/Sao_Paulo" });
}
