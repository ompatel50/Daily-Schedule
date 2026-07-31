import type { Metadata } from "next";
import { Stethoscope } from "lucide-react";

import { MetricPanel } from "@/components/health/metric-panel";
import { RangePicker } from "@/components/health/range-picker";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { getCurrentUser } from "@/lib/db";
import { formatDay } from "@/lib/date";
import { rangeFromParam } from "@/lib/health-ranges";
import { formatNumber } from "@/lib/utils";
import { getGroupView, getHealthRecords } from "@/server/health-module";

export const metadata: Metadata = { title: "Vitals · Health" };
export const dynamic = "force-dynamic";

/**
 * Vitals and respiratory metrics, plus the non-numeric records an export
 * carries — ECGs, medications, clinical records and workout routes. They live
 * together because they answer the same question ("what did a device or a
 * clinician record about me?") and none of them is a daily number.
 */
export default async function HealthVitalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const user = await getCurrentUser();
  const [vitals, respiratory, records] = await Promise.all([
    getGroupView("vitals", range),
    getGroupView("respiratory", range),
    getHealthRecords(user.id, { limit: 100 }),
  ]);

  const series = [...vitals.series, ...respiratory.series];
  const empty = vitals.empty && respiratory.empty && records.length === 0;

  return (
    <>
      <PageHeader
        title="Vitals"
        description={`Blood pressure, glucose, temperature, breathing and blood oxygen · ${formatDay(vitals.from, "MMM d, yyyy")} → ${formatDay(vitals.to, "MMM d, yyyy")}`}
        actions={<RangePicker current={range} />}
      />

      {empty ? (
        <EmptyState
          icon={Stethoscope}
          title="No vitals in this range"
          description="Blood pressure, glucose, temperature, blood oxygen, ECGs and clinical records all appear here once an export contains them."
          action={
            <Button asChild>
              <Link href="/health/import">Import health data</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {series.map((entry) => (
              <MetricPanel key={entry.type} series={entry} chart="line" />
            ))}
          </div>

          {records.length > 0 && (
            <SectionCard
              title="Health records"
              icon={Stethoscope}
              accent="text-domain-health"
              description="ECGs, medications, clinical records and route metadata"
              className="mt-6"
            >
              <ul className="divide-y">
                {records.map((record) => (
                  <li key={record.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Badge variant="outline" className="text-[10px]">
                      {record.kindLabel}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {record.title}
                    </span>
                    {record.value !== null && (
                      <span className="tabular text-sm">
                        {formatNumber(record.value, 2)}
                        {record.unit && (
                          <span className="ml-0.5 text-xs text-muted-foreground">{record.unit}</span>
                        )}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDay(record.date, "MMM d, yyyy")}
                      {record.subtitle ? ` · ${record.subtitle}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Only each record&rsquo;s summary is stored. ECG voltage traces, route coordinates and
                the raw clinical documents are read for their metadata and then discarded — they are
                never copied into this app.
              </p>
            </SectionCard>
          )}
        </>
      )}
    </>
  );
}
