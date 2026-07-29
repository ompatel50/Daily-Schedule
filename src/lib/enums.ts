/**
 * SQLite has no native enums, so every "enum" column is TEXT validated here.
 * Each list is paired with display metadata (label, colour, icon) so the UI
 * never hard-codes strings and new values only have to be added once.
 */

export const SCHEDULE_CATEGORIES = [
  "work",
  "personal",
  "health",
  "fitness",
  "meal",
  "learning",
  "admin",
  "social",
  "rest",
] as const;
export type ScheduleCategory = (typeof SCHEDULE_CATEGORIES)[number];

export const CATEGORY_META: Record<
  ScheduleCategory,
  { label: string; dot: string; chip: string; bar: string }
> = {
  work: {
    label: "Work",
    dot: "bg-blue-500",
    chip: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    bar: "border-l-blue-500",
  },
  personal: {
    label: "Personal",
    dot: "bg-slate-500",
    chip: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20",
    bar: "border-l-slate-400",
  },
  health: {
    label: "Health",
    dot: "bg-sky-500",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
    bar: "border-l-sky-500",
  },
  fitness: {
    label: "Fitness",
    dot: "bg-violet-500",
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
    bar: "border-l-violet-500",
  },
  meal: {
    label: "Meal",
    dot: "bg-orange-500",
    chip: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
    bar: "border-l-orange-500",
  },
  learning: {
    label: "Learning",
    dot: "bg-amber-500",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    bar: "border-l-amber-500",
  },
  admin: {
    label: "Admin",
    dot: "bg-zinc-500",
    chip: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/20",
    bar: "border-l-zinc-500",
  },
  social: {
    label: "Social",
    dot: "bg-pink-500",
    chip: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20",
    bar: "border-l-pink-500",
  },
  rest: {
    label: "Rest",
    dot: "bg-teal-500",
    chip: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20",
    bar: "border-l-teal-500",
  },
};

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_META: Record<Priority, { label: string; chip: string; rank: number }> = {
  low: { label: "Low", chip: "text-muted-foreground", rank: 0 },
  medium: { label: "Medium", chip: "text-foreground", rank: 1 },
  high: { label: "High", chip: "text-amber-600 dark:text-amber-400", rank: 2 },
  urgent: { label: "Urgent", chip: "text-red-600 dark:text-red-400", rank: 3 },
};

export const ITEM_STATUSES = ["planned", "done", "skipped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const HABIT_CATEGORIES = [
  "health",
  "productivity",
  "learning",
  "hygiene",
  "mindfulness",
  "personal",
] as const;
export type HabitCategory = (typeof HABIT_CATEGORIES)[number];

export const HABIT_CATEGORY_META: Record<HabitCategory, { label: string; chip: string }> = {
  health: { label: "Health", chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  productivity: { label: "Productivity", chip: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  learning: { label: "Learning", chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  hygiene: { label: "Hygiene", chip: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" },
  mindfulness: { label: "Mindfulness", chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  personal: { label: "Personal", chip: "bg-pink-500/10 text-pink-600 dark:text-pink-400" },
};

export const TIMES_OF_DAY = ["morning", "afternoon", "evening", "before_bed", "anytime"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export const TIME_OF_DAY_META: Record<TimeOfDay, { label: string; order: number }> = {
  morning: { label: "Morning", order: 0 },
  afternoon: { label: "Afternoon", order: 1 },
  evening: { label: "Evening", order: 2 },
  before_bed: { label: "Before bed", order: 3 },
  anytime: { label: "Anytime", order: 4 },
};

export const HABIT_STATUSES = ["done", "skipped", "missed"] as const;
export type HabitStatus = (typeof HABIT_STATUSES)[number];

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "custom"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_TYPE_META: Record<MealType, { label: string; order: number; defaultTime: string }> =
  {
    breakfast: { label: "Breakfast", order: 0, defaultTime: "08:00" },
    lunch: { label: "Lunch", order: 1, defaultTime: "12:30" },
    dinner: { label: "Dinner", order: 3, defaultTime: "19:00" },
    snack: { label: "Snack", order: 2, defaultTime: "15:30" },
    custom: { label: "Other", order: 4, defaultTime: "10:00" },
  };

export const FOOD_CATEGORIES = [
  "protein",
  "grain",
  "vegetable",
  "fruit",
  "dairy",
  "fat",
  "snack",
  "beverage",
  "supplement",
  "prepared",
  "other",
] as const;
export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

/**
 * Serving units, defined once in `lib/logic/servings` alongside the conversion
 * factors and re-exported here so the enums module stays the single import for
 * UI code. Widening this list is not enough to make a unit usable — the food
 * must also have the constants to convert it, which `canConvert` decides.
 */
export { ALL_SERVING_UNITS as SERVING_UNITS } from "@/lib/logic/servings";
export type { AnyServingUnit as ServingUnit } from "@/lib/logic/servings";

export const WORKOUT_TYPES = [
  "strength",
  "cardio",
  "walking",
  "running",
  "cycling",
  "swimming",
  "yoga",
  "mobility",
  "hiit",
  "sport",
  "custom",
] as const;
export type WorkoutType = (typeof WORKOUT_TYPES)[number];

export const WORKOUT_TYPE_META: Record<
  WorkoutType,
  { label: string; chip: string; tracksSets: boolean; tracksDistance: boolean; met: number }
> = {
  strength: {
    label: "Strength",
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    tracksSets: true,
    tracksDistance: false,
    met: 5,
  },
  cardio: {
    label: "Cardio",
    chip: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    tracksSets: false,
    tracksDistance: false,
    met: 7,
  },
  walking: {
    label: "Walking",
    chip: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
    tracksSets: false,
    tracksDistance: true,
    met: 3.5,
  },
  running: {
    label: "Running",
    chip: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    tracksSets: false,
    tracksDistance: true,
    met: 9.8,
  },
  cycling: {
    label: "Cycling",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tracksSets: false,
    tracksDistance: true,
    met: 7.5,
  },
  swimming: {
    label: "Swimming",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    tracksSets: false,
    tracksDistance: true,
    met: 8,
  },
  yoga: {
    label: "Yoga",
    chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    tracksSets: false,
    tracksDistance: false,
    met: 3,
  },
  mobility: {
    label: "Mobility",
    chip: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    tracksSets: true,
    tracksDistance: false,
    met: 2.5,
  },
  hiit: {
    label: "HIIT",
    chip: "bg-red-500/10 text-red-600 dark:text-red-400",
    tracksSets: true,
    tracksDistance: false,
    met: 10,
  },
  sport: {
    label: "Sport",
    chip: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    tracksSets: false,
    tracksDistance: true,
    met: 7,
  },
  custom: {
    label: "Custom",
    chip: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
    tracksSets: true,
    tracksDistance: true,
    met: 5,
  },
};

export const INTENSITIES = ["easy", "moderate", "hard", "max"] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const INTENSITY_MULTIPLIER: Record<Intensity, number> = {
  easy: 0.8,
  moderate: 1,
  hard: 1.2,
  max: 1.4,
};

export const HEALTH_METRIC_TYPES = [
  "steps",
  "active_calories",
  "resting_calories",
  "sleep_hours",
  "resting_hr",
  "hrv",
  "body_weight",
  "body_fat",
  "hydration_ml",
  "blood_pressure",
  "mood",
  "energy",
] as const;
export type HealthMetricType = (typeof HEALTH_METRIC_TYPES)[number];

export const HEALTH_METRIC_META: Record<
  HealthMetricType,
  {
    label: string;
    unit: string;
    /** Higher is better (`up`), lower is better (`down`), or neutral. */
    goodDirection: "up" | "down" | "neutral";
    decimals: number;
    /** Used to seed a sensible default goal and chart domain. */
    typical: number;
    icon: string;
  }
> = {
  steps: { label: "Steps", unit: "", goodDirection: "up", decimals: 0, typical: 8000, icon: "Footprints" },
  active_calories: {
    label: "Active calories",
    unit: "kcal",
    goodDirection: "up",
    decimals: 0,
    typical: 500,
    icon: "Flame",
  },
  resting_calories: {
    label: "Resting calories",
    unit: "kcal",
    goodDirection: "neutral",
    decimals: 0,
    typical: 1750,
    icon: "Battery",
  },
  sleep_hours: { label: "Sleep", unit: "h", goodDirection: "up", decimals: 1, typical: 7.5, icon: "Moon" },
  resting_hr: {
    label: "Resting HR",
    unit: "bpm",
    goodDirection: "down",
    decimals: 0,
    typical: 58,
    icon: "HeartPulse",
  },
  hrv: { label: "HRV", unit: "ms", goodDirection: "up", decimals: 0, typical: 55, icon: "Activity" },
  body_weight: {
    label: "Body weight",
    unit: "lb",
    goodDirection: "neutral",
    decimals: 1,
    typical: 175,
    icon: "Scale",
  },
  body_fat: { label: "Body fat", unit: "%", goodDirection: "down", decimals: 1, typical: 18, icon: "Percent" },
  hydration_ml: {
    label: "Hydration",
    unit: "ml",
    goodDirection: "up",
    decimals: 0,
    typical: 2500,
    icon: "Droplets",
  },
  blood_pressure: {
    label: "Blood pressure",
    unit: "mmHg",
    goodDirection: "neutral",
    decimals: 0,
    typical: 118,
    icon: "Gauge",
  },
  mood: { label: "Mood", unit: "/5", goodDirection: "up", decimals: 1, typical: 4, icon: "Smile" },
  energy: { label: "Energy", unit: "/5", goodDirection: "up", decimals: 1, typical: 4, icon: "Zap" },
};

export const GOAL_DOMAINS = ["nutrition", "workout", "habit", "health", "planner"] as const;
export type GoalDomain = (typeof GOAL_DOMAINS)[number];

/** Narrow an untrusted string to a known enum member, else fall back. */
export function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
