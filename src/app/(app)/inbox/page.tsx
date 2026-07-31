import type { Metadata } from "next";
import { Suspense } from "react";

import {
  DocumentsPanel,
  type DocumentListItem,
} from "@/components/documents/documents-panel";
import { InboxBoard, type InboxListItem } from "@/components/inbox/inbox-board";
import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { toDayKey } from "@/lib/date";
import { pluralize } from "@/lib/utils";
import { getDocumentViews } from "@/server/documents";
import { getInboxPage } from "@/server/inbox";
import { getUser } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const [{ open, resolved, projects }, documentViews] = await Promise.all([
    getInboxPage(),
    getDocumentViews(),
  ]);

  const mapItem = (item: (typeof open)[number]): InboxListItem => ({
    id: item.id,
    title: item.title,
    notes: item.notes,
    status: item.status,
    taskId: item.taskId,
    createdDay: toDayKey(item.createdAt),
    resolvedDay: toDayKey(item.updatedAt),
  });

  const documents: DocumentListItem[] = documentViews.map((view) => ({
    id: view.document.id,
    name: view.document.name,
    kind: view.document.kind,
    issuer: view.document.issuer,
    expiryDate: view.document.expiryDate,
    notes: view.document.notes,
    reminderEnabled: view.document.reminderEnabled,
    reminderDaysBefore: view.document.reminderDaysBefore,
    bucket: view.bucket,
    daysUntilExpiry: view.daysUntilExpiry,
    expired: view.expired,
    reminderArmed: view.reminderArmed,
  }));

  const expiringSoon = documents.filter((document) => document.daysUntilExpiry <= 30).length;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Inbox"
        description="Capture now, decide later — plus the renewals you'd rather not discover late."
      />

      {/* Deliberately no stat grid — a catchall queue should stay calm. */}
      <p className="-mt-4 mb-6 text-sm text-muted-foreground">
        {open.length === 0
          ? "Nothing waiting"
          : `${open.length} ${pluralize(open.length, "item")} waiting`}
        {" · "}
        {resolved.length} resolved
        {documents.length > 0 && (
          <>
            {" · "}
            {expiringSoon > 0
              ? `${expiringSoon} ${pluralize(expiringSoon, "renewal")} within 30 days`
              : `${documents.length} ${pluralize(documents.length, "document")} tracked`}
          </>
        )}
      </p>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <div className="space-y-6">
          <InboxBoard
            open={open.map(mapItem)}
            resolved={resolved.map(mapItem)}
            projects={projects.map((project) => ({ id: project.id, name: project.name }))}
            today={settings.today}
          />
          <DocumentsPanel documents={documents} today={settings.today} />
        </div>
      </Suspense>
    </div>
  );
}
