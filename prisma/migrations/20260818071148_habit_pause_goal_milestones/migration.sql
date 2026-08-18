-- AlterTable
ALTER TABLE "Habit" ADD COLUMN     "pausedFrom" TEXT,
ADD COLUMN     "pausedUntil" TEXT;

-- CreateTable
CREATE TABLE "GoalMilestone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "label" TEXT,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "targetDate" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoalMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoalMilestone_goalId_ordinal_idx" ON "GoalMilestone"("goalId", "ordinal");

-- CreateIndex
CREATE INDEX "GoalMilestone_userId_idx" ON "GoalMilestone"("userId");

-- AddForeignKey
ALTER TABLE "GoalMilestone" ADD CONSTRAINT "GoalMilestone_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
