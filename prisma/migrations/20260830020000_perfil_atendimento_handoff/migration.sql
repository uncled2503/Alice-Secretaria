-- Perfil de atendimento da clinica
ALTER TABLE "Clinic" ADD COLUMN "servicePosture" TEXT NOT NULL DEFAULT 'comercial';
ALTER TABLE "Clinic" ADD COLUMN "clinicKind" TEXT NOT NULL DEFAULT 'estetica';
ALTER TABLE "Clinic" ADD COLUMN "evaluationFirst" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "allowEmojis" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Clinic" ADD COLUMN "schedulingLink" TEXT;

-- Motivo do handoff para humano
ALTER TABLE "Conversation" ADD COLUMN "handoffReason" TEXT;
