// Sobe a Alice: aplica as migracoes SO SE HOUVER PENDENTE (com tentativas SO para falha transitoria) e inicia o servidor.
//
// Por que so se houver pendente: durante uma troca de versao o container antigo continua
// rodando e escrevendo no SQLite. O "prisma migrate deploy" NAO espera pelo banco (falha na
// hora com "database is locked"), entao a versao nova nunca conseguia subir e a antiga nunca
// era desligada. A maioria dos deploys nao tem migracao nova: ai nem precisa mexer no banco.
//
// Falha DETERMINISTICA (migracao marcada como falhada/P3009, SQL invalido/P3018...) NAO e repetida: o boot encerra na hora com a instrucao de recuperacao, e o
// codigo novo NUNCA inicia sobre schema incompleto. Nada destrutivo e feito automaticamente aqui. Veja docs/hotfix-migracao-disparos.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyMigrateFailure, recoveryInstructions } from "./migracao-erros.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MODO DE RECUPERACAO: o container sobe sem migrar e sem iniciar o servidor, so para dar acesso ao console (um container que sai em loop nao permite rodar os comandos).
if (process.env.ALICE_MODO_RECUPERACAO === "1") {
  console.log("[start] ALICE_MODO_RECUPERACAO=1: NAO vou migrar nem iniciar o servidor. Use o console do servico (docs/hotfix-migracao-disparos.md). Remova a variavel e implante de novo para voltar ao normal.");
  console.log(recoveryInstructions());
  // Responde /health (200, com "modo":"recuperacao") para o HEALTHCHECK do Docker/Swarm nao reiniciar o container no meio da recuperacao e derrubar o console.
  // ATENCAO: neste modo /health NAO prova que a Alice esta no ar; depois da recuperacao, remova a variavel, implante e confira "revision"/"lastMigration" no /health.
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, modo: "recuperacao", aviso: "Alice NAO esta atendendo: container em modo de recuperacao da migracao" }));
  });
  srv.listen(Number(process.env.PORT ?? 3000), () => console.log(`[start] modo de recuperacao ouvindo na porta ${srv.address().port} (so /health)`));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  // SEM CONSOLE (o EasyPanel as vezes mostra "Nenhum conteiner em execucao"): o proprio container roda o DIAGNOSTICO (somente leitura) e imprime no LOG.
  // So com ALICE_RECUPERACAO_APLICAR=1 (decisao explicita do operador) ele tambem aplica o reparo - com backup verificado, transacao unica e validacao - e SO ENTAO marca a migracao
  // como aplicada. Qualquer estado inesperado interrompe sem escrever (ver docs/hotfix-migracao-disparos.md).
  try {
    const { run, MIGRATION } = await import("./recuperar-migracao-disparos.mjs");
    const aplicar = process.env.ALICE_RECUPERACAO_APLICAR === "1";
    const argv = aplicar ? ["--apply", ...(process.env.ALICE_RECUPERACAO_ACEITA_ARMAZENAMENTO_DESCONHECIDO === "1" ? ["--aceito-armazenamento-desconhecido"] : [])] : [];
    console.log(`[recuperacao] ${aplicar ? "APLICANDO (ALICE_RECUPERACAO_APLICAR=1)" : "diagnostico (somente leitura); para aplicar defina ALICE_RECUPERACAO_APLICAR=1"}`);
    const r = await run(argv);
    if (aplicar && ["falhada_parcial", "falhada_completa"].includes(r.state) && r.validation?.ok) {
      console.log(`[recuperacao] validacao OK: marcando ${MIGRATION} como aplicada`);
      const sh = process.platform === "win32";
      const res = spawnSync("npx", ["prisma", "migrate", "resolve", "--applied", MIGRATION], { stdio: "inherit", shell: sh });
      if (res.status === 0) spawnSync("npx", ["prisma", "migrate", "status"], { stdio: "inherit", shell: sh });
      console.log(res.status === 0 ? "[recuperacao] CONCLUIDO. Remova ALICE_RECUPERACAO_APLICAR e ALICE_MODO_RECUPERACAO e implante de novo." : "[recuperacao] o 'migrate resolve' falhou: NAO remova o modo de recuperacao; envie este log.");
    } else if (aplicar) console.log("[recuperacao] nada foi marcado como aplicado (estado/validacao nao permitem). Veja as mensagens acima.");
  } catch (err) {
    console.error(`[recuperacao] ERRO: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise(() => {});
}

// Le (so leitura, nao trava) as migracoes ja aplicadas e compara com as pastas do repositorio. Migracao FALHADA e detectada aqui, antes de qualquer tentativa.
async function readMigrationState() {
  try {
    const { prisma } = await import("../dist/db/client.js");
    const rows = await prisma.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"');
    await prisma.$disconnect();
    const applied = new Set(rows.filter((r) => r.finished_at != null && r.rolled_back_at == null).map((r) => r.migration_name));
    const failed = rows.filter((r) => r.finished_at == null && r.rolled_back_at == null).map((r) => r.migration_name);
    const dirs = fs
      .readdirSync(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const pending = dirs.filter((d) => !applied.has(d));
    return { ok: true, pending, failed };
  } catch (err) {
    console.log("[start] nao consegui ler as migracoes aplicadas (banco novo?); vou rodar a migracao:", String(err).slice(0, 120));
    return { ok: false, pending: [], failed: [] };
  }
}

const state = await readMigrationState();

if (state.failed.length) {
  console.error(`[start] migracao(oes) FALHADA(S) registrada(s) no banco: ${state.failed.join(", ")}. Nao adianta repetir 'migrate deploy' (P3009); encerrando SEM iniciar o servidor.`);
  console.error(recoveryInstructions(state.failed[0]));
  process.exit(1);
}

if (!state.ok || state.pending.length) {
  if (state.pending.length) console.log(`[start] ${state.pending.length} migracao(oes) pendente(s): ${state.pending.join(", ")}`);
  const MAX_TRANSIENT = 15; // so para banco ocupado/indisponivel
  const MAX_UNKNOWN = 3; // erro sem classificacao: sem evidencia de que repetir ajude
  let ok = false;
  let unknown = 0;
  for (let attempt = 1; attempt <= MAX_TRANSIENT; attempt++) {
    const r = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", shell: process.platform === "win32" });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status === 0) {
      ok = true;
      break;
    }
    const kind = classifyMigrateFailure(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    if (kind === "deterministica") {
      console.error("[start] a migracao falhou de forma DETERMINISTICA (nao e instabilidade): nao vou repetir. Encerrando SEM iniciar o servidor.");
      console.error(recoveryInstructions());
      process.exit(1);
    }
    if (kind === "desconhecida" && ++unknown >= MAX_UNKNOWN) {
      console.error(`[start] a migracao falhou ${unknown} vez(es) com erro nao reconhecido; nao vou repetir mais. Encerrando SEM iniciar o servidor.`);
      process.exit(1);
    }
    const wait = Math.min(5000 * attempt, 30000);
    console.error(`[start] migracao falhou (${kind}; tentativa ${attempt}/${MAX_TRANSIENT}); nova tentativa em ${wait / 1000}s`);
    await sleep(wait);
  }
  if (!ok) {
    console.error("[start] migracoes nao aplicadas apos varias tentativas (banco indisponivel?); encerrando SEM iniciar o servidor.");
    process.exit(1);
  }
} else {
  console.log("[start] nenhuma migracao pendente: pulando 'prisma migrate deploy'.");
}
await import("../dist/server.js");
