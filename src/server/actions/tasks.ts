"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/enums";
import { todayIn } from "@/lib/logic/schedule";
import { nextDueAfterCompletion } from "@/lib/logic/tasks";
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

/** Tasks survive their project's deletion — they fall back to standalone. */
export async function deleteProject(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.project.deleteMany({ where: { id, userId: user.id } });
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
}

/**
 * Completing a repeating task advances its due date instead of closing it —
 * the repeat IS the task. Everything else closes with a completion stamp.
 */
export async function completeTask(id: string): Promise<ActionResult<CompleteTaskOutcome>> {
  const user = await getCurrentUser();
  const task = await prisma.task.findFirst({ where: { id, userId: user.id } });
  if (!task) return fail("Task not found");
  if (task.status !== "open") return fail("This task is not open");

  const nextDue = nextDueAfterCompletion(task, todayIn(user.timezone));
  if (nextDue) {
    await prisma.task.update({ where: { id }, data: { dueDate: nextDue } });
    revalidateAll();
    return succeed({ status: "advanced", nextDue });
  }

  await prisma.task.update({
    where: { id },
    data: { status: "done", completedAt: new Date() },
  });
  revalidateAll();
  return succeed({ status: "completed", nextDue: null });
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

/** Deleting a task takes its subtasks with it (schema cascade). */
export async function deleteTask(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.task.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

export interface ScheduleTaskOutcome {
  scheduleItemId: string;
  date: string;
}

/**
 * Put a task on the planner: an ordinary planner block on the chosen day,
 * carrying the task's title and priority and a link back to the task. No
 * scheduling logic rides the link — the block behaves exactly like one typed
 * into the planner, completing it never completes the task, and deleting the
 * task merely unlinks the block. One task can be scheduled onto several days;
 * that is time-blocking, not duplication.
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
