import { Skeleton } from "@/components/ui/skeleton";

/** Calendar-shaped: heatmap card, stat row, then the month grid. */
export default function CalendarLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-56" />
      </div>
      <Skeleton className="h-44" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-[480px]" />
    </div>
  );
}
