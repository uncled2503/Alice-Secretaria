ALTER TABLE "ReminderRule" ADD COLUMN "pauseMinSec" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "ReminderRule" ADD COLUMN "pauseMaxSec" INTEGER NOT NULL DEFAULT 45;
ALTER TABLE "ReminderRule" ADD COLUMN "scheduledChange" TEXT;

-- Lisboa: HOJE (08/10) continua o horario normal (dia seguinte 12h-18h, do dia 7h-12h, pausa 15-45s).
-- A partir de AMANHA (09/10, 00:00 de Sao Paulo) entram: dia seguinte 8h-11h, do dia 7h-8h, pausa 10-30s.
UPDATE "ReminderRule" SET "sendHour" = 12, "sendMinute" = 0, "sendEndHour" = 18, "pauseMinSec" = 15, "pauseMaxSec" = 45,
  "scheduledChange" = '{"from":"2026-10-09T03:00:00.000Z","sendHour":8,"sendMinute":0,"sendEndHour":11,"pauseMinSec":10,"pauseMaxSec":30}'
WHERE "dayOffset" = 1 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "ReminderRule" SET "sendHour" = 7, "sendMinute" = 0, "sendEndHour" = 12, "pauseMinSec" = 15, "pauseMaxSec" = 45,
  "scheduledChange" = '{"from":"2026-10-09T03:00:00.000Z","sendHour":7,"sendMinute":0,"sendEndHour":8,"pauseMinSec":10,"pauseMaxSec":30}'
WHERE "dayOffset" = 0 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
