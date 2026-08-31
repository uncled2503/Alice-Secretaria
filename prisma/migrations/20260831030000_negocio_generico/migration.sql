-- A Alice deixa de ser exclusiva de clinica. businessType controla o
-- vocabulario e o comportamento do atendimento:
--   clinica -> paciente, procedimentos, agenda, seguranca medica (padrao)
--   geral   -> cliente, catalogo/FAQ, sem agenda (loja, servico, etc.)
-- businessLabel e o rotulo livre do negocio (ex: "loja de roupas infantis").
ALTER TABLE "Clinic" ADD COLUMN "businessType" TEXT NOT NULL DEFAULT 'clinica';
ALTER TABLE "Clinic" ADD COLUMN "businessLabel" TEXT;
