// Sobe a Alice: aplica as migracoes (com tentativas) e depois inicia o servidor.
// Antes era "prisma migrate deploy && node dist/server.js": se o banco estivesse ocupado
// ("database is locked", ex.: o container antigo ainda fechando), a migracao falhava, o
// container saia e a hospedagem reiniciava em loop.
import { spawnSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX = 15;
let ok = false;
for (let attempt = 1; attempt <= MAX; attempt++) {
  const r = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status === 0) {
    ok = true;
    break;
  }
  const wait = Math.min(5000 * attempt, 30000);
  console.error(`[start] migracao falhou (tentativa ${attempt}/${MAX}); nova tentativa em ${wait / 1000}s`);
  await sleep(wait);
}
if (!ok) {
  console.error("[start] migracoes nao aplicadas apos varias tentativas; encerrando.");
  process.exit(1);
}
await import("../dist/server.js");
