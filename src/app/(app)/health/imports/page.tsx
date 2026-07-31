import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { History, Upload } from "lucide-react";

import { ImportHistory } from "@/components/health/import-history";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/db";
import { formatBytes, formatNumber } from "@/lib/utils";
import { listImportBatches } from "@/server/health-import";

export const metadata: Metadata = { title: "Import history · Health" };
export const dynamic = "force-dynamic";

function formatDateTime(date: Date): string {
  return format(date, "MMM d, yyyy · h:mm a");
}

export default async function HealthImportHistoryPage() {
  const user = await getCurrentUser();
  const raw = await listImportBatches(user.id, 100);

  // Timestamps are formatted here, on the server, so the client component
  // renders a plain string and cannot hydrate differently.
  const batches = raw.map((batch) => ({
    ...batch,
    importedAtLabel: formatDateTime(batch.createdAt),
    undoneAtLabel: batch.undoneAt ? formatDateTime(batch.undoneAt) : null,
  }));

  const completed = batches.filter((batch) => batch.status === "completed");
  const totalImported = completed.reduce((sum, batch) => sum + batch.imported, 0);
  const totalBytes = batches.reduce((sum, batch) => sum + (batch.fileSize ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Import history"
        description="Every health import this account has run — what it read, how long it took, and what it wrote."
        actions={
          <Button asChild size="sm">
            <Link href="/health/import">
              <Upload /> New import
            </Link>
          </Button>
        }
      />

      {batches.length > 0 && (
        <div className="stat-grid mb-6">
          <StatTile label="Imports" value={formatNumber(batches.length)} />
          <StatTile label="Active" value={formatNumber(completed.length)} hint="not undone" />
          <StatTile label="Readings written" value={formatNumber(totalImported)} />
          <StatTile label="Files read" value={formatBytes(totalBytes)} />
        </div>
      )}

      <SectionCard
        title="Imports"
        icon={History}
        accent="text-muted-foreground"
        description="Newest first · each can be undone as a unit"
      >
        <ImportHistory batches={batches} />
      </SectionCard>
    </>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-2 text-2xl font-semibold leading-none">{value}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
