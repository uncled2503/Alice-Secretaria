-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" REAL,
    "description" TEXT,
    "photoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Procedure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 60,
    "description" TEXT,
    "price" REAL,
    "priceVariable" BOOLEAN NOT NULL DEFAULT false,
    "offerInstallments" BOOLEAN NOT NULL DEFAULT false,
    "maxInstallments" INTEGER,
    "paymentMethods" TEXT NOT NULL DEFAULT '',
    "paymentLink" TEXT,
    "goals" TEXT,
    "benefits" TEXT,
    "aliases" TEXT,
    "resultTimeline" TEXT,
    CONSTRAINT "Procedure_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Procedure" ("clinicId", "description", "durationMin", "id", "name") SELECT "clinicId", "description", "durationMin", "id", "name" FROM "Procedure";
DROP TABLE "Procedure";
ALTER TABLE "new_Procedure" RENAME TO "Procedure";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

