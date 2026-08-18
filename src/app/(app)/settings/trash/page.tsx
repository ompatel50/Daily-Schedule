import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Trash2 } from "lucide-react";

import { TrashList } from "@/components/settings/trash-list";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { getTrashPage } from "@/server/trash";

export const metadata: Metadata = { title: "Trash" };
export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const { items, retentionDays } = await getTrashPage();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Trash"
        description="Everything you deleted, restorable per item — from every module."
      />
      <div className="space-y-4">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to settings
        </Link>
        <SectionCard title="Deleted items" icon={Trash2} accent="text-muted-foreground">
          <TrashList items={items} retentionDays={retentionDays} />
        </SectionCard>
      </div>
    </div>
  );
}
