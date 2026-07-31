import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatDay } from "@/lib/date";
import type { HealthRange } from "@/lib/health-ranges";
import { MetricPanel } from "./metric-panel";
import { RangePicker } from "./range-picker";
import type { GroupView } from "@/server/health-module";

/**
 * The shape every metric-group page shares: a header with the range picker,
 * then one panel per metric in the group. Written once so Activity, Heart,
 * Body, Nutrition, Respiratory and Vitals cannot drift apart in layout,
 * empty-state wording or how a range is applied.
 */
export function HealthGroupPage({
  title,
  description,
  icon,
  view,
  range,
  chart = "area",
  empty = view.empty,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  view: GroupView;
  range: HealthRange;
  chart?: "area" | "line";
  /**
   * Whether the page has nothing to show. Defaults to "no metric in the group
   * has a reading", which a page with other content of its own (sleep
   * sessions, say) overrides so a full page never renders an empty state.
   */
  empty?: boolean;
  /** Extra content shown above the metric panels (notes, sessions, lists). */
  children?: ReactNode;
}) {
  const withData = view.series.filter((series) => series.daysWithData > 0);
  const withoutData = view.series.filter((series) => series.daysWithData === 0);

  return (
    <>
      <PageHeader
        title={title}
        description={`${description} · ${formatDay(view.from, "MMM d, yyyy")} → ${formatDay(view.to, "MMM d, yyyy")}`}
        actions={<RangePicker current={range} />}
      />

      {children}

      {empty ? (
        <EmptyState
          icon={icon}
          title={`No ${title.toLowerCase()} data in this range`}
          description="Import an Apple Health export to fill in the history, log a value by hand, or widen the range."
          action={
            <Button asChild>
              <Link href="/health/import">Import health data</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {withData.map((series) => (
              <MetricPanel key={series.type} series={series} chart={chart} />
            ))}
          </div>

          {/*
            The metrics this group covers but this account has no readings for.
            One line rather than one empty chart panel each: Nutrition alone
            covers twenty-odd metrics, and a page of identical "nothing recorded"
            cards buries the four that do have data. Still listed, because
            silently dropping them would leave the user unable to tell whether
            the app tracks the metric at all.
          */}
          {withoutData.length > 0 && (
            <p className="mt-4 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                No readings in this range for {withoutData.length}{" "}
                {withoutData.length === 1 ? "metric" : "metrics"}:
              </span>{" "}
              {withoutData.map((series) => series.label).join(", ")}. They appear here as soon as an
              import or a manual entry supplies one.
            </p>
          )}
        </>
      )}
    </>
  );
}
