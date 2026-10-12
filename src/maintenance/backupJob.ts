import cron from "node-cron";
import { scheduleLocked } from "../jobs/lock.js";
import { createBackup, pruneBackups } from "./backupCore.js";

// Backup diario do banco (03:30, horario de Brasilia), mantendo os ultimos BACKUP_KEEP (padrao 14).
// Onde fica: BACKUP_DIR - em producao aponte pra um volume PERSISTENTE (fora do container) e copie pra fora do servidor.
// Defina BACKUP_ENCRYPTION_KEY pra guardar criptografado. Desligue com BACKUP_JOB=off.
export function startBackupJob(): void {
  if (process.env.BACKUP_JOB === "off") {
    console.warn("[backup] job diario desligado (BACKUP_JOB=off)");
    return;
  }
  if (!process.env.DATABASE_URL?.startsWith("file:")) return;
  if (!cron.validate("30 3 * * *")) return;
  scheduleLocked(
    "backup-diario",
    "30 3 * * *",
    async () => {
      const destination = await createBackup();
      const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14) || 14);
      const removed = pruneBackups(keep);
      console.log(`[backup] criado em ${destination}${removed ? ` (${removed} antigo(s) removido(s))` : ""}`);
    },
    { timezone: "America/Sao_Paulo" },
  );
  if (!process.env.BACKUP_DIR) {
    console.warn("[backup] BACKUP_DIR nao definido: os backups ficam dentro do container e somem num redeploy. Aponte para um volume persistente.");
  }
}
