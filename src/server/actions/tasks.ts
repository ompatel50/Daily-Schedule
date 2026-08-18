"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/enums";
import { operationalDayOfRecord } from "@/lib/logic/operational-day";
import { resetMinuteOf } from "@/lib/logic/schedule";
import { trashStamp } from "@/lib/soft-delete";
import { scheduleSettingsFor } from "@/server/schedule";
import { recomputeDay } from "@/server/summaries";
import { linkedBlocksToComplete, nextDueAfterCompletion } from "@/lib/logic/tasks";
import {
  fail,
  fromZod,
  projectSchema,
  scheduleTaskSchema,
  succeed,
  taskSchema,
  type ActionResult,
} from "@/lib/validation";

function revalidateAll() {
  revalidatePath("/", "layout");
}

// --- projects ----------------------------------------------------------------

export async function saveProject(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;
  const payload = { ...data, description: data.description ?? null };

  if (id) {
    const existing = await prisma.project.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Project not found");
    await prisma.project.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.project.create({
    data: {
      ...payload,
      userId: user.id,
      sortOrder: await prisma.project.count({ where: { userId: user.id } }),
    },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

export async function setProjectStatus(id: string, status: string): Promise<ActionResult<null>> {
  if (!PROJECT_STATUSES.includes(status as ProjectStatus)) return fail("Unknown status");
  const user = await getCurrentUser();
  const result = await prisma.project.updateMany({
    where: { id, userId: user.id },
    data: { status, completedAt: status === "completed" ? new Date() : null },
  });
  if (result.count === 0) return fail("Project not found");
  revalidateAll();
  return succeed(null);
}

/**
 * Move a project to the Trash. Its tasks survive: while the project sits in
 * the Trash they render standalone (the read models hide a trashed project
 * link), and they re-attach if it is restored. Purging detaches them for
 * good (schema `SetNull`).
 */
export async function deleteProject(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.project.updateMany({
    where: { id, userId: user.id },
    data: { deletedAt: trashStamp() },
  });
  revalidateAll();
  return succeed(null);
}

// --- tasks -------------------------------------------------------------------

/**
 * Resolve tag NAMES to the caller's own tag rows, creating any that are new.
 *
 * Tags are created by typing them — there is no separate "manage tags" step —
 * and they share the planner's vocabulary, so `#admin` on a task and `#admin`
 * on a planner block are the same tag. Every row is written with the caller's
 * `userId`, so a name can only ever resolve inside their own account.
 */
async function resolveTagIds(userId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const existing = await prisma.tag.findMany({
    where: { userId, name: { in: names } },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((tag) => [tag.name, tag.id]));

  for (const name of names) {
    if (byName.has(name)) continue;
    // Upsert, not create: two tabs adding the same new tag race down to one row
    // rather than one of them failing on the (userId, name) unique.
    const tag = await prisma.tag.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name },
      update: {},
      select: { id: true },
    });
    byName.set(name, tag.id);
  }

  return names.map((name) => byName.get(name)).filter((id): id is string => Boolean(id));
}

/** Replace a task's tag set with exactly `tagIds`, inside the caller's scope. */
async function syncTaskTags(
  db: Pick<typeof prisma, "taskTag">,
  taskId: string,
  tagIds: string[],
): Promise<void> {
  await db.taskTag.deleteMany({ where: { taskId, tagId: { notIn: tagIds } } });
  if (tagIds.length === 0) return;
  await db.taskTag.createMany({
    data: tagIds.map((tagId) => ({ taskId, tagId })),
    skipDuplicates: true,
  });
}

export async function saveTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, projectId, parentId, tags, ...data } = parsed.data;

  // Client-supplied references must belong to the caller.
  if (projectId) {
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return fail("Project not found");
  }
  if (parentId) {
    if (parentId === id) return fail("A task cannot be its own subtask");
    const parent = await prisma.task.findFirst({ where: { id: parentId, userId: user.id } });
    if (!parent) return fail("Parent task not found");
    // One level of nesting: the UI renders subtasks under their parent, and a
    // deeper tree would silently disappear from every view.
    if (parent.parentId) return fail("Subtasks cannot have their own subtasks");
  }

  const payload = {
    ...data,
    projectId: projectId ?? null,
    parentId: parentId ?? null,
    notes: data.notes ?? null,
    dueDate: data.dueDate ?? null,
    // The anchor is the due date the repeat was configured against; clearing
    // the repeat clears it.
    repeatAnchor: data.repeat === "none" ? null : (data.dueDate ?? null),
  };

  const tagIds = await resolveTagIds(user.id, tags);

  if (id) {
    const existing = await prisma.task.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Task not found");
    await prisma.$transaction(async (db) => {
      await db.task.update({ where: { id }, data: payload });
      await syncTaskTags(db, id, tagIds);
    });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.task.create({
    data: {
      ...payload,
      userId: user.id,
      sortOrder: await prisma.task.count({ where: { userId: user.id, status: "open" } }),
      tags: tagIds.length ? { create: tagIds.map((tagId) => ({ tagId })) } : undefined,
    },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

export interface CompleteTaskOutcome {
  /** `completed` closed the task; `advanced` moved a repeating task's due date. */
  status: "completed" | "advanced";
  nextDue: string | null;
  /** Linked planner blocks this completion also marked done. */
  blocksCompleted: number;
}

/**
 * Mark a task's still-planned linked planner blocks done alongside the
 * completion. Which blocks reflect is the pure rule in
 * `linkedBlocksToComplete`; this only writes it and keeps the affected days'
 * summaries current. Runs inside the completion's transaction so the task and
 * its blocks can never disagree.
 */
async function reflectCompletionOnBlocks(
  db: Pick<typeof prisma, "scheduleItem">,
  userId: string,
  taskId: string,
  outcome: "completed" | "advanced",
  today: string,
  resetMinute: number,
): Promise<{ count: number; days: string[] }> {
  const blocks = await db.scheduleItem.findMany({
    where: { userId, taskId, status: "planned" },
    select: { id: true, status: true, date: true, startMinute: true },
  });
  const completing = linkedBlocksToComplete(blocks, outcome, today, resetMinute);
  if (completing.length === 0) return { count: 0, days: [] };
  await db.scheduleItem.updateMany({
    where: { id: { in: completing.map((block) => block.id) }, userId },
    data: { status: "done", completedAt: new Date() },
  });
  return {
    count: completing.length,
    days: [...new Set(completing.map((block) => operationalDayOfRecord(block, resetMinute)))],
  };
}

/**
 * Completing a repeating task advances its due date instead of closing it —
 * the repeat IS the task. Everything else closes with a completion stamp.
 *
 * Either way the completion reflects on planner blocks scheduled from this
 * task: closing marks every still-planned block done, advancing marks only
 * blocks up to today (future blocks are time set aside for the next
 * occurrence). See `linkedBlocksToComplete` for the rule and its reasoning.
 */
export async function completeTask(id: string): Promise<ActionResult<CompleteTaskOutcome>> {
  const user = await getCurrentUser();
  const task = await prisma.task.findFirst({ where: { id, userId: user.id } });
  if (!task) return fail("Task not found");
  if (task.status !== "open") return fail("This task is not open");

  const settings = scheduleSettingsFor(user);
  const reset = resetMinuteOf(settings);

  const nextDue = nextDueAfterCompletion(task, settings.today);
  const outcome: CompleteTaskOutcome["status"] = nextDue ? "advanced" : "completed";

  const reflected = await prisma.$transaction(async (db) => {
    await db.task.update({
      where: { id },
      data: nextDue ? { dueDate: nextDue } : { status: "done", completedAt: new Date() },
    });
    return reflectCompletionOnBlocks(db, user.id, id, outcome, settings.today, reset);
  });

  for (const day of reflected.days) {
    await recomputeDay(user.id, day);
  }
  revalidateAll();
  return succeed({ status: outcome, nextDue: nextDue ?? null, blocksCompleted: reflected.count });
}

export async function reopenTask(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await prisma.task.updateMany({
    where: { id, userId: user.id, status: { in: ["done", "dropped"] } },
    data: { status: "open", completedAt: null },
  });
  if (result.count === 0) return fail("Task not found");
  revalidateAll();
  return succeed(null);
}

/** Deliberately not doing it — distinct from done, and it breaks no repeat. */
export async function dropTask(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await prisma.task.updateMany({
    where: { id, userId: user.id, status: "open" },
    data: { status: "dropped", completedAt: null },
  });
  if (result.count === 0) return fail("Task not found");
  revalidateAll();
  return succeed(null);
}

/**
 * Move a task to the Trash, its subtasks with it. Children share the
 * parent's trash stamp, so restoring the task brings back exactly the rows
 * this delete removed — a subtask trashed separately stays trashed. Planner
 * blocks scheduled from the task keep their link (hidden while the task is
 * trashed, live again on restore); purging detaches them (schema `SetNull`).
 */
export async function deleteTask(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const task = await prisma.task.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!task) return succeed(null);
  await prisma.task.updateMany({
    where: { userId: user.id, OR: [{ id }, { parentId: id }] },
    data: { deletedAt: trashStamp() },
  });
  revalidateAll();
  return succeed(null);
}

/**
 * "Didn't get to it" — the weekly review's one-click roll: move an OPEN
 * task's due date forward (typically to the next week's start). A repeating
 * task re-anchors on the new date, exactly as an edit through the dialog
 * would, so its cadence walks from where it actually restarts.
 */
export async function rollTaskForward(
  id: string,
  toDate: string,
): Promise<ActionResult<{ dueDate: string }>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return fail("Expected a YYYY-MM-DD date");
  const user = await getCurrentUser();
  const task = await prisma.task.findFirst({ where: { id, userId: user.id, status: "open" } });
  if (!task) return fail("Task not found");

  await prisma.task.update({
    where: { id },
    data: {
      dueDate: toDate,
      repeatAnchor: task.repeat === "none" ? task.repeatAnchor : toDate,
    },
  });
  revalidateAll();
  return succeed({ dueDate: toDate });
}

export interface ScheduleTaskOutcome {
  scheduleItemId: string;
  date: string;
}

/**
 * Put a task on the planner: an ordinary planner block on the chosen day,
 * carrying the task's title and priority and a link back to the task. One
 * task can be scheduled onto several days; that is time-blocking, not
 * duplication.
 *
 * The link is live in both directions but never destructive: marking the
 * block done OFFERS to complete the task (`ScheduleStatusOutcome.taskOffer`),
 * completing the task from anywhere marks its planned blocks done
 * (`completeTask`), and deleting either side merely detaches — the task's
 * deletion nulls the block's `taskId` (schema `SetNull`), the block's
 * deletion never touches the task.
 */
export async function scheduleTaskOnPlanner(
  input: unknown,
): Promise<ActionResult<ScheduleTaskOutcome>> {
  const parsed = scheduleTaskSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { taskId, date, startMinute, endMinute } = parsed.data;

  const task = await prisma.task.findFirst({ where: { id: taskId, userId: user.id } });
  if (!task) return fail("Task not found");
  if (task.status !== "open") return fail("Only open tasks can be scheduled");

  const timed = startMinute !== null && startMinute !== undefined;
  const created = await prisma.scheduleItem.create({
    data: {
      userId: user.id,
      title: task.title,
      date,
      allDay: !timed,
      startMinute: timed ? startMinute : null,
      endMinute: timed ? (endMinute ?? null) : null,
      category: "admin",
      priority: task.priority,
      taskId: task.id,
    },
  });

  revalidateAll();
  return succeed({ scheduleItemId: created.id, date });
}
