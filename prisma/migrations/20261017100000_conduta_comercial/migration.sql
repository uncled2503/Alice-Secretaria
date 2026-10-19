-- Conducao comercial (17/10/2026, Lisboa): regras por clinica/procedimento, todas opcionais e sem alterar dado existente.
ALTER TABLE "Clinic" ADD COLUMN "strictBookingRules" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "notOfferedServices" TEXT;
ALTER TABLE "Procedure" ADD COLUMN "bookingMode" TEXT;
