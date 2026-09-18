-- Chave Pix dedicada por procedimento (antes disso, clinicas colavam a
-- chave pix no campo "Link de pagamento" por falta de campo proprio) e
-- galeria de fotos de exemplo (antes/depois) que a Alice pode enviar quando
-- o paciente pedir resultado. Aditivo, nada muda pro que ja existe.

ALTER TABLE "Procedure" ADD COLUMN "pixKey" TEXT;

CREATE TABLE "ProcedurePhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "procedureId" TEXT NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "caption" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcedurePhoto_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProcedurePhoto_procedureId_idx" ON "ProcedurePhoto"("procedureId");
