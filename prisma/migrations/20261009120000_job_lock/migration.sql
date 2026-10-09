-- Concessao de tarefa agendada: so uma copia do servidor roda cada tarefa por vez.
CREATE TABLE "JobLock" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "holder" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);
