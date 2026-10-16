-- Diagnostico de login (16/10/2026, Laleblu: "nao consigo entrar"): registra tentativas que falharam e quando a senha foi trocada.
ALTER TABLE "StaffUser" ADD COLUMN "passwordChangedAt" DATETIME;

CREATE TABLE "LoginFailure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "staffId" TEXT,
    "clinicId" TEXT,
    "reason" TEXT NOT NULL,
    "hint" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LoginFailure_clinicId_createdAt_idx" ON "LoginFailure"("clinicId", "createdAt");
CREATE INDEX "LoginFailure_username_createdAt_idx" ON "LoginFailure"("username", "createdAt");
