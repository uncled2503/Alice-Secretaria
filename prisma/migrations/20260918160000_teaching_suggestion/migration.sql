-- Caixa de entrada unica "O que voce quer ensinar pra Alice hoje?": o texto
-- livre do admin passa por uma IA que decide o destino certo (regra, roteiro,
-- mensagem pronta ou FAQ) antes de aplicar - fica pendente ate ser aprovado.

CREATE TABLE "TeachingSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "rawInput" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "clarifyingQuestion" TEXT,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeachingSuggestion_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TeachingSuggestion_clinicId_status_idx" ON "TeachingSuggestion"("clinicId", "status");
