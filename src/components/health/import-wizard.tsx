"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatBytes, formatNumber } from "@/lib/utils";
import {
  cancelHealthImportAction,
  confirmHealthImportAction,
} from "@/server/actions/health-import";
import type { ImportOutcome, ImportPreviewResult } from "@/server/health-import";

/**
 * The staged import: pick a file → it uploads and is parsed **on the server**
 * → a server-checked preview (nothing written) → choose what to bring in →
 * confirm → results. Cancelling discards the staged rows; the health tables
 * are only ever touched by the confirm step.
 *
 * The upload goes to `/api/health/import` rather than through a server action
 * because an action buffers its whole body in memory and caps it at a few
 * megabytes — an Apple Health export is routinely far larger, and the route
 * streams it to disk instead.
 */
export function ImportWizard({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ImportPreviewResult | null>(null);
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    setOutcome(null);
    setProgress(`Uploading ${formatBytes(file.size)}…`);
    try {
      const response = await fetch("/api/health/import", {
        method: "POST",
        body: file,
        headers: {
          "content-type": "application/octet-stream",
          // Percent-encoded so a name with non-ASCII characters survives as
          // a header; the server takes the base name and nothing else.
          "x-file-name": encodeURIComponent(file.name),
        },
      });
      setProgress("Reading the export on the server…");

      const payload = (await response.json()) as
        | { ok: true; preview: ImportPreviewResult }
        | { ok: false; error: string };

      if (!payload.ok) {
        toast.error(payload.error);
        return;
      }
      setPreview(payload.preview);
      setSelected(new Set(payload.preview.categories.map((category) => category.key)));
      setOpen(true);
    } catch {
      toast.error("The upload did not complete. Nothing was imported.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function toggleCategory(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await confirmHealthImportAction({
        token: preview.token,
        categories: [...selected],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setOutcome(result.data);
      setPreview(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const token = preview?.token;
    setOpen(false);
    setPreview(null);
    setOutcome(null);
    if (token) await cancelHealthImportAction(token);
  }

  function closeAfterDone() {
    setOpen(false);
    setOutcome(null);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Upload />}
          Import health data
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.xml,.csv,application/zip,text/xml,text/csv"
          hidden
          onChange={onFile}
          aria-label="Choose a health export file"
        />
        <a
          className="text-xs text-muted-foreground underline underline-offset-2"
          href="/health-template.csv"
          download
        >
          Download the CSV template
        </a>
        {progress && (
          <span className="text-xs text-muted-foreground" role="status">
            {progress}
          </span>
        )}
      </div>
      {!compact && (
        <p className="mt-2 text-xs text-muted-foreground">
          Apple Health <code>export.zip</code>, <code>export.xml</code> or a CSV. The file is read
          on the server, in your account only, and is deleted the moment the preview is ready —
          nothing is saved to your health records until you confirm.
        </p>
      )}

      <Dialog open={open} onOpenChange={(next) => (!next ? void cancel() : setOpen(true))}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {outcome ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Import complete
                </DialogTitle>
                <DialogDescription>
                  Goals, day scores, the calendar and insights have been recalculated.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <OutcomeStat label="New records" value={outcome.imported} />
                <OutcomeStat label="Refreshed" value={outcome.updated} />
                <OutcomeStat label="Already present" value={outcome.duplicates} />
                <OutcomeStat label="Workouts added" value={outcome.workoutsImported} />
                <OutcomeStat label="Workouts skipped" value={outcome.workoutsSkipped} />
                <OutcomeStat label="Health records" value={outcome.recordsImported} />
                <OutcomeStat label="Days recalculated" value={outcome.recomputedDays} />
              </div>
              <DialogFooter>
                <Button onClick={closeAfterDone}>Done</Button>
              </DialogFooter>
            </>
          ) : preview ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <FileUp className="h-5 w-5" /> Preview — nothing saved yet
                </DialogTitle>
                <DialogDescription>
                  {preview.fileName} · {formatBytes(preview.fileSize)} ·{" "}
                  {formatNumber(preview.examined)} records examined in{" "}
                  {(preview.parseMs / 1000).toFixed(1)}s
                  {preview.dateFrom && preview.dateTo
                    ? ` · ${preview.dateFrom} to ${preview.dateTo}`
                    : ""}
                </DialogDescription>
              </DialogHeader>

              {(preview.warnings.length > 0 || preview.errors.length > 0) && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                  <p className="mb-1 flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Worth knowing
                  </p>
                  <ul className="list-disc space-y-1 pl-4">
                    {[...preview.errors, ...preview.warnings].slice(0, 8).map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Choose what to import</legend>
                {preview.categories.map((category) => (
                  <div key={category.key} className="rounded-lg border p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`cat-${category.key}`}
                        checked={selected.has(category.key)}
                        onCheckedChange={(checked) => toggleCategory(category.key, checked === true)}
                      />
                      <div className="min-w-0 flex-1">
                        <Label htmlFor={`cat-${category.key}`} className="cursor-pointer font-medium">
                          {category.label}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {formatNumber(category.records)} records → {formatNumber(category.rows)}{" "}
                          {category.rows === 1 ? "entry" : "entries"}
                          {category.dateFrom && category.dateTo
                            ? ` · ${category.dateFrom} → ${category.dateTo}`
                            : ""}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                          {category.newRows > 0 && (
                            <Badge variant="muted">{formatNumber(category.newRows)} new</Badge>
                          )}
                          {category.updatedRows > 0 && (
                            <Badge variant="muted">{formatNumber(category.updatedRows)} refreshed</Badge>
                          )}
                          {category.unchangedRows > 0 && (
                            <Badge variant="muted">
                              {formatNumber(category.unchangedRows)} already present
                            </Badge>
                          )}
                        </div>
                        {category.sample.length > 0 && (
                          <details className="mt-1.5">
                            <summary className="cursor-pointer text-[11px] text-muted-foreground">
                              Sample entries
                            </summary>
                            <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                              {category.sample.map((row, index) => (
                                <li key={index} className="tabular">
                                  {row.date} · {formatNumber(row.value, 2)}
                                  {row.unit ? ` ${row.unit}` : ""}
                                  {row.subtype ? ` · ${row.subtype}` : ""}
                                  {row.sourceApp ? ` · ${row.sourceApp}` : ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </fieldset>

              {preview.unsupported.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {formatNumber(preview.unsupported.reduce((sum, entry) => sum + entry.count, 0))}{" "}
                    records of {preview.unsupported.length} unsupported types were skipped
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {preview.unsupported.slice(0, 10).map((entry) => (
                      <li key={entry.type}>
                        {entry.type} × {formatNumber(entry.count)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {preview.invalid > 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatNumber(preview.invalid)} records failed validation and will not be imported.
                </p>
              )}

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={cancel} disabled={busy}>
                  Cancel — import nothing
                </Button>
                <Button onClick={confirm} disabled={busy || selected.size === 0}>
                  {busy && <Loader2 className="animate-spin" />}
                  Import selected
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OutcomeStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
      <p className="tabular text-lg font-semibold leading-none">{formatNumber(value)}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
