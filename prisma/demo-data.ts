/**
 * THE demo-data generator — ~10 weeks of realistic history so every chart,
 * streak and heatmap has something to show.
 *
 * Two callers, one implementation (a second generator would be the exact
 * duplication this upgrade exists to remove):
 *
 *  * `prisma/seed.ts` — the CLI (`npm run db:seed` / `npm run setup`), which
 *    wipes the user's records first so re-seeding gives a fresh, consistent
 *    dataset rather than duplicates.
 *  * the in-app "Start with sample data" action, offered only while the
 *    database is empty — where the wipe is a no-op by construction.
 *
 * Every record written here is registered in a `SeedBatch`/`SeedRecord` pair
 * afterwards, which is what makes "remove the demo data" possible without
 * touching anything the user made themselves. The bundled food table is *not*
 * part of the batch: foods are shared reference data (`userId: null`), not
 * records about the user, and removing the demo must not empty the food search.
 *
 * The user row is never overwritten: the CLI upsert only ever creates, and the
 * in-app path passes the existing user through untouched.
 */
import type { DbClient } from "./db-client";
import { hashPassword } from "../scripts/lib/password-hash.mjs";

/** CLI-seed sign-in for local development; printed by `npm run db:seed`. */
export const LOCAL_DEV_PASSWORD = "local-dev-password";
import { addDays, addMonths, format, startOfMonth, subDays, subMonths } from "date-fns";

import { SEED_FOODS } from "../src/lib/data/foods";
import { moneyRound } from "../src/lib/logic/finance";
import { fingerprintFor, manualDailyFingerprint } from "../src/lib/logic/health-import/rollup";
import { IMPORT_FORMAT_VERSION } from "../src/lib/logic/health-import/version";
// The seed calls the app's real aggregation rather than keeping its own copy of
// the scoring formula. It used to duplicate scoreDay() by hand, which meant
// seeded history and live recomputation could drift apart silently.
import { rebuildSummaries } from "../src/server/summaries";

/** The span the generator writes, exported so removal knows what to recompute. */
export const HISTORY_DAYS = 70;
export const FUTURE_DAYS = 14;

export const DEMO_BATCH_LABEL = "Sample data";

export interface SeedCounts {
  scheduleItems: number;
  habits: number;
  habitLogs: number;
  meals: number;
  workouts: number;
  metrics: number;
  foods: number;
  tasks: number;
  transactions: number;
  documents: number;
  seedRecords: number;
}

export interface SeedOptions {
  /** Seed for this existing user instead of upserting the demo profile. */
  userId?: string;
}

const day = (offset: number) => format(addDays(new Date(), offset), "yyyy-MM-dd");

/** Deterministic pseudo-random so re-seeding produces the same-looking data. */
let seedState = 42;
function random(): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
function chance(probability: number): boolean {
  return random() < probability;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)];
}
function between(min: number, max: number): number {
  return min + random() * (max - min);
}
function intBetween(min: number, max: number): number {
  return Math.round(between(min, max));
}

export async function seedDemoData(
  prisma: DbClient,
  options: SeedOptions = {},
): Promise<SeedCounts> {
  console.log("Seeding Personal OS…");

  // Deterministic from the top on every run, so re-seeding produces the same
  // data even when this module stays loaded between calls.
  seedState = 42;

  // --- user ----------------------------------------------------------------
  // `update: {}` is deliberate: seeding must never overwrite settings on a
  // user that already exists. The in-app path names its user explicitly.
  const user = options.userId
    ? await prisma.user.findUniqueOrThrow({ where: { id: options.userId } })
    : await prisma.user.upsert({
        where: { email: "you@local" },
        create: {
          name: "Om",
          email: "you@local",
          timezone: "America/New_York",
          birthDate: "1996-05-14",
          heightCm: 180,
          sex: "male",
          activityLevel: "active",
          unitSystem: "imperial",
          weekStartsOn: 1,
          dayStartHour: 6,
          dayEndHour: 22,
        },
        update: {},
      });

  // CLI seeding only (never the in-app sample-data path): give the local dev
  // account a password so `npm run setup` ends with a sign-in that works.
  // The seed CLI refuses non-local databases, so this known password can
  // never reach a hosted deployment. Existing passwords are never touched.
  if (!options.userId) {
    const cred = await prisma.user.findUniqueOrThrow({
      where: { email: "you@local" },
      select: { passwordHash: true },
    });
    if (!cred.passwordHash) {
      await prisma.user.update({
        where: { email: "you@local" },
        data: {
          passwordHash: await hashPassword(LOCAL_DEV_PASSWORD),
          passwordUpdatedAt: new Date(),
        },
      });
    }
    console.log(`Local sign-in: you@local / ${LOCAL_DEV_PASSWORD}`);
  }

  // Clear this user's records so re-seeding is clean. On the in-app path the
  // database is empty by precondition, so this deletes nothing.
  await prisma.seedRecord.deleteMany({ where: { batch: { userId: user.id } } });
  await prisma.seedBatch.deleteMany({ where: { userId: user.id } });
  await prisma.scheduleItemTag.deleteMany({ where: { scheduleItem: { userId: user.id } } });
  await prisma.mealEntry.deleteMany({ where: { meal: { userId: user.id } } });
  await prisma.mealTemplateItem.deleteMany({ where: { template: { userId: user.id } } });
  await prisma.workoutSet.deleteMany({ where: { workout: { userId: user.id } } });
  await prisma.scheduleItem.deleteMany({ where: { userId: user.id } });
  await prisma.meal.deleteMany({ where: { userId: user.id } });
  await prisma.mealTemplate.deleteMany({ where: { userId: user.id } });
  await prisma.workout.deleteMany({ where: { userId: user.id } });
  await prisma.workoutTemplate.deleteMany({ where: { userId: user.id } });
  await prisma.scheduleTemplate.deleteMany({ where: { userId: user.id } });
  await prisma.habitLog.deleteMany({ where: { userId: user.id } });
  await prisma.habit.deleteMany({ where: { userId: user.id } });
  await prisma.healthRecord.deleteMany({ where: { userId: user.id } });
  await prisma.healthMetric.deleteMany({ where: { userId: user.id } });
  await prisma.healthImportBatch.deleteMany({ where: { userId: user.id } });
  await prisma.journalEntry.deleteMany({ where: { userId: user.id } });
  await prisma.reminder.deleteMany({ where: { userId: user.id } });
  await prisma.favoriteItem.deleteMany({ where: { userId: user.id } });
  await prisma.goalEntry.deleteMany({ where: { userId: user.id } });
  await prisma.goal.deleteMany({ where: { userId: user.id } });
  // Schedules are polymorphic, so they are cleared explicitly rather than
  // cascading from the goal/habit rows.
  await prisma.scheduleRule.deleteMany({ where: { userId: user.id } });
  await prisma.scheduleOverride.deleteMany({ where: { userId: user.id } });
  // Life-admin modules: children before parents, so nothing is orphaned
  // mid-wipe. (TaskTag also cascades from either end; deleting it explicitly
  // keeps this list readable as "everything the generator writes".)
  await prisma.taskTag.deleteMany({ where: { task: { userId: user.id } } });
  await prisma.financeTransaction.deleteMany({ where: { userId: user.id } });
  await prisma.bill.deleteMany({ where: { userId: user.id } });
  await prisma.financeImportBatch.deleteMany({ where: { userId: user.id } });
  await prisma.budget.deleteMany({ where: { userId: user.id } });
  await prisma.savingsGoal.deleteMany({ where: { userId: user.id } });
  await prisma.financeAccount.deleteMany({ where: { userId: user.id } });
  await prisma.inboxItem.deleteMany({ where: { userId: user.id } });
  await prisma.task.deleteMany({ where: { userId: user.id } });
  await prisma.project.deleteMany({ where: { userId: user.id } });
  await prisma.lifeDocument.deleteMany({ where: { userId: user.id } });
  await prisma.tag.deleteMany({ where: { userId: user.id } });
  await prisma.calendarDaySummary.deleteMany({ where: { userId: user.id } });

  // --- food database -------------------------------------------------------
  console.log(`  · ${SEED_FOODS.length} foods`);
  for (const food of SEED_FOODS) {
    const searchKey = `${food.name} ${food.brand ?? ""} ${food.category}`.toLowerCase().trim();
    const existing = await prisma.foodItem.findFirst({
      where: { name: food.name, userId: null },
    });

    const data = {
      name: food.name,
      brand: food.brand ?? null,
      basis: food.basis ?? "per_100g",
      servingSize: food.servingSize,
      servingUnit: food.servingUnit,
      servingLabel: food.servingLabel ?? null,
      calories: food.calories,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
      fiber: food.fiber ?? 0,
      sugar: food.sugar ?? 0,
      sodium: food.sodium ?? 0,
      category: food.category,
      verified: true,
      searchKey,
    };

    if (existing) await prisma.foodItem.update({ where: { id: existing.id }, data });
    else await prisma.foodItem.create({ data });
  }

  const foods = await prisma.foodItem.findMany({ where: { userId: null } });
  const foodByName = new Map(foods.map((food) => [food.name, food]));
  const need = (name: string) => {
    const food = foodByName.get(name);
    if (!food) throw new Error(`Seed food missing: ${name}`);
    return food;
  };

  // --- goals ---------------------------------------------------------------
  // Each goal carries a real schedule and a completion source, so the sample
  // data exercises the same paths a real user's goals would — including a
  // weekday-only training goal whose rest days must stay neutral.
  const goalSeeds: Array<{
    domain: string;
    metric: string;
    label: string;
    target: number;
    targetMax?: number;
    unit: string;
    period: string;
    direction: string;
    source: string;
    schedule: { mode: string; weekdays?: number[]; timesPerWeek?: number };
  }> = [
    { domain: "nutrition", metric: "calories", label: "Stay under 2,400 kcal", target: 2400, unit: "kcal", period: "daily", direction: "lte", source: "calories", schedule: { mode: "every_day" } },
    { domain: "nutrition", metric: "protein", label: "Eat 180 g of protein", target: 180, unit: "g", period: "daily", direction: "gte", source: "protein", schedule: { mode: "every_day" } },
    { domain: "workout", metric: "workout_session", label: "Complete a workout", target: 1, unit: "", period: "daily", direction: "gte", source: "workout_count", schedule: { mode: "weekdays", weekdays: [1, 2, 4, 5] } },
    { domain: "workout", metric: "workouts_per_week", label: "4 workouts per week", target: 4, unit: "", period: "weekly", direction: "gte", source: "workout_count", schedule: { mode: "times_per_week", timesPerWeek: 4 } },
    { domain: "health", metric: "steps", label: "Walk 9,000 steps", target: 9000, unit: "", period: "daily", direction: "gte", source: "steps", schedule: { mode: "every_day" } },
    { domain: "health", metric: "sleep_hours", label: "Sleep at least 7.5 hours", target: 7.5, unit: "h", period: "daily", direction: "gte", source: "sleep_hours", schedule: { mode: "weekdays", weekdays: [0, 1, 2, 3, 4] } },
  ];

  for (const [index, seed] of goalSeeds.entries()) {
    const { schedule, ...goalFields } = seed;
    const goal = await prisma.goal.create({
      data: {
        ...goalFields,
        targetMax: goalFields.targetMax ?? null,
        userId: user.id,
        sortOrder: index,
        startDate: day(-HISTORY_DAYS),
      },
    });
    await prisma.scheduleRule.create({
      data: {
        userId: user.id,
        ownerType: "goal",
        ownerId: goal.id,
        effectiveFrom: day(-HISTORY_DAYS),
        mode: schedule.mode,
        timesPerWeek: schedule.timesPerWeek ?? null,
        days: schedule.weekdays?.length
          ? { create: schedule.weekdays.map((weekday) => ({ weekday })) }
          : undefined,
      },
    });
  }

  // --- tags ----------------------------------------------------------------
  // One vocabulary, shared by planner blocks and tasks — which is the whole
  // point of tags living in their own table rather than on either model.
  const tagNames = ["deepwork", "errand", "family", "focus", "admin", "money", "home"];
  const tags = await Promise.all(
    tagNames.map((name) => prisma.tag.create({ data: { userId: user.id, name, color: "slate" } })),
  );
  const tagByName = new Map(tags.map((tag) => [tag.name, tag]));
  const tagId = (name: string) => tagByName.get(name)!.id;

  // --- habits --------------------------------------------------------------
  const habitSeeds = [
    { name: "Morning water", category: "health", timeOfDay: "morning", frequency: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6], targetPerWeek: 7, reliability: 0.92, icon: "Droplets", color: "sky" },
    { name: "10-minute meditation", category: "mindfulness", timeOfDay: "morning", frequency: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6], targetPerWeek: 7, reliability: 0.72, icon: "Brain", color: "violet" },
    { name: "Read 20 pages", category: "learning", timeOfDay: "before_bed", frequency: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6], targetPerWeek: 7, reliability: 0.66, icon: "BookOpen", color: "amber" },
    { name: "Stretch / mobility", category: "health", timeOfDay: "evening", frequency: "custom", weekdays: [1, 3, 5], targetPerWeek: 3, reliability: 0.78, icon: "Activity", color: "emerald" },
    { name: "No screens after 10pm", category: "personal", timeOfDay: "before_bed", frequency: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6], targetPerWeek: 7, reliability: 0.55, icon: "MoonStar", color: "indigo" },
    { name: "Plan tomorrow", category: "productivity", timeOfDay: "evening", frequency: "custom", weekdays: [1, 2, 3, 4, 5], targetPerWeek: 5, reliability: 0.84, icon: "ClipboardList", color: "blue" },
    { name: "Inbox to zero", category: "productivity", timeOfDay: "afternoon", frequency: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], targetPerWeek: 3, reliability: 0.5, icon: "Mail", color: "cyan" },
    { name: "Floss", category: "hygiene", timeOfDay: "before_bed", frequency: "daily", weekdays: [0, 1, 2, 3, 4, 5, 6], targetPerWeek: 7, reliability: 0.88, icon: "Sparkles", color: "teal" },
  ];

  console.log(`  · ${habitSeeds.length} habits with ${HISTORY_DAYS} days of logs`);
  const habits = [];
  for (const [index, seed] of habitSeeds.entries()) {
    const habit = await prisma.habit.create({
      data: {
        userId: user.id,
        name: seed.name,
        category: seed.category,
        timeOfDay: seed.timeOfDay,
        frequency: seed.frequency,
        weekdays: JSON.stringify(seed.weekdays),
        targetPerWeek: seed.targetPerWeek,
        icon: seed.icon,
        color: seed.color,
        sortOrder: index,
        startDate: day(-HISTORY_DAYS),
      },
    });

    // The schedule engine reads ScheduleRule, not the legacy columns. Seeding
    // both keeps the sample data on exactly the same path as a habit created
    // through the UI.
    const mode =
      seed.frequency === "custom"
        ? "weekdays"
        : seed.frequency === "weekly"
          ? "times_per_week"
          : "every_day";
    await prisma.scheduleRule.create({
      data: {
        userId: user.id,
        ownerType: "habit",
        ownerId: habit.id,
        effectiveFrom: day(-HISTORY_DAYS),
        mode,
        timesPerWeek: mode === "times_per_week" ? seed.targetPerWeek : null,
        daypart: seed.timeOfDay,
        days:
          mode === "weekdays"
            ? { create: seed.weekdays.map((weekday) => ({ weekday })) }
            : undefined,
      },
    });

    habits.push({ habit, seed });
  }

  const habitLogs: Array<{ habitId: string; userId: string; date: string; status: string }> = [];
  for (const { habit, seed } of habits) {
    for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
      const date = day(offset);
      const weekday = addDays(new Date(), offset).getDay();
      if (seed.frequency === "custom" && !seed.weekdays.includes(weekday)) continue;
      // Weekly habits only get logged on the days they actually happened.
      if (seed.frequency === "weekly" && !chance(seed.targetPerWeek / 7)) continue;
      // Today is intentionally left partly unlogged so the UI has something to do.
      if (offset === 0 && chance(0.45)) continue;

      // Consistency improves slightly over time — makes the trend charts honest.
      const drift = ((offset + HISTORY_DAYS) / HISTORY_DAYS) * 0.12;
      const roll = random();
      const threshold = Math.min(0.97, seed.reliability + drift);

      if (roll < threshold) habitLogs.push({ habitId: habit.id, userId: user.id, date, status: "done" });
      else if (roll < threshold + 0.06)
        habitLogs.push({ habitId: habit.id, userId: user.id, date, status: "skipped" });
    }
  }
  await prisma.habitLog.createMany({ data: habitLogs });

  // --- workout templates ---------------------------------------------------
  interface SeedExercise {
    exercise: string;
    sets: number;
    reps?: number;
    weightKg?: number;
    restSec?: number;
    notes?: string;
  }
  interface SeedWorkoutTemplate {
    name: string;
    type: string;
    durationMin: number;
    intensity: string;
    description: string;
    exercises: SeedExercise[];
  }

  const workoutTemplates: SeedWorkoutTemplate[] = [
    {
      name: "Upper body push",
      type: "strength",
      durationMin: 55,
      intensity: "hard",
      description: "Chest, shoulders, triceps",
      exercises: [
        { exercise: "Bench press", sets: 4, reps: 6, weightKg: 80, restSec: 150 },
        { exercise: "Overhead press", sets: 3, reps: 8, weightKg: 45, restSec: 120 },
        { exercise: "Incline dumbbell press", sets: 3, reps: 10, weightKg: 28, restSec: 90 },
        { exercise: "Cable fly", sets: 3, reps: 12, weightKg: 20, restSec: 60 },
        { exercise: "Triceps pushdown", sets: 3, reps: 12, weightKg: 30, restSec: 60 },
      ],
    },
    {
      name: "Lower body",
      type: "strength",
      durationMin: 60,
      intensity: "hard",
      description: "Squat focus",
      exercises: [
        { exercise: "Back squat", sets: 5, reps: 5, weightKg: 110, restSec: 180 },
        { exercise: "Romanian deadlift", sets: 3, reps: 8, weightKg: 90, restSec: 120 },
        { exercise: "Bulgarian split squat", sets: 3, reps: 10, weightKg: 24, restSec: 90 },
        { exercise: "Leg curl", sets: 3, reps: 12, weightKg: 45, restSec: 60 },
        { exercise: "Standing calf raise", sets: 4, reps: 15, weightKg: 60, restSec: 45 },
      ],
    },
    {
      name: "Upper body pull",
      type: "strength",
      durationMin: 50,
      intensity: "moderate",
      description: "Back and biceps",
      exercises: [
        { exercise: "Deadlift", sets: 3, reps: 5, weightKg: 140, restSec: 180 },
        { exercise: "Pull-up", sets: 4, reps: 8, restSec: 120 },
        { exercise: "Barbell row", sets: 3, reps: 10, weightKg: 70, restSec: 90 },
        { exercise: "Face pull", sets: 3, reps: 15, weightKg: 25, restSec: 60 },
        { exercise: "Barbell curl", sets: 3, reps: 10, weightKg: 35, restSec: 60 },
      ],
    },
    {
      name: "Zone 2 run",
      type: "running",
      durationMin: 40,
      intensity: "easy",
      description: "Conversational pace",
      exercises: [],
    },
    {
      name: "Mobility flow",
      type: "mobility",
      durationMin: 20,
      intensity: "easy",
      description: "Hips, thoracic spine, ankles",
      exercises: [
        { exercise: "90/90 hip switch", sets: 3, reps: 10 },
        { exercise: "Thoracic rotation", sets: 3, reps: 10 },
        { exercise: "Couch stretch", sets: 2, reps: 1, notes: "60s each side" },
      ],
    },
  ];

  const templateRecords = [];
  for (const template of workoutTemplates) {
    templateRecords.push(
      await prisma.workoutTemplate.create({
        data: {
          userId: user.id,
          name: template.name,
          type: template.type,
          description: template.description,
          durationMin: template.durationMin,
          intensity: template.intensity,
          exercises: JSON.stringify(template.exercises),
          useCount: intBetween(3, 14),
          lastUsed: subDays(new Date(), intBetween(1, 6)),
        },
      }),
    );
  }

  // --- workout history -----------------------------------------------------
  // A repeating 4-day split plus easy cardio, with realistic missed sessions
  // and slow progressive overload.
  console.log("  · workout history");
  const rotation = [0, 3, 1, 4, 2, 3];
  let rotationIndex = 0;

  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    const date = day(offset);
    const weekday = addDays(new Date(), offset).getDay();

    // Rest on Sundays; occasionally miss another day.
    if (weekday === 0) continue;
    if (chance(0.28)) continue;

    const template = workoutTemplates[rotation[rotationIndex % rotation.length]];
    rotationIndex += 1;

    // Progressive overload: ~1.5% every 10 days.
    const progress = 1 + ((offset + HISTORY_DAYS) / 10) * 0.015;
    const duration = Math.round(template.durationMin * between(0.85, 1.12));
    const intensity = template.intensity;

    const workout = await prisma.workout.create({
      data: {
        userId: user.id,
        date,
        time: pick(["06:45", "07:15", "17:30", "18:00", "18:30"]),
        name: template.name,
        type: template.type,
        durationMin: duration,
        intensity,
        caloriesBurned: Math.round(duration * between(6, 11)),
        avgHeartRate: intBetween(118, 158),
        distanceKm: template.type === "running" ? Number(between(5, 9).toFixed(2)) : null,
        perceivedEffort: intBetween(5, 9),
        notes: chance(0.25) ? pick(["Felt strong.", "Low energy, still showed up.", "Great pump.", "Grip gave out first."]) : null,
        status: "completed",
        templateId: templateRecords[rotation[(rotationIndex - 1) % rotation.length]].id,
        sets: {
          create: template.exercises.flatMap((exercise, exerciseIndex) =>
            Array.from({ length: exercise.sets }, (_, setIndex) => ({
              exercise: exercise.exercise,
              setNumber: setIndex + 1,
              reps: exercise.reps ? Math.max(1, exercise.reps + intBetween(-1, 1)) : null,
              weightKg: exercise.weightKg
                ? Math.round(exercise.weightKg * progress * 2) / 2
                : null,
              restSec: exercise.restSec ?? null,
              rpe: Number(between(6, 9.5).toFixed(1)),
              completed: true,
              sortOrder: exerciseIndex * 10 + setIndex,
            })),
          ),
        },
      },
    });

    // Mirror the workout onto the planner.
    const [hours, minutes] = (workout.time ?? "18:00").split(":").map(Number);
    const startMinute = hours * 60 + minutes;
    await prisma.scheduleItem.create({
      data: {
        userId: user.id,
        title: workout.name,
        date,
        startMinute,
        endMinute: Math.min(1439, startMinute + duration),
        allDay: false,
        category: "fitness",
        priority: "high",
        status: "done",
        completedAt: new Date(),
        workoutId: workout.id,
      },
    });
  }

  // --- meal templates ------------------------------------------------------
  const mealTemplates = [
    {
      name: "Standard breakfast",
      mealType: "breakfast",
      items: [
        { food: "Oats, dry rolled", quantity: 1, unit: "serving" },
        { food: "Whey protein powder", quantity: 1, unit: "serving" },
        { food: "Blueberries", quantity: 0.5, unit: "serving" },
        { food: "Peanut butter", quantity: 0.5, unit: "serving" },
      ],
    },
    {
      name: "Chicken & rice bowl",
      mealType: "lunch",
      items: [
        { food: "Chicken breast, grilled", quantity: 1.5, unit: "serving" },
        { food: "White rice, cooked", quantity: 1.5, unit: "serving" },
        { food: "Broccoli, steamed", quantity: 1, unit: "serving" },
        { food: "Olive oil", quantity: 1, unit: "serving" },
      ],
    },
    {
      name: "Post-workout shake",
      mealType: "snack",
      items: [
        { food: "Whey protein powder", quantity: 1, unit: "serving" },
        { food: "Banana", quantity: 1, unit: "serving" },
        { food: "Milk, 2%", quantity: 1, unit: "serving" },
      ],
    },
  ];

  for (const template of mealTemplates) {
    await prisma.mealTemplate.create({
      data: {
        userId: user.id,
        name: template.name,
        mealType: template.mealType,
        useCount: intBetween(4, 20),
        lastUsed: subDays(new Date(), intBetween(0, 4)),
        items: {
          create: template.items.map((item) => ({
            foodItemId: need(item.food).id,
            quantity: item.quantity,
            unit: item.unit,
          })),
        },
      },
    });
  }

  // --- nutrition history ---------------------------------------------------
  console.log("  · nutrition history");

  const breakfastOptions = [
    [{ food: "Oats, dry rolled", qty: 1 }, { food: "Whey protein powder", qty: 1 }, { food: "Blueberries", qty: 0.5 }],
    [{ food: "Egg, large", qty: 3 }, { food: "Whole wheat bread", qty: 2 }, { food: "Avocado", qty: 0.5 }],
    [{ food: "Greek yogurt, plain nonfat", qty: 1.5 }, { food: "Strawberries", qty: 1 }, { food: "Almonds", qty: 1 }],
  ];
  const lunchOptions = [
    [{ food: "Chicken breast, grilled", qty: 1.5 }, { food: "White rice, cooked", qty: 1.5 }, { food: "Broccoli, steamed", qty: 1 }],
    [{ food: "Turkey sandwich", qty: 1 }, { food: "Apple", qty: 1 }],
    [{ food: "Chicken burrito bowl", qty: 1 }],
    [{ food: "Salmon, baked", qty: 1 }, { food: "Quinoa, cooked", qty: 1.5 }, { food: "Asparagus, roasted", qty: 1 }],
  ];
  const dinnerOptions = [
    [{ food: "Ground beef, 90% lean", qty: 1.5 }, { food: "Sweet potato, baked", qty: 1 }, { food: "Green beans, steamed", qty: 1 }],
    [{ food: "Salmon, baked", qty: 1.2 }, { food: "Brown rice, cooked", qty: 1 }, { food: "Mixed salad greens", qty: 1 }, { food: "Olive oil", qty: 1 }],
    [{ food: "Tofu, firm", qty: 1.5 }, { food: "Pasta, cooked", qty: 1.5 }, { food: "Mushrooms, sautéed", qty: 1 }],
    [{ food: "Cheese pizza slice", qty: 3 }],
  ];
  const snackOptions = [
    [{ food: "Protein bar", qty: 1 }],
    [{ food: "Greek yogurt, plain nonfat", qty: 1 }, { food: "Banana", qty: 1 }],
    [{ food: "Almonds", qty: 1 }, { food: "Dark chocolate, 70%", qty: 0.5 }],
    [{ food: "Whey protein powder", qty: 1 }, { food: "Milk, 2%", qty: 1 }],
  ];

  /** Macros for `quantity` servings, matching src/lib/logic/nutrition.ts. */
  function macrosFor(food: (typeof foods)[number], quantity: number) {
    const units = food.basis === "per_serving" ? quantity : (quantity * food.servingSize) / 100;
    return {
      calories: Math.round(food.calories * units),
      protein: Math.round(food.protein * units * 10) / 10,
      carbs: Math.round(food.carbs * units * 10) / 10,
      fat: Math.round(food.fat * units * 10) / 10,
      fiber: Math.round(food.fiber * units * 10) / 10,
      sugar: Math.round(food.sugar * units * 10) / 10,
      sodium: Math.round(food.sodium * units),
    };
  }

  const usageCounts = new Map<string, number>();

  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    const date = day(offset);
    // Logging discipline improves over the window; a few days are skipped.
    const logChance = 0.55 + ((offset + HISTORY_DAYS) / HISTORY_DAYS) * 0.35;
    if (!chance(logChance)) continue;

    const plan: Array<{ type: string; time: string; items: Array<{ food: string; qty: number }> }> = [
      { type: "breakfast", time: "08:00", items: pick(breakfastOptions) },
      { type: "lunch", time: "12:30", items: pick(lunchOptions) },
      { type: "dinner", time: "19:00", items: pick(dinnerOptions) },
    ];
    if (chance(0.7)) plan.push({ type: "snack", time: "15:30", items: pick(snackOptions) });

    // Today is left partially logged, so the day still has something to do.
    const meals = offset === 0 ? plan.slice(0, 2) : plan;

    for (const meal of meals) {
      const record = await prisma.meal.create({
        data: { userId: user.id, date, type: meal.type, time: meal.time },
      });

      for (const [index, item] of meal.items.entries()) {
        const food = need(item.food);
        const quantity = Math.round(item.qty * between(0.9, 1.15) * 4) / 4;
        await prisma.mealEntry.create({
          data: {
            mealId: record.id,
            foodItemId: food.id,
            quantity,
            unit: "serving",
            sortOrder: index,
            ...macrosFor(food, quantity),
          },
        });
        usageCounts.set(food.id, (usageCounts.get(food.id) ?? 0) + 1);
      }
    }
  }

  // Favourites / recents derived from what actually got eaten.
  const ranked = Array.from(usageCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [index, [foodId, count]] of ranked.slice(0, 20).entries()) {
    const food = foods.find((candidate) => candidate.id === foodId);
    if (!food) continue;
    await prisma.favoriteItem.create({
      data: {
        userId: user.id,
        kind: "food",
        refId: foodId,
        label: food.name,
        useCount: count,
        // Top 8 are pinned favourites; the rest are just "recent".
        sortOrder: index < 8 ? index : -1,
        lastUsedAt: subDays(new Date(), intBetween(0, 10)),
      },
    });
  }

  // --- health metrics ------------------------------------------------------
  console.log("  · health metrics");
  let weight = 178.5; // lb
  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    const date = day(offset);
    // Slow downward trend with daily noise — realistic weight data.
    weight += between(-0.35, 0.28);

    const rows = [
      { type: "steps", value: Math.round(between(4200, 14500)), unit: "" },
      { type: "active_calories", value: Math.round(between(280, 900)), unit: "kcal" },
      { type: "resting_calories", value: Math.round(between(1680, 1790)), unit: "kcal" },
      { type: "sleep_hours", value: Number(between(5.6, 8.6).toFixed(1)), unit: "h" },
      { type: "resting_hr", value: Math.round(between(50, 62)), unit: "bpm" },
      { type: "hrv", value: Math.round(between(38, 78)), unit: "ms" },
      { type: "hydration_ml", value: Math.round(between(1400, 3400)), unit: "ml" },
    ];

    // Weight isn't logged every day — nobody does that.
    if (chance(0.7)) {
      rows.push({ type: "body_weight", value: Number(weight.toFixed(1)), unit: "lb" });
    }

    await prisma.healthMetric.createMany({
      data: rows.map((row) => ({
        userId: user.id,
        date,
        type: row.type,
        value: row.value,
        unit: row.unit,
        source: "manual",
        // The same identity the manual-entry UI upserts on, so logging a value
        // for a seeded day replaces it instead of stacking a second row.
        fingerprint: manualDailyFingerprint(row.type, date),
      })),
    });
  }

  await seedImportedHealth(prisma, user.id);

  // --- schedule templates --------------------------------------------------
  const scheduleTemplates = [
    {
      name: "Deep work day",
      category: "work",
      description: "Two long focus blocks with a hard stop",
      items: [
        { title: "Morning routine", startMinute: 6 * 60 + 30, endMinute: 7 * 60 + 15, category: "personal", priority: "medium" },
        { title: "Deep work — block 1", startMinute: 9 * 60, endMinute: 11 * 60 + 30, category: "work", priority: "high" },
        { title: "Lunch + walk", startMinute: 12 * 60 + 30, endMinute: 13 * 60 + 15, category: "meal", priority: "medium" },
        { title: "Deep work — block 2", startMinute: 14 * 60, endMinute: 16 * 60, category: "work", priority: "high" },
        { title: "Shutdown ritual", startMinute: 17 * 60, endMinute: 17 * 60 + 20, category: "admin", priority: "medium" },
      ],
    },
    {
      name: "Training day",
      category: "fitness",
      description: "Lift, eat, recover",
      items: [
        { title: "Pre-workout meal", startMinute: 16 * 60 + 30, endMinute: 17 * 60, category: "meal", priority: "medium" },
        { title: "Gym session", startMinute: 17 * 60 + 30, endMinute: 18 * 60 + 45, category: "fitness", priority: "high" },
        { title: "Post-workout shake", startMinute: 19 * 60, endMinute: 19 * 60 + 15, category: "meal", priority: "medium" },
        { title: "Mobility + stretch", startMinute: 21 * 60, endMinute: 21 * 60 + 20, category: "health", priority: "low" },
      ],
    },
    {
      name: "Sunday reset",
      category: "personal",
      description: "Plan, prep and reset for the week",
      items: [
        { title: "Weekly review", startMinute: 10 * 60, endMinute: 11 * 60, category: "admin", priority: "high" },
        { title: "Meal prep", startMinute: 11 * 60 + 30, endMinute: 13 * 60, category: "meal", priority: "high" },
        { title: "Laundry + tidy", startMinute: 14 * 60, endMinute: 15 * 60, category: "admin", priority: "medium" },
        { title: "Plan the week", startMinute: 18 * 60, endMinute: 18 * 60 + 45, category: "admin", priority: "high" },
      ],
    },
  ];

  for (const template of scheduleTemplates) {
    await prisma.scheduleTemplate.create({
      data: {
        userId: user.id,
        name: template.name,
        description: template.description,
        category: template.category,
        items: JSON.stringify(template.items),
        useCount: intBetween(2, 11),
        lastUsed: subDays(new Date(), intBetween(1, 9)),
      },
    });
  }

  // --- schedule items ------------------------------------------------------
  console.log("  · schedule history + upcoming");

  const weekdayBlocks = [
    { title: "Morning routine", start: 6 * 60 + 30, end: 7 * 60 + 15, category: "personal", priority: "medium" },
    { title: "Standup", start: 9 * 60 + 30, end: 9 * 60 + 45, category: "work", priority: "medium" },
    { title: "Deep work", start: 10 * 60, end: 12 * 60, category: "work", priority: "high" },
    { title: "Lunch", start: 12 * 60 + 30, end: 13 * 60 + 15, category: "meal", priority: "medium" },
    { title: "Email + admin", start: 16 * 60, end: 16 * 60 + 45, category: "admin", priority: "low" },
    { title: "Dinner", start: 19 * 60, end: 19 * 60 + 45, category: "meal", priority: "medium" },
    { title: "Reading", start: 21 * 60 + 30, end: 22 * 60, category: "learning", priority: "low" },
  ];

  const weekendBlocks = [
    { title: "Slow morning", start: 8 * 60, end: 9 * 60, category: "rest", priority: "low" },
    { title: "Errands", start: 11 * 60, end: 12 * 60 + 30, category: "admin", priority: "medium" },
    { title: "Lunch", start: 13 * 60, end: 13 * 60 + 45, category: "meal", priority: "medium" },
    { title: "Friends / family", start: 18 * 60, end: 20 * 60, category: "social", priority: "medium" },
  ];

  const extras = [
    { title: "Call the dentist", category: "admin", priority: "high" },
    { title: "Review budget", category: "admin", priority: "medium" },
    { title: "Book flights", category: "personal", priority: "high" },
    { title: "Reply to Sam", category: "work", priority: "medium" },
    { title: "Water the plants", category: "personal", priority: "low" },
    { title: "Order groceries", category: "admin", priority: "medium" },
  ];

  for (let offset = -HISTORY_DAYS; offset <= FUTURE_DAYS; offset += 1) {
    const date = day(offset);
    const weekday = addDays(new Date(), offset).getDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const isPast = offset < 0;
    const isFuture = offset > 0;

    const blocks = isWeekend ? weekendBlocks : weekdayBlocks;
    let sortOrder = 0;

    for (const block of blocks) {
      if (chance(0.12)) continue; // days aren't identical

      // Completion rate climbs slightly across the window.
      const completionChance = 0.7 + ((offset + HISTORY_DAYS) / (HISTORY_DAYS + FUTURE_DAYS)) * 0.18;
      const status = isFuture
        ? "planned"
        : isPast
          ? chance(completionChance)
            ? "done"
            : chance(0.5)
              ? "skipped"
              : "planned"
          : // Today: earlier blocks are done, later ones still open.
            block.start < new Date().getHours() * 60 + new Date().getMinutes()
            ? chance(0.8)
              ? "done"
              : "planned"
            : "planned";

      await prisma.scheduleItem.create({
        data: {
          userId: user.id,
          title: block.title,
          date,
          startMinute: block.start,
          endMinute: block.end,
          allDay: false,
          category: block.category,
          priority: block.priority,
          status,
          completedAt: status === "done" ? new Date() : null,
          sortOrder: sortOrder++,
        },
      });
    }

    // A couple of untimed to-dos per day.
    const extraCount = isWeekend ? intBetween(0, 2) : intBetween(1, 3);
    for (let index = 0; index < extraCount; index += 1) {
      const extra = pick(extras);
      const status = isFuture ? "planned" : isPast ? (chance(0.72) ? "done" : "planned") : "planned";
      const item = await prisma.scheduleItem.create({
        data: {
          userId: user.id,
          title: extra.title,
          date,
          allDay: true,
          category: extra.category,
          priority: extra.priority,
          status,
          completedAt: status === "done" ? new Date() : null,
          sortOrder: sortOrder++,
        },
      });

      if (chance(0.25)) {
        await prisma.scheduleItemTag.create({
          data: { scheduleItemId: item.id, tagId: pick(tags).id },
        });
      }
    }
  }

  // A genuine recurring series so the recurrence UI has something to show.
  const seriesParent = await prisma.scheduleItem.create({
    data: {
      userId: user.id,
      title: "Weekly review",
      notes: "What worked, what didn't, what's next.",
      date: day(0),
      startMinute: 17 * 60,
      endMinute: 18 * 60,
      allDay: false,
      category: "admin",
      priority: "high",
      status: "planned",
      recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [0] }),
    },
  });

  for (let week = 1; week <= 8; week += 1) {
    const occurrence = addDays(new Date(), week * 7);
    // Land it on the next Sunday from the parent.
    const delta = (7 - occurrence.getDay()) % 7;
    await prisma.scheduleItem.create({
      data: {
        userId: user.id,
        title: seriesParent.title,
        notes: seriesParent.notes,
        date: format(addDays(occurrence, delta), "yyyy-MM-dd"),
        startMinute: seriesParent.startMinute,
        endMinute: seriesParent.endMinute,
        allDay: false,
        category: seriesParent.category,
        priority: seriesParent.priority,
        status: "planned",
        seriesId: seriesParent.id,
      },
    });
  }

  // --- journal -------------------------------------------------------------
  const journalNotes = [
    "Good focus today. The morning block is doing a lot of work.",
    "Slept badly, everything felt harder. Still hit the gym.",
    "Great session — hit a PR on squats.",
    "Too much context switching. Need to protect the deep work block.",
    "Quiet day. Caught up on reading and cooked properly.",
    "Travel day, ate out. Back on plan tomorrow.",
  ];

  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    if (!chance(0.3)) continue;
    const date = day(offset);
    const mood = intBetween(2, 5);
    const energy = intBetween(2, 5);

    await prisma.journalEntry.create({
      data: { userId: user.id, date, content: pick(journalNotes), mood, energy },
    });

    for (const [type, value] of [["mood", mood], ["energy", energy]] as const) {
      const fingerprint = manualDailyFingerprint(type, date);
      await prisma.healthMetric.upsert({
        where: { userId_fingerprint: { userId: user.id, fingerprint } },
        create: { userId: user.id, date, type, value, unit: "/5", source: "manual", fingerprint },
        update: { value },
      });
    }
  }

  // --- reminders -----------------------------------------------------------
  const tomorrow = addDays(new Date(), 1);
  tomorrow.setHours(7, 0, 0, 0);
  await prisma.reminder.create({
    data: {
      userId: user.id,
      title: "Plan your day",
      message: "Two minutes now saves an hour later.",
      remindAt: tomorrow,
      repeat: "weekdays",
    },
  });

  // --- projects, tasks & task tags -----------------------------------------
  console.log("  · projects, tasks and tags");
  const projectSeeds = [
    { name: "Apartment move", description: "Everything between now and the handover.", color: "blue", status: "active" },
    { name: "Learn Spanish", description: "30 minutes a day, B1 by spring.", color: "violet", status: "active" },
    { name: "Taxes 2025", description: "Filed and done.", color: "amber", status: "completed" },
  ];
  const projects = [];
  for (const [index, seed] of projectSeeds.entries()) {
    projects.push(
      await prisma.project.create({
        data: {
          userId: user.id,
          name: seed.name,
          description: seed.description,
          color: seed.color,
          status: seed.status,
          completedAt: seed.status === "completed" ? subDays(new Date(), 21) : null,
          sortOrder: index,
        },
      }),
    );
  }
  const [moveProject, spanishProject, taxProject] = projects;

  const taskSeeds: Array<{
    title: string;
    notes?: string;
    projectId?: string | null;
    priority: string;
    dueOffset: number | null;
    status?: string;
    repeat?: string;
    reminder?: boolean;
    tags: string[];
    subtasks?: string[];
  }> = [
    // Overdue, due today and upcoming, so every bucket on /tasks has content.
    { title: "Renew the parking permit", priority: "high", dueOffset: -2, tags: ["admin", "errand"] },
    { title: "Book the movers", notes: "Two quotes in, waiting on the third.", projectId: moveProject.id, priority: "urgent", dueOffset: 0, reminder: true, tags: ["home", "admin"], subtasks: ["Compare the three quotes", "Confirm the date"] },
    { title: "Send the deposit", projectId: moveProject.id, priority: "high", dueOffset: 3, tags: ["home", "money"] },
    { title: "Cancel the old internet plan", projectId: moveProject.id, priority: "medium", dueOffset: 9, tags: ["home", "admin"] },
    { title: "Weekly budget review", priority: "medium", dueOffset: 2, repeat: "weekly", reminder: true, tags: ["money", "focus"] },
    { title: "Spanish: unit 6 vocabulary", projectId: spanishProject.id, priority: "low", dueOffset: 1, tags: ["deepwork"] },
    { title: "Spanish: book a conversation session", projectId: spanishProject.id, priority: "low", dueOffset: 21, tags: ["deepwork"] },
    { title: "Replace the smoke alarm batteries", priority: "low", dueOffset: null, tags: ["home"] },
    { title: "Read the pension statement", priority: "low", dueOffset: null, tags: ["money", "admin"] },
    { title: "File the return", projectId: taxProject.id, priority: "high", dueOffset: -24, status: "done", tags: ["money", "admin"] },
    { title: "Collect the receipts", projectId: taxProject.id, priority: "medium", dueOffset: -30, status: "done", tags: ["money"] },
  ];

  for (const [index, seed] of taskSeeds.entries()) {
    const dueDate = seed.dueOffset === null ? null : day(seed.dueOffset);
    const task = await prisma.task.create({
      data: {
        userId: user.id,
        projectId: seed.projectId ?? null,
        title: seed.title,
        notes: seed.notes ?? null,
        status: seed.status ?? "open",
        priority: seed.priority,
        dueDate,
        completedAt: seed.status === "done" ? subDays(new Date(), 20 + index) : null,
        repeat: seed.repeat ?? "none",
        repeatAnchor: seed.repeat ? dueDate : null,
        reminderEnabled: seed.reminder ?? false,
        sortOrder: index,
        tags: { create: seed.tags.map((name) => ({ tagId: tagId(name) })) },
      },
    });

    for (const [subIndex, title] of (seed.subtasks ?? []).entries()) {
      await prisma.task.create({
        data: {
          userId: user.id,
          parentId: task.id,
          projectId: seed.projectId ?? null,
          title,
          status: subIndex === 0 ? "done" : "open",
          completedAt: subIndex === 0 ? subDays(new Date(), 1) : null,
          priority: "medium",
          sortOrder: subIndex,
        },
      });
    }
  }

  // --- inbox ---------------------------------------------------------------
  console.log("  · inbox captures");
  const convertedTask = await prisma.task.create({
    data: {
      userId: user.id,
      title: "Ask the dentist about the night guard",
      status: "open",
      priority: "medium",
      dueDate: day(6),
      sortOrder: taskSeeds.length,
      tags: { create: [{ tagId: tagId("admin") }] },
    },
  });

  const inboxSeeds: Array<{ title: string; notes?: string; status?: string; taskId?: string }> = [
    { title: "Look into a better travel card", notes: "The current one charges abroad." },
    { title: "That podcast episode on index funds" },
    { title: "Photo backup — is it actually running?" },
    { title: "Ask the dentist about the night guard", status: "archived", taskId: convertedTask.id },
    { title: "Return the blue jacket", status: "done" },
  ];
  for (const seed of inboxSeeds) {
    await prisma.inboxItem.create({
      data: {
        userId: user.id,
        title: seed.title,
        notes: seed.notes ?? null,
        status: seed.status ?? "open",
        completedAt: seed.status === "done" ? subDays(new Date(), 2) : null,
        taskId: seed.taskId ?? null,
      },
    });
  }

  // --- finance -------------------------------------------------------------
  console.log("  · accounts, ledger, bills, budgets");
  const checking = await prisma.financeAccount.create({
    data: { userId: user.id, name: "Everyday checking", type: "checking", openingBalance: 2400, lowBalanceThreshold: 500, sortOrder: 0 },
  });
  const savings = await prisma.financeAccount.create({
    data: { userId: user.id, name: "Emergency savings", type: "savings", openingBalance: 6100, sortOrder: 1 },
  });
  const card = await prisma.financeAccount.create({
    data: { userId: user.id, name: "Rewards card", type: "credit_card", openingBalance: -320, sortOrder: 2 },
  });

  const spendSeeds: Array<{ payee: string; category: string; min: number; max: number; chance: number }> = [
    { payee: "Corner Market", category: "groceries", min: 18, max: 74, chance: 0.5 },
    { payee: "Cafe Luna", category: "dining", min: 6, max: 28, chance: 0.35 },
    { payee: "Metro Transit", category: "transport", min: 3, max: 14, chance: 0.4 },
    { payee: "Pharmacy", category: "health", min: 8, max: 45, chance: 0.08 },
    { payee: "Bookshop", category: "shopping", min: 12, max: 60, chance: 0.1 },
  ];

  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    const date = day(offset);
    for (const seed of spendSeeds) {
      if (!chance(seed.chance)) continue;
      await prisma.financeTransaction.create({
        data: {
          userId: user.id,
          accountId: seed.category === "groceries" || seed.category === "dining" ? card.id : checking.id,
          date,
          amount: -moneyRound(between(seed.min, seed.max)),
          payee: seed.payee,
          category: seed.category,
        },
      });
    }
    // Salary on the 1st and 15th, and a standing transfer to savings after it.
    const dayOfMonth = Number(date.slice(8, 10));
    if (dayOfMonth === 1 || dayOfMonth === 15) {
      await prisma.financeTransaction.create({
        data: { userId: user.id, accountId: checking.id, date, amount: 2150, payee: "Acme Corp", category: "income" },
      });
      const transferGroupId = `demo-transfer-${date}`;
      await prisma.financeTransaction.createMany({
        data: [
          { userId: user.id, accountId: checking.id, date, amount: -400, payee: "Transfer to Emergency savings", category: "transfer", transferGroupId },
          { userId: user.id, accountId: savings.id, date, amount: 400, payee: "Transfer from Everyday checking", category: "transfer", transferGroupId },
        ],
      });
    }
  }

  // A CSV import batch with its rows still linked — so "undo this import" has
  // something real to demonstrate on a fresh account.
  const importBatch = await prisma.financeImportBatch.create({
    data: {
      userId: user.id,
      accountId: checking.id,
      fileName: "checking-statement.csv",
      rowCount: 4,
      createdCount: 3,
      skippedCount: 1,
      rejectedCount: 0,
    },
  });
  const importedRows = [
    { date: day(-5), amount: -42.18, payee: "Hardware Store", category: "shopping" },
    { date: day(-4), amount: -16.4, payee: "Corner Market", category: "groceries" },
    { date: day(-3), amount: -9.75, payee: "Metro Transit", category: "transport" },
  ];
  for (const row of importedRows) {
    await prisma.financeTransaction.create({
      data: {
        userId: user.id,
        accountId: checking.id,
        date: row.date,
        amount: row.amount,
        payee: row.payee,
        category: row.category,
        importBatchId: importBatch.id,
        // The identity the parser would have written for this row — so the
        // demo batch undoes (and re-imports) exactly like a real one.
        importKey: `v1|${checking.id}|${row.date}|${row.amount}|${row.payee.toLowerCase()}|0`,
      },
    });
  }

  const billSeeds = [
    { name: "Rent", amount: 1650, category: "housing", recurrence: "monthly", dayOfMonth: 1, accountId: checking.id },
    { name: "Internet", amount: 62, category: "utilities", recurrence: "monthly", dayOfMonth: 12, accountId: checking.id },
    { name: "Phone", amount: 38, category: "utilities", recurrence: "monthly", dayOfMonth: 20, accountId: checking.id },
    { name: "Streaming", amount: 15.99, category: "entertainment", recurrence: "monthly", dayOfMonth: 8, accountId: card.id, kind: "subscription" },
  ];
  for (const seed of billSeeds) {
    // Anchor three months back on the seed's day-of-month, then walk forward a
    // month at a time to the first occurrence that is not already past.
    const anchor = subMonths(startOfMonth(new Date()), 3);
    anchor.setDate(seed.dayOfMonth);
    const anchorDate = format(anchor, "yyyy-MM-dd");
    let cursor = anchor;
    while (format(cursor, "yyyy-MM-dd") < day(0)) cursor = addMonths(cursor, 1);
    const nextDueDate = format(cursor, "yyyy-MM-dd");
    await prisma.bill.create({
      data: {
        userId: user.id,
        name: seed.name,
        amount: seed.amount,
        kind: seed.kind ?? "bill",
        category: seed.category,
        accountId: seed.accountId,
        recurrence: seed.recurrence,
        anchorDate,
        nextDueDate,
        reminderEnabled: true,
        reminderDaysBefore: 3,
      },
    });
  }

  await prisma.savingsGoal.createMany({
    data: [
      { userId: user.id, name: "Moving costs", targetAmount: 3000, currentAmount: 1850, targetDate: day(45), sortOrder: 0 },
      { userId: user.id, name: "New laptop", targetAmount: 1800, currentAmount: 620, sortOrder: 1 },
    ],
  });

  // One monthly budget with a threshold alert, one weekly budget, one plain —
  // enough for the finance page to show all three states at a glance.
  await prisma.budget.createMany({
    data: [
      { userId: user.id, category: "groceries", amount: 520, period: "monthly", alertThresholdPercent: 75 },
      { userId: user.id, category: "dining", amount: 60, period: "weekly", alertThresholdPercent: 90 },
      { userId: user.id, category: "transport", amount: 120, period: "monthly" },
    ],
  });

  // --- documents & renewals ------------------------------------------------
  console.log("  · documents and renewals");
  await prisma.lifeDocument.createMany({
    data: [
      { userId: user.id, name: "Passport", kind: "id", issuer: "State Department", expiryDate: day(148), reminderDaysBefore: 90 },
      { userId: user.id, name: "Apartment lease", kind: "lease", issuer: "Brightwater Properties", expiryDate: day(24), reminderDaysBefore: 30, notes: "Renew or give notice 30 days out." },
      { userId: user.id, name: "Car insurance", kind: "insurance", issuer: "Northline Mutual", expiryDate: day(41), reminderDaysBefore: 30 },
      { userId: user.id, name: "Laptop warranty", kind: "warranty", issuer: "Acme Devices", expiryDate: day(-12), reminderDaysBefore: 30 },
      { userId: user.id, name: "Gym membership", kind: "membership", expiryDate: day(96), reminderEnabled: false, reminderDaysBefore: 14 },
    ],
  });

  // --- register everything as demo data ------------------------------------
  // The generator is the only writer for this user during a seed (the wipe just
  // emptied the tables), so "everything the user owns right now" is exactly
  // "everything this run created" — which spares 900 lines of id plumbing.
  console.log("  · registering the seed batch");
  const seedRecords = await recordSeedBatch(prisma, user.id);

  // --- rebuild day summaries ----------------------------------------------
  console.log("  · rebuilding day summaries");
  await rebuildSummaries(user.id, day(-HISTORY_DAYS), day(FUTURE_DAYS));

  const counts = {
    scheduleItems: await prisma.scheduleItem.count({ where: { userId: user.id } }),
    habits: await prisma.habit.count({ where: { userId: user.id } }),
    habitLogs: await prisma.habitLog.count({ where: { userId: user.id } }),
    meals: await prisma.meal.count({ where: { userId: user.id } }),
    workouts: await prisma.workout.count({ where: { userId: user.id } }),
    metrics: await prisma.healthMetric.count({ where: { userId: user.id } }),
    foods: await prisma.foodItem.count(),
    tasks: await prisma.task.count({ where: { userId: user.id } }),
    transactions: await prisma.financeTransaction.count({ where: { userId: user.id } }),
    documents: await prisma.lifeDocument.count({ where: { userId: user.id } }),
    seedRecords,
  };

  console.log("Done:", counts);
  return counts;
}

/**
 * Deletion order for demo removal: children before parents, so a partial
 * failure can never orphan a child row. `ScheduleRuleDay`, `ScheduleItemTag`,
 * `GoalEntry` and `SeedRecord` itself cascade from their parents and are not
 * listed. Exported so the removal action and its test read the same list.
 */
export const DEMO_MODEL_ORDER = [
  "MealEntry",
  "MealTemplateItem",
  "WorkoutSet",
  "HabitLog",
  "GoalEntry",
  "ScheduleItem",
  // Life-admin, children first: ledger rows reference accounts, bills and
  // import batches; inbox captures and planner blocks reference tasks; tasks
  // reference projects. `TaskTag` cascades from either end and is not listed.
  "FinanceTransaction",
  "Bill",
  "FinanceImportBatch",
  "Budget",
  "SavingsGoal",
  "FinanceAccount",
  "InboxItem",
  "Task",
  "Project",
  "LifeDocument",
  "Meal",
  "MealTemplate",
  "Workout",
  "WorkoutTemplate",
  "ScheduleTemplate",
  "Habit",
  "Goal",
  "ScheduleRule",
  "ScheduleOverride",
  // Health rows before the batch they belong to: a batch's metrics,
  // records and workouts all reference it.
  "HealthRecord",
  "HealthMetric",
  "HealthImportBatch",
  "JournalEntry",
  "Reminder",
  "FavoriteItem",
  "Tag",
] as const;
export type DemoModel = (typeof DEMO_MODEL_ORDER)[number];

/**
 * A realistic Apple Health import, without an Apple Health export.
 *
 * The demo needs the *shape* an import leaves behind — device-attributed rows
 * across the richer metric vocabulary, sleep with real stages, workouts marked
 * as imported, a few ECG and medication records, and an import batch that can
 * be undone — because otherwise every Health page except the basics reads as
 * empty and the import history has nothing to show.
 *
 * Fingerprints are built with the real `fingerprintFor`, so re-seeding is
 * idempotent for exactly the same reason a re-import is, and undoing this
 * batch exercises the real undo path against real-shaped rows.
 */
async function seedImportedHealth(prisma: DbClient, userId: string): Promise<void> {
  console.log("  · imported health (Apple Health-shaped)");

  const startedAt = subDays(new Date(), 2);
  const finishedAt = new Date(startedAt.getTime() + 8_400);
  const batch = await prisma.healthImportBatch.create({
    data: {
      userId,
      source: "apple_health",
      fileType: "zip",
      fileName: "export.zip",
      fileSize: 92 * 1024 * 1024,
      status: "completed",
      dateFrom: day(-HISTORY_DAYS),
      dateTo: day(0),
      categories: JSON.stringify([
        "active_calories",
        "blood_oxygen",
        "distance_km",
        "exercise_minutes",
        "flights_climbed",
        "heart_rate",
        "records",
        "sleep_hours",
        "stand_hours",
        "steps",
        "vo2_max",
        "workouts",
      ]),
      examined: 1_284_902,
      skipped: 41_233,
      invalid: 12,
      warnings: JSON.stringify([
        "Skipped: 12 sleep records had a non-positive or absurd duration.",
      ]),
      ignoredFiles: JSON.stringify([
        "clinical document duplicate of export.xml",
        "raw FHIR payloads — only their index is read",
      ]),
      xmlBytes: BigInt(1_842_301_774),
      formatVersion: IMPORT_FORMAT_VERSION,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      // `createdAt` defaults to now(); without this the history row would say
      // the import ran today while the run's own timings said two days ago.
      createdAt: startedAt,
    },
  });

  const WATCH = "Apple Watch";
  const PHONE = "iPhone";
  const rows: Array<{
    date: string;
    type: string;
    subtype: string | null;
    value: number;
    unit: string;
    sourceApp: string;
    startAt?: Date;
    endAt?: Date;
    minValue?: number;
    maxValue?: number;
    sampleCount: number;
  }> = [];

  let vo2 = 41.2;
  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    const date = day(offset);
    const push = (
      type: string,
      value: number,
      unit: string,
      sourceApp: string,
      extra: Partial<(typeof rows)[number]> = {},
    ) => rows.push({ date, type, subtype: null, value, unit, sourceApp, sampleCount: 1, ...extra });

    // The watch and the phone both count steps and distance — two source
    // groups, which is precisely what the aggregation is built to reconcile.
    push("steps", Math.round(between(5200, 15200)), "", WATCH, { sampleCount: intBetween(80, 260) });
    push("steps", Math.round(between(3100, 9800)), "", PHONE, { sampleCount: intBetween(40, 120) });
    push("distance_km", Number(between(3.2, 11.4).toFixed(2)), "km", WATCH, {
      sampleCount: intBetween(60, 200),
    });
    push("flights_climbed", intBetween(2, 26), "", PHONE, { sampleCount: intBetween(2, 26) });
    push("exercise_minutes", intBetween(12, 84), "min", WATCH, { sampleCount: intBetween(6, 30) });
    push("stand_hours", intBetween(7, 14), "h", WATCH, { sampleCount: intBetween(7, 14) });
    push("active_calories", Math.round(between(320, 940)), "kcal", WATCH, {
      sampleCount: intBetween(90, 300),
    });

    const restingHr = Math.round(between(49, 61));
    push("heart_rate", Math.round(between(66, 84)), "bpm", WATCH, {
      minValue: restingHr - intBetween(1, 5),
      maxValue: Math.round(between(138, 178)),
      sampleCount: intBetween(400, 1400),
    });
    push("resting_hr", restingHr, "bpm", WATCH, { sampleCount: 1 });
    push("walking_hr", Math.round(between(94, 118)), "bpm", WATCH, { sampleCount: 1 });
    push("hrv", Math.round(between(34, 82)), "ms", WATCH, { sampleCount: intBetween(2, 8) });
    push("blood_oxygen", Math.round(between(95, 99)), "%", WATCH, { sampleCount: intBetween(4, 22) });
    push("respiratory_rate", Math.round(between(12, 18)), "br/min", WATCH, {
      sampleCount: intBetween(4, 12),
    });

    // VO₂ max moves slowly and is only estimated after outdoor workouts.
    if (chance(0.25)) {
      vo2 += between(-0.25, 0.32);
      rows.push({
        date,
        type: "vo2_max",
        subtype: null,
        value: Number(vo2.toFixed(1)),
        unit: "ml/kg·min",
        sourceApp: WATCH,
        startAt: atHour(offset, 18),
        sampleCount: 1,
      });
    }

    // Nutrition, on the days a food app was actually used.
    if (chance(0.55)) {
      push("dietary_calories", Math.round(between(1780, 2680)), "kcal", "Food log");
      push("protein_g", Math.round(between(95, 175)), "g", "Food log");
      push("carbs_g", Math.round(between(150, 320)), "g", "Food log");
      push("fat_g", Math.round(between(48, 96)), "g", "Food log");
      push("fiber_g", Math.round(between(14, 38)), "g", "Food log");
      push("sugar_g", Math.round(between(22, 78)), "g", "Food log");
      push("sodium_mg", Math.round(between(1600, 3400)), "mg", "Food log");
      push("caffeine_mg", Math.round(between(60, 280)), "mg", "Food log");
      push("vitamin_c_mg", Math.round(between(30, 140)), "mg", "Food log");
      push("calcium_mg", Math.round(between(600, 1400)), "mg", "Food log");
      push("iron_mg", Number(between(6, 19).toFixed(1)), "mg", "Food log");
    }

    // Sleep, as stages that never overlap — the night belongs to the morning
    // it ends on, which is the day key used here.
    if (chance(0.94)) {
      const core = between(3.1, 4.6);
      const deep = between(0.6, 1.5);
      const rem = between(1.0, 2.1);
      const awake = between(0.1, 0.6);
      let cursor = 0;
      const bedtime = atHour(offset - 1, 23);
      const stage = (name: string, hours: number) => {
        const start = new Date(bedtime.getTime() + cursor * 3_600_000);
        cursor += hours;
        rows.push({
          date,
          type: "sleep_hours",
          subtype: name,
          value: Number(hours.toFixed(2)),
          unit: "h",
          sourceApp: WATCH,
          startAt: start,
          endAt: new Date(bedtime.getTime() + cursor * 3_600_000),
          sampleCount: intBetween(3, 14),
        });
      };
      stage("core", core);
      stage("deep", deep);
      stage("rem", rem);
      stage("awake", awake);
      rows.push({
        date,
        type: "sleep_hours",
        subtype: "in_bed",
        value: Number((core + deep + rem + awake + between(0.2, 0.5)).toFixed(2)),
        unit: "h",
        sourceApp: WATCH,
        startAt: bedtime,
        endAt: new Date(bedtime.getTime() + cursor * 3_600_000),
        sampleCount: 1,
      });
    }
  }

  // Written in batches: the same shape a real confirm uses, and the only way
  // a 70-day multi-metric seed stays a handful of statements.
  //
  // Every row is stamped with the batch's own `finishedAt`. Undo's boundary is
  // that instant, so rows left at their default `now()` would all be classified
  // as "edited after the import" — and the demo's undo preview would offer to
  // remove nothing while claiming the user had personally corrected 1,682
  // readings. The timestamps have to agree with the run that wrote them.
  const CHUNK = 500;
  for (let index = 0; index < rows.length; index += CHUNK) {
    await prisma.healthMetric.createMany({
      data: rows.slice(index, index + CHUNK).map((row) => ({
        userId,
        batchId: batch.id,
        createdAt: finishedAt,
        updatedAt: finishedAt,
        date: row.date,
        type: row.type,
        subtype: row.subtype,
        value: row.value,
        unit: row.unit,
        minValue: row.minValue ?? null,
        maxValue: row.maxValue ?? null,
        startAt: row.startAt ?? null,
        endAt: row.endAt ?? null,
        recordedAt: row.startAt ?? null,
        source: "apple_health",
        sourceApp: row.sourceApp,
        sourceDevice: row.sourceApp,
        sampleCount: row.sampleCount,
        fingerprint: fingerprintFor({
          type: row.type,
          subtype: row.subtype as never,
          value: row.value,
          unit: row.unit,
          minValue: null,
          maxValue: null,
          date: row.date,
          startAt: row.startAt?.toISOString() ?? null,
          endAt: row.endAt?.toISOString() ?? null,
          source: "apple_health",
          sourceApp: row.sourceApp,
          sourceDevice: row.sourceApp,
          externalId: null,
          notes: null,
          sampleCount: row.sampleCount,
        }),
      })),
    });
  }

  // Imported workouts, marked as such so undo can take them back.
  const importedWorkouts = [
    { offset: -3, activity: "Running", type: "running", durationMin: 38, distanceKm: 7.1, calories: 512, hr: 156 },
    { offset: -6, activity: "Cycling", type: "cycling", durationMin: 64, distanceKm: 24.6, calories: 703, hr: 141 },
    { offset: -9, activity: "Outdoor Walk", type: "walking", durationMin: 46, distanceKm: 4.2, calories: 218, hr: 108 },
    { offset: -13, activity: "Running", type: "running", durationMin: 52, distanceKm: 9.8, calories: 688, hr: 159 },
    { offset: -18, activity: "Pool Swim", type: "swimming", durationMin: 35, distanceKm: 1.4, calories: 402, hr: 132 },
  ];
  for (const workout of importedWorkouts) {
    const startedAtWorkout = atHour(workout.offset, 18);
    await prisma.workout.create({
      data: {
        userId,
        // Same reason as the metric rows above: undo compares against the
        // batch's `finishedAt`, so a row stamped `now()` reads as user-edited.
        createdAt: finishedAt,
        updatedAt: finishedAt,
        date: day(workout.offset),
        time: "18:00",
        name: workout.activity,
        type: workout.type,
        durationMin: workout.durationMin,
        distanceKm: workout.distanceKm,
        caloriesBurned: workout.calories,
        avgHeartRate: workout.hr,
        status: "completed",
        startedAt: startedAtWorkout,
        completedAt: new Date(startedAtWorkout.getTime() + workout.durationMin * 60_000),
        source: "apple_health",
        externalId: `ah:${startedAtWorkout.toISOString()}:HKWorkoutActivityType${workout.activity.replace(/\s+/g, "")}`,
        importBatchId: batch.id,
      },
    });
  }

  // The non-numeric side of an export: ECGs, a medication, a clinical record
  // and a route's metadata. Summaries only — never a voltage or a coordinate.
  const records = [
    {
      kind: "ecg",
      offset: -5,
      title: "Sinus Rhythm",
      subtitle: "Average 62 bpm",
      value: 62,
      unit: "bpm",
      detail: { symptoms: "None", device: "Apple Watch" },
    },
    {
      kind: "ecg",
      offset: -27,
      title: "Sinus Rhythm",
      subtitle: "Average 58 bpm",
      value: 58,
      unit: "bpm",
      detail: { symptoms: "None", device: "Apple Watch" },
    },
    {
      kind: "medication",
      offset: -34,
      title: "Cholecalciferol 1000 IU",
      subtitle: "Riverside Family Practice",
      value: null,
      unit: "",
      detail: { type: "MedicationStatement", fhirVersion: "4.0.1" },
    },
    {
      kind: "clinical",
      offset: -41,
      title: "Influenza vaccine",
      subtitle: "Riverside Family Practice",
      value: null,
      unit: "",
      detail: { type: "Immunization", fhirVersion: "4.0.1" },
    },
    {
      kind: "workout_route",
      offset: -3,
      title: "Route · 7.10 km",
      subtitle: "1,284 GPS points recorded",
      value: 7.1,
      unit: "km",
      detail: { points: 1284 },
    },
  ];
  for (const record of records) {
    const recordedAt = atHour(record.offset, 9);
    await prisma.healthRecord.create({
      data: {
        userId,
        batchId: batch.id,
        createdAt: finishedAt,
        updatedAt: finishedAt,
        kind: record.kind,
        date: day(record.offset),
        recordedAt,
        startAt: recordedAt,
        title: record.title,
        subtitle: record.subtitle,
        value: record.value,
        unit: record.unit,
        detail: JSON.stringify(record.detail),
        source: "apple_health",
        sourceApp: record.kind === "ecg" ? "Apple Watch" : "Riverside Family Practice",
        externalId: `demo-${record.kind}-${record.offset}`,
        fingerprint: `ahr|${record.kind}|demo-${record.kind}-${record.offset}`,
      },
    });
  }

  await prisma.healthImportBatch.update({
    where: { id: batch.id },
    data: {
      imported: rows.length,
      updated: 0,
      duplicates: 0,
      workoutsImported: importedWorkouts.length,
      workoutsSkipped: 2,
      recordsImported: records.length,
    },
  });

  await seedEarlierScaleImport(prisma, userId);
  await seedFailedImport(prisma, userId);
}

/**
 * A third batch: one that failed.
 *
 * It owns no rows — that is precisely what a rolled-back import is — so it
 * costs the demo nothing and shows two things a healthy-looking history never
 * would: what a failure looks like, and that a failure wrote nothing. It also
 * gives the history's status filters and search box more than one answer to
 * return, which is the only way those controls can be judged.
 */
async function seedFailedImport(prisma: DbClient, userId: string): Promise<void> {
  const startedAt = subDays(new Date(), 21);
  const finishedAt = new Date(startedAt.getTime() + 31_400);
  await prisma.healthImportBatch.create({
    data: {
      userId,
      source: "apple_health",
      fileType: "zip",
      fileName: "export-partial.zip",
      fileSize: 14 * 1024 * 1024,
      status: "failed",
      error: "Import failed (reference demo-0000) — the archive ended mid-file.",
      categories: JSON.stringify([]),
      examined: 184_002,
      formatVersion: IMPORT_FORMAT_VERSION,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      createdAt: startedAt,
    },
  });
}

/**
 * A second, earlier import — a smart scale's CSV export, six weeks ago.
 *
 * The demo needs more than one import for the import dashboard and the history
 * to be worth looking at: with a single batch the search box, the source
 * filters, the "imports run" tile and the format-version note all describe a
 * list of one. This is the smallest thing that makes them mean something, and
 * it is a real batch with real rows — undoable, fingerprinted, and counted by
 * the same aggregates as any other.
 *
 * It is stamped `formatVersion: 1` because that is what a batch of its age
 * would be: the pipeline that wrote it replaced matching readings instead of
 * protecting the ones you had edited. The history says so, which is exactly
 * the case that note exists to cover.
 */
async function seedEarlierScaleImport(prisma: DbClient, userId: string): Promise<void> {
  const startedAt = subDays(new Date(), 42);
  const finishedAt = new Date(startedAt.getTime() + 1_900);

  // One weigh-in a week for ten weeks, drifting gently downward — the shape a
  // scale's own export has, and a metric the Apple batch above does not carry,
  // so the two imports never contend for the same fingerprints.
  const readings: Array<{ date: string; value: number; externalId: string }> = [];
  let weight = 83.4;
  for (let week = 10; week >= 1; week -= 1) {
    weight = Number((weight - between(0.05, 0.3)).toFixed(2));
    readings.push({
      date: day(-week * 7),
      value: weight,
      externalId: `demo-scale-${week}`,
    });
  }

  const batch = await prisma.healthImportBatch.create({
    data: {
      userId,
      source: "csv",
      fileType: "csv",
      fileName: "scale-export-2026.csv",
      fileSize: 2_184,
      status: "completed",
      dateFrom: readings[0].date,
      dateTo: readings[readings.length - 1].date,
      categories: JSON.stringify(["body_weight"]),
      examined: readings.length,
      imported: readings.length,
      warnings: JSON.stringify([]),
      formatVersion: 1,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      createdAt: startedAt,
    },
  });

  await prisma.healthMetric.createMany({
    data: readings.map((reading) => ({
      userId,
      batchId: batch.id,
      createdAt: finishedAt,
      updatedAt: finishedAt,
      date: reading.date,
      type: "body_weight",
      value: reading.value,
      unit: "kg",
      source: "csv",
      sourceApp: "Smart scale",
      externalId: reading.externalId,
      sampleCount: 1,
      // The real key a CSV row with its own id gets, so re-seeding is
      // idempotent for the same reason a re-import is.
      fingerprint: fingerprintFor({
        type: "body_weight",
        subtype: null,
        value: reading.value,
        unit: "kg",
        date: reading.date,
        source: "csv",
        externalId: reading.externalId,
      } as never),
    })),
    skipDuplicates: true,
  });
}

/** A Date at a given hour on a day `offset` days from today. */
function atHour(offset: number, hour: number): Date {
  const date = addDays(new Date(), offset);
  date.setHours(hour, 0, 0, 0);
  return date;
}

async function recordSeedBatch(prisma: DbClient, userId: string): Promise<number> {
  const owned = { where: { userId }, select: { id: true } } as const;
  const idsByModel: Array<[DemoModel, { id: string }[]]> = [
    ["MealEntry", await prisma.mealEntry.findMany({ where: { meal: { userId } }, select: { id: true } })],
    ["MealTemplateItem", await prisma.mealTemplateItem.findMany({ where: { template: { userId } }, select: { id: true } })],
    ["WorkoutSet", await prisma.workoutSet.findMany({ where: { workout: { userId } }, select: { id: true } })],
    ["HabitLog", await prisma.habitLog.findMany(owned)],
    ["GoalEntry", await prisma.goalEntry.findMany(owned)],
    ["ScheduleItem", await prisma.scheduleItem.findMany(owned)],
    ["FinanceTransaction", await prisma.financeTransaction.findMany(owned)],
    ["Bill", await prisma.bill.findMany(owned)],
    ["FinanceImportBatch", await prisma.financeImportBatch.findMany(owned)],
    ["Budget", await prisma.budget.findMany(owned)],
    ["SavingsGoal", await prisma.savingsGoal.findMany(owned)],
    ["FinanceAccount", await prisma.financeAccount.findMany(owned)],
    ["InboxItem", await prisma.inboxItem.findMany(owned)],
    ["Task", await prisma.task.findMany(owned)],
    ["Project", await prisma.project.findMany(owned)],
    ["LifeDocument", await prisma.lifeDocument.findMany(owned)],
    ["Meal", await prisma.meal.findMany(owned)],
    ["MealTemplate", await prisma.mealTemplate.findMany(owned)],
    ["Workout", await prisma.workout.findMany(owned)],
    ["WorkoutTemplate", await prisma.workoutTemplate.findMany(owned)],
    ["ScheduleTemplate", await prisma.scheduleTemplate.findMany(owned)],
    ["Habit", await prisma.habit.findMany(owned)],
    ["Goal", await prisma.goal.findMany(owned)],
    ["ScheduleRule", await prisma.scheduleRule.findMany(owned)],
    ["ScheduleOverride", await prisma.scheduleOverride.findMany(owned)],
    ["HealthRecord", await prisma.healthRecord.findMany(owned)],
    ["HealthMetric", await prisma.healthMetric.findMany(owned)],
    ["HealthImportBatch", await prisma.healthImportBatch.findMany(owned)],
    ["JournalEntry", await prisma.journalEntry.findMany(owned)],
    ["Reminder", await prisma.reminder.findMany(owned)],
    ["FavoriteItem", await prisma.favoriteItem.findMany(owned)],
    ["Tag", await prisma.tag.findMany(owned)],
  ];

  const batch = await prisma.seedBatch.create({
    data: { userId, label: DEMO_BATCH_LABEL, kind: "demo" },
  });

  let total = 0;
  for (const [model, rows] of idsByModel) {
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500);
      await prisma.seedRecord.createMany({
        data: chunk.map((row) => ({ batchId: batch.id, model, recordId: row.id })),
      });
      total += chunk.length;
    }
  }
  return total;
}
