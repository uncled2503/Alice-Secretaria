-- Aniversario: data de nascimento do paciente
ALTER TABLE "Patient" ADD COLUMN "birthDate" DATETIME;

-- Recontato: nome, tempo em minutos, modo de repeticao, guardas e janela de envio
ALTER TABLE "FollowUpRule" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "FollowUpRule" ADD COLUMN "afterMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FollowUpRule" ADD COLUMN "repeatMode" TEXT NOT NULL DEFAULT 'every_silence';
ALTER TABLE "FollowUpRule" ADD COLUMN "skipIfHumanTakeover" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FollowUpRule" ADD COLUMN "skipIfUpcomingAppt" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "FollowUpRule" ADD COLUMN "sendWindowStart" INTEGER;
ALTER TABLE "FollowUpRule" ADD COLUMN "sendWindowEnd" INTEGER;

-- Renovacao
CREATE TABLE "RenewalRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "intervalValue" INTEGER NOT NULL DEFAULT 1,
    "intervalUnit" TEXT NOT NULL DEFAULT 'months',
    "onlyIfCompleted" BOOLEAN NOT NULL DEFAULT true,
    "procedureIds" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenewalRule_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "RenewalSent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appointmentId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenewalSent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RenewalSent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RenewalRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RenewalSent_appointmentId_ruleId_key" ON "RenewalSent"("appointmentId", "ruleId");

-- Aniversario
CREATE TABLE "BirthdayRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sendHour" INTEGER NOT NULL DEFAULT 9,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BirthdayRule_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BirthdaySent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BirthdaySent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BirthdaySent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "BirthdayRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BirthdaySent_patientId_ruleId_year_key" ON "BirthdaySent"("patientId", "ruleId", "year");
