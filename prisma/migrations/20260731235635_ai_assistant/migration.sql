-- AlterTable
ALTER TABLE "User" ADD COLUMN     "assistantBaseUrl" TEXT,
ADD COLUMN     "assistantMode" TEXT NOT NULL DEFAULT 'readonly',
ADD COLUMN     "assistantModel" TEXT;

-- CreateTable
CREATE TABLE "AssistantProposal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "requestPreview" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedRecordId" TEXT,
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantAuditEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "requestPreview" TEXT NOT NULL DEFAULT '',
    "toolCalls" TEXT NOT NULL DEFAULT '[]',
    "proposalId" TEXT,
    "model" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantAuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantProposal_userId_status_idx" ON "AssistantProposal"("userId", "status");

-- CreateIndex
CREATE INDEX "AssistantProposal_userId_createdAt_idx" ON "AssistantProposal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantProposal_expiresAt_idx" ON "AssistantProposal"("expiresAt");

-- CreateIndex
CREATE INDEX "AssistantAuditEntry_userId_createdAt_idx" ON "AssistantAuditEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantAuditEntry_userId_kind_idx" ON "AssistantAuditEntry"("userId", "kind");

-- AddForeignKey
ALTER TABLE "AssistantProposal" ADD CONSTRAINT "AssistantProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantAuditEntry" ADD CONSTRAINT "AssistantAuditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
