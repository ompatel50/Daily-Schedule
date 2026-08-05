import { Skeleton } from "@/components/ui/skeleton";

/** Tasks-shaped: header, stat row, buckets beside the projects rail. */
export default function TasksLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="stat-grid">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    </div>
  );
}
