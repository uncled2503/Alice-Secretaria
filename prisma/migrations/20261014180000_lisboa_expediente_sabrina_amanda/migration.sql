-- Lisboa (Aline, 14/10/2026): expediente das biomedicas. A Alice oferecia "terca 09:30" com a Dra. Sabrina, que so atende
-- terca e quinta das 12h as 21h; o expediente dela herdava o da clinica (seg-sex 8h-21h).
UPDATE "Professional"
SET "workDays" = '2,4', "workStartHour" = 12, "workStartMinute" = 0, "workEndHour" = 21, "workEndMinute" = 0
WHERE "name" LIKE '%Sabrina%' AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');

-- Dra. Amanda: so aos sabados, das 8h as 15h.
UPDATE "Professional"
SET "workDays" = '6', "workStartHour" = 8, "workStartMinute" = 0, "workEndHour" = 15, "workEndMinute" = 0
WHERE "name" LIKE '%Amanda%' AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
