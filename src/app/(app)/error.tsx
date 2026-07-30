"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the authenticated app. Deliberately quiet:
 * no stack trace, no query text, no file path — those belong in server logs,
 * never in a browser. The digest lets the owner correlate a report with the
 * server-side log line.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="max-w-md space-y-4 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" aria-hidden />
        <h2 className="text-lg font-semibold">Something went wrong on this page</h2>
        <p className="text-sm text-muted-foreground">
          Your data is safe — nothing was changed by opening a page. Try again, or switch to
          another tab and come back.
          {error.digest ? (
            <span className="mt-2 block text-xs">Reference: {error.digest}</span>
          ) : null}
        </p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
