import { Skeleton } from "@/components/ui/skeleton";

/** Planner-shaped: header with date nav, the view tabs, then list + timeline. */
export default function PlannerLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-64" />
      </div>
      <Skeleton className="h-9 w-56" />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-2 xl:col-span-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-96 xl:col-span-2" />
      </div>
    </div>
  );
}
