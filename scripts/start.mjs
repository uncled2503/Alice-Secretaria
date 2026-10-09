// Sobe a Alice: aplica as migracoes SO SE HOUVER PENDENTE (com tentativas) e inicia o servidor.
//
// Por que so se houver pendente: durante uma troca de versao o container antigo continua
// rodando e escrevendo no SQLite. O "prisma migrate deploy" NAO espera pelo banco (falha na
// hora com "database is locked"), entao a versao nova nunca conseguia subir e a antiga nunca
// era desligada. A maioria dos deploys nao tem migracao nova: ai nem precisa mexer no banco.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le (so leitura, nao trava) as migracoes ja aplicadas e compara com as pastas do repositorio.
async function hasPendingMigrations() {
  try {
    const { prisma } = await import("../dist/db/client.js");
    const rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    await prisma.$disconnect();
    const applied = new Set(rows.map((r) => r.migration_name));
    const dirs = fs
      .readdirSync(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const pending = dirs.filter((d) => !applied.has(d));
    if (pending.length) console.log(`[start] ${pending.length} migracao(oes) pendente(s): ${pending.join(", ")}`);
    return pending.length > 0;
  } catch (err) {
    console.log("[start] nao consegui ler as migracoes aplicadas (banco novo?); vou rodar a migracao:", String(err).slice(0, 120));
    return true;
  }
}

if (await hasPendingMigrations()) {
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
} else {
  console.log("[start] nenhuma migracao pendente: pulando 'prisma migrate deploy'.");
}
await import("../dist/server.js");
