import cron from "node-cron";
import { scheduleLocked } from "../jobs/lock.js";
import { createBackup, pruneBackups, backupRootDir, storageKind } from "./backupCore.js";
import { REVISION } from "../version.js";

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
      const destination = await createBackup(); // (lanca se o arquivo gravado nao abrir/nao passar no integrity_check)
      const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14) || 14);
      const removed = pruneBackups(keep);
      console.log(`[backup] criado e VERIFICADO (restaurado num temporario e aberto) em ${destination} armazenamento=${storageKind(backupRootDir())}${removed ? ` (${removed} antigo(s) removido(s))` : ""} revisao=${REVISION.split(":")[0]}`);
    },
    { timezone: "America/Sao_Paulo" },
  );
  // Aviso por EVIDENCIA (tabela de montagens do Linux), nao por suposicao: BACKUP_DIR configurado nao prova que o diretorio e um volume.
  const where = storageKind(backupRootDir());
  if (!process.env.BACKUP_DIR) {
    console.warn(`[backup] BACKUP_DIR nao definido: os backups vao para ${backupRootDir()} (armazenamento=${where}) e, sem um volume montado ali, somem num redeploy. Veja docs/backup.md.`);
  } else if (where === "raiz_do_container") {
    console.warn(`[backup] BACKUP_DIR=${backupRootDir()} esta na raiz do container (nenhum volume montado nesse caminho): os backups somem num redeploy. Monte um volume nesse caminho no EasyPanel. Veja docs/backup.md.`);
  } else {
    console.log(`[backup] diretorio de backup=${backupRootDir()} armazenamento=${where}`);
  }
}
