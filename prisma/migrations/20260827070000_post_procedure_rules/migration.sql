-- CreateTable
CREATE TABLE "PostProcedureRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "intervalValue" INTEGER NOT NULL DEFAULT 1,
    "intervalUnit" TEXT NOT NULL DEFAULT 'days',
    "onlyIfCompleted" BOOLEAN NOT NULL DEFAULT true,
    "procedureIds" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostProcedureRule_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostProcedureSent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appointmentId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostProcedureSent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PostProcedureSent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PostProcedureRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PostProcedureSent_appointmentId_ruleId_key" ON "PostProcedureSent"("appointmentId", "ruleId");

