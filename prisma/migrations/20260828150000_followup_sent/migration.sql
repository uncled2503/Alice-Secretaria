-- Trava de envio unico por conversa (repeatMode = "once")
CREATE TABLE "FollowUpSent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowUpSent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FollowUpSent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "FollowUpRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FollowUpSent_conversationId_ruleId_key" ON "FollowUpSent"("conversationId", "ruleId");
