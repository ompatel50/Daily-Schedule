import { relativeDayLabel, type DayKey } from "@/lib/date";
import {
  ACCOUNT_TYPE_META,
  BILL_KINDS,
  FINANCE_CATEGORY_META,
  type AccountType,
  type FinanceCategory,
} from "@/lib/enums";
import { describeExpiryDistance, documentKindLabel } from "@/lib/logic/documents";
import { formatMoney } from "@/lib/logic/finance";
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
  "Templates",
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
  bills: Array<{ id: string; name: string; kind: string; amount: number; nextDueDate: DayKey }>;
  budgets: Array<{ id: string; category: string; amount: number; period: string }>;
  savingsGoals: Array<{ id: string; name: string; targetAmount: number; currentAmount: number }>;
}

export function emptySearchRows(): SearchRows {
  return {
    items: [],
    workouts: [],
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
    accounts: [],
    transactions: [],
    bills: [],
    budgets: [],
    savingsGoals: [],
  };
}

/**
 * Flatten matching rows into grouped, render-ready hits. Group order is the
 * declaration order of SEARCH_GROUPS: the things you act on daily first.
 */
export function buildSearchHits(rows: SearchRows, referenceDay: DayKey): SearchHit[] {
  const hits: SearchHit[] = [];

  for (const item of rows.items) {
    hits.push({
      id: `item-${item.id}`,
      group: "Planner",
      title: item.title,
      subtitle: `${relativeDayLabel(item.date, referenceDay)} · ${item.category}`,
      href: `/planner?date=${item.date}`,
    });
  }

  for (const task of rows.tasks) {
    hits.push({
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
    });
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

  for (const document of rows.documents) {
    const kindLabel = documentKindLabel(document.kind);
    hits.push({
      id: `doc-${document.id}`,
      group: "Documents",
      title: document.name,
      subtitle: `${document.issuer ? `${document.issuer} · ` : ""}${kindLabel} · ${describeExpiryDistance(document.expiryDate, referenceDay)}`,
      href: "/inbox",
    });
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
    hits.push({
      id: `bill-${bill.id}`,
      group: "Bills",
      title: bill.name,
      subtitle: `${kindLabel} · ${formatMoney(bill.amount)} · ${describeDueDistance(bill.nextDueDate, referenceDay)}`,
      href: "/finance",
    });
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
    hits.push({
      id: `txn-${transaction.id}`,
      group: "Transactions",
      title: transaction.payee || categoryLabel,
      subtitle: `${relativeDayLabel(transaction.date, referenceDay)} · ${formatMoney(transaction.amount, transaction.currency)}`,
      href: "/finance",
    });
  }

  for (const budget of rows.budgets) {
    const label =
      FINANCE_CATEGORY_META[budget.category as FinanceCategory]?.label ?? budget.category;
    hits.push({
      id: `budget-${budget.id}`,
      group: "Budgets",
      title: `${label} budget`,
      subtitle: `${formatMoney(budget.amount)} ${budget.period === "weekly" ? "weekly" : "monthly"}`,
      href: "/finance",
    });
  }

  for (const goal of rows.savingsGoals) {
    hits.push({
      id: `sg-${goal.id}`,
      group: "Savings goals",
      title: goal.name,
      subtitle: `${formatMoney(goal.currentAmount)} of ${formatMoney(goal.targetAmount)} saved`,
      href: "/finance",
    });
  }

  for (const workout of rows.workouts) {
    hits.push({
      id: `workout-${workout.id}`,
      group: "Workouts",
      title: workout.name,
      subtitle: `${relativeDayLabel(workout.date, referenceDay)} · ${workout.durationMin} min`,
      href: `/workouts?date=${workout.date}`,
    });
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
    hits.push({
      id: `journal-${entry.id}`,
      group: "Journal",
      title: entry.title || entry.content.slice(0, 60),
      subtitle: relativeDayLabel(entry.date, referenceDay),
      href: `/today?date=${entry.date}`,
    });
  }

  const order = new Map(SEARCH_GROUPS.map((group, index) => [group, index]));
  return hits.sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99));
}

function formatTarget(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}
