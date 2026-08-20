"use server";

import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import { dayKey, fail, fromZod, succeed, type ActionResult } from "@/lib/validation";
import {
  FINANCE_CATEGORIES,
  MANUAL_ENTRY_METRICS,
  MEAL_TYPES,
  PRIORITIES,
  SERVING_UNITS,
  WORKOUT_TYPES,
  type HealthMetricType,
} from "@/lib/enums";
import { displayUnitFor, toCanonical, toDisplay } from "@/lib/logic/health";
import { lbToKg } from "@/lib/logic/nutrition";
import { searchFoods } from "@/server/queries";

import { createScheduleItem } from "@/server/actions/planner";
import { saveTask } from "@/server/actions/tasks";
import { saveTransaction } from "@/server/actions/finance";
import { logHealthMetric } from "@/server/actions/health";
import { logFood } from "@/server/actions/nutrition";
import { saveWorkout } from "@/server/actions/workouts";
import { logHabit } from "@/server/actions/habits";
import { saveInboxItem } from "@/server/actions/inbox";

/**
 * Server half of unified quick-capture. The pure parser
 * (src/lib/logic/capture.ts) classifies and drafts; this file answers the two
 * questions only the database can: "which of MY records does this text mean?"
 * (previewCapture) and "write it" (commitCapture).
 *
 * commitCapture deliberately contains no mutation logic of its own — every
 * branch delegates to the module's existing server action, which performs its
 * own validation, ownership checks, day recomputes and revalidation. Capture
 * is a router, not a second write path.
 */

// --- preview: resolve drafts against the user's data --------------------------

export interface HabitCandidate {
  id: string;
  name: string;
  /** Today's logged status, so the dialog can say "already done". */
  loggedStatus: string | null;
}

export interface FoodCandidate {
  foodItemId: string | null;
  provider: string;
  externalId: string | null;
  name: string;
  brand: string | null;
  calories: number;
  /** True when the name matches the phrase exactly — safe to preselect. */
  confident: boolean;
}

export interface AccountOption {
  id: string;
  name: string;
  currency: string;
}

export interface CaptureContext {
  accounts: AccountOption[];
  /** The account the last transaction used — the sensible default. */
  defaultAccountId: string | null;
  unitSystem: string;
  weightUnit: string;
}

const previewSchema = z.object({
  habitQuery: z.string().trim().max(200).optional(),
  habitDate: dayKey.optional(),
  foodPhrases: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  wantAccounts: z.boolean().optional(),
});

export interface CapturePreview {
  habits: HabitCandidate[];
  foods: Record<string, FoodCandidate[]>;
  context: CaptureContext;
}

export async function previewCapture(input: unknown): Promise<ActionResult<CapturePreview>> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  const [habits, foodEntries, accounts, lastTransaction] = await Promise.all([
    parsed.data.habitQuery
      ? prisma.habit.findMany({
          where: { userId: user.id, archived: false },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    resolveFoodPhrases(parsed.data.foodPhrases ?? []),
    parsed.data.wantAccounts
      ? prisma.financeAccount.findMany({
          where: { userId: user.id, archivedAt: null },
          select: { id: true, name: true, currency: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([] as AccountOption[]),
    parsed.data.wantAccounts
      ? prisma.financeTransaction.findFirst({
          where: { userId: user.id },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          select: { accountId: true },
        })
      : Promise.resolve(null as { accountId: string } | null),
  ]);

  // Habit resolution: substring match either way, so "did meditate" finds
  // "Meditation" and "did morning meditation" finds it too.
  let habitCandidates: HabitCandidate[] = [];
  if (parsed.data.habitQuery) {
    const query = parsed.data.habitQuery.toLowerCase();
    const matched = habits.filter((habit) => {
      const name = habit.name.toLowerCase();
      return name.includes(query) || query.includes(name);
    });
    const date = parsed.data.habitDate;
    const logs = date
      ? await prisma.habitLog.findMany({
          where: { userId: user.id, date, habitId: { in: matched.map((habit) => habit.id) } },
          select: { habitId: true, status: true },
        })
      : [];
    const statusByHabit = new Map(logs.map((log) => [log.habitId, log.status]));
    habitCandidates = matched.map((habit) => ({
      id: habit.id,
      name: habit.name,
      loggedStatus: statusByHabit.get(habit.id) ?? null,
    }));
  }

  return succeed({
    habits: habitCandidates,
    foods: foodEntries,
    context: {
      accounts,
      defaultAccountId:
        lastTransaction?.accountId ?? (accounts.length > 0 ? accounts[0].id : null),
      unitSystem: user.unitSystem,
      weightUnit: user.unitSystem === "imperial" ? "lb" : "kg",
    },
  });
}

/**
 * Resolve free-text food phrases against the local catalogue (bundled + the
 * user's own). Deliberately LOCAL-ONLY: this runs on every preview keystroke
 * and must never fan text out to external providers — the full provider
 * search stays behind the nutrition page's explicit search flow.
 */
async function resolveFoodPhrases(
  phrases: string[],
): Promise<Record<string, FoodCandidate[]>> {
  const result: Record<string, FoodCandidate[]> = {};
  for (const phrase of phrases) {
    const term = phrase.toLowerCase();
    // Try the phrase, then a naive singular — "eggs" should find "Egg".
    let rows = await searchFoods(term, 6);
    if (rows.length === 0 && term.endsWith("s") && term.length > 3) {
      rows = await searchFoods(term.slice(0, -1), 6);
    }
    result[phrase] = rows.map((row) => ({
      foodItemId: row.id,
      provider: row.provider,
      externalId: row.externalId,
      name: row.name,
      brand: row.brand,
      calories: row.calories,
      confident:
        rows.length > 0 &&
        (row.name.toLowerCase() === term ||
          row.name.toLowerCase() === term.replace(/s$/, "")) &&
        rows[0].id === row.id,
    }));
  }
  return result;
}

// --- commit: route the confirmed draft to the owning module -------------------

const commitSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("planner"),
    title: z.string().trim().min(1).max(200),
    date: dayKey,
    startMinute: z.number().int().min(0).max(1439).nullable(),
    endMinute: z.number().int().min(0).max(1439).nullable(),
    allDay: z.boolean(),
    category: z.string().max(40),
    priority: z.enum(PRIORITIES),
  }),
  z.object({
    intent: z.literal("task"),
    title: z.string().trim().min(1).max(200),
    dueDate: dayKey.nullable(),
    priority: z.enum(PRIORITIES),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  }),
  z.object({
    intent: z.enum(["expense", "income"]),
    accountId: z.string().min(1),
    amount: z.number().positive().max(1_000_000_000),
    payee: z.string().trim().max(200).nullable(),
    category: z.enum(FINANCE_CATEGORIES),
    date: dayKey,
  }),
  z.object({
    intent: z.literal("health"),
    metric: z.string().min(1).max(60),
    value: z.number().min(0).max(1_000_000),
    unit: z.string().max(10).nullable(),
    secondaryValue: z.number().min(0).max(1000).nullable(),
    date: dayKey,
  }),
  z.object({
    intent: z.literal("nutrition"),
    date: dayKey,
    mealType: z.enum(MEAL_TYPES),
    items: z
      .array(
        z.object({
          foodItemId: z.string().nullable(),
          provider: z.string().max(20).nullable(),
          externalId: z.string().max(120).nullable(),
          quantity: z.number().positive().max(10000),
          unit: z.enum(SERVING_UNITS),
          idempotencyKey: z.string().min(8).max(80),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.object({
    intent: z.literal("workout"),
    date: dayKey,
    name: z.string().trim().min(1).max(160),
    type: z.enum(WORKOUT_TYPES),
    durationMin: z.number().int().min(0).max(1440).nullable(),
    distanceKm: z.number().min(0).max(1000).nullable(),
    strength: z
      .object({
        exercise: z.string().trim().min(1).max(120),
        sets: z.number().int().min(1).max(30),
        reps: z.number().int().min(1).max(1000),
        weight: z.number().min(0).max(5000).nullable(),
        weightUnit: z.enum(["kg", "lb"]).nullable(),
      })
      .nullable(),
  }),
  z.object({
    intent: z.literal("habit"),
    habitId: z.string().min(1),
    status: z.enum(["done", "skipped"]),
    date: dayKey,
  }),
  z.object({
    intent: z.literal("inbox"),
    title: z.string().trim().min(1).max(300),
    notes: z.string().max(5000).nullable(),
  }),
]);

export interface CaptureOutcome {
  /** Where the record went, for the confirmation toast. */
  message: string;
  href: string;
}

export async function commitCapture(input: unknown): Promise<ActionResult<CaptureOutcome>> {
  const parsed = commitSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const draft = parsed.data;

  switch (draft.intent) {
    case "planner": {
      const result = await createScheduleItem({
        title: draft.title,
        date: draft.date,
        startMinute: draft.startMinute,
        endMinute: draft.endMinute,
        allDay: draft.allDay,
        category: draft.category,
        priority: draft.priority,
        status: "planned",
        tagIds: [],
      });
      if (!result.ok) return result;
      return succeed({ message: "Added to your planner", href: `/planner?date=${draft.date}` });
    }
    case "task": {
      const result = await saveTask({
        title: draft.title,
        priority: draft.priority,
        dueDate: draft.dueDate ?? undefined,
        tags: draft.tags,
      });
      if (!result.ok) return result;
      return succeed({ message: "Task created", href: "/tasks" });
    }
    case "expense":
    case "income": {
      const signed = draft.intent === "expense" ? -Math.abs(draft.amount) : Math.abs(draft.amount);
      const result = await saveTransaction({
        accountId: draft.accountId,
        date: draft.date,
        amount: signed,
        payee: draft.payee,
        category: draft.category,
      });
      if (!result.ok) return result;
      return succeed({
        message: draft.intent === "expense" ? "Expense recorded" : "Income recorded",
        href: "/finance",
      });
    }
    case "health": {
      if (!(MANUAL_ENTRY_METRICS as string[]).includes(draft.metric)) {
        return fail("That metric can't be logged manually");
      }
      const metric = draft.metric as HealthMetricType;
      // The action expects the value in the user's DISPLAY unit. An explicit
      // unit in the text ("weight 80kg" from an imperial user) converts via
      // the one health unit table — never ad-hoc math here.
      let value = draft.value;
      if (draft.unit) {
        const canonical = toCanonical(metric, draft.value, draft.unit);
        if (canonical === null) return fail(`"${draft.unit}" isn't a unit for ${metric}`);
        value = toDisplay(metric, canonical, user.unitSystem).value;
      }
      const result = await logHealthMetric({
        date: draft.date,
        type: metric,
        value: Math.round(value * 100) / 100,
        secondaryValue: draft.secondaryValue,
      });
      if (!result.ok) return result;
      return succeed({
        message: `Logged (${displayUnitFor(metric, user.unitSystem) || "value"})`,
        href: "/health",
      });
    }
    case "nutrition": {
      let logged = 0;
      for (const item of draft.items) {
        const result = await logFood({
          date: draft.date,
          mealType: draft.mealType,
          foodItemId: item.foodItemId ?? undefined,
          provider: item.foodItemId ? undefined : (item.provider ?? undefined),
          externalId: item.foodItemId ? undefined : (item.externalId ?? undefined),
          quantity: item.quantity,
          unit: item.unit,
          idempotencyKey: item.idempotencyKey,
        });
        if (!result.ok) {
          return logged === 0
            ? result
            : fail(`Logged ${logged} item${logged === 1 ? "" : "s"}, then: ${result.error}`);
        }
        logged += 1;
      }
      return succeed({
        message: `Logged ${logged} item${logged === 1 ? "" : "s"} to ${draft.mealType}`,
        href: `/nutrition?date=${draft.date}`,
      });
    }
    case "workout": {
      const sets = draft.strength
        ? Array.from({ length: draft.strength.sets }, (_, index) => ({
            exercise: draft.strength!.exercise,
            setNumber: index + 1,
            reps: draft.strength!.reps,
            weightKg: resolveWeightKg(
              draft.strength!.weight,
              draft.strength!.weightUnit,
              user.unitSystem,
            ),
            completed: true,
          }))
        : [];
      const result = await saveWorkout({
        date: draft.date,
        name: draft.name,
        type: draft.type,
        durationMin: draft.durationMin ?? 0,
        distanceKm: draft.distanceKm,
        status: "completed",
        sets,
      });
      if (!result.ok) return result;
      return succeed({ message: "Workout logged", href: `/workouts?date=${draft.date}` });
    }
    case "habit": {
      const result = await logHabit({
        habitId: draft.habitId,
        date: draft.date,
        status: draft.status,
      });
      if (!result.ok) return result;
      return succeed({
        message: draft.status === "done" ? "Habit marked done" : "Habit marked skipped",
        href: "/habits",
      });
    }
    case "inbox": {
      const result = await saveInboxItem({ title: draft.title, notes: draft.notes });
      if (!result.ok) return result;
      return succeed({ message: "Captured to your inbox", href: "/inbox" });
    }
  }
  // The switch is exhaustive over the schema's intents.
  return fail("Unknown capture intent");
}

/** Bare weights use the user's display unit; explicit units win. */
function resolveWeightKg(
  weight: number | null,
  unit: "kg" | "lb" | null,
  unitSystem: string,
): number | null {
  if (weight === null) return null;
  const effective = unit ?? (unitSystem === "imperial" ? "lb" : "kg");
  const kg = effective === "lb" ? lbToKg(weight) : weight;
  return Math.round(kg * 100) / 100;
}
