-- Memoria do lead (16/10/2026): notas curtas escritas por IA com o que vale lembrar de cada pessoa, sempre atualizadas (ver src/ai/leadBriefing.ts).
ALTER TABLE "Patient" ADD COLUMN "briefingNotes" TEXT;
ALTER TABLE "Patient" ADD COLUMN "briefingNotesAt" DATETIME;
