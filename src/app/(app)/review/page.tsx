import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { ReviewBoard } from "@/components/review/review-board";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
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
      {/* Deliberately NOT the shared DateNav: it steps freely in both
          directions, and a future week must stay unreachable here — its
          reflection would write a journal entry under a future date. The
          links keep the one-way semantics but wear the Button anatomy, so
          they get the focus ring and full touch targets the raw links
          lacked. */}
      <PageHeader
        title="Weekly review"
        description={`${page.week.label}${page.isCurrentWeek ? " — this week" : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button asChild variant="outline" size="sm" className="touch-target">
              <Link href={`/review?date=${page.previousAnchor}`}>
                <ChevronLeft /> Previous<span className="hidden sm:inline"> week</span>
              </Link>
            </Button>
            {!page.isCurrentWeek && page.nextAnchor && (
              <Button asChild variant="outline" size="sm" className="touch-target">
                <Link href={`/review?date=${page.nextAnchor}`}>
                  Next<span className="hidden sm:inline"> week</span> <ChevronRight />
                </Link>
              </Button>
            )}
            {!page.isCurrentWeek && (
              <Button asChild variant="outline" size="sm" className="touch-target">
                <Link href="/review">This week</Link>
              </Button>
            )}
          </div>
        }
      />

      <ReviewBoard page={page} />
    </div>
  );
}
