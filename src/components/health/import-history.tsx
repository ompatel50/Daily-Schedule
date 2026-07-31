"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { History, Loader2, Search, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { IMPORT_FORMAT_VERSION } from "@/lib/logic/health-import/version";
import { formatBytes, formatNumber } from "@/lib/utils";
import {
  previewBatchRemovalAction,
  removeImportBatchAction,
} from "@/server/actions/health-import";
import type { BatchRemovalPreview } from "@/server/health-import";

export interface BatchSummary {
  id: string;
  fileName: string;
  source: string;
  fileType: string;
  fileSize: number | null;
  status: string;
  error: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  imported: number;
  updated: number;
  duplicates: number;
  protectedRows: number;
  skipped: number;
  invalid: number;
  workoutsImported: number;
  workoutsSkipped: number;
  recordsImported: number;
  durationMs: number | null;
  xmlBytes: number | null;
  undoneCount: number;
  keptCount: number;
  formatVersion: number;
  /** Pre-formatted on the server — formatting a Date here would hydrate
   * differently when the server and browser disagree on locale or zone. */
  importedAtLabel: string;
  undoneAtLabel: string | null;
  categoriesList: string[];
  warningsList: string[];
  errorsList: string[];
  ignoredFilesList: string[];
}

function categoryLabel(key: string): string {
  if (key === "workouts") return "Workouts";
  if (key === "records") return "Health records";
  return HEALTH_METRIC_META[key as HealthMetricType]?.label ?? key;
}

export function sourceName(source: string): string {
  if (source === "apple_health") return "Apple Health";
  if (source === "csv") return "CSV";
  return source;
}

/** What the status badge says — "removed" is an implementation word. */
function statusLabel(status: string): string {
  if (status === "removed") return "undone";
  return status;
}

type StatusFilter = "all" | "completed" | "removed" | "failed";

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "completed", label: "Active" },
  { key: "removed", label: "Undone" },
  { key: "failed", label: "Failed" },
];

/**
 * Everything a batch can be searched by, flattened once per row.
 *
 * Filtering happens in the browser over a bounded list the server already
 * fetched — a hundred rows is nothing to scan, and a round trip per keystroke
 * would be both slower and a query per keystroke against the health tables.
 */
function haystack(batch: BatchSummary): string {
  return [
    batch.fileName,
    sourceName(batch.source),
    batch.fileType,
    statusLabel(batch.status),
    batch.importedAtLabel,
    batch.dateFrom,
    batch.dateTo,
    ...batch.categoriesList.map(categoryLabel),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Past imports, each undoable as a unit, searchable once there are enough of
 * them to be worth searching.
 *
 * The undo shows exactly what it would delete *and what it would keep* before
 * asking — a row you have edited since importing, or a workout you have since
 * added sets to, is listed as kept rather than quietly removed.
 */
export function ImportHistory({ batches }: { batches: BatchSummary[] }) {
  const router = useRouter();
  const [removal, setRemoval] = React.useState<BatchRemovalPreview | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");

  const indexed = React.useMemo(
    () => batches.map((batch) => ({ batch, text: haystack(batch) })),
    [batches],
  );

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return indexed
      .filter((entry) => (status === "all" ? true : entry.batch.status === status))
      .filter((entry) => (needle === "" ? true : entry.text.includes(needle)))
      .map((entry) => entry.batch);
  }, [indexed, query, status]);

  async function askRemove(batchId: string) {
    setBusy(batchId);
    try {
      const result = await previewBatchRemovalAction(batchId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRemoval(result.data);
    } finally {
      setBusy(null);
    }
  }

  async function confirmRemove() {
    if (!removal) return;
    setBusy(removal.batchId);
    try {
      const result = await removeImportBatchAction(removal.batchId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { removedMetrics, removedWorkouts, removedRecords, keptCount } = result.data;
      toast.success(
        `Undone — removed ${formatNumber(removedMetrics)} readings` +
          (removedWorkouts > 0 ? `, ${formatNumber(removedWorkouts)} workouts` : "") +
          (removedRecords > 0 ? `, ${formatNumber(removedRecords)} records` : ""),
        {
          description:
            (keptCount > 0
              ? `${formatNumber(keptCount)} kept because you changed or built on them. `
              : "") + "Goals, scores, the calendar and insights have been recalculated.",
        },
      );
      setRemoval(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (batches.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No imports yet. Records you import appear here, and each import can be undone as a unit
        without touching anything you entered by hand.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* The controls earn their space only once there is something to sift:
          below three rows, every answer is already on screen. */}
      {batches.length > 2 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by file, source, date or category"
              aria-label="Search import history"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex gap-1" role="group" aria-label="Filter by status">
            {FILTERS.map((filter) => (
              <Button
                key={filter.key}
                type="button"
                size="sm"
                variant={status === filter.key ? "secondary" : "ghost"}
                aria-pressed={status === filter.key}
                onClick={() => setStatus(filter.key)}
              >
                {filter.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {visible.length !== batches.length && (
        <p className="text-xs text-muted-foreground" role="status">
          {visible.length === 0
            ? "No import matches that."
            : `${formatNumber(visible.length)} of ${formatNumber(batches.length)} imports`}
        </p>
      )}

      <div className="space-y-2">
        {visible.map((batch) => (
          <div key={batch.id} className="rounded-lg border p-3" data-testid="import-batch">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-all">{batch.fileName}</span>
                  <Badge
                    variant={
                      batch.status === "failed"
                        ? "danger"
                        : batch.status === "removed"
                          ? "outline"
                          : "muted"
                    }
                    className="text-[10px] capitalize"
                  >
                    {statusLabel(batch.status)}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {sourceName(batch.source)}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {batch.importedAtLabel}
                  {batch.fileSize ? ` · ${formatBytes(batch.fileSize)}` : ""}
                  {batch.durationMs !== null
                    ? ` · wrote in ${(batch.durationMs / 1000).toFixed(1)}s`
                    : ""}
                  {batch.dateFrom && batch.dateTo ? ` · ${batch.dateFrom} → ${batch.dateTo}` : ""}
                </p>
                {batch.status === "failed" && batch.error ? (
                  <p className="mt-1 text-xs text-destructive">{batch.error}</p>
                ) : batch.status === "removed" ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Undone{batch.undoneAtLabel ? ` ${batch.undoneAtLabel}` : ""} ·{" "}
                    {formatNumber(batch.undoneCount)} removed
                    {batch.keptCount > 0 ? ` · ${formatNumber(batch.keptCount)} kept` : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatNumber(batch.imported)} new · {formatNumber(batch.updated)} merged ·{" "}
                    {formatNumber(batch.duplicates)} already present
                    {batch.protectedRows > 0
                      ? ` · ${formatNumber(batch.protectedRows)} kept as yours`
                      : ""}
                    {batch.workoutsImported > 0
                      ? ` · ${formatNumber(batch.workoutsImported)} workouts`
                      : ""}
                    {batch.recordsImported > 0
                      ? ` · ${formatNumber(batch.recordsImported)} records`
                      : ""}
                    {batch.invalid > 0 ? ` · ${formatNumber(batch.invalid)} invalid` : ""}
                    {batch.skipped > 0 ? ` · ${formatNumber(batch.skipped)} unsupported` : ""}
                  </p>
                )}
                {batch.categoriesList.length > 0 && batch.status !== "failed" && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {batch.categoriesList.map((key) => (
                      <Badge key={key} variant="muted" className="text-[10px]">
                        {categoryLabel(key)}
                      </Badge>
                    ))}
                  </div>
                )}
                {(batch.warningsList.length > 0 || batch.errorsList.length > 0) && (
                  <details className="mt-1.5 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      {batch.warningsList.length + batch.errorsList.length} note
                      {batch.warningsList.length + batch.errorsList.length === 1 ? "" : "s"} from
                      this import
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {[...batch.errorsList, ...batch.warningsList]
                        .slice(0, 10)
                        .map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                    </ul>
                  </details>
                )}
                {/* Only shown when it changes how the row above should be read:
                    a batch from the old pipeline overwrote instead of
                    protecting, so its zero is not a promise. */}
                {batch.formatVersion < IMPORT_FORMAT_VERSION && batch.status === "completed" && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Imported by an earlier version of the importer (v{batch.formatVersion}), which
                    replaced matching readings instead of protecting the ones you had edited.
                  </p>
                )}
              </div>
              {batch.status === "completed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => askRemove(batch.id)}
                  disabled={busy !== null}
                  aria-label={`Undo the import ${batch.fileName}`}
                >
                  {busy === batch.id ? <Loader2 className="animate-spin" /> : <Undo2 />}
                  Undo
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={removal !== null} onOpenChange={(open) => !open && setRemoval(null)}>
        <DialogContent className="max-w-md">
          {removal && (
            <>
              <DialogHeader>
                <DialogTitle>Undo this import?</DialogTitle>
                <DialogDescription>
                  This removes only what {removal.fileName} wrote and still owns. Manual entries,
                  other imports, and anything you have changed since stay exactly as they are.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <p>
                  <span className="tabular font-semibold">{formatNumber(removal.metricCount)}</span>{" "}
                  readings
                  {removal.workoutCount > 0 && (
                    <>
                      {", "}
                      <span className="tabular font-semibold">
                        {formatNumber(removal.workoutCount)}
                      </span>{" "}
                      workouts
                    </>
                  )}
                  {removal.recordCount > 0 && (
                    <>
                      {", "}
                      <span className="tabular font-semibold">
                        {formatNumber(removal.recordCount)}
                      </span>{" "}
                      health records
                    </>
                  )}{" "}
                  will be deleted
                  {removal.dateFrom && removal.dateTo
                    ? ` (${removal.dateFrom} → ${removal.dateTo})`
                    : ""}
                  .
                </p>
                {removal.keptEdited + removal.keptLinked > 0 && (
                  <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    <span className="tabular font-semibold text-foreground">
                      {formatNumber(removal.keptEdited + removal.keptLinked)}
                    </span>{" "}
                    will be kept
                    {removal.keptEdited > 0 && ` — ${formatNumber(removal.keptEdited)} you edited`}
                    {removal.keptLinked > 0 &&
                      `${removal.keptEdited > 0 ? "," : " —"} ${formatNumber(removal.keptLinked)} now used by something else`}
                    .
                  </p>
                )}
                {removal.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {removal.categories.map((category) => (
                      <Badge key={category.type} variant="muted" className="text-[10px]">
                        {category.label} × {formatNumber(category.count)}
                      </Badge>
                    ))}
                    {removal.recordKinds.map((kind) => (
                      <Badge key={kind.kind} variant="muted" className="text-[10px]">
                        {kind.label} × {formatNumber(kind.count)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setRemoval(null)} disabled={busy !== null}>
                  Keep it
                </Button>
                <Button variant="destructive" onClick={confirmRemove} disabled={busy !== null}>
                  {busy !== null && <Loader2 className="animate-spin" />}
                  Undo import
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
