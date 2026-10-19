-- Retomadas / convite de indicacao: MODO DE EXECUCAO RESTRITO para validacao controlada (19/10/2026).
-- Antes, ligar uma retomada a abria para todo o publico elegivel. Agora a configuracao pode ficar "restrita": so os contatos de teste autorizados (ids de pacientes DA
-- CLINICA), com limite de envios do teste. Lista vazia/invalida ou limite ausente BLOQUEIA a execucao (nunca libera todos). O modo de cada decisao fica gravado.
-- Tudo aditivo e com padrao: o comportamento atual ("normal") nao muda.

ALTER TABLE "ResumeFlowConfig" ADD COLUMN "runMode" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "ResumeFlowConfig" ADD COLUMN "testPatientIds" TEXT;
ALTER TABLE "ResumeFlowConfig" ADD COLUMN "testMaxSends" INTEGER;
ALTER TABLE "ResumeFlowConfig" ADD COLUMN "testStartedAt" DATETIME;
ALTER TABLE "FollowUpDispatch" ADD COLUMN "runMode" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "mode" TEXT;
