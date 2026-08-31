-- Plano contratado e vigencia da clinica. So a administracao da Alice edita,
-- pelo painel adm. Nada e bloqueado automaticamente quando vence: o painel
-- adm mostra um aviso (ver src/reminders/planExpiry.ts).
ALTER TABLE "Clinic" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'prime';
ALTER TABLE "Clinic" ADD COLUMN "planActivatedAt" DATETIME;
ALTER TABLE "Clinic" ADD COLUMN "planExpiresAt" DATETIME;
ALTER TABLE "Clinic" ADD COLUMN "planExpiryNotified" BOOLEAN NOT NULL DEFAULT false;
