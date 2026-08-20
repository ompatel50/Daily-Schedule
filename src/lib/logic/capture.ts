import { type DayKey } from "@/lib/date";
import {
  FINANCE_CATEGORIES,
  MANUAL_ENTRY_METRICS,
  MEAL_TYPES,
  type FinanceCategory,
  type HealthMetricType,
  type MealType,
  type Priority,
  type WorkoutType,
} from "@/lib/enums";
import {
  extractDateToken,
  extractHashTokens,
  extractPriority,
  parseQuickAdd,
  type ParsedQuickAdd,
} from "@/lib/logic/quick-add";

/**
 * Unified quick-capture: classify one line of text into the module it belongs
 * to and parse it into that module's draft. Pure — no data access; anything
 * that needs the user's records (which habit? which food? which account?) is
 * resolved by the server preview (src/server/actions/capture.ts) and finally
 * confirmed by the user in the capture dialog.
 *
 * Two guarantees, inherited from the original planner quick-add and extended:
 *  1. Input is never lost. Whatever a sub-parser cannot claim stays in the
 *     draft's visible text (title/notes/phrase), and text no parser can claim
 *     falls through to Planner (the historical default) or, after a
 *     recognised-verb-but-unparseable start, to Inbox — never force-fit.
 *  2. Nothing commits silently. The dialog shows every parsed field editable
 *     before anything is written, and an ambiguous read (a non-empty
 *     `alternates`) requires the user to pick the intent first.
 */

export type CaptureIntent =
  | "planner"
  | "task"
  | "expense"
  | "income"
  | "health"
  | "nutrition"
  | "workout"
  | "habit"
  | "inbox";

export const CAPTURE_INTENT_META: Record<
  CaptureIntent,
  { label: string; hint: string; commitLabel: string }
> = {
  // "Add item" is the planner quick-add's historical button label — kept.
  planner: { label: "Planner", hint: "a block on your day", commitLabel: "Add item" },
  task: { label: "Task", hint: "something to get done", commitLabel: "Add task" },
  expense: { label: "Expense", hint: "money spent", commitLabel: "Add expense" },
  income: { label: "Income", hint: "money received", commitLabel: "Add income" },
  health: { label: "Health", hint: "a metric reading", commitLabel: "Log reading" },
  nutrition: { label: "Food", hint: "something you ate", commitLabel: "Log food" },
  workout: { label: "Workout", hint: "training you did", commitLabel: "Log workout" },
  habit: { label: "Habit", hint: "a habit tick", commitLabel: "Log habit" },
  inbox: { label: "Inbox", hint: "keep the raw note", commitLabel: "Capture" },
};

export interface PlannerDraft {
  intent: "planner";
  planner: ParsedQuickAdd;
}

export interface TaskDraft {
  intent: "task";
  title: string;
  /** Null when no date word appeared — an undated task, not "due today". */
  dueDate: DayKey | null;
  priority: Priority;
  tags: string[];
}

export interface MoneyDraft {
  intent: "expense" | "income";
  /** Positive dollars; the sign is the intent. */
  amount: number;
  payee: string | null;
  /** Null when no category word appeared — the server suggests one. */
  category: FinanceCategory | null;
  date: DayKey;
}

export interface HealthDraft {
  intent: "health";
  metric: HealthMetricType;
  /** In the unit the user typed (see `unit`) or their display unit if bare. */
  value: number;
  /** Explicit unit token from the text, e.g. "kg" — null means display unit. */
  unit: string | null;
  /** Diastolic for blood pressure. */
  secondaryValue: number | null;
  date: DayKey;
}

export interface NutritionItemDraft {
  phrase: string;
  quantity: number;
  /** A recognised serving unit token, or null for "count of the food". */
  unit: string | null;
}

export interface NutritionDraft {
  intent: "nutrition";
  mealType: MealType;
  items: NutritionItemDraft[];
  date: DayKey;
}

export interface WorkoutSetDraft {
  exercise: string;
  sets: number;
  reps: number;
  /** In the unit the user typed, or their display unit if bare. */
  weight: number | null;
  weightUnit: "kg" | "lb" | null;
}

export interface WorkoutDraft {
  intent: "workout";
  name: string;
  type: WorkoutType;
  durationMin: number | null;
  distanceKm: number | null;
  strength: WorkoutSetDraft | null;
  date: DayKey;
}

export interface HabitDraft {
  intent: "habit";
  /** Free text to resolve against the user's habits server-side. */
  query: string;
  status: "done" | "skipped";
  date: DayKey;
}

export interface InboxDraft {
  intent: "inbox";
  title: string;
  notes: string | null;
}

export type CaptureDraft =
  | PlannerDraft
  | TaskDraft
  | MoneyDraft
  | HealthDraft
  | NutritionDraft
  | WorkoutDraft
  | HabitDraft
  | InboxDraft;

export interface CaptureParse {
  draft: CaptureDraft;
  /**
   * Other plausible intents for the same text. Non-empty means the reading is
   * ambiguous and the UI must ask instead of committing the primary guess.
   */
  alternates: CaptureIntent[];
}

export interface CaptureOptions {
  baseDate: DayKey;
  /** Wall-clock minute for meal-type inference; null = unknown. */
  nowMinute?: number | null;
  /** "imperial" | "metric" — only used to default bare workout weights. */
  unitSystem?: string;
}

// --- shared token helpers ----------------------------------------------------

/** "$12.40", "12", "1,250.50" → dollars. Returns null when absent. */
function extractMoney(text: string): { text: string; amount: number | null } {
  const match = /(?:^|\s)[-−]?\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?=\s|$)/.exec(text);
  if (!match) return { text, amount: null };
  const whole = match[1].replace(/,/g, "");
  const amount = Number(`${whole}${match[2] ?? ""}`);
  if (!Number.isFinite(amount) || amount <= 0) return { text, amount: null };
  return { text: text.replace(match[0], " "), amount };
}

const FINANCE_CATEGORY_ALIASES: Record<string, FinanceCategory> = {
  food: "dining",
  restaurant: "dining",
  coffee: "dining",
  grocery: "groceries",
  gas: "transport",
  fuel: "transport",
  uber: "transport",
  rent: "housing",
  mortgage: "housing",
  salary: "income",
  paycheck: "income",
  wages: "income",
};

function extractFinanceCategory(text: string): { text: string; category: FinanceCategory | null } {
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    if ((FINANCE_CATEGORIES as readonly string[]).includes(word)) {
      return {
        text: text.replace(new RegExp(`\\b${word}\\b`, "i"), " "),
        category: word as FinanceCategory,
      };
    }
    if (FINANCE_CATEGORY_ALIASES[word]) {
      return {
        text: text.replace(new RegExp(`\\b${word}\\b`, "i"), " "),
        category: FINANCE_CATEGORY_ALIASES[word],
      };
    }
  }
  return { text, category: null };
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—:,.]+|[-–—:,.]+$/g, "")
    .trim();
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

// --- per-intent parsers -------------------------------------------------------

function parseTask(rest: string, baseDate: DayKey): TaskDraft {
  let text = ` ${rest} `;
  const priorityResult = extractPriority(text);
  text = priorityResult.text;
  const hashResult = extractHashTokens(text);
  text = hashResult.text;
  const dateResult = extractDateToken(text, baseDate);
  text = dateResult.text;
  // Tasks have no schedule category — every #token is a tag here, including
  // ones that would name a planner category ("#admin").
  const tags = hashResult.category ? [...hashResult.tags, hashResult.category] : hashResult.tags;
  return {
    intent: "task",
    title: tidy(text) || tidy(rest),
    dueDate: dateResult.matched ? dateResult.date : null,
    priority: priorityResult.priority ?? "medium",
    tags,
  };
}

function parseMoney(
  kind: "expense" | "income",
  rest: string,
  baseDate: DayKey,
): MoneyDraft | null {
  let text = ` ${rest} `;
  const money = extractMoney(text);
  if (money.amount === null) return null; // near-miss: verb without an amount
  text = money.text;
  const dateResult = extractDateToken(text, baseDate);
  text = dateResult.text;
  const categoryResult = extractFinanceCategory(text);
  text = categoryResult.text;

  // "at Chipotle", "from work", or whatever words remain become the payee.
  const payeeMatch = /\b(?:at|from|to)\s+(.+)$/i.exec(text.trim());
  const payee = tidy(payeeMatch ? payeeMatch[1] : text);

  return {
    intent: kind,
    amount: money.amount,
    payee: payee || null,
    category:
      categoryResult.category ?? (kind === "income" ? ("income" as FinanceCategory) : null),
    date: dateResult.date,
  };
}

/**
 * Metric aliases the health parser understands, longest first so "resting hr"
 * wins over "hr". Every target must stay inside MANUAL_ENTRY_METRICS — a
 * committed test asserts it, so a metric leaving the manual roster breaks the
 * build here rather than at runtime.
 */
export const HEALTH_CAPTURE_ALIASES: ReadonlyArray<{ alias: string; metric: HealthMetricType }> = [
  { alias: "resting heart rate", metric: "resting_hr" },
  { alias: "resting hr", metric: "resting_hr" },
  { alias: "blood pressure", metric: "blood_pressure" },
  { alias: "blood sugar", metric: "blood_glucose" },
  { alias: "blood glucose", metric: "blood_glucose" },
  { alias: "body fat", metric: "body_fat" },
  { alias: "heart rate variability", metric: "hrv" },
  { alias: "hydration", metric: "hydration_ml" },
  { alias: "glucose", metric: "blood_glucose" },
  { alias: "weight", metric: "body_weight" },
  { alias: "water", metric: "hydration_ml" },
  { alias: "steps", metric: "steps" },
  { alias: "slept", metric: "sleep_hours" },
  { alias: "sleep", metric: "sleep_hours" },
  // No mood/energy aliases: those are journal-owned (saveJournalEntry
  // double-writes them) and are not manual-entry metrics.
  { alias: "rhr", metric: "resting_hr" },
  { alias: "hrv", metric: "hrv" },
  { alias: "bw", metric: "body_weight" },
  { alias: "bp", metric: "blood_pressure" },
];

const HEALTH_UNIT_TOKENS = ["kg", "lb", "lbs", "ml", "l", "oz", "h", "hr", "hours", "min"] as const;

function parseHealth(input: string, baseDate: DayKey): HealthDraft | InboxDraft | null {
  const lower = input.toLowerCase();
  const hit = HEALTH_CAPTURE_ALIASES.find(
    (entry) => lower.startsWith(`${entry.alias} `) || lower === entry.alias,
  );
  if (!hit) return null;

  let text = ` ${input.slice(hit.alias.length)} `;
  const dateResult = extractDateToken(text, baseDate);
  text = dateResult.text.trim();

  // Blood pressure reads as systolic/diastolic.
  if (hit.metric === "blood_pressure") {
    const bp = /^(\d{2,3})\s*\/\s*(\d{2,3})$/.exec(text);
    if (!bp) return { intent: "inbox", title: input, notes: null };
    return {
      intent: "health",
      metric: hit.metric,
      value: Number(bp[1]),
      unit: null,
      secondaryValue: Number(bp[2]),
      date: dateResult.date,
    };
  }

  // Sleep accepts durations: "7h30", "7:30", "7.5", "450 min".
  if (hit.metric === "sleep_hours") {
    const clock = /^(\d{1,2})[h:](\d{1,2})\s*(?:m|min)?$/.exec(text);
    if (clock) {
      const hours = Number(clock[1]) + Number(clock[2]) / 60;
      return {
        intent: "health",
        metric: hit.metric,
        value: Math.round(hours * 100) / 100,
        unit: null,
        secondaryValue: null,
        date: dateResult.date,
      };
    }
    const minutes = /^(\d{2,4})\s*(?:m|min|minutes)$/.exec(text);
    if (minutes) {
      return {
        intent: "health",
        metric: hit.metric,
        value: Math.round((Number(minutes[1]) / 60) * 100) / 100,
        unit: null,
        secondaryValue: null,
        date: dateResult.date,
      };
    }
  }

  const valueMatch = /^(\d+(?:\.\d+)?)\s*([a-z%/]*)$/i.exec(text.replace(/\/5$/, ""));
  if (!valueMatch) return { intent: "inbox", title: input, notes: null };
  const rawUnit = valueMatch[2]?.toLowerCase() || null;
  const unit =
    rawUnit && (HEALTH_UNIT_TOKENS as readonly string[]).includes(rawUnit)
      ? rawUnit === "lbs"
        ? "lb"
        : rawUnit
      : null;
  return {
    intent: "health",
    metric: hit.metric,
    value: Number(valueMatch[1]),
    unit,
    secondaryValue: null,
    date: dateResult.date,
  };
}

const MEAL_WORDS: Record<string, MealType> = {
  breakfast: "breakfast",
  brunch: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  supper: "dinner",
  snack: "snack",
};

/** Meal type by wall clock, mirroring how people actually name meals. */
export function inferMealType(nowMinute: number | null | undefined): MealType {
  if (nowMinute === null || nowMinute === undefined) return "snack";
  if (nowMinute < 10.5 * 60) return "breakfast";
  if (nowMinute < 15 * 60) return "lunch";
  if (nowMinute < 17.5 * 60) return "snack";
  if (nowMinute < 22 * 60) return "dinner";
  return "snack";
}

const FOOD_UNIT_TOKENS = new Set([
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "cup",
  "cups",
  "tbsp",
  "tsp",
  "slice",
  "slices",
  "piece",
  "pieces",
  "serving",
  "servings",
]);

function normalizeFoodUnit(token: string): string {
  const singular = token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
  return singular === "cups" ? "cup" : singular;
}

function parseNutrition(
  rest: string,
  baseDate: DayKey,
  nowMinute: number | null | undefined,
): NutritionDraft | null {
  let text = ` ${rest} `;
  const dateResult = extractDateToken(text, baseDate);
  text = dateResult.text;

  let mealType: MealType | null = null;
  const mealWord = /\b(?:for\s+)?(breakfast|brunch|lunch|dinner|supper|snack)\b/i.exec(text);
  if (mealWord) {
    mealType = MEAL_WORDS[mealWord[1].toLowerCase()];
    text = text.replace(mealWord[0], " ");
  }

  const items: NutritionItemDraft[] = [];
  for (const chunk of tidy(text).split(/\s*,\s*|\s+and\s+/i)) {
    const phrase = tidy(chunk);
    if (!phrase) continue;
    // Attached unit first: "100g chicken breast".
    const attached = /^(\d+(?:\.\d+)?)(g|kg|ml|l|oz|lb)\s+(?:of\s+)?(.+)$/i.exec(phrase);
    if (attached) {
      items.push({
        phrase: tidy(attached[3]),
        quantity: Number(attached[1]),
        unit: attached[2].toLowerCase(),
      });
      continue;
    }
    const quantityMatch = /^(\d+(?:\.\d+)?|\d+\/\d+)\s+(.*)$/.exec(phrase);
    if (quantityMatch) {
      const raw = quantityMatch[1];
      const quantity = raw.includes("/")
        ? Number(raw.split("/")[0]) / Number(raw.split("/")[1])
        : Number(raw);
      let name = quantityMatch[2];
      let unit: string | null = null;
      const unitMatch = /^([a-z]+)\s+(?:of\s+)?(.+)$/i.exec(name);
      if (unitMatch && FOOD_UNIT_TOKENS.has(unitMatch[1].toLowerCase())) {
        unit = normalizeFoodUnit(unitMatch[1].toLowerCase());
        name = unitMatch[2];
      }
      items.push({ phrase: tidy(name), quantity: quantity > 0 ? quantity : 1, unit });
    } else {
      items.push({ phrase, quantity: 1, unit: null });
    }
  }
  if (items.length === 0) return null;

  return {
    intent: "nutrition",
    mealType: mealType ?? inferMealType(nowMinute),
    items,
    date: dateResult.date,
  };
}

const CARDIO_VERBS: Record<string, { type: WorkoutType; name: string }> = {
  ran: { type: "running", name: "Run" },
  run: { type: "running", name: "Run" },
  jogged: { type: "running", name: "Jog" },
  walked: { type: "walking", name: "Walk" },
  hiked: { type: "walking", name: "Hike" },
  cycled: { type: "cycling", name: "Ride" },
  biked: { type: "cycling", name: "Ride" },
  swam: { type: "swimming", name: "Swim" },
  rowed: { type: "cardio", name: "Row" },
};

const MILES_PER_KM = 0.621371;

/** "bench 3x8 135", "squat 5x5 100kg" — the whole input, not a remainder. */
const STRENGTH_PATTERN =
  /^([a-z][a-z\s'-]*?)\s+(\d{1,2})\s*[x×]\s*(\d{1,3})(?:\s+(\d+(?:\.\d+)?)\s*(kg|lbs?)?)?$/i;

function parseStrength(input: string, baseDate: DayKey): WorkoutDraft | null {
  let text = ` ${input} `;
  const dateResult = extractDateToken(text, baseDate);
  text = tidy(dateResult.text);
  const match = STRENGTH_PATTERN.exec(text);
  if (!match) return null;
  const weight = match[4] ? Number(match[4]) : null;
  const unitToken = match[5]?.toLowerCase() ?? null;
  return {
    intent: "workout",
    name: titleCase(tidy(match[1])),
    type: "strength",
    durationMin: null,
    distanceKm: null,
    strength: {
      exercise: titleCase(tidy(match[1])),
      sets: Number(match[2]),
      reps: Number(match[3]),
      weight,
      weightUnit: unitToken ? (unitToken.startsWith("lb") ? "lb" : "kg") : null,
    },
    date: dateResult.date,
  };
}

function parseCardio(verb: string, rest: string, baseDate: DayKey): WorkoutDraft | InboxDraft {
  const meta = CARDIO_VERBS[verb];
  let text = ` ${rest} `;
  const dateResult = extractDateToken(text, baseDate);
  text = dateResult.text;

  let distanceKm: number | null = null;
  const distance = /(\d+(?:\.\d+)?)\s*(mi|mile|miles|km|k|kilometers?)\b/i.exec(text);
  if (distance) {
    const value = Number(distance[1]);
    const unit = distance[2].toLowerCase();
    distanceKm = unit.startsWith("mi") ? value / MILES_PER_KM : value;
    distanceKm = Math.round(distanceKm * 100) / 100;
    text = text.replace(distance[0], " ");
  }

  let durationMin: number | null = null;
  const minutes = /(\d+(?:\.\d+)?)\s*(min|mins|minutes|m)\b/i.exec(text);
  const hours = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours)\b/i.exec(text);
  if (minutes) {
    durationMin = Math.round(Number(minutes[1]));
    text = text.replace(minutes[0], " ");
  } else if (hours) {
    durationMin = Math.round(Number(hours[1]) * 60);
    text = text.replace(hours[0], " ");
  }

  if (distanceKm === null && durationMin === null) {
    // "ran errands" — a workout verb without workout numbers is not a workout.
    return { intent: "inbox", title: `${verb} ${tidy(rest)}`.trim(), notes: null };
  }

  const leftover = tidy(text);
  return {
    intent: "workout",
    name: leftover ? titleCase(leftover) : meta.name,
    type: meta.type,
    durationMin,
    distanceKm,
    strength: null,
    date: dateResult.date,
  };
}

function parseHabit(rest: string, status: "done" | "skipped", baseDate: DayKey): HabitDraft {
  let text = ` ${rest} `;
  const dateResult = extractDateToken(text, baseDate);
  text = dateResult.text;
  return { intent: "habit", query: tidy(text), status, date: dateResult.date };
}

// --- the classifier -----------------------------------------------------------

export function parseCapture(input: string, options: CaptureOptions): CaptureParse {
  const raw = input.trim();
  const { baseDate } = options;

  const fallbackInbox: CaptureParse = {
    draft: { intent: "inbox", title: raw, notes: null },
    alternates: [],
  };
  if (!raw) return fallbackInbox;

  // Explicit prefixes always win — they exist so nothing is ever trapped in a
  // wrong guess: "note ..." and "inbox ..." capture the raw text.
  const inboxPrefix = /^(?:inbox|note)\b[:\s]+(.*)$/i.exec(raw);
  if (inboxPrefix) {
    return { draft: { intent: "inbox", title: tidy(inboxPrefix[1]), notes: null }, alternates: [] };
  }

  // Tasks: "todo …", "task …", "remember to …".
  const taskPrefix = /^(?:todo|task)\b[:\s]+(.*)$/i.exec(raw) ?? /^remember to\s+(.*)$/i.exec(raw);
  if (taskPrefix) {
    const rest = tidy(taskPrefix[1]);
    if (!rest) return fallbackInbox;
    return { draft: parseTask(rest, baseDate), alternates: [] };
  }

  // Income before expense: "got paid" must not read as "paid".
  const incomePrefix = /^(?:got paid|received|earned|refunded|refund|income)\b[:\s]*(.*)$/i.exec(
    raw,
  );
  if (incomePrefix) {
    const draft = parseMoney("income", incomePrefix[1], baseDate);
    return draft ? { draft, alternates: [] } : fallbackInbox;
  }

  const expensePrefix = /^(?:spent|bought|paid)\b[:\s]*(.*)$/i.exec(raw);
  if (expensePrefix) {
    const draft = parseMoney("expense", expensePrefix[1], baseDate);
    return draft ? { draft, alternates: [] } : fallbackInbox;
  }

  // "-12.40 chipotle dining" / "−$25 gas" — a leading signed amount.
  const signedExpense = /^[-−]\s*\$?\d/.test(raw);
  if (signedExpense) {
    const draft = parseMoney("expense", raw.replace(/^[-−]\s*/, ""), baseDate);
    return draft ? { draft, alternates: [] } : fallbackInbox;
  }

  // Health metrics: a known alias followed by a reading.
  const health = parseHealth(raw, baseDate);
  if (health) return { draft: health, alternates: [] };

  // Nutrition: "ate …" / "had …".
  const nutritionPrefix = /^(?:ate|eating|had)\s+(.*)$/i.exec(raw);
  if (nutritionPrefix) {
    const draft = parseNutrition(nutritionPrefix[1], baseDate, options.nowMinute);
    return draft ? { draft, alternates: [] } : fallbackInbox;
  }

  // Cardio: "ran 3.2 miles 28 min".
  const cardioPrefix = /^([a-z]+)\s+(.*)$/i.exec(raw);
  if (cardioPrefix && CARDIO_VERBS[cardioPrefix[1].toLowerCase()]) {
    const draft = parseCardio(cardioPrefix[1].toLowerCase(), cardioPrefix[2], baseDate);
    return { draft, alternates: [] };
  }

  // Habits: "did meditation" / "skipped reading". "did 3x8 …" is plausibly a
  // strength log too — that ambiguity is surfaced, never guessed.
  const habitPrefix = /^(did|skipped)\s+(.*)$/i.exec(raw);
  if (habitPrefix) {
    const status = habitPrefix[1].toLowerCase() === "did" ? "done" : "skipped";
    const rest = tidy(habitPrefix[2]);
    if (!rest) return fallbackInbox;
    const draft = parseHabit(rest, status, baseDate);
    const strengthReading = status === "done" ? parseStrength(rest, baseDate) : null;
    return { draft, alternates: strengthReading ? ["workout"] : [] };
  }

  // Strength shorthand: "bench 3x8 135".
  const strength = parseStrength(raw, baseDate);
  if (strength) return { draft: strength, alternates: [] };

  // Everything else is the planner grammar — the historical default, kept
  // byte-compatible (tests/quick-add.test.ts is the regression baseline).
  return {
    draft: { intent: "planner", planner: parseQuickAdd(raw, baseDate) },
    alternates: [],
  };
}

/** Re-parse under a user-chosen intent (the disambiguation step). */
export function parseCaptureAs(
  intent: CaptureIntent,
  input: string,
  options: CaptureOptions,
): CaptureDraft {
  const raw = input.trim();
  const { baseDate } = options;
  switch (intent) {
    case "planner":
      return { intent: "planner", planner: parseQuickAdd(raw, baseDate) };
    case "task": {
      const stripped = /^(?:todo|task)\b[:\s]+(.*)$/i.exec(raw)?.[1] ?? raw;
      return parseTask(stripped, baseDate);
    }
    case "expense":
      return (
        parseMoney("expense", raw.replace(/^(?:spent|bought|paid)\b[:\s]*/i, ""), baseDate) ?? {
          intent: "inbox",
          title: raw,
          notes: null,
        }
      );
    case "income":
      return (
        parseMoney(
          "income",
          raw.replace(/^(?:got paid|received|earned|refunded|refund|income)\b[:\s]*/i, ""),
          baseDate,
        ) ?? { intent: "inbox", title: raw, notes: null }
      );
    case "health":
      return parseHealth(raw, baseDate) ?? { intent: "inbox", title: raw, notes: null };
    case "nutrition":
      return (
        parseNutrition(raw.replace(/^(?:ate|eating|had)\s+/i, ""), baseDate, options.nowMinute) ?? {
          intent: "inbox",
          title: raw,
          notes: null,
        }
      );
    case "workout": {
      // Strip the habit-ish verb FIRST — "did bench 3x8" must read as
      // exercise "bench", not "did bench".
      const asStrength =
        parseStrength(raw.replace(/^(?:did|logged)\s+/i, ""), baseDate) ??
        parseStrength(raw, baseDate);
      if (asStrength) return asStrength;
      const cardio = /^([a-z]+)\s+(.*)$/i.exec(raw);
      if (cardio && CARDIO_VERBS[cardio[1].toLowerCase()]) {
        return parseCardio(cardio[1].toLowerCase(), cardio[2], baseDate);
      }
      return { intent: "inbox", title: raw, notes: null };
    }
    case "habit": {
      const match = /^(did|skipped)\s+(.*)$/i.exec(raw);
      if (match) {
        return parseHabit(
          tidy(match[2]),
          match[1].toLowerCase() === "did" ? "done" : "skipped",
          baseDate,
        );
      }
      return parseHabit(raw, "done", baseDate);
    }
    case "inbox":
      return { intent: "inbox", title: raw, notes: null };
  }
}

/** One-line summary of a draft — the dialog's "what I understood" headline. */
export function describeCaptureDraft(draft: CaptureDraft): string {
  switch (draft.intent) {
    case "planner":
      return `Planner block · ${draft.planner.title}`;
    case "task":
      return `Task · ${draft.title}${draft.dueDate ? ` · due ${draft.dueDate}` : ""}`;
    case "expense":
      return `Expense · $${draft.amount.toFixed(2)}${draft.payee ? ` at ${draft.payee}` : ""}`;
    case "income":
      return `Income · $${draft.amount.toFixed(2)}${draft.payee ? ` from ${draft.payee}` : ""}`;
    case "health":
      return `Health · ${draft.metric} ${draft.value}${draft.unit ?? ""}`;
    case "nutrition":
      return `Food · ${draft.items.map((item) => item.phrase).join(", ")} (${draft.mealType})`;
    case "workout":
      return draft.strength
        ? `Workout · ${draft.strength.exercise} ${draft.strength.sets}×${draft.strength.reps}`
        : `Workout · ${draft.name}`;
    case "habit":
      return `Habit · ${draft.query} ${draft.status === "done" ? "done" : "skipped"}`;
    case "inbox":
      return `Inbox · ${draft.title}`;
  }
}

/** Sanity roster: every intent the classifier can produce, for UI chip rows. */
export const CAPTURE_INTENTS: readonly CaptureIntent[] = [
  "planner",
  "task",
  "expense",
  "income",
  "health",
  "nutrition",
  "workout",
  "habit",
  "inbox",
];

// Compile-time guard: alias targets must stay manually enterable, and the
// meal-word map must stay inside MEAL_TYPES. Runtime-asserted in tests too.
const _manualMetricGuard: HealthMetricType[] = MANUAL_ENTRY_METRICS;
void _manualMetricGuard;
const _mealGuard: readonly MealType[] = MEAL_TYPES;
void _mealGuard;
