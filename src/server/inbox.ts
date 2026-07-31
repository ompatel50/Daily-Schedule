import "server-only";

import { cache } from "react";

import { getCurrentUser, prisma } from "@/lib/db";

/**
 * Inbox read model. Deliberately tiny — the inbox is a catchall queue, not a
 * second task system.
 */

async function openInboxImpl(userId: string) {
  return prisma.inboxItem.findMany({
    where: { userId, status: "open" },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

const openInboxMemo = cache(openInboxImpl);

export type InboxItemRow = Awaited<ReturnType<typeof openInboxImpl>>[number];

/** Everything the inbox page renders: the open queue plus recent history. */
export async function getInboxPage() {
  const user = await getCurrentUser();
  const [open, resolved] = await Promise.all([
    openInboxMemo(user.id),
    prisma.inboxItem.findMany({
      where: { userId: user.id, status: { in: ["done", "archived"] } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);
  return { open, resolved };
}

export type InboxPage = Awaited<ReturnType<typeof getInboxPage>>;

/** The bounded slice the dashboard shows. */
export async function getInboxSummary() {
  const user = await getCurrentUser();
  const open = await openInboxMemo(user.id);
  return {
    openCount: open.length,
    latest: open.slice(0, 3).map((item) => ({ id: item.id, title: item.title })),
  };
}

export type InboxSummary = Awaited<ReturnType<typeof getInboxSummary>>;
