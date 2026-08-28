-- Como a Alice se apresenta no atendimento (nunca como IA/assistente virtual).
ALTER TABLE "Clinic" ADD COLUMN "assistantPersona" TEXT NOT NULL DEFAULT 'team';
ALTER TABLE "Clinic" ADD COLUMN "assistantPersonaName" TEXT;
