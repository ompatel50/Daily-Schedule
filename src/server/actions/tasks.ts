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

export async function saveTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, projectId, parentId, ...data } = parsed.data;

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

  if (id) {
    const existing = await prisma.task.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Task not found");
    await prisma.task.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.task.create({
    data: {
      ...payload,
      userId: user.id,
      sortOrder: await prisma.task.count({ where: { userId: user.id, status: "open" } }),
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
