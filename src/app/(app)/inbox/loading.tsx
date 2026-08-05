import { Skeleton } from "@/components/ui/skeleton";

/** Inbox-shaped: capture bar first, then open items beside resolved. */
export default function InboxLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
