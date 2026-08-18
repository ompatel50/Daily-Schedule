-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "rollover" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "FinanceAccount" ADD COLUMN     "creditLimit" DOUBLE PRECISION,
ADD COLUMN     "statementDueDay" INTEGER;

-- CreateTable
CREATE TABLE "BillSuggestionDismissal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payeeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillSuggestionDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillSuggestionDismissal_userId_payeeKey_key" ON "BillSuggestionDismissal"("userId", "payeeKey");

-- AddForeignKey
ALTER TABLE "BillSuggestionDismissal" ADD CONSTRAINT "BillSuggestionDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
