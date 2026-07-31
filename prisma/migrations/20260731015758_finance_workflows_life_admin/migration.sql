-- AlterTable
ALTER TABLE "FinanceAccount" ADD COLUMN     "lowBalanceThreshold" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "transferGroupId" TEXT;

-- AlterTable
ALTER TABLE "InboxItem" ADD COLUMN     "taskId" TEXT;

-- AlterTable
ALTER TABLE "ScheduleItem" ADD COLUMN     "taskId" TEXT;

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'monthly',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "rejectedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Budget_userId_category_key" ON "Budget"("userId", "category");

-- CreateIndex
CREATE INDEX "FinanceImportBatch_userId_createdAt_idx" ON "FinanceImportBatch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceImportBatch_accountId_idx" ON "FinanceImportBatch"("accountId");

-- CreateIndex
CREATE INDEX "FinanceTransaction_transferGroupId_idx" ON "FinanceTransaction"("transferGroupId");

-- CreateIndex
CREATE INDEX "FinanceTransaction_importBatchId_idx" ON "FinanceTransaction"("importBatchId");

-- CreateIndex
CREATE INDEX "InboxItem_taskId_idx" ON "InboxItem"("taskId");

-- CreateIndex
CREATE INDEX "ScheduleItem_taskId_idx" ON "ScheduleItem"("taskId");

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "FinanceImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceImportBatch" ADD CONSTRAINT "FinanceImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
