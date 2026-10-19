-- Pesquisa de satisfacao, link do Google e convite de indicacao (18/10/2026): frequencia por pessoa, nota lida pelo codigo, link so depois de confirmado.
-- Nao envia nada e nao muda nenhuma mensagem ou regra. Colunas novas, anulaveis ou com padrao.

ALTER TABLE "Clinic" ADD COLUMN "googleReviewConfirmedAt" DATETIME;
ALTER TABLE "Clinic" ADD COLUMN "googleReviewConfirmedBy" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "googleReviewPlace" TEXT;

-- Clinicas que ja tinham o link cadastrado por elas mesmas continuam como estavam. A LISBOA fica de fora: o link dela veio de uma migracao/seed (16/10/2026),
-- nunca foi conferido contra o estabelecimento. Enquanto ninguem confirmar, o link NAO e enviado (a Alice agradece e a pendencia fica para a equipe).
UPDATE "Clinic" SET "googleReviewConfirmedAt" = CURRENT_TIMESTAMP, "googleReviewConfirmedBy" = 'migracao: link ja cadastrado pela clinica'
WHERE "googleReviewUrl" IS NOT NULL AND TRIM("googleReviewUrl") <> '' AND "name" <> 'Lisboa Beauty Center';

ALTER TABLE "SatisfactionSurvey" ADD COLUMN "answeredByMessageId" TEXT;
ALTER TABLE "SatisfactionSurvey" ADD COLUMN "band" TEXT;
ALTER TABLE "SatisfactionSurvey" ADD COLUMN "hasComplaint" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SatisfactionSurvey" ADD COLUMN "linkState" TEXT;

ALTER TABLE "ResumeFlowConfig" ADD COLUMN "delayMinutes" INTEGER;
