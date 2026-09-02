-- Limite de atendimentos por mês, por plano. A Alice conta 1 atendimento por
-- conversa/mês; ao estourar o limite, novos contatos vão direto pra equipe.
ALTER TABLE "Clinic" ADD COLUMN "conversationLimitOverride" INTEGER;
ALTER TABLE "Clinic" ADD COLUMN "usageMonth" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Clinic" ADD COLUMN "usageCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Clinic" ADD COLUMN "usageLimitNotified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "aliceMonth" TEXT NOT NULL DEFAULT '';
