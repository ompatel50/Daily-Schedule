-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "amountCents" INTEGER;

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "amountCents" INTEGER;

-- AlterTable
ALTER TABLE "FinanceAccount" ADD COLUMN     "creditLimitCents" INTEGER,
ADD COLUMN     "lowBalanceThresholdCents" INTEGER,
ADD COLUMN     "openingBalanceCents" INTEGER;

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "amountCents" INTEGER;

-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "currentAmountCents" INTEGER,
ADD COLUMN     "targetAmountCents" INTEGER;

-- Backfill: integer cents from the legacy float columns. CAST to numeric
-- first: a float that was moneyRound-ed on write (all of them were) prints as
-- its exact 2-decimal value, so ×100 is exact and ROUND never faces a tie.
-- WHERE ... IS NULL keeps re-runs (and partially backfilled rows) untouched.
UPDATE "FinanceAccount" SET "openingBalanceCents" = CAST(ROUND(CAST("openingBalance" AS numeric) * 100) AS integer) WHERE "openingBalanceCents" IS NULL;
UPDATE "FinanceAccount" SET "lowBalanceThresholdCents" = CAST(ROUND(CAST("lowBalanceThreshold" AS numeric) * 100) AS integer) WHERE "lowBalanceThresholdCents" IS NULL AND "lowBalanceThreshold" IS NOT NULL;
UPDATE "FinanceAccount" SET "creditLimitCents" = CAST(ROUND(CAST("creditLimit" AS numeric) * 100) AS integer) WHERE "creditLimitCents" IS NULL AND "creditLimit" IS NOT NULL;
UPDATE "FinanceTransaction" SET "amountCents" = CAST(ROUND(CAST("amount" AS numeric) * 100) AS integer) WHERE "amountCents" IS NULL;
UPDATE "Bill" SET "amountCents" = CAST(ROUND(CAST("amount" AS numeric) * 100) AS integer) WHERE "amountCents" IS NULL;
UPDATE "Budget" SET "amountCents" = CAST(ROUND(CAST("amount" AS numeric) * 100) AS integer) WHERE "amountCents" IS NULL;
UPDATE "SavingsGoal" SET "targetAmountCents" = CAST(ROUND(CAST("targetAmount" AS numeric) * 100) AS integer) WHERE "targetAmountCents" IS NULL;
UPDATE "SavingsGoal" SET "currentAmountCents" = CAST(ROUND(CAST("currentAmount" AS numeric) * 100) AS integer) WHERE "currentAmountCents" IS NULL;
