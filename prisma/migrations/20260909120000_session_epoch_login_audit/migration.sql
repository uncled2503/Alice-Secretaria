-- Versao de sessao por conta: o cookie assinado carrega esse numero; bumpar
-- (troca de senha ou "desconectar todos os acessos") derruba os cookies antigos.
ALTER TABLE "StaffUser" ADD COLUMN "sessionEpoch" INTEGER NOT NULL DEFAULT 0;

-- Auditoria de login: um registro por login bem-sucedido.
CREATE TABLE "LoginEvent" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "staffId"   TEXT NOT NULL,
  "clinicId"  TEXT,
  "ip"        TEXT NOT NULL DEFAULT '',
  "userAgent" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginEvent_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LoginEvent_clinicId_createdAt_idx" ON "LoginEvent"("clinicId", "createdAt");
CREATE INDEX "LoginEvent_staffId_createdAt_idx" ON "LoginEvent"("staffId", "createdAt");
