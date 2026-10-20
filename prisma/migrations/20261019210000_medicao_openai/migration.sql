-- Medicao persistente do uso da OpenAI (sem conteudo de conversa nem dado pessoal). So tabelas novas.
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clinicId" TEXT,
    "conversationId" TEXT,
    "traceId" TEXT,
    "purpose" TEXT NOT NULL,
    "requestedModel" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "usageState" TEXT NOT NULL DEFAULT 'known',
    "errorKind" TEXT,
    "attemptReason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "AiCall_at_idx" ON "AiCall"("at");
CREATE INDEX "AiCall_clinicId_at_idx" ON "AiCall"("clinicId", "at");
CREATE INDEX "AiCall_traceId_idx" ON "AiCall"("traceId");

CREATE TABLE "AiUsageDaily" (
    "day" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL DEFAULT '',
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "calls" INTEGER NOT NULL DEFAULT 0,
    "okCalls" INTEGER NOT NULL DEFAULT 0,
    "errorCalls" INTEGER NOT NULL DEFAULT 0,
    "unknownCalls" INTEGER NOT NULL DEFAULT 0,
    "notSentCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("day", "clinicId", "purpose", "model")
);
