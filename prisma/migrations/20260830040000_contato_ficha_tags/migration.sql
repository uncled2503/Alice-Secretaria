-- Campos de ficha do contato
ALTER TABLE "Patient" ADD COLUMN "email" TEXT;
ALTER TABLE "Patient" ADD COLUMN "cpf" TEXT;
ALTER TABLE "Patient" ADD COLUMN "notes" TEXT;

-- Etiquetas
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#8b5cf6',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tag_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Tag_clinicId_label_key" ON "Tag"("clinicId", "label");

CREATE TABLE "PatientTag" (
    "patientId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    PRIMARY KEY ("patientId", "tagId"),
    CONSTRAINT "PatientTag_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PatientTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PatientTag_tagId_idx" ON "PatientTag"("tagId");
