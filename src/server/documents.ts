import "server-only";

import { cache } from "react";

import { getCurrentUser, prisma } from "@/lib/db";
import type { DayKey } from "@/lib/date";
import {
  documentsByExpiry,
  documentsExpiringSoon,
  DOCUMENT_SOON_DAYS,
} from "@/lib/logic/documents";
import { scheduleSettingsFor } from "@/server/schedule";

/**
 * Documents & renewals read model — user-scoped and bounded, with the expiry
 * arithmetic done by the pure module so the inbox page, the dashboard and the
 * reminder feed agree about what is running out.
 */

/** A personal life-admin drawer, not a document management system. */
const DOCUMENT_CAP = 200;

async function documentsImpl(userId: string, today: DayKey) {
  const documents = await prisma.lifeDocument.findMany({
    where: { userId, archivedAt: null },
    orderBy: { expiryDate: "asc" },
    take: DOCUMENT_CAP,
  });
  return documentsByExpiry(documents, today);
}

const documentsMemo = cache(documentsImpl);

export type DocumentView = Awaited<ReturnType<typeof documentsImpl>>[number];

/** Active documents annotated with expiry state, most urgent first. */
export async function getDocumentViews(): Promise<DocumentView[]> {
  const user = await getCurrentUser();
  return documentsMemo(user.id, scheduleSettingsFor(user).today);
}

/** Archived documents — kept for the record, shown only on request. */
export async function getArchivedDocuments(limit = 50) {
  const user = await getCurrentUser();
  return prisma.lifeDocument.findMany({
    where: { userId: user.id, archivedAt: { not: null } },
    orderBy: { expiryDate: "desc" },
    take: limit,
  });
}

/** The bounded slice the dashboard and the inbox header show. */
export async function getDocumentSummary() {
  const views = await getDocumentViews();
  const soon = documentsExpiringSoon(views, DOCUMENT_SOON_DAYS);
  return {
    total: views.length,
    expiringSoonCount: soon.length,
    expiredCount: views.filter((view) => view.expired).length,
    next: soon.slice(0, 3).map((view) => ({
      id: view.document.id,
      name: view.document.name,
      kind: view.document.kind,
      expiryDate: view.document.expiryDate,
      daysUntilExpiry: view.daysUntilExpiry,
      expired: view.expired,
    })),
  };
}

export type DocumentSummary = Awaited<ReturnType<typeof getDocumentSummary>>;
