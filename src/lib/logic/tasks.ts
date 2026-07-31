import type { DayKey } from "@/lib/date";
import { PRIORITY_META, REPEAT_UNIT_META, type Priority, type RepeatUnit } from "@/lib/enums";
import { dueBucketOf, nextOccurrenceAfter, type Cadence } from "@/lib/logic/due";

/**
 * Task views and recurrence — pure. The server fetches rows; the bucketing,
 * ordering and repeat arithmetic that the tasks page, the dashboard and the
 * tests share live here.
 */

export interface TaskLike {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: DayKey | null;
  parentId: string | null;
  projectId: string | null;
  repeat: string;
  repeatEvery: number;
  repeatAnchor: DayKey | null;
  sortOrder: number;
}

export function taskIsOpen(task: Pick<TaskLike, "status">): boolean {
  return task.status === "open";
}

/**
 * The one ordering for "what should I look at first": priority, then the
 * nearer due date (undated last), then the user's manual order.
 */
export function compareTasks(a: TaskLike, b: TaskLike): number {
  const rank =
    (PRIORITY_META[b.priority as Priority]?.rank ?? 1) -
    (PRIORITY_META[a.priority as Priority]?.rank ?? 1);
  if (rank !== 0) return rank;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }
  return a.sortOrder - b.sortOrder || a.title.localeCompare(b.title);
}

export interface TaskBuckets<T extends TaskLike = TaskLike> {
  overdue: T[];
  today: T[];
  /** Due within the next week. */
  upcoming: T[];
  /** Due beyond the upcoming window. */
  later: T[];
  /** No due date at all. */
  someday: T[];
}

/**
 * The Today / Upcoming / Overdue view. Only OPEN, TOP-LEVEL tasks are
 * bucketed — subtasks render under their parent, wherever the parent lands.
 * Every bucket is sorted by `compareTasks`.
 */
export function bucketTasks<T extends TaskLike>(tasks: T[], today: DayKey): TaskBuckets<T> {
  const buckets: TaskBuckets<T> = { overdue: [], today: [], upcoming: [], later: [], someday: [] };
  for (const task of tasks) {
    if (!taskIsOpen(task) || task.parentId !== null) continue;
    if (task.dueDate === null) {
      buckets.someday.push(task);
      continue;
    }
    const bucket = dueBucketOf(task.dueDate, today);
    if (bucket === "overdue") buckets.overdue.push(task);
    else if (bucket === "today") buckets.today.push(task);
    else if (bucket === "soon") buckets.upcoming.push(task);
    else buckets.later.push(task);
  }
  for (const list of Object.values(buckets)) list.sort(compareTasks);
  return buckets;
}

/** Open top-level tasks due today or overdue — the dashboard's "act now" list. */
export function tasksDueNow<T extends TaskLike>(tasks: T[], today: DayKey): T[] {
  const buckets = bucketTasks(tasks, today);
  return [...buckets.overdue, ...buckets.today];
}

// --- repeats -----------------------------------------------------------------

export function repeatCadence(repeat: string, every: number): Cadence | null {
  switch (repeat as RepeatUnit) {
    case "daily":
      return { unit: "daily", every };
    case "weekly":
      return { unit: "weekly", every };
    case "monthly":
      return { unit: "monthly", every };
    case "yearly":
      return { unit: "yearly", every };
    default:
      return null;
  }
}

/**
 * Where a repeating task's due date moves when it is completed, or null when
 * completing should simply close it (no repeat, or no due date to advance).
 *
 * Occurrences are generated from the anchor (the due date the repeat was
 * configured against), so "monthly on the 31st" clamps in short months without
 * drifting. The advance lands strictly after BOTH the current due date and
 * today: completing a long-overdue weekly task yields one next occurrence in
 * the future, not a march through every missed week.
 */
export function nextDueAfterCompletion(
  task: Pick<TaskLike, "dueDate" | "repeat" | "repeatEvery" | "repeatAnchor">,
  today: DayKey,
): DayKey | null {
  if (task.dueDate === null) return null;
  const cadence = repeatCadence(task.repeat, Math.max(1, task.repeatEvery));
  if (!cadence) return null;
  const anchor = task.repeatAnchor ?? task.dueDate;
  const after = task.dueDate > today ? task.dueDate : today;
  return nextOccurrenceAfter(anchor, cadence, after);
}

export function describeRepeat(repeat: string, every: number): string {
  const unit = repeat as RepeatUnit;
  if (unit === "none" || !REPEAT_UNIT_META[unit]) return "Does not repeat";
  if (every <= 1) return REPEAT_UNIT_META[unit].label;
  const noun =
    unit === "daily" ? "days" : unit === "weekly" ? "weeks" : unit === "monthly" ? "months" : "years";
  return `Every ${every} ${noun}`;
}

// --- projects ----------------------------------------------------------------

export interface ProjectProgress {
  /** Tasks counted toward completion (dropped ones are not obligations). */
  total: number;
  done: number;
  open: number;
  /** Null when the project has no countable tasks yet. */
  percent: number | null;
}

/** Completion across a project's tasks, subtasks included. */
export function projectProgress(tasks: Array<Pick<TaskLike, "status">>): ProjectProgress {
  const countable = tasks.filter((task) => task.status !== "dropped");
  const done = countable.filter((task) => task.status === "done").length;
  const open = countable.length - done;
  return {
    total: countable.length,
    done,
    open,
    percent: countable.length === 0 ? null : Math.round((done / countable.length) * 100),
  };
}
