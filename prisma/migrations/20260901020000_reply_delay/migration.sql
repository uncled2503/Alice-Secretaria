-- Espera alguns segundos antes de responder, pra agrupar mensagens que o
-- cliente manda em sequencia (quebradas). 0 = responde na hora (padrao).
ALTER TABLE "Clinic" ADD COLUMN "replyDelaySeconds" INTEGER NOT NULL DEFAULT 0;
