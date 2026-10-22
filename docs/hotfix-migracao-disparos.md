# HOTFIX: migração `20261025100000_disparos` (22/10/2026)

Status: **pronto para aplicar. Nada foi executado em produção; não foi afirmado que a produção voltou.** Banco do incidente: `file:/app/data/prod.db`.

## 1. Causa exata

- Arquivo: `prisma/migrations/20261025100000_disparos/migration.sql` (versão original, commit `54fd2a9`; cópia em `tests/fixtures/migracao-disparos-original-quebrada.sql`).
- Instrução (linha 20 do original), tabela `BirthdaySent`, coluna **`updatedAt`**:

  ```sql
  ALTER TABLE "BirthdaySent" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
  ```

- O SQLite **não aceita `ADD COLUMN` com default não constante** (`CURRENT_TIMESTAMP`) → `P3018 Cannot add a column with non-constant default`. Era a única instrução incompatível (os demais defaults são constantes; `CURRENT_TIMESTAMP` em `CREATE TABLE` é aceito).
- O Prisma **não envolve o script do SQLite numa transação**. Ficou aplicado o que veio **antes** da instrução, e não rodou o que veio **depois**:

  | Já aplicado (parcial) | Não aplicado |
  | --- | --- |
  | `ReminderDispatch`: 8 colunas (`destination`, `providerId`, `attemptedAt`, `deliveryState`, `deliveryAt`, `nextAttemptAt`, `deadlineAt`, `extendedReason`) + índice `ReminderDispatch_providerId_idx` | `BirthdaySent.updatedAt` (a que falhou) |
  | `BirthdaySent`: 8 colunas (`attemptedAt`, `destination`, `providerId`, `detail`, `deliveryState`, `deliveryAt`, `attempts`, `nextAttemptAt`) | tabelas `PhoneResolution`, `DispatchPolicy`, `DispatchRun`, `DispatchRunItem` e seus índices |

  `_prisma_migrations` ficou com a migração **falhada** (`finished_at` nulo) → `P3009` em todo boot. (A tabela acima é o que o código/teste reproduz; **a produção deve ser confirmada pelo diagnóstico do passo 3**, que lê o banco real.)
- O boot repetia `migrate deploy` 15 vezes: erro **determinístico** tratado como transitório.

## 2. Correção implementada

1. **`migration.sql` corrigida** (a mesma pasta; ver §6 sobre outros ambientes): `BirthdaySent` agora é **reconstruída** (padrão `RedefineTables` do Prisma: cria `new_BirthdaySent` com a forma final, copia **todas** as linhas e ids, remove a antiga, renomeia, recria o índice único e as chaves estrangeiras). `updatedAt` das linhas antigas = `sentAt` (a última alteração conhecida), **nunca uma data fixa**; `attempts` = 0 (registro anterior ao controle por tentativa). Linhas novas usam o default dinâmico `CURRENT_TIMESTAMP`. Nenhuma outra migração foi tocada.
2. **`scripts/recuperar-migracao-disparos.mjs`**: diagnóstico (padrão, somente leitura) e `--apply` (backup verificado + completa só o que falta numa transação + validação). Estratégia **A (completar)**: as colunas já aplicadas estão vazias e são exatamente as da migração corrigida, então completar não desfaz nem toca em dados; a reversão (B) exigiria `DROP COLUMN` na tabela de histórico de envios para depois refazer o mesmo.
3. **`scripts/start.mjs` + `scripts/migracao-erros.mjs`**: migração falhada registrada (P3009) ou erro determinístico (P3018, SQL inválido, coluna duplicada…) **encerra na hora**, sem repetir e **sem iniciar o servidor**, com a instrução de recuperação. Só banco ocupado/indisponível (`database is locked`, `SQLITE_BUSY`, P1001/P1002/P1008, timeout…) é repetido (15×); erro desconhecido é repetido no máximo 3×. **Nada destrutivo roda no boot.**
4. **Modo de recuperação** (`ALICE_MODO_RECUPERACAO=1`): o container sobe **sem migrar e sem iniciar o servidor**, responde `/health` com `"modo":"recuperacao"` (para o healthcheck não reiniciar o container no meio) e fica vivo para você usar o console. Sem isso, o container sai em loop e não há console.

## 3. Resultado dos testes (reais, SQL pelo CLI do Prisma — `tests/migracao-disparos.test.mjs`)

- A versão original falha com `P3018`, o retry cai em `P3009`, ambos classificados como determinísticos; o estado parcial é exatamente o da tabela acima.
- **Banco novo**: toda a sequência de migrações (anteriores + corrigida) aplica; `migrate status` "up to date"; nenhum objeto do Disparos diverge do `schema.prisma` (`migrate diff`).
- **Banco populado no estado anterior**: corrigida aplica; mesmas linhas/ids/estados/`sentAt`; `updatedAt = sentAt`; `attempts = 0`; histórico de `ReminderDispatch` intacto; default dinâmico, índice único, chaves estrangeiras, `integrity_check` e `foreign_key_check` ok.
- **Estado parcial do incidente**: diagnóstico não altera nada (schema, migrações, linhas idênticos); `--apply` sem prova de armazenamento persistente recusa e não escreve; com backup: backup restaurável (integrity ok, estado anterior), completa só o que falta (não reaplica as colunas de `ReminderDispatch`), valida; **segunda execução = nenhuma alteração**; `migrate resolve --applied` → `migrate status` "up to date" → `migrate deploy` "No pending migrations"; o cliente Prisma do app lê e grava os dados antigos e novos.
- Estados fora do roteiro (rolled-back com SQL parcial; objetos sem registro) **interrompem sem escrever e sem criar backup**; falha no fim do plano desfaz **tudo** (rollback completo).
- Boot: migração falhada encerra em segundos, sem 2ª tentativa e sem subir o servidor; erro determinístico sem registro idem; modo de recuperação fica vivo e responde `/health`.
- `migrate diff` mostra "Redefined table `Clinic`" mesmo no estado anterior ao Disparos: divergência **preexistente e alheia** a esta migração (não tocada).
- Não verificável localmente: o comportamento do **seu** `prod.db` (WAL, tamanho, o que de fato foi aplicado) — por isso o diagnóstico vem antes de qualquer escrita.

## 4. Procedimento exato no EasyPanel (nesta ordem)

Pré-requisito: o hotfix está no repositório e sincronizado (o push/webhook só sincroniza; **não** reinicia o servidor).

1. **Serviço da Alice → Ambiente**: adicionar `ALICE_MODO_RECUPERACAO=1`. Clicar em **Implantar**. O log deve mostrar `[start] ALICE_MODO_RECUPERACAO=1 ... NAO vou migrar nem iniciar o servidor` e `modo de recuperacao ouvindo na porta ...`.
2. **Console** do serviço (shell dentro do container):

   ```sh
   cd /app
   echo $DATABASE_URL            # deve ser file:/app/data/prod.db
   ls -la /app/data              # o banco e o -wal, se houver
   ```

3. **Diagnóstico (não escreve):**

   ```sh
   node scripts/recuperar-migracao-disparos.mjs
   ```

   Esperado: `Estado: falhada_parcial` e a lista do que falta/difere (o que já foi aplicado **não** aparece). Se disser `inesperado`, **pare** e envie a saída para revisão (nada foi escrito). Se disser `aplicada_integra`/`nao_iniciada`, não há o que recuperar.
4. **Aplicar** (backup consistente + completar + validar). `/app/data` é o volume do banco, então o backup fica em armazenamento persistente (o script **recusa** caminho na raiz do container, como `/app/backups` sem volume):

   ```sh
   node scripts/recuperar-migracao-disparos.mjs --apply --backup-dir /app/data/backups-hotfix
   ```

   Esperado: `Backup verificado: /app/data/backups-hotfix/prod-antes-20261025100000_disparos-<data>.db ... integrity_check=ok`, `Aplicado: N passo(s).` e `VALIDACAO OK`. Copie o arquivo de backup também para **fora** do servidor (o volume protege de redeploy, não de perda do servidor). Se aparecer `VALIDACAO FALHOU`, **não** prossiga (ver §6).
5. **Só depois da validação**, marcar como aplicada e conferir:

   ```sh
   npx prisma migrate resolve --applied 20261025100000_disparos
   npx prisma migrate status
   ```

   Esperado: `Database schema is up to date!`. (Rodar o script de novo deve dizer `aplicada_integra`.)
6. **Variável**: remover `ALICE_MODO_RECUPERACAO` e clicar em **Implantar**.

## 5. Como verificar depois (não afirmar sem isto)

- Log de boot: `[start] nenhuma migracao pendente: pulando 'prisma migrate deploy'.` seguido de `Alice rodando na porta ...`.
- No console:

  ```sh
  node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.text()).then(console.log)"
  ```

  Esperado: `revision` começando por `2026-10-22-a` e `lastMigration` = `20261025100000_disparos` (e **sem** `"modo":"recuperacao"`). No modo de recuperação o `/health` responde 200 **sem provar** que a Alice atende.
- `npx prisma migrate status` → up to date.
- Uptime do `/health` (confirma que o container novo é o que está no ar).
- Reaplicar o webhook das clínicas (Canais) para o evento `messages_update`.

## 6. Reversão / se algo falhar

- **Falha do script (transação):** o `--apply` é uma única transação; se algum passo falhar, **nada** é alterado (testado). O backup já foi criado antes de escrever.
- **Validação falhou / quer voltar ao estado de antes:** com o serviço em modo de recuperação (ninguém escrevendo),

  ```sh
  cp /app/data/backups-hotfix/<arquivo-do-backup>.db /app/data/prod.db
  rm -f /app/data/prod.db-wal /app/data/prod.db-shm
  ```

  Isso devolve o banco ao estado parcial original (migração ainda "falhada"); nada escrito depois do backup é preservado (por isso o serviço precisa estar em modo de recuperação durante todo o reparo).
- **Voltar o código à versão antiga** não ajuda sozinho: o `start.mjs` antigo também esbarra no P3009 enquanto a migração estiver falhada. Conclua os passos 3–5 primeiro.
- **Nunca usar:** `prisma migrate reset`, `db push` em produção, apagar o `prod.db`, apagar linhas de `_prisma_migrations`, `migrate resolve` sem o diagnóstico e a validação.
- **Outros ambientes:** a migração falhou em produção; ela nunca foi aplicada com sucesso em outro ambiente real (os bancos de desenvolvimento/teste usam `db push`). Por isso editar o arquivo é seguro. Em um banco que **já** tenha aplicado a versão antiga por outro meio, o checksum registrado difere do arquivo novo: o `migrate deploy`/`status` não bloqueia por isso (testado com o `resolve --applied` do fluxo acima); `migrate dev` reclamaria.

## 7. Outros problemas do log (lista separada; NÃO fazem parte do hotfix e não foram investigados aqui)

1. Jornadas de Adriana, Suelen e Talita herdando 08h–21h (em vez da jornada real de cada uma).
2. O revisor de envio removendo convites comerciais porque a cliente não pediu agendamento.
3. Veto de aviso de agendamento pelo motivo de a pessoa já ter horário.
4. Clínica Experts devolvendo criação **sem o código da reserva**: exige reconciliação antes de concluir falha ou repetir a criação (nunca recriar às cegas).

## 8. Sem console (EasyPanel: "Nenhum contêiner em execução encontrado")

Se o console do serviço não abrir, o próprio container faz a recuperação e escreve no **LOG** (testado: `tests/migracao-disparos.test.mjs`, "MODO DE RECUPERACAO SEM CONSOLE").

1. Ambiente: `ALICE_MODO_RECUPERACAO=1` → **Implantar** → abra os **Logs**: aparece `[recuperacao] diagnostico (somente leitura)` e o `Estado: ...` (nada é escrito). Se for `falhada_parcial`, siga; se for outro estado, pare e envie o log.
2. Ambiente: adicione também `ALICE_RECUPERACAO_APLICAR=1` → **Implantar**. O container: faz o backup verificado em `/app/data/backups-hotfix` (recusa se não for volume persistente), completa o schema numa transação, valida e **só então** roda `prisma migrate resolve --applied 20261025100000_disparos` e `migrate status`. Procure `VALIDACAO OK` e `[recuperacao] CONCLUIDO` no log. Se aparecer `VALIDACAO FALHOU`, `nada foi marcado como aplicado` ou `ERRO`, **não** remova o modo de recuperação e envie o log.
3. Remova `ALICE_RECUPERACAO_APLICAR` **e** `ALICE_MODO_RECUPERACAO` → **Implantar** → confira o `/health` (§5).
