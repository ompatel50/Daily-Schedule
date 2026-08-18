-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "preTransferCategory" TEXT;

-- CreateTable
CREATE TABLE "TransferDismissal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransferDismissal_aId_idx" ON "TransferDismissal"("aId");

-- CreateIndex
CREATE INDEX "TransferDismissal_bId_idx" ON "TransferDismissal"("bId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferDismissal_userId_aId_bId_key" ON "TransferDismissal"("userId", "aId", "bId");

-- AddForeignKey
ALTER TABLE "TransferDismissal" ADD CONSTRAINT "TransferDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferDismissal" ADD CONSTRAINT "TransferDismissal_aId_fkey" FOREIGN KEY ("aId") REFERENCES "FinanceTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferDismissal" ADD CONSTRAINT "TransferDismissal_bId_fkey" FOREIGN KEY ("bId") REFERENCES "FinanceTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
