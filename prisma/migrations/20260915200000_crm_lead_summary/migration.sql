-- Resumo automatico do lead no CRM: o robo le a conversa e preenche o que o
-- paciente queria, pra equipe nao precisar reler o historico inteiro.
-- Aditivo: so acrescenta colunas opcionais em Patient.

ALTER TABLE "Patient" ADD COLUMN "contactReason" TEXT;
ALTER TABLE "Patient" ADD COLUMN "interestNote" TEXT;
ALTER TABLE "Patient" ADD COLUMN "conversationSummary" TEXT;
ALTER TABLE "Patient" ADD COLUMN "crmSummaryAt" DATETIME;
