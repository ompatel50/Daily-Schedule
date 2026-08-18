import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Database } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { formatDay } from "@/lib/date";
import { getDataOverview } from "@/server/data-overview";

export const metadata: Metadata = { title: "Your data" };
export const dynamic = "force-dynamic";

function relativeStamp(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Read-only transparency: what this account holds, per module, with the
 * bounds and recency the counts alone don't tell. The numbers are the same
 * ones the assistant's get_backup_status reports.
 */
export default async function DataPage() {
  const overview = await getDataOverview();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Your data"
        description="What this account holds, module by module. Read-only."
      />
      <div className="space-y-4">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to settings
        </Link>

        <SectionCard
          title="Records"
          icon={Database}
          accent="text-muted-foreground"
          description={`${overview.totalRecords.toLocaleString("en-US")} records in total${
            overview.trashCount > 0 ? ` · ${overview.trashCount} in the trash` : ""
          }`}
        >
          {/* Phones get cards; the table needs its min width so it scrolls
              sideways instead of silently squeezing the date columns. */}
          <ul className="space-y-2 md:hidden">
            {overview.modules.map((row) => (
              <li key={row.module} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>{row.module}</span>
                  <span className="tabular">{row.count.toLocaleString("en-US")}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.oldest && row.newest
                    ? `${formatDay(row.oldest, "MMM d, yyyy")} – ${formatDay(row.newest, "MMM d, yyyy")}`
                    : "No dated records"}
                </p>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Module</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Records</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Oldest</th>
                  <th scope="col" className="py-1.5 font-medium">Newest</th>
                </tr>
              </thead>
              <tbody>
                {overview.modules.map((row) => (
                  <tr key={row.module} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">{row.module}</td>
                    <td className="tabular py-1.5 pr-3 text-right">
                      {row.count.toLocaleString("en-US")}
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {row.oldest ? formatDay(row.oldest, "MMM d, yyyy") : "—"}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {row.newest ? formatDay(row.newest, "MMM d, yyyy") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          title="Imports & backups"
          icon={Database}
          accent="text-muted-foreground"
          description="Where data last came in, and when it last went out"
        >
          <dl className="space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Last finance import</dt>
              <dd>
                {overview.lastFinanceImport
                  ? `${overview.lastFinanceImport.fileName} · ${relativeStamp(
                      overview.lastFinanceImport.at,
                    )} · ${overview.lastFinanceImport.created} rows${
                      overview.lastFinanceImport.undone ? " (undone)" : ""
                    }`
                  : "No finance imports yet"}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Last health import</dt>
              <dd>
                {overview.lastHealthImport
                  ? `${overview.lastHealthImport.fileName ?? "Apple Health"} · ${relativeStamp(
                      overview.lastHealthImport.at,
                    )} · ${overview.lastHealthImport.status}`
                  : "No health imports yet"}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Last backup export</dt>
              <dd>
                {overview.lastBackupExportAt ? (
                  relativeStamp(overview.lastBackupExportAt)
                ) : (
                  <>
                    never —{" "}
                    <Link href="/settings#backup" className="underline underline-offset-2">
                      export one now
                    </Link>
                  </>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Backup format</dt>
              <dd>v{overview.backupFormatVersion}</dd>
            </div>
          </dl>
        </SectionCard>
      </div>
    </div>
  );
}
