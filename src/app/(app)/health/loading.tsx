import { Skeleton } from "@/components/ui/skeleton";

/**
 * The Health section's own loading boundary.
 *
 * `(app)/loading.tsx` covers navigations that change the segment *below the
 * app shell* — clicking Finance, or Habits, in the sidebar. Moving between
 * Health tabs changes a segment one level deeper, below `health/layout.tsx`,
 * which that boundary does not wrap. Without one here, React has to finish
 * rendering the destination before it can commit the transition at all: the
 * tab bar stays on the old page with no feedback, and a slow render can lose
 * the navigation outright.
 *
 * With this boundary the URL and the tab highlight commit immediately and the
 * page streams in behind a skeleton — the same behaviour the shell already
 * documents for its primary tabs.
 */
export default function HealthLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-8 w-72" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
