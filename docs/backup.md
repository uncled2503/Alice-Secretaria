# Backup do banco

O servidor cria um backup consistente do SQLite (`VACUUM INTO`) todo dia às 03:30 (Brasília) e mantém os `BACKUP_KEEP`
mais recentes (padrão 14). Também dá para criar um na hora: `npm run backup`.

`VACUUM INTO` gera uma cópia consistente do banco com o servidor em uso, tanto no modo de diário padrão quanto em WAL
(o modo do banco de origem fica gravado no `manifest.json`, campo `journalMode`).

## O que conta como "backup válido" (desde 21/10/2026)

Ter a pasta `BACKUP_DIR` configurada **não prova** que existe um backup utilizável. Depois de gravar, o servidor
**restaura o arquivo para um temporário**, abre com o SQLite, roda `PRAGMA integrity_check` e conta as tabelas. O resultado
vai no `manifest.json` (`verification`: `ok`, `integrity`, `tables`, `clinics`, `bytes`, `sha256`). Se a verificação falhar,
o job registra erro no log (`[backup] ... NAO passou na verificacao`) e **não** trata aquele arquivo como confiável.

Linha de log normal:
`[backup] criado e VERIFICADO (restaurado num temporario e aberto) em <pasta> armazenamento=volume revisao=<versão>`

## Onde fica e como confirmar que sobrevive a um redeploy

`BACKUP_DIR` (padrão: `./backups` dentro do container). **Não presuma** que o caminho é persistente: o servidor lê a tabela
de montagens do Linux (`/proc/self/mountinfo`) e informa `armazenamento=`:

| valor | significa |
| --- | --- |
| `volume` | o caminho está dentro de um ponto de montagem próprio (volume). A durabilidade do volume em si é do EasyPanel/servidor. |
| `raiz_do_container` | nenhum volume montado nesse caminho: **os backups somem num redeploy**. O boot registra um aviso. |
| `desconhecido` | sem `/proc/self/mountinfo` (Windows/desenvolvimento): não dá para afirmar. |

### EasyPanel (passos, a executar por quem tem acesso)

1. Serviço da Alice → **Mounts** → adicionar **Volume**: nome `alice-backups`, caminho no container `/app/backups`.
2. Serviço → **Ambiente**: `BACKUP_DIR=/app/backups` (e, se quiser, `BACKUP_KEEP=14`, `BACKUP_ENCRYPTION_KEY=<chave guardada fora do servidor>`).
3. O banco também precisa de volume próprio (`/app/data`, com `DATABASE_URL=file:/app/data/prod.db`). **Confirme** que ele já existe: não está provado pelo código.
4. Clicar em **Implantar** e conferir no log de boot: `[backup] diretorio de backup=/app/backups armazenamento=volume`.
5. **Teste de persistência** (obrigatório antes de confiar): com o serviço rodando, `touch /app/backups/_teste_persistencia`, faça **outro** "Implantar" e confira que o arquivo continua lá (`ls /app/backups`). Depois apague o arquivo de teste.
6. Rode um backup na hora (`npm run backup` no console do serviço) e confira que a linha do log diz `VERIFICADO`.
7. Copie periodicamente os backups para **fora** do servidor (o volume protege de redeploy, não de perda do servidor).

## Restaurar um backup (sem tocar na produção)

Para **conferir** um backup sem risco, restaure para um arquivo temporário e abra-o: é exatamente o que o servidor faz a cada
backup (`verifyBackupDir` em `src/maintenance/backupCore.ts`; teste em `tests/backup-verificado.test.mjs`).

Restauração manual de um backup criptografado:

```js
// node restaurar.mjs database.db.enc database.db
import fs from "fs";
import crypto from "crypto";
const [src, dst] = process.argv.slice(2);
const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, "base64"); // ou "hex" se a chave tiver 64 caracteres hex
const data = fs.readFileSync(src);
const iv = data.subarray(0, 12);
const tag = data.subarray(data.length - 16);
const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
fs.writeFileSync(dst, Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]));
```

Para voltar a produção a um backup: pare o servidor, substitua o arquivo do banco (`DATABASE_URL`) pelo restaurado e suba de novo.
Antes de substituir, guarde uma cópia do arquivo atual.
