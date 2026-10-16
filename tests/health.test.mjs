import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("/health mostra a revisao do codigo e a ultima migracao aplicada", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /revision: REVISION, lastMigration/);
  assert.match(src, /FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1/);
  const v = fs.readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
  assert.match(v, /export const REVISION = "2026-10-16/);
  // a ultima migracao do repositorio e a que o /health deve mostrar depois do deploy
  const dirs = fs.readdirSync(new URL("../prisma/migrations/", import.meta.url)).filter((d) => /^\d{14}_/.test(d)).sort();
  assert.ok(dirs.length > 80);
  assert.equal(dirs.at(-1), "20261016120000_memoria_do_lead");
});
