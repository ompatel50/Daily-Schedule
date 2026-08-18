-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FinanceAccount" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Habit" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InboxItem" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LifeDocument" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Meal" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ScheduleItem" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Workout" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Bill_userId_deletedAt_idx" ON "Bill"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Budget_userId_deletedAt_idx" ON "Budget"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "FinanceAccount_userId_deletedAt_idx" ON "FinanceAccount"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "FinanceTransaction_userId_deletedAt_idx" ON "FinanceTransaction"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Goal_userId_deletedAt_idx" ON "Goal"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Habit_userId_deletedAt_idx" ON "Habit"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "InboxItem_userId_deletedAt_idx" ON "InboxItem"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_deletedAt_idx" ON "JournalEntry"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "LifeDocument_userId_deletedAt_idx" ON "LifeDocument"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Meal_userId_deletedAt_idx" ON "Meal"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Project_userId_deletedAt_idx" ON "Project"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Reminder_userId_deletedAt_idx" ON "Reminder"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_deletedAt_idx" ON "SavingsGoal"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "ScheduleItem_userId_deletedAt_idx" ON "ScheduleItem"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Task_userId_deletedAt_idx" ON "Task"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Workout_userId_deletedAt_idx" ON "Workout"("userId", "deletedAt");
