import { z } from "zod";
import {
  ACCOUNT_TYPES,
  BILL_KINDS,
  BILL_RECURRENCES,
  BUDGETABLE_CATEGORIES,
  BUDGET_ALERT_THRESHOLDS,
  BUDGET_PERIODS,
  DOCUMENT_KINDS,
  FINANCE_CATEGORIES,
  isBookkeepingCategory,
  FOOD_CATEGORIES,
  GOAL_DOMAINS,
  HABIT_CATEGORIES,
  HABIT_STATUSES,
  HEALTH_METRIC_TYPES,
  INTENSITIES,
  ITEM_STATUSES,
  MEAL_TYPES,
  PRIORITIES,
  REPEAT_UNITS,
  SCHEDULE_CATEGORIES,
  SERVING_UNITS,
  WORKOUT_TYPES,
} from "./enums";
import { FOOD_PROVIDERS } from "./logic/food";
import { GOAL_COMPARISONS, GOAL_SOURCES } from "./logic/goals";
import { TEMPLATE_APPLY_MODES } from "./logic/planner";
import { DAYPARTS, OVERRIDE_KINDS, SCHEDULE_MODES } from "./logic/schedule";
import { NUTRIENT_BASES } from "./logic/servings";
import { normalizeTagNames, TAG_NAME_MAX, TASK_TAG_LIMIT } from "./logic/tasks";

/** Every server action validates its input through one of these schemas. */

const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

const minute = z.number().int().min(0).max(1439);
const optionalMinute = minute.nullable().optional();

export const scheduleItemSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().trim().min(1, "Title is required").max(200),
    notes: z.string().max(5000).nullable().optional(),
    date: dayKey,
    startMinute: optionalMinute,
    endMinute: optionalMinute,
    allDay: z.boolean().default(false),
    category: z.enum(SCHEDULE_CATEGORIES).default("personal"),
    priority: z.enum(PRIORITIES).default("medium"),
    status: z.enum(ITEM_STATUSES).default("planned"),
    recurrenceRule: z.string().nullable().optional(),
    tagIds: z.array(z.string()).default([]),
    habitId: z.string().nullable().optional(),
  })
  .refine(
    (value) =>
      value.allDay ||
      value.startMinute === null ||
      value.startMinute === undefined ||
      value.endMinute === null ||
      value.endMinute === undefined ||
      value.endMinute >= value.startMinute,
    { message: "End time must be after the start time", path: ["endMinute"] },
  );

export type ScheduleItemInput = z.infer<typeof scheduleItemSchema>;

export const quickAddSchema = z.object({
  text: z.string().trim().min(1).max(300),
  date: dayKey,
});

export const scheduleTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  category: z.enum(SCHEDULE_CATEGORIES).default("personal"),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        startMinute: optionalMinute,
        endMinute: optionalMinute,
        allDay: z.boolean().default(false),
        category: z.enum(SCHEDULE_CATEGORIES).default("personal"),
        priority: z.enum(PRIORITIES).default("medium"),
        notes: z.string().max(2000).nullable().optional(),
      }),
    )
    .min(1, "Add at least one item"),
});

/** Applying a saved routine to a day. `mode` answers "it's already there". */
export const templateApplySchema = z.object({
  templateId: z.string().min(1),
  date: dayKey,
  mode: z.enum(TEMPLATE_APPLY_MODES).default("auto"),
});

/**
 * How far an edit or a delete reaches on a recurring item: just this
 * occurrence, this one and everything after it, or the whole series.
 */
export const seriesScopeSchema = z.enum(["one", "future", "all"]);
export type SeriesScope = z.infer<typeof seriesScopeSchema>;

export const habitSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().max(1000).nullable().optional(),
  category: z.enum(HABIT_CATEGORIES).default("health"),
  targetValue: z.number().positive().nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  color: z.string().max(20).default("emerald"),
  icon: z.string().max(40).default("Check"),
  startDate: dayKey,
  endDate: dayKey.nullable().optional(),
  archived: z.boolean().default(false),
});

export const habitLogSchema = z.object({
  habitId: z.string().min(1),
  date: dayKey,
  status: z.enum(HABIT_STATUSES),
  value: z.number().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

/** A finite, non-negative number — `.finite()` rejects NaN and Infinity. */
const nutrientAmount = (max: number) =>
  z.number().finite("Must be a number").min(0, "Cannot be negative").max(max);

export const foodItemSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name is required").max(160),
  brand: z.string().max(120).nullable().optional(),
  description: z.string().max(400).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  basis: z.enum(NUTRIENT_BASES).default("per_100g"),
  servingSize: z.number().positive("Serving size must be greater than 0").max(100000).default(100),
  servingUnit: z.string().max(20).default("g"),
  servingLabel: z.string().max(80).nullable().optional(),
  calories: nutrientAmount(10000),
  protein: nutrientAmount(1000).default(0),
  carbs: nutrientAmount(1000).default(0),
  fat: nutrientAmount(1000).default(0),
  fiber: nutrientAmount(1000).default(0),
  sugar: nutrientAmount(1000).default(0),
  sodium: nutrientAmount(500000).default(0),
  /** Optional micronutrients, keyed by the names in `lib/logic/food`. */
  extraNutrients: z.record(z.string(), nutrientAmount(1_000_000)).optional(),
  category: z.enum(FOOD_CATEGORIES).default("other"),
  favorite: z.boolean().optional(),
});

/**
 * `idempotencyKey` is generated per save attempt by the client. A double-click,
 * a retried submit and an optimistic replay all carry the same one, and the
 * unique index on `(mealId, idempotencyKey)` turns the second write into a
 * no-op. Deliberate duplication uses a fresh key, so it still works.
 */
export const mealEntrySchema = z.object({
  date: dayKey,
  mealType: z.enum(MEAL_TYPES),
  mealLabel: z.string().max(60).nullable().optional(),
  /** Internal id, when the food is already in the database. */
  foodItemId: z.string().min(1).optional(),
  /** Provider identity, when logging a result that has not been cached yet. */
  provider: z.enum(FOOD_PROVIDERS).optional(),
  externalId: z.string().min(1).max(64).optional(),
  quantity: z.number().positive("Quantity must be greater than 0").max(10000),
  unit: z.enum(SERVING_UNITS).default("serving"),
  idempotencyKey: z.string().min(8).max(80).optional(),
});

export const updateMealEntrySchema = z.object({
  id: z.string().min(1),
  quantity: z.number().positive().max(10000),
  unit: z.enum(SERVING_UNITS),
});

export const moveMealEntrySchema = z.object({
  id: z.string().min(1),
  date: dayKey.optional(),
  mealType: z.enum(MEAL_TYPES).optional(),
  mealLabel: z.string().max(60).nullable().optional(),
});

// --- workout sessions -------------------------------------------------------

/**
 * A session starts from a template, from a past workout, or empty. All three
 * are optional and mutually exclusive in practice; the action picks whichever
 * is present, preferring the template.
 */
export const startSessionSchema = z.object({
  date: dayKey,
  templateId: z.string().min(1).optional(),
  fromWorkoutId: z.string().min(1).optional(),
  name: z.string().trim().max(120).optional(),
  type: z.enum(WORKOUT_TYPES).optional(),
});

/**
 * Ticking a set. Everything is optional because the common case is tapping the
 * checkbox and accepting the target — the action falls back to it rather than
 * writing nulls over a plan.
 */
export const completeSetSchema = z.object({
  id: z.string().min(1),
  reps: z.number().int().min(0).max(1000).nullable().optional(),
  weightKg: z.number().min(0).max(2000).nullable().optional(),
  rpe: z.number().min(0).max(10).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const addSessionSetSchema = z.object({
  workoutId: z.string().min(1),
  exercise: z.string().trim().min(1, "Exercise is required").max(120),
  targetReps: z.number().int().min(0).max(1000).nullable().optional(),
  targetWeightKg: z.number().min(0).max(2000).nullable().optional(),
});

/**
 * Rest override for one exercise's sets within the open session. Null (or 0)
 * clears it back to the session default.
 */
export const setExerciseRestSchema = z.object({
  workoutId: z.string().min(1),
  exercise: z.string().trim().min(1, "Exercise is required").max(120),
  restSec: z.number().int().min(0).max(3600).nullable(),
});

/**
 * Writing a progression estimate onto an exercise's outstanding targets. Only
 * ever sent from an explicit "apply" tap — suggestions never apply themselves.
 */
export const applyProgressionSchema = z.object({
  workoutId: z.string().min(1),
  exercise: z.string().trim().min(1, "Exercise is required").max(120),
  targetWeightKg: z.number().min(0).max(2000),
});

export const workoutSetSchema = z.object({
  id: z.string().optional(),
  exercise: z.string().trim().min(1).max(120),
  setNumber: z.number().int().min(1).default(1),
  reps: z.number().int().min(0).max(1000).nullable().optional(),
  weightKg: z.number().min(0).max(2000).nullable().optional(),
  durationSec: z.number().int().min(0).max(86400).nullable().optional(),
  distanceM: z.number().min(0).max(1000000).nullable().optional(),
  restSec: z.number().int().min(0).max(3600).nullable().optional(),
  rpe: z.number().min(0).max(10).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  completed: z.boolean().default(true),
});

export const workoutSchema = z.object({
  id: z.string().optional(),
  date: dayKey,
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),
  name: z.string().trim().min(1, "Name is required").max(160),
  type: z.enum(WORKOUT_TYPES).default("strength"),
  durationMin: z.number().int().min(0).max(1440).default(0),
  intensity: z.enum(INTENSITIES).default("moderate"),
  caloriesBurned: z.number().int().min(0).max(20000).nullable().optional(),
  avgHeartRate: z.number().int().min(0).max(250).nullable().optional(),
  distanceKm: z.number().min(0).max(1000).nullable().optional(),
  perceivedEffort: z.number().int().min(1).max(10).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(["planned", "completed", "skipped"]).default("completed"),
  sets: z.array(workoutSetSchema).default([]),
  addToPlanner: z.boolean().default(true),
});

export const workoutTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(WORKOUT_TYPES).default("strength"),
  description: z.string().max(1000).nullable().optional(),
  durationMin: z.number().int().min(0).max(1440).default(45),
  intensity: z.enum(INTENSITIES).default("moderate"),
  exercises: z
    .array(
      z.object({
        exercise: z.string().trim().min(1).max(120),
        sets: z.number().int().min(1).max(30).default(3),
        reps: z.number().int().min(0).max(1000).optional(),
        weightKg: z.number().min(0).max(2000).optional(),
        restSec: z.number().int().min(0).max(3600).optional(),
        notes: z.string().max(300).optional(),
        /** Superset/circuit key ("A", "B"…). Absent means ungrouped. */
        group: z.string().trim().max(10).optional(),
      }),
    )
    .default([]),
});

export const healthMetricSchema = z.object({
  date: dayKey,
  type: z.enum(HEALTH_METRIC_TYPES),
  value: z.number().min(0).max(1000000),
  secondaryValue: z.number().min(0).max(1000).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  /** Optional time of the reading, HH:mm. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
});

/** The schedule half of a goal or habit form. Shared so both stay in step. */
export const scheduleInputSchema = z
  .object({
    mode: z.enum(SCHEDULE_MODES).default("every_day"),
    weekdays: z.array(z.number().int().min(0).max(6)).default([]),
    interval: z.number().int().min(1).max(365).default(1),
    timesPerWeek: z.number().int().min(1).max(7).nullable().default(null),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    enabled: z.boolean().default(true),
    daypart: z.enum(DAYPARTS).default("anytime"),
    timeMinute: optionalMinute,
    reminderEnabled: z.boolean().default(false),
    reminderMinute: optionalMinute,
  })
  .refine((value) => value.mode !== "weekdays" || value.weekdays.length > 0, {
    message: "Pick at least one day",
    path: ["weekdays"],
  })
  .refine((value) => value.mode !== "times_per_week" || (value.timesPerWeek ?? 0) > 0, {
    message: "Choose how many times per week",
    path: ["timesPerWeek"],
  });

export type ScheduleFormInput = z.infer<typeof scheduleInputSchema>;

/** How a schedule change should treat already-scored history. */
export const scheduleApplySchema = z.object({
  mode: z.enum(["forward", "from", "all"]).default("forward"),
  from: dayKey.optional(),
});

export const goalSchema = z.object({
  id: z.string().optional(),
  domain: z.enum(GOAL_DOMAINS),
  metric: z.string().min(1).max(60),
  label: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().max(1000).nullable().optional(),
  target: z.number().min(0).max(1000000),
  targetMax: z.number().min(0).max(1000000).nullable().optional(),
  unit: z.string().max(20).default(""),
  direction: z.enum(GOAL_COMPARISONS).default("gte"),
  period: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  source: z.enum(GOAL_SOURCES).default("manual"),
  sourceRef: z.string().max(60).nullable().optional(),
  startDate: dayKey.nullable().optional(),
  endDate: dayKey.nullable().optional(),
  active: z.boolean().default(true),
});

/** Goal creation/editing including its schedule — one atomic submission. */
export const goalWithScheduleSchema = z.object({
  goal: goalSchema,
  schedule: scheduleInputSchema,
  apply: scheduleApplySchema.optional(),
});

/** Habit creation/editing including its schedule — one atomic submission. */
export const habitWithScheduleSchema = z.object({
  habit: habitSchema,
  schedule: scheduleInputSchema,
  apply: scheduleApplySchema.optional(),
});

export const goalEntrySchema = z.object({
  goalId: z.string().min(1),
  date: dayKey,
  status: z.enum(["done", "skipped", "excused"]),
  value: z.number().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const dateOverrideSchema = z.object({
  ownerType: z.enum(["goal", "habit"]),
  ownerId: z.string().min(1),
  date: dayKey,
  kind: z.enum(OVERRIDE_KINDS),
  movedToDate: dayKey.nullable().optional(),
  timeMinute: optionalMinute,
  note: z.string().max(500).nullable().optional(),
});

export const journalSchema = z.object({
  date: dayKey,
  title: z.string().max(200).nullable().optional(),
  content: z.string().max(50000).default(""),
  mood: z.number().int().min(1).max(5).nullable().optional(),
  energy: z.number().int().min(1).max(5).nullable().optional(),
});

export const reminderSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(160),
  message: z.string().max(500).nullable().optional(),
  remindAt: z.string().min(1),
  repeat: z.enum(["none", "daily", "weekdays", "weekly"]).default("none"),
  enabled: z.boolean().default(true),
});

export const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().max(60),
  birthDate: z.string().nullable().optional(),
  heightCm: z.number().min(0).max(300).nullable().optional(),
  sex: z.enum(["male", "female", "other"]).nullable().optional(),
  activityLevel: z.enum(["sedentary", "light", "moderate", "active", "athlete"]),
  weekStartsOn: z.number().int().min(0).max(1),
  unitSystem: z.enum(["imperial", "metric"]),
  dayStartHour: z.number().int().min(0).max(23),
  dayEndHour: z.number().int().min(1).max(24),
});

// --- tasks & projects --------------------------------------------------------

export const projectSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give the project a name").max(120),
  description: z.string().max(1000).nullable().optional(),
  color: z.string().max(40).default("slate"),
});

export type ProjectInput = z.infer<typeof projectSchema>;

export const taskSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().trim().min(1, "Give the task a title").max(200),
    notes: z.string().max(5000).nullable().optional(),
    projectId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    priority: z.enum(PRIORITIES).default("medium"),
    dueDate: dayKey.nullable().optional(),
    repeat: z.enum(REPEAT_UNITS).default("none"),
    repeatEvery: z.number().int().min(1).max(365).default(1),
    reminderEnabled: z.boolean().default(false),
    /**
     * Tag NAMES, not ids: a tag is created by typing it. The transform
     * normalises spelling, drops blanks and duplicates, and caps the list, so
     * the action layer only ever sees a clean vocabulary.
     */
    tags: z
      .array(z.string().max(TAG_NAME_MAX * 2))
      .max(TASK_TAG_LIMIT * 4, `Up to ${TASK_TAG_LIMIT} tags per task`)
      .default([])
      .transform((values) => normalizeTagNames(values)),
  })
  .refine((value) => value.repeat === "none" || Boolean(value.dueDate), {
    message: "A repeating task needs a due date to repeat from",
    path: ["repeat"],
  });

export type TaskInput = z.infer<typeof taskSchema>;

// --- finance -----------------------------------------------------------------

/** Cents-precision money, kept finite and inside a sane planetary bound. */
const money = z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000);

export const financeAccountSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give the account a name").max(120),
  type: z.enum(ACCOUNT_TYPES).default("checking"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code")
    .transform((value) => value.toUpperCase())
    .default("USD"),
  openingBalance: money.default(0),
  /** Remind when the balance drops below this; null = no low-balance alert. */
  lowBalanceThreshold: money.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type FinanceAccountInput = z.infer<typeof financeAccountSchema>;

export const financeTransactionSchema = z
  .object({
    id: z.string().optional(),
    accountId: z.string().min(1, "Pick an account"),
    date: dayKey,
    /** Signed: positive = money in, negative = money out. */
    amount: money,
    payee: z.string().max(200).nullable().optional(),
    category: z.enum(FINANCE_CATEGORIES).default("other"),
    notes: z.string().max(2000).nullable().optional(),
    billId: z.string().nullable().optional(),
  })
  .refine((value) => value.amount !== 0, {
    message: "An amount of zero records nothing",
    path: ["amount"],
  });

export type FinanceTransactionInput = z.infer<typeof financeTransactionSchema>;

export const setAccountBalanceSchema = z.object({
  accountId: z.string().min(1),
  balance: money,
  date: dayKey,
});

export const billSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give it a name").max(120),
  amount: money.refine((value) => value > 0, "The amount must be above zero"),
  kind: z.enum(BILL_KINDS).default("bill"),
  // Bookkeeping categories are refused: markBillPaid writes the payment into
  // the ledger under the bill's category, and a `transfer`/`adjustment` row
  // would hide real spending from every summary while pairing with nothing.
  category: z
    .enum(FINANCE_CATEGORIES)
    .default("utilities")
    .refine(
      (value) => !isBookkeepingCategory(value),
      "Bills record real spending — pick a spending category",
    ),
  accountId: z.string().nullable().optional(),
  recurrence: z.enum(BILL_RECURRENCES).default("monthly"),
  /** The next due date; on create it anchors the recurrence too. */
  dueDate: dayKey,
  autoPay: z.boolean().default(false),
  reminderEnabled: z.boolean().default(true),
  reminderDaysBefore: z.number().int().min(0).max(60).default(3),
  notes: z.string().max(2000).nullable().optional(),
});

export type BillInput = z.infer<typeof billSchema>;

export const markBillPaidSchema = z.object({
  billId: z.string().min(1),
  /** The day the payment happened (defaults to the user's today in the action). */
  date: dayKey,
  /** Actual amount paid; defaults to the bill's expected amount. */
  amount: money.refine((value) => value > 0, "The amount must be above zero").optional(),
  /** Account it was paid from; defaults to the bill's account. */
  accountId: z.string().nullable().optional(),
  /** Also write the payment into the ledger (needs an account). */
  recordTransaction: z.boolean().default(true),
});

export const savingsGoalSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give the goal a name").max(120),
  targetAmount: money.refine((value) => value > 0, "The target must be above zero"),
  currentAmount: money.refine((value) => value >= 0, "Cannot be negative").default(0),
  targetDate: dayKey.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type SavingsGoalInput = z.infer<typeof savingsGoalSchema>;

export const savingsContributionSchema = z
  .object({
    id: z.string().min(1),
    /** Signed: positive adds to the goal, negative withdraws. */
    amount: money,
  })
  .refine((value) => value.amount !== 0, {
    message: "An amount of zero records nothing",
    path: ["amount"],
  });

/** Moving money between two of your own accounts — same currency only. */
export const transferSchema = z
  .object({
    fromAccountId: z.string().min(1, "Pick the account the money leaves"),
    toAccountId: z.string().min(1, "Pick the account the money enters"),
    amount: money.refine((value) => value > 0, "The amount must be above zero"),
    date: dayKey,
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: "Pick two different accounts",
    path: ["toAccountId"],
  });

export type TransferInput = z.infer<typeof transferSchema>;

/** One budget per spending category, measured over a monthly or weekly window. */
export const budgetSchema = z.object({
  id: z.string().optional(),
  category: z.enum(BUDGETABLE_CATEGORIES as [string, ...string[]]),
  amount: money.refine((value) => value > 0, "The target must be above zero"),
  period: z.enum(BUDGET_PERIODS).default("monthly"),
  /** Warn once per period at this share of the target; null = no alert. */
  alertThresholdPercent: z
    .union([
      z.literal(BUDGET_ALERT_THRESHOLDS[0]),
      z.literal(BUDGET_ALERT_THRESHOLDS[1]),
      z.literal(BUDGET_ALERT_THRESHOLDS[2]),
      z.literal(BUDGET_ALERT_THRESHOLDS[3]),
    ])
    .nullable()
    .optional(),
});

export type BudgetInput = z.infer<typeof budgetSchema>;

// --- documents & renewals ----------------------------------------------------

/** Something with an expiry date worth being reminded about. */
export const documentSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give it a name").max(120),
  kind: z.enum(DOCUMENT_KINDS).default("other"),
  issuer: z.string().max(120).nullable().optional(),
  expiryDate: dayKey,
  notes: z.string().max(2000).nullable().optional(),
  reminderEnabled: z.boolean().default(true),
  /** Remind this many days before expiry (0 = only on the day). */
  reminderDaysBefore: z.number().int().min(0).max(365).default(30),
});

export type DocumentInput = z.infer<typeof documentSchema>;

/**
 * A CSV import request — preview and commit share it, so what was previewed is
 * exactly what commits. The content cap matches the parser's own bound.
 */
export const financeCsvImportSchema = z.object({
  accountId: z.string().min(1, "Pick an account"),
  fileName: z.string().trim().min(1).max(200),
  content: z.string().min(1, "The file is empty").max(1_000_000),
  /** Override the auto-detected day/month order of slash dates. */
  dateOrder: z.enum(["iso", "mdy", "dmy"]).optional(),
});

export type FinanceCsvImportInput = z.infer<typeof financeCsvImportSchema>;

// --- inbox -------------------------------------------------------------------

export const inboxItemSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, "Write something to capture").max(300),
  notes: z.string().max(5000).nullable().optional(),
});

export type InboxItemInput = z.infer<typeof inboxItemSchema>;

/**
 * Turning a capture into a task. Title/notes default to the item's own; the
 * rest is what the task dialog would have asked anyway.
 */
export const convertInboxItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1, "Give the task a title").max(200).optional(),
  notes: z.string().max(5000).nullable().optional(),
  projectId: z.string().nullable().optional(),
  priority: z.enum(PRIORITIES).default("medium"),
  dueDate: dayKey.nullable().optional(),
});

export type ConvertInboxItemInput = z.infer<typeof convertInboxItemSchema>;

/**
 * Putting a task on the planner: an ordinary planner block on a chosen day,
 * linked back to the task. All-day unless a start time is given.
 */
export const scheduleTaskSchema = z
  .object({
    taskId: z.string().min(1),
    date: dayKey,
    startMinute: optionalMinute,
    endMinute: optionalMinute,
  })
  .refine(
    (value) =>
      value.startMinute === null ||
      value.startMinute === undefined ||
      value.endMinute === null ||
      value.endMinute === undefined ||
      value.endMinute >= value.startMinute,
    { message: "End time must be after the start time", path: ["endMinute"] },
  );

export type ScheduleTaskInput = z.infer<typeof scheduleTaskSchema>;

/** Standard action result — every server action returns this shape. */
export type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

export function succeed<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/** Turn a Zod failure into an ActionResult without repeating boilerplate. */
export function fromZod(error: z.ZodError): ActionResult<never> {
  const flat = error.flatten();
  const first =
    Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? "Invalid input";
  return fail(first, flat.fieldErrors as Record<string, string[]>);
}
