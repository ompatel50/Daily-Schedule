import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { ReviewBoard } from "@/components/review/review-board";
import { PageHeader } from "@/components/shared/page-header";
import { isDayKey, type DayKey } from "@/lib/date";
import { getWeeklyReviewPage } from "@/server/review";

export const metadata: Metadata = { title: "Weekly review" };
export const dynamic = "force-dynamic";

/**
 * The guided weekly review. `?date=` anchors any week; without it, this week.
 * The numbers are the same computation the assistant's get_week_review runs.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const anchor = params.date && isDayKey(params.date) ? (params.date as DayKey) : undefined;
  const page = await getWeeklyReviewPage(anchor);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Weekly review"
        description={`${page.week.label}${page.isCurrentWeek ? " — this week" : ""}`}
      />

      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/review?date=${page.previousAnchor}`}
          className="inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 text-sm transition-colors hover:bg-accent"
        >
          <ChevronLeft className="h-4 w-4" /> Previous week
        </Link>
        {!page.isCurrentWeek && (
          <>
            {page.nextAnchor && (
              <Link
                href={`/review?date=${page.nextAnchor}`}
                className="inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 text-sm transition-colors hover:bg-accent"
              >
                Next week <ChevronRight className="h-4 w-4" />
              </Link>
            )}
            <Link
              href="/review"
              className="inline-flex min-h-9 items-center rounded-md border px-2.5 text-sm transition-colors hover:bg-accent"
            >
              This week
            </Link>
          </>
        )}
      </div>

      <ReviewBoard page={page} />
    </div>
  );
}
