import { daysBetween, relativeDayLabel, type DayKey } from "@/lib/date";
import {
  ACCOUNT_TYPE_META,
  BILL_KINDS,
  FINANCE_CATEGORY_META,
  HEALTH_RECORD_KIND_META,
  MEAL_TYPE_META,
  type AccountType,
  type FinanceCategory,
  type HealthRecordKind,
  type MealType,
} from "@/lib/enums";
import { describeExpiryDistance, documentKindLabel } from "@/lib/logic/documents";
import { formatCents } from "@/lib/logic/money";
import { describeDueDistance } from "@/lib/logic/due";

/**
 * Global-search hit building — pure. The server fetches matching rows; this
 * module turns them into render-ready hits with the destination each entity
 * actually lives at, labelled relative to the *user's* today (passed in — the
 * host clock is never consulted).
 */

export const SEARCH_GROUPS = [
  "Planner",
  "Tasks",
  "Projects",
  "Tags",
  "Inbox",
  "Reminders",
  "Documents",
  "Routines",
  "Habits",
  "Goals",
  "Bills",
  "Accounts",
  "Transactions",
  "Budgets",
  "Savings goals",
  "Workouts",
  "Health",
  "Health records",
  "Templates",
  "Meals",
  "Foods",
  "Meal templates",
  "Journal",
] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export interface SearchHit {
  id: string;
  group: SearchGroup;
  title: string;
  subtitle: string;
  href: string;
}

export interface SearchRows {
  items: Array<{ id: string; title: string; date: DayKey; category: string }>;
  workouts: Array<{ id: string; name: string; date: DayKey; durationMin: number }>;
  /**
   * Logged meals, matched on their free text (label/notes) — never on `type`:
   * "lunch" is a fixed vocabulary word that would return every lunch ever
   * logged, capped at the per-module bound, which helps nobody.
   */
  meals: Array<{ id: string; date: DayKey; type: string; label: string | null }>;
  /**
   * `day` is the reminder's next fire date resolved in the USER's timezone by
   * the server — the pure layer never does timezone math on an instant.
   * `blockDate` is set when the reminder was born from a (live) planner
   * block: the hit then deep-links that day's planner.
   */
  reminders: Array<{
    id: string;
    title: string;
    repeat: string;
    enabled: boolean;
    day: DayKey | null;
    blockDate: DayKey | null;
  }>;
  foods: Array<{ id: string; name: string; brand: string | null; category: string; calories: number }>;
  habits: Array<{ id: string; name: string; category: string; archived: boolean }>;
  goals: Array<{ id: string; label: string; domain: string; unit: string; target: number }>;
  journal: Array<{ id: string; title: string | null; content: string; date: DayKey }>;
  routines: Array<{ id: string; name: string; category: string }>;
  workoutTemplates: Array<{ id: string; name: string; type: string }>;
  mealTemplates: Array<{ id: string; name: string; mealType: string }>;
  tasks: Array<{ id: string; title: string; status: string; dueDate: DayKey | null }>;
  projects: Array<{ id: string; name: string; status: string }>;
  tags: Array<{ id: string; name: string; taskCount: number; plannerCount: number }>;
  inboxItems: Array<{ id: string; title: string; status: string }>;
  documents: Array<{
    id: string;
    name: string;
    kind: string;
    issuer: string | null;
    expiryDate: DayKey;
  }>;
  accounts: Array<{ id: string; name: string; type: string; archived: boolean; currency: string }>;
  transactions: Array<{
    id: string;
    payee: string | null;
    category: string;
    date: DayKey;
    amount: number;
    currency: string;
  }>;
  /**
   * One entry per health metric the account actually has readings for and
   * whose name matches — not one per reading. A decade of steps is one hit
   * that takes you to the chart, which is what someone typing "steps" wants;
   * ten thousand identical rows is not.
   */
  healthMetrics: Array<{
    type: string;
    label: string;
    unit: string;
    group: string;
    count: number;
    latestDate: DayKey | null;
    latestValue: number | null;
  }>;
  healthRecords: Array<{
    id: string;
    kind: string;
    title: string;
    subtitle: string | null;
    date: DayKey;
  }>;
  bills: Array<{ id: string; name: string; kind: string; amount: number; nextDueDate: DayKey }>;
  budgets: Array<{ id: string; category: string; amount: number; period: string }>;
  savingsGoals: Array<{ id: string; name: string; targetAmount: number; currentAmount: number }>;
}

export function emptySearchRows(): SearchRows {
  return {
    items: [],
    workouts: [],
    meals: [],
    reminders: [],
    foods: [],
    habits: [],
    goals: [],
    journal: [],
    routines: [],
    workoutTemplates: [],
    mealTemplates: [],
    tasks: [],
    projects: [],
    tags: [],
    inboxItems: [],
    documents: [],
    healthMetrics: [],
    healthRecords: [],
    accounts: [],
    transactions: [],
    bills: [],
    budgets: [],
    savingsGoals: [],
  };
}

/**
 * How strongly a hit's title matches the typed term. Levels, not a continuum:
 * whole-title match beats prefix beats word-start beats mid-word; a hit whose
 * title does not contain the term at all (it matched on a secondary field —
 * notes, payee, issuer…) scores zero and relies on recency alone.
 */
function exactness(title: string, term: string): number {
  const haystack = title.trim().toLowerCase();
  const needle = term.trim().toLowerCase();
  if (!needle) return 0;
  if (haystack === needle) return 3;
  if (haystack.startsWith(needle)) return 2;
  const index = haystack.indexOf(needle);
  if (index === -1) return 0;
  const boundary = !/[a-z0-9]/.test(haystack[index - 1] ?? "");
  return boundary ? 1 : 0.5;
}

/**
 * Recency weight in (0, 1]: 1 for the reference day itself, halving every
 * week of distance (past or future — "next week's bill" is as current as
 * "last week's transaction"). Hits with no natural date score 0 and keep
 * their fetch order.
 */
function recency(day: DayKey | null, referenceDay: DayKey): number {
  if (!day) return 0;
  return 1 / (1 + Math.abs(daysBetween(day, referenceDay)) / 7);
}

/**
 * Flatten matching rows into grouped, render-ready hits.
 *
 * Ranking: hits stay grouped by source module (the palette renders one section
 * per group). Groups order by their best *title* match for the typed term —
 * an exact title hit floats its whole group — falling back to SEARCH_GROUPS
 * declaration order (the things you act on daily first). Within a group, hits
 * order by match strength then recency, so "chipotle" puts today's Chipotle
 * transaction above one from March. Bounding happens at fetch time: the server
 * caps every module's rows, so one noisy model cannot crowd out the rest.
 */
export function buildSearchHits(rows: SearchRows, referenceDay: DayKey, term = ""): SearchHit[] {
  const entries: Array<{ hit: SearchHit; day: DayKey | null; index: number }> = [];
  const hits = {
    push(hit: SearchHit, day: DayKey | null = null) {
      entries.push({ hit, day, index: entries.length });
    },
  };

  for (const item of rows.items) {
    hits.push(
      {
        id: `item-${item.id}`,
        group: "Planner",
        title: item.title,
        subtitle: `${relativeDayLabel(item.date, referenceDay)} · ${item.category}`,
        href: `/planner?date=${item.date}`,
      },
      item.date,
    );
  }

  for (const task of rows.tasks) {
    hits.push(
      {
        id: `task-${task.id}`,
        group: "Tasks",
        title: task.title,
        subtitle:
          task.status !== "open"
            ? task.status === "done"
              ? "Done"
              : "Dropped"
            : task.dueDate
              ? describeDueDistance(task.dueDate, referenceDay)
              : "Open",
        href: "/tasks",
      },
      task.dueDate,
    );
  }

  for (const project of rows.projects) {
    hits.push({
      id: `project-${project.id}`,
      group: "Projects",
      title: project.name,
      subtitle: project.status === "active" ? "Project" : `Project · ${project.status}`,
      href: "/tasks",
    });
  }

  // A tag hit is a filter, not a record: following it opens the task list
  // already narrowed to that tag.
  for (const tag of rows.tags) {
    const parts: string[] = [];
    if (tag.taskCount > 0) parts.push(`${tag.taskCount} task${tag.taskCount === 1 ? "" : "s"}`);
    if (tag.plannerCount > 0) {
      parts.push(`${tag.plannerCount} planner item${tag.plannerCount === 1 ? "" : "s"}`);
    }
    hits.push({
      id: `tag-${tag.id}`,
      group: "Tags",
      title: `#${tag.name}`,
      subtitle: parts.length > 0 ? parts.join(" · ") : "Tag · not used yet",
      href: `/tasks?tag=${encodeURIComponent(tag.name)}`,
    });
  }

  for (const item of rows.inboxItems) {
    hits.push({
      id: `inbox-${item.id}`,
      group: "Inbox",
      title: item.title,
      subtitle: item.status === "open" ? "In your inbox" : `Inbox · ${item.status}`,
      href: "/inbox",
    });
  }

  for (const reminder of rows.reminders) {
    const repeatLabel = REMINDER_REPEAT_LABELS[reminder.repeat] ?? "Reminder";
    const when = reminder.day ? ` · ${relativeDayLabel(reminder.day, referenceDay)}` : "";
    hits.push(
      {
        id: `reminder-${reminder.id}`,
        group: "Reminders",
        title: reminder.title,
        subtitle: `${repeatLabel}${when}${reminder.enabled ? "" : " · off"}`,
        href: reminder.blockDate
          ? `/planner?date=${reminder.blockDate}`
          : "/settings#reminders",
      },
      reminder.day,
    );
  }

  for (const document of rows.documents) {
    const kindLabel = documentKindLabel(document.kind);
    hits.push(
      {
        id: `doc-${document.id}`,
        group: "Documents",
        title: document.name,
        subtitle: `${document.issuer ? `${document.issuer} · ` : ""}${kindLabel} · ${describeExpiryDistance(document.expiryDate, referenceDay)}`,
        href: "/inbox",
      },
      document.expiryDate,
    );
  }

  for (const routine of rows.routines) {
    hits.push({
      id: `routine-${routine.id}`,
      group: "Routines",
      title: routine.name,
      subtitle: `Routine · apply it from the planner`,
      href: "/planner",
    });
  }

  for (const habit of rows.habits) {
    hits.push({
      id: `habit-${habit.id}`,
      group: "Habits",
      title: habit.name,
      subtitle: habit.archived ? `${habit.category} · archived` : habit.category,
      href: "/habits",
    });
  }

  for (const goal of rows.goals) {
    hits.push({
      id: `goal-${goal.id}`,
      group: "Goals",
      title: goal.label,
      subtitle: `${goal.domain} · target ${formatTarget(goal.target)}${goal.unit ? ` ${goal.unit}` : ""}`,
      href: "/settings",
    });
  }

  for (const bill of rows.bills) {
    const kindLabel = bill.kind === BILL_KINDS[1] ? "Subscription" : "Bill";
    hits.push(
      {
        id: `bill-${bill.id}`,
        group: "Bills",
        title: bill.name,
        subtitle: `${kindLabel} · ${formatCents(bill.amount)} · ${describeDueDistance(bill.nextDueDate, referenceDay)}`,
        href: "/finance",
      },
      bill.nextDueDate,
    );
  }

  for (const account of rows.accounts) {
    const typeLabel = ACCOUNT_TYPE_META[account.type as AccountType]?.label ?? account.type;
    hits.push({
      id: `acct-${account.id}`,
      group: "Accounts",
      title: account.name,
      subtitle: account.archived ? `${typeLabel} · archived` : typeLabel,
      href: "/finance",
    });
  }

  for (const transaction of rows.transactions) {
    const categoryLabel =
      FINANCE_CATEGORY_META[transaction.category as FinanceCategory]?.label ?? transaction.category;
    hits.push(
      {
        id: `txn-${transaction.id}`,
        group: "Transactions",
        title: transaction.payee || categoryLabel,
        subtitle: `${relativeDayLabel(transaction.date, referenceDay)} · ${formatCents(transaction.amount, transaction.currency)}`,
        href: "/finance",
      },
      transaction.date,
    );
  }

  for (const budget of rows.budgets) {
    const label =
      FINANCE_CATEGORY_META[budget.category as FinanceCategory]?.label ?? budget.category;
    hits.push({
      id: `budget-${budget.id}`,
      group: "Budgets",
      title: `${label} budget`,
      subtitle: `${formatCents(budget.amount)} ${budget.period === "weekly" ? "weekly" : "monthly"}`,
      href: "/finance",
    });
  }

  for (const goal of rows.savingsGoals) {
    hits.push({
      id: `sg-${goal.id}`,
      group: "Savings goals",
      title: goal.name,
      subtitle: `${formatCents(goal.currentAmount)} of ${formatCents(goal.targetAmount)} saved`,
      href: "/finance",
    });
  }

  for (const workout of rows.workouts) {
    hits.push(
      {
        id: `workout-${workout.id}`,
        group: "Workouts",
        title: workout.name,
        subtitle: `${relativeDayLabel(workout.date, referenceDay)} · ${workout.durationMin} min`,
        href: `/workouts?date=${workout.date}`,
      },
      workout.date,
    );
  }

  for (const metric of rows.healthMetrics) {
    const latest =
      metric.latestValue !== null && metric.latestDate !== null
        ? `${formatTarget(metric.latestValue)}${metric.unit ? ` ${metric.unit}` : ""} on ${relativeDayLabel(metric.latestDate, referenceDay)}`
        : "no readings yet";
    hits.push(
      {
        id: `health-${metric.type}`,
        group: "Health",
        title: metric.label,
        subtitle: `${metric.count} reading${metric.count === 1 ? "" : "s"} · ${latest}`,
        href: `/health/${metric.group}`,
      },
      metric.latestDate,
    );
  }

  for (const record of rows.healthRecords) {
    hits.push(
      {
        id: `hrec-${record.id}`,
        group: "Health records",
        title: record.title,
        subtitle: `${HEALTH_RECORD_KIND_META[record.kind as HealthRecordKind]?.label ?? record.kind} · ${relativeDayLabel(record.date, referenceDay)}${record.subtitle ? ` · ${record.subtitle}` : ""}`,
        href: "/health/vitals",
      },
      record.date,
    );
  }

  for (const template of rows.workoutTemplates) {
    hits.push({
      id: `wt-${template.id}`,
      group: "Templates",
      title: template.name,
      subtitle: `Workout template · ${template.type}`,
      href: "/workouts",
    });
  }

  for (const meal of rows.meals) {
    const typeLabel = MEAL_TYPE_META[meal.type as MealType]?.label ?? meal.type;
    hits.push(
      {
        id: `meal-${meal.id}`,
        group: "Meals",
        title: meal.label?.trim() || typeLabel,
        subtitle: `${relativeDayLabel(meal.date, referenceDay)} · ${meal.label?.trim() ? typeLabel : "Meal"}`,
        href: `/nutrition?date=${meal.date}`,
      },
      meal.date,
    );
  }

  for (const food of rows.foods) {
    hits.push({
      id: `food-${food.id}`,
      group: "Foods",
      title: food.name,
      subtitle: `${Math.round(food.calories)} kcal · ${food.brand ?? food.category}`,
      href: "/nutrition",
    });
  }

  for (const template of rows.mealTemplates) {
    hits.push({
      id: `mt-${template.id}`,
      group: "Meal templates",
      title: template.name,
      subtitle: `Meal template · ${template.mealType}`,
      href: "/nutrition",
    });
  }

  for (const entry of rows.journal) {
    hits.push(
      {
        id: `journal-${entry.id}`,
        group: "Journal",
        title: entry.title || entry.content.slice(0, 60),
        subtitle: relativeDayLabel(entry.date, referenceDay),
        href: `/today?date=${entry.date}`,
      },
      entry.date,
    );
  }

  // Rank. Exactness dominates recency within a group (a full level apart is
  // always decisive); a group floats only on title-match strength, never on
  // recency alone, so declaration order stays meaningful when nothing stands
  // out. Sorts are stable, so fetch order breaks every remaining tie.
  const declared = new Map(SEARCH_GROUPS.map((group, index) => [group, index]));
  const scored = entries.map((entry) => ({
    ...entry,
    score: exactness(entry.hit.title, term) * 2 + recency(entry.day, referenceDay),
    exact: exactness(entry.hit.title, term),
  }));
  const groupRank = new Map<SearchGroup, number>();
  for (const entry of scored) {
    const current = groupRank.get(entry.hit.group) ?? 0;
    if (entry.exact > current) groupRank.set(entry.hit.group, entry.exact);
  }
  scored.sort((a, b) => {
    if (a.hit.group !== b.hit.group) {
      const rankDelta =
        (groupRank.get(b.hit.group) ?? 0) - (groupRank.get(a.hit.group) ?? 0);
      if (rankDelta !== 0) return rankDelta;
      return (declared.get(a.hit.group) ?? 99) - (declared.get(b.hit.group) ?? 99);
    }
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });
  return scored.map((entry) => entry.hit);
}

/** Human labels for Reminder.repeat — the fixed vocabulary from validation. */
const REMINDER_REPEAT_LABELS: Record<string, string> = {
  none: "Reminder",
  daily: "Daily reminder",
  weekdays: "Weekday reminder",
  weekly: "Weekly reminder",
};

function formatTarget(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}
