import { Skeleton } from "@/components/ui/skeleton";

/** Settings-shaped: one narrow column of stacked panels. */
export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-96" />
      <Skeleton className="h-56" />
      <Skeleton className="h-56" />
      <Skeleton className="h-40" />
    </div>
  );
}
