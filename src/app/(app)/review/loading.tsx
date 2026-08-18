import { Skeleton } from "@/components/ui/skeleton";

/** Review-shaped: header, week navigation, then the page's stacked sections. */
export default function ReviewLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-36" />
      <Skeleton className="h-44" />
    </div>
  );
}
