import { Skeleton } from "@/components/ui/skeleton";

/**
 * The assistant's own loading boundary.
 *
 * `(app)/loading.tsx` already covers this navigation, but its skeleton is the
 * dashboard's shape — four stat tiles and two wide panels — which is nothing
 * like this page. Showing that layout first and then replacing it with a chat
 * card reads as a flash of the wrong page. This one matches what actually
 * arrives: header, status row, transcript card, composer.
 */
export default function AssistantLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-4xl space-y-6 pb-safe">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-11" />
      <div className="rounded-xl border">
        <div className="space-y-3 p-3 sm:p-4">
          <Skeleton className="h-4 w-72 max-w-full" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-7 w-36" />
            <Skeleton className="h-7 w-52" />
          </div>
          <Skeleton className="h-24" />
        </div>
        <div className="flex items-end gap-2 border-t p-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-9 shrink-0" />
        </div>
      </div>
    </div>
  );
}
