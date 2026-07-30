-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "birthDate" TEXT,
    "heightCm" DOUBLE PRECISION,
    "sex" TEXT,
    "activityLevel" TEXT NOT NULL DEFAULT 'moderate',
    "theme" TEXT NOT NULL DEFAULT 'system',
    "weekStartsOn" INTEGER NOT NULL DEFAULT 1,
    "unitSystem" TEXT NOT NULL DEFAULT 'imperial',
    "dayStartHour" INTEGER NOT NULL DEFAULT 6,
    "dayEndHour" INTEGER NOT NULL DEFAULT 22,
    "scoreWeights" TEXT,
    "scoreOptionalTasks" BOOLEAN NOT NULL DEFAULT false,
    "onboardingState" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'every_day',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "timesPerWeek" INTEGER,
    "monthDay" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "daypart" TEXT NOT NULL DEFAULT 'anytime',
    "timeMinute" INTEGER,
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reminderMinute" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRuleDay" (
    "ruleId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,

    CONSTRAINT "ScheduleRuleDay_pkey" PRIMARY KEY ("ruleId","weekday")
);

-- CreateTable
CREATE TABLE "ScheduleOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "movedToDate" TEXT,
    "timeMinute" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'demo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeedBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,

    CONSTRAINT "SeedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleItemTag" (
    "scheduleItemId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "ScheduleItemTag_pkey" PRIMARY KEY ("scheduleItemId","tagId")
);

-- CreateTable
CREATE TABLE "ScheduleItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "date" TEXT NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL DEFAULT 'personal',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'planned',
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "recurrenceRule" TEXT,
    "seriesId" TEXT,
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "habitId" TEXT,
    "workoutId" TEXT,
    "mealId" TEXT,
    "templateId" TEXT,
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'personal',
    "items" TEXT NOT NULL DEFAULT '[]',
    "icon" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Habit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'health',
    "icon" TEXT NOT NULL DEFAULT 'Check',
    "color" TEXT NOT NULL DEFAULT 'emerald',
    "timeOfDay" TEXT NOT NULL DEFAULT 'anytime',
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "weekdays" TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
    "targetPerWeek" INTEGER NOT NULL DEFAULT 7,
    "targetValue" DOUBLE PRECISION,
    "unit" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Habit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HabitLog" (
    "id" TEXT NOT NULL,
    "habitId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "value" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HabitLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "description" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'local',
    "externalId" TEXT,
    "barcode" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "source" TEXT,
    "retrievedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "extraNutrients" TEXT,
    "servingOptions" TEXT,
    "completeness" DOUBLE PRECISION,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "basis" TEXT NOT NULL DEFAULT 'per_100g',
    "servingSize" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "servingUnit" TEXT NOT NULL DEFAULT 'g',
    "servingLabel" TEXT,
    "calories" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fiber" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sugar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sodium" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'other',
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "searchKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'breakfast',
    "label" TEXT,
    "time" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealEntry" (
    "id" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "foodItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'serving',
    "calories" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL,
    "carbs" DOUBLE PRECISION NOT NULL,
    "fat" DOUBLE PRECISION NOT NULL,
    "fiber" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sugar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sodium" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "foodNameAtLog" TEXT,
    "basisAtLog" TEXT,
    "servingSizeAtLog" DOUBLE PRECISION,
    "servingUnitAtLog" TEXT,
    "gramsAtLog" DOUBLE PRECISION,
    "extraNutrientsAtLog" TEXT,
    "idempotencyKey" TEXT,
    "templateId" TEXT,
    "sourceKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mealType" TEXT NOT NULL DEFAULT 'breakfast',
    "notes" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealTemplateItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "foodItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'serving',

    CONSTRAINT "MealTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'strength',
    "durationMin" INTEGER NOT NULL DEFAULT 0,
    "intensity" TEXT NOT NULL DEFAULT 'moderate',
    "caloriesBurned" INTEGER,
    "avgHeartRate" INTEGER,
    "maxHeartRate" INTEGER,
    "distanceKm" DOUBLE PRECISION,
    "elevationM" DOUBLE PRECISION,
    "perceivedEffort" INTEGER,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "restSecDefault" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "externalId" TEXT,
    "importBatchId" TEXT,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutSet" (
    "id" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "exercise" TEXT NOT NULL,
    "setNumber" INTEGER NOT NULL DEFAULT 1,
    "reps" INTEGER,
    "weightKg" DOUBLE PRECISION,
    "durationSec" INTEGER,
    "distanceM" DOUBLE PRECISION,
    "restSec" INTEGER,
    "rpe" DOUBLE PRECISION,
    "notes" TEXT,
    "targetReps" INTEGER,
    "targetWeightKg" DOUBLE PRECISION,
    "completed" BOOLEAN NOT NULL DEFAULT true,
    "completedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkoutSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'strength',
    "description" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 45,
    "intensity" TEXT NOT NULL DEFAULT 'moderate',
    "exercises" TEXT NOT NULL DEFAULT '[]',
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkoutTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "subtype" TEXT,
    "secondaryValue" DOUBLE PRECISION,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "notes" TEXT,
    "recordedAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceApp" TEXT,
    "sourceDevice" TEXT,
    "externalId" TEXT,
    "sampleCount" INTEGER,
    "fingerprint" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "dateFrom" TEXT,
    "dateTo" TEXT,
    "categories" TEXT NOT NULL DEFAULT '[]',
    "examined" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "workoutsImported" INTEGER NOT NULL DEFAULT 0,
    "workoutsSkipped" INTEGER NOT NULL DEFAULT 0,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "target" DOUBLE PRECISION NOT NULL,
    "targetMax" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT '',
    "direction" TEXT NOT NULL DEFAULT 'gte',
    "period" TEXT NOT NULL DEFAULT 'daily',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalEntry" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "value" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarDaySummary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "habitsDue" INTEGER NOT NULL DEFAULT 0,
    "habitsDone" INTEGER NOT NULL DEFAULT 0,
    "calories" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protein" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "workoutCount" INTEGER NOT NULL DEFAULT 0,
    "workoutMinutes" INTEGER NOT NULL DEFAULT 0,
    "caloriesBurned" INTEGER NOT NULL DEFAULT 0,
    "steps" DOUBLE PRECISION,
    "sleepHours" DOUBLE PRECISION,
    "bodyWeight" DOUBLE PRECISION,
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreApplicable" INTEGER NOT NULL DEFAULT 0,
    "scoreCompleted" INTEGER NOT NULL DEFAULT 0,
    "scoreMissed" INTEGER NOT NULL DEFAULT 0,
    "scorePending" INTEGER NOT NULL DEFAULT 0,
    "scoreExcluded" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarDaySummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "mood" INTEGER,
    "energy" INTEGER,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "repeat" TEXT NOT NULL DEFAULT 'none',
    "scheduleItemId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FavoriteItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ScheduleRule_userId_ownerType_ownerId_effectiveFrom_idx" ON "ScheduleRule"("userId", "ownerType", "ownerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ScheduleRule_ownerType_ownerId_idx" ON "ScheduleRule"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "ScheduleRuleDay_weekday_idx" ON "ScheduleRuleDay"("weekday");

-- CreateIndex
CREATE INDEX "ScheduleOverride_userId_date_idx" ON "ScheduleOverride"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleOverride_ownerType_ownerId_date_key" ON "ScheduleOverride"("ownerType", "ownerId", "date");

-- CreateIndex
CREATE INDEX "SeedBatch_userId_kind_idx" ON "SeedBatch"("userId", "kind");

-- CreateIndex
CREATE INDEX "SeedRecord_batchId_idx" ON "SeedRecord"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedRecord_model_recordId_key" ON "SeedRecord"("model", "recordId");

-- CreateIndex
CREATE INDEX "Tag_userId_idx" ON "Tag"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_name_key" ON "Tag"("userId", "name");

-- CreateIndex
CREATE INDEX "ScheduleItemTag_tagId_idx" ON "ScheduleItemTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleItem_workoutId_key" ON "ScheduleItem"("workoutId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleItem_mealId_key" ON "ScheduleItem"("mealId");

-- CreateIndex
CREATE INDEX "ScheduleItem_userId_date_idx" ON "ScheduleItem"("userId", "date");

-- CreateIndex
CREATE INDEX "ScheduleItem_userId_status_idx" ON "ScheduleItem"("userId", "status");

-- CreateIndex
CREATE INDEX "ScheduleItem_seriesId_idx" ON "ScheduleItem"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleItem_userId_date_templateId_sourceKey_key" ON "ScheduleItem"("userId", "date", "templateId", "sourceKey");

-- CreateIndex
CREATE INDEX "ScheduleTemplate_userId_idx" ON "ScheduleTemplate"("userId");

-- CreateIndex
CREATE INDEX "Habit_userId_archived_idx" ON "Habit"("userId", "archived");

-- CreateIndex
CREATE INDEX "HabitLog_userId_date_idx" ON "HabitLog"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "HabitLog_habitId_date_key" ON "HabitLog"("habitId", "date");

-- CreateIndex
CREATE INDEX "FoodItem_searchKey_idx" ON "FoodItem"("searchKey");

-- CreateIndex
CREATE INDEX "FoodItem_userId_idx" ON "FoodItem"("userId");

-- CreateIndex
CREATE INDEX "FoodItem_barcode_idx" ON "FoodItem"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "FoodItem_provider_externalId_key" ON "FoodItem"("provider", "externalId");

-- CreateIndex
CREATE INDEX "Meal_userId_date_idx" ON "Meal"("userId", "date");

-- CreateIndex
CREATE INDEX "MealEntry_mealId_idx" ON "MealEntry"("mealId");

-- CreateIndex
CREATE UNIQUE INDEX "MealEntry_mealId_idempotencyKey_key" ON "MealEntry"("mealId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MealEntry_mealId_templateId_sourceKey_key" ON "MealEntry"("mealId", "templateId", "sourceKey");

-- CreateIndex
CREATE INDEX "MealTemplate_userId_idx" ON "MealTemplate"("userId");

-- CreateIndex
CREATE INDEX "MealTemplateItem_templateId_idx" ON "MealTemplateItem"("templateId");

-- CreateIndex
CREATE INDEX "Workout_userId_date_idx" ON "Workout"("userId", "date");

-- CreateIndex
CREATE INDEX "Workout_userId_type_idx" ON "Workout"("userId", "type");

-- CreateIndex
CREATE INDEX "Workout_importBatchId_idx" ON "Workout"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Workout_userId_source_externalId_key" ON "Workout"("userId", "source", "externalId");

-- CreateIndex
CREATE INDEX "WorkoutSet_workoutId_idx" ON "WorkoutSet"("workoutId");

-- CreateIndex
CREATE INDEX "WorkoutTemplate_userId_idx" ON "WorkoutTemplate"("userId");

-- CreateIndex
CREATE INDEX "HealthMetric_userId_type_date_idx" ON "HealthMetric"("userId", "type", "date");

-- CreateIndex
CREATE INDEX "HealthMetric_userId_date_idx" ON "HealthMetric"("userId", "date");

-- CreateIndex
CREATE INDEX "HealthMetric_batchId_idx" ON "HealthMetric"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthMetric_userId_fingerprint_key" ON "HealthMetric"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "HealthImportBatch_userId_createdAt_idx" ON "HealthImportBatch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Goal_userId_domain_metric_idx" ON "Goal"("userId", "domain", "metric");

-- CreateIndex
CREATE INDEX "Goal_userId_active_idx" ON "Goal"("userId", "active");

-- CreateIndex
CREATE INDEX "GoalEntry_userId_date_idx" ON "GoalEntry"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GoalEntry_goalId_date_key" ON "GoalEntry"("goalId", "date");

-- CreateIndex
CREATE INDEX "CalendarDaySummary_userId_date_idx" ON "CalendarDaySummary"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarDaySummary_userId_date_key" ON "CalendarDaySummary"("userId", "date");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_date_idx" ON "JournalEntry"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_userId_date_key" ON "JournalEntry"("userId", "date");

-- CreateIndex
CREATE INDEX "Reminder_userId_enabled_idx" ON "Reminder"("userId", "enabled");

-- CreateIndex
CREATE INDEX "ReminderDelivery_userId_deliveredAt_idx" ON "ReminderDelivery"("userId", "deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderDelivery_userId_key_key" ON "ReminderDelivery"("userId", "key");

-- CreateIndex
CREATE INDEX "FavoriteItem_userId_kind_idx" ON "FavoriteItem"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FavoriteItem_userId_kind_refId_key" ON "FavoriteItem"("userId", "kind", "refId");

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleRuleDay" ADD CONSTRAINT "ScheduleRuleDay_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ScheduleRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedBatch" ADD CONSTRAINT "SeedBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedRecord" ADD CONSTRAINT "SeedRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SeedBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItemTag" ADD CONSTRAINT "ScheduleItemTag_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "ScheduleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItemTag" ADD CONSTRAINT "ScheduleItemTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "ScheduleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "Habit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "Workout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ScheduleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleTemplate" ADD CONSTRAINT "ScheduleTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Habit" ADD CONSTRAINT "Habit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HabitLog" ADD CONSTRAINT "HabitLog_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "Habit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HabitLog" ADD CONSTRAINT "HabitLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodItem" ADD CONSTRAINT "FoodItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meal" ADD CONSTRAINT "Meal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealEntry" ADD CONSTRAINT "MealEntry_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealEntry" ADD CONSTRAINT "MealEntry_foodItemId_fkey" FOREIGN KEY ("foodItemId") REFERENCES "FoodItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealTemplate" ADD CONSTRAINT "MealTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealTemplateItem" ADD CONSTRAINT "MealTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MealTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealTemplateItem" ADD CONSTRAINT "MealTemplateItem_foodItemId_fkey" FOREIGN KEY ("foodItemId") REFERENCES "FoodItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workout" ADD CONSTRAINT "Workout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workout" ADD CONSTRAINT "Workout_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkoutTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutSet" ADD CONSTRAINT "WorkoutSet_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "Workout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutTemplate" ADD CONSTRAINT "WorkoutTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthMetric" ADD CONSTRAINT "HealthMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthMetric" ADD CONSTRAINT "HealthMetric_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HealthImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthImportBatch" ADD CONSTRAINT "HealthImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalEntry" ADD CONSTRAINT "GoalEntry_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarDaySummary" ADD CONSTRAINT "CalendarDaySummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "ScheduleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDelivery" ADD CONSTRAINT "ReminderDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteItem" ADD CONSTRAINT "FavoriteItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
