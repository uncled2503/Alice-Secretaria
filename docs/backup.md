# Backup do banco

O servidor cria um backup consistente do SQLite (`VACUUM INTO`) todo dia às 03:30 (Brasília) e mantém os `BACKUP_KEEP`
mais recentes (padrão 14). Também dá para criar um na hora: `npm run backup`.

- **Onde fica:** `BACKUP_DIR`. Em produção aponte para um volume persistente (fora do container) e copie para fora do
  servidor; sem `BACKUP_DIR` o backup fica dentro do container e some num redeploy (o servidor avisa no log).
- **Criptografia:** com `BACKUP_ENCRYPTION_KEY` o arquivo é `database.db.enc` (AES-256-GCM). Guarde a chave fora do servidor.
  Formato: 12 bytes de IV + texto cifrado + 16 bytes de tag.

## Restaurar um backup criptografado

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

Pare o servidor, substitua o arquivo do banco (`DATABASE_URL`) pelo restaurado e suba de novo.
