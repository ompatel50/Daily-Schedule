import type { Metadata } from "next";
import { Suspense } from "react";

import { InboxBoard, type InboxListItem } from "@/components/inbox/inbox-board";
import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { toDayKey } from "@/lib/date";
import { pluralize } from "@/lib/utils";
import { getInboxPage } from "@/server/inbox";
import { getUser } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const { open, resolved } = await getInboxPage();

  const mapItem = (item: (typeof open)[number]): InboxListItem => ({
    id: item.id,
    title: item.title,
    notes: item.notes,
    status: item.status,
    createdDay: toDayKey(item.createdAt),
    resolvedDay: toDayKey(item.updatedAt),
  });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Inbox"
        description="Capture now, decide later. Anything that doesn't have a home yet lands here."
      />

      {/* Deliberately no stat grid — a catchall queue should stay calm. */}
      <p className="-mt-4 mb-6 text-sm text-muted-foreground">
        {open.length === 0
          ? "Nothing waiting"
          : `${open.length} ${pluralize(open.length, "item")} waiting`}
        {" · "}
        {resolved.length} resolved
      </p>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <InboxBoard
          open={open.map(mapItem)}
          resolved={resolved.map(mapItem)}
          today={settings.today}
        />
      </Suspense>
    </div>
  );
}
