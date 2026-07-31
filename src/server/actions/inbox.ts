"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { INBOX_STATUSES, type InboxStatus } from "@/lib/enums";
import { fail, fromZod, inboxItemSchema, succeed, type ActionResult } from "@/lib/validation";

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
