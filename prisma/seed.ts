/**
 * Seed script — populates the local database with the bundled food table plus
 * ~10 weeks of realistic history so every chart, streak and heatmap has
 * something to show the moment you open the app.
 *
 * Run with `npm run db:seed` (or `npm run setup` for generate + push + seed).
 * It is idempotent-ish: it clears the demo user's records first, so re-running
 * gives a fresh, consistent dataset rather than duplicates.
 */
import { PrismaClient } from "@prisma/client";
import { addDays, format, subDays } from "date-fns";

import { SEED_FOODS } from "../src/lib/data/foods";
import { manualDailyFingerprint } from "../src/lib/logic/health-import/rollup";
// The seed calls the app's real aggregation rather than keeping its own copy of
// the scoring formula. It used to duplicate scoreDay() by hand, which meant
// seeded history and live recomputation could drift apart silently.
import { rebuildSummaries } from "../src/server/summaries";

const prisma = new PrismaClient();

const HISTORY_DAYS = 70;
const FUTURE_DAYS = 14;

const day = (offset: number) => format(addDays(new Date(), offset), "yyyy-MM-dd");
const todayKey = () => format(new Date(), "yyyy-MM-dd");

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

async function main() {
  console.log("Seeding Personal OS…");

  // --- user ----------------------------------------------------------------
  const user = await prisma.user.upsert({
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

  // Clear this user's records so re-seeding is clean.
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
  const tagNames = ["deepwork", "errand", "family", "focus"];
  const tags = await Promise.all(
    tagNames.map((name) => prisma.tag.create({ data: { userId: user.id, name, color: "slate" } })),
  );

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
  };

  console.log("Done:", counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

export { todayKey };
