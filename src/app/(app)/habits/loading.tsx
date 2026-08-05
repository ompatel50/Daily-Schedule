import { Skeleton } from "@/components/ui/skeleton";

/** Habits-shaped: header, stat row, habit cards beside the checklist rail. */
export default function HabitsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="stat-grid">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-6 lg:grid-cols-4">
        <div className="grid gap-4 lg:col-span-3 xl:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}
