-- Modelo de IA por clinica (admin): vazio = o padrao do servidor (OPENAI_MODEL). Permite testar um modelo maior so numa clinica.
ALTER TABLE "Clinic" ADD COLUMN "aiModel" TEXT;
