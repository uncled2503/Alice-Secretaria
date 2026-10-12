import "dotenv/config";
import { prisma } from "../db/client.js";
import { createBackup } from "./backupCore.js";

// `npm run backup`: cria um backup agora (o servidor tambem cria um por dia sozinho - ver backupJob.ts).
createBackup()
  .then((destination) => console.log(`Backup criado em ${destination}`))
  .catch((error) => {
    console.error("Falha ao criar backup:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
