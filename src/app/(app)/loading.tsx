import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown inside the persistent shell the moment a primary tab is clicked,
 * while the next route's server render streams in. The sidebar and topbar
 * never unmount — only the content area skeletons — so navigation responds
 * instantly instead of holding the old page until the new one is ready.
 */
export default function AppLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
