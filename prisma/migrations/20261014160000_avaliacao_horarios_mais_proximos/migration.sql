-- Avaliacao: a Alice oferece sempre os horarios livres mais proximos (hoje, depois amanha), em vez de listar dias.
ALTER TABLE "Clinic" ADD COLUMN "evalNearestFirst" BOOLEAN NOT NULL DEFAULT false;

-- Lisboa (Aline, 14/10/2026): "se tiver horario livre hoje ou amanha, sempre oferecer os mais perto possiveis".
UPDATE "Clinic" SET "evalNearestFirst" = 1 WHERE "name" = 'Lisboa Beauty Center';
