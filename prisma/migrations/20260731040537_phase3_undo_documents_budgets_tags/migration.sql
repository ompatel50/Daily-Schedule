-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "alertThresholdPercent" INTEGER;

-- AlterTable
ALTER TABLE "FinanceImportBatch" ADD COLUMN     "keptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "undoneAt" TIMESTAMP(3),
ADD COLUMN     "undoneCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TaskTag" (
    "taskId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TaskTag_pkey" PRIMARY KEY ("taskId","tagId")
);

-- CreateTable
CREATE TABLE "LifeDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "issuer" TEXT,
    "expiryDate" TEXT NOT NULL,
    "notes" TEXT,
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 30,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskTag_tagId_idx" ON "TaskTag"("tagId");

-- CreateIndex
CREATE INDEX "LifeDocument_userId_expiryDate_idx" ON "LifeDocument"("userId", "expiryDate");

-- CreateIndex
CREATE INDEX "LifeDocument_userId_archivedAt_idx" ON "LifeDocument"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "Budget_userId_alertThresholdPercent_idx" ON "Budget"("userId", "alertThresholdPercent");

-- AddForeignKey
ALTER TABLE "TaskTag" ADD CONSTRAINT "TaskTag_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTag" ADD CONSTRAINT "TaskTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifeDocument" ADD CONSTRAINT "LifeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
