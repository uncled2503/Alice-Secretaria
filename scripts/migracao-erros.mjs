// Classifica a saida de "prisma migrate deploy" para o boot decidir: tentar de novo (falha TRANSITORIA) ou encerrar com instrucao (falha DETERMINISTICA).
// Repetir 15 vezes um SQL invalido ou uma migracao marcada como falhada nao conserta nada: so atrasa o diagnostico e mantem o container em loop.

// Codigos/mensagens do Prisma que NAO mudam sozinhos entre uma tentativa e outra.
const DETERMINISTIC = [
  /\bP3009\b/, // migrate found failed migrations in the target database
  /\bP3018\b/, // A migration failed to apply (SQL invalido / incompativel)
  /\bP3006\b/, // migracao nao aplica no shadow database
  /\bP3014\b/, /\bP3015\b/, /\bP3017\b/, /\bP3019\b/, // diretorio/estado de migracao inconsistente
  /\bP3005\b/, // banco nao vazio sem baseline
  /\bP3003\b/, // formato de migracao invalido
  /found failed migrations/i,
  /A migration failed to apply/i,
  /Cannot add a column with non-constant default/i,
  /syntax error/i,
  /no such (table|column)/i,
  /(table|column|index) .* already exists/i,
  /duplicate column name/i,
];

// Indisponibilidade momentanea: vale esperar e tentar de novo (ex.: o container antigo ainda segura o banco durante a troca de versao).
const TRANSIENT = [
  /database is locked/i,
  /SQLITE_BUSY/i,
  /\bP1001\b/, /\bP1002\b/, /\bP1008\b/, /\bP1017\b/,
  /timed out/i,
  /Can't reach database/i,
  /Socket timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT/i,
  /EBUSY|resource busy/i,
];

export function classifyMigrateFailure(output) {
  const text = String(output ?? "");
  if (DETERMINISTIC.some((re) => re.test(text))) return "deterministica";
  if (TRANSIENT.some((re) => re.test(text))) return "transitoria";
  return "desconhecida"; // poucas tentativas e para: sem evidencia de que repetir resolva
}

export function recoveryInstructions(migrationName = "20261025100000_disparos") {
  return [
    "",
    "================ ALICE NAO VAI SUBIR: MIGRACAO FALHADA NO BANCO ================",
    `Migracao: ${migrationName}`,
    "O banco ficou parcialmente migrado e o Prisma recusa novas migracoes (P3009). Repetir 'migrate deploy' NAO resolve.",
    "O novo codigo NAO e iniciado sobre um schema incompleto. Nada destrutivo e feito automaticamente no boot.",
    "",
    "RECUPERACAO (docs/hotfix-migracao-disparos.md):",
    "  1. No EasyPanel, defina a variavel de ambiente ALICE_MODO_RECUPERACAO=1 e implante (o container sobe SEM migrar e SEM iniciar o servidor, so para voce usar o console).",
    "  2. No console do servico:  node scripts/recuperar-migracao-disparos.mjs                 (diagnostico, nao escreve nada)",
    "  3.                         node scripts/recuperar-migracao-disparos.mjs --apply --backup-dir /app/data/backups-hotfix",
    `  4.                         npx prisma migrate resolve --applied ${migrationName}`,
    "  5.                         npx prisma migrate status",
    "  6. Remova ALICE_MODO_RECUPERACAO e implante de novo; confira /health.",
    "=================================================================================",
    "",
  ].join("\n");
}
