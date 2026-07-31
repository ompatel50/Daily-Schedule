"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { documentSchema, fail, fromZod, succeed, type ActionResult } from "@/lib/validation";

/**
 * Documents & renewals — the life-admin things that expire. Every mutation is
 * scoped to the signed-in user and verified by ownership before it writes; a
 * guessed id finds nothing, exactly like every other module here.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function saveDocument(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;

  const payload = {
    ...data,
    issuer: data.issuer?.trim() || null,
    notes: data.notes ?? null,
  };

  if (id) {
    const existing = await prisma.lifeDocument.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Document not found");
    await prisma.lifeDocument.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.lifeDocument.create({
    data: { ...payload, userId: user.id },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

/**
 * Archive rather than delete: a lapsed policy is still a record of what you
 * had. An archived document never reminds and never appears in the list.
 */
export async function setDocumentArchived(
  id: string,
  archived: boolean,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await prisma.lifeDocument.updateMany({
    where: { id, userId: user.id },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (result.count === 0) return fail("Document not found");
  revalidateAll();
  return succeed(null);
}

export async function deleteDocument(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.lifeDocument.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}
