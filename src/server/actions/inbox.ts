"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { INBOX_STATUSES, type InboxStatus } from "@/lib/enums";
import {
  convertInboxItemSchema,
  fail,
  fromZod,
  inboxItemSchema,
  succeed,
  type ActionResult,
} from "@/lib/validation";

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function saveInboxItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = inboxItemSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;
  const payload = { ...data, notes: data.notes ?? null };

  if (id) {
    const existing = await prisma.inboxItem.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Inbox item not found");
    await prisma.inboxItem.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.inboxItem.create({ data: { ...payload, userId: user.id } });
  revalidateAll();
  return succeed({ id: created.id });
}

export async function setInboxItemStatus(id: string, status: string): Promise<ActionResult<null>> {
  if (!INBOX_STATUSES.includes(status as InboxStatus)) return fail("Unknown status");
  const user = await getCurrentUser();
  const result = await prisma.inboxItem.updateMany({
    where: { id, userId: user.id },
    data: { status, completedAt: status === "done" ? new Date() : null },
  });
  if (result.count === 0) return fail("Inbox item not found");
  revalidateAll();
  return succeed(null);
}

export async function deleteInboxItem(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.inboxItem.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

export interface ConvertInboxItemOutcome {
  taskId: string;
}

/**
 * Turn a capture into a task, atomically: the task is created and the item is
 * archived with a link to it in one transaction. The link is also the
 * double-conversion guard — an item that already became a task refuses to
 * become a second one until that task is deleted (which frees the link via
 * SetNull). The inbox stays a capture queue; the work now lives in Tasks.
 */
export async function convertInboxItemToTask(
  input: unknown,
): Promise<ActionResult<ConvertInboxItemOutcome>> {
  const parsed = convertInboxItemSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, projectId, ...data } = parsed.data;

  const item = await prisma.inboxItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Inbox item not found");
  if (item.taskId) return fail("This item already became a task");

  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
    });
    if (!project) return fail("Project not found");
  }

  const task = await prisma.$transaction(async (db) => {
    // Guarded update first: if another tab converted the item in the
    // meantime, the count is 0 and nothing is created.
    const claimed = await db.inboxItem.updateMany({
      where: { id, userId: user.id, taskId: null },
      data: { status: "archived", completedAt: null },
    });
    if (claimed.count === 0) throw new Error("already-converted");

    const created = await db.task.create({
      data: {
        userId: user.id,
        title: data.title ?? item.title,
        notes: data.notes !== undefined ? data.notes : item.notes,
        projectId: projectId ?? null,
        priority: data.priority,
        dueDate: data.dueDate ?? null,
        sortOrder: await db.task.count({ where: { userId: user.id, status: "open" } }),
      },
    });
    await db.inboxItem.update({ where: { id }, data: { taskId: created.id } });
    return created;
  }).catch((error: Error) => {
    if (error.message === "already-converted") return null;
    throw error;
  });

  if (!task) return fail("This item already became a task");
  revalidateAll();
  return succeed({ taskId: task.id });
}
