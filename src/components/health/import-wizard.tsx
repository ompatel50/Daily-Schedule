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
import { Progress } from "@/components/ui/progress";
import { stageHealthFile, type UploadStage } from "@/lib/health/staged-upload";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import {
  cancelHealthImportAction,
  confirmHealthImportAction,
} from "@/server/actions/health-import";
import type { ImportOutcome, ImportPreviewResult } from "@/server/health-import";

/**
 * The staged import: pick a file → it uploads **in parts** → the server
 * reassembles and parses it → a server-checked preview (nothing written) →
 * choose what to bring in → confirm → results. Cancelling discards the staged
 * rows; the health tables are only ever touched by the confirm step.
 *
 * The file is never sent as one request body. It used to be, and on a hosting
 * platform that failed at the edge with `413 FUNCTION_PAYLOAD_TOO_LARGE`
 * before any of this app's code ran — an Apple Health export is one to three
 * orders of magnitude larger than a serverless request may carry. The parts,
 * the retries and the bounds live in `@/lib/health/staged-upload`; this
 * component only renders where the upload has got to.
 *
 * The stages are shown rather than summarised in one spinner, because they take
 * meaningfully different amounts of time — minutes of upload, then seconds of
 * parsing — and a user watching a single "working…" has no way to tell a slow
 * upload from a hung one.
 */

/** The stages, in the order they happen, as the user sees them. */
const STAGE_ORDER: ReadonlyArray<{ key: UploadStage; label: string }> = [
  { key: "preparing", label: "Staging" },
  { key: "uploading", label: "Upload" },
  { key: "parsing", label: "Parsing" },
  { key: "preview", label: "Preview" },
  { key: "importing", label: "Import" },
  { key: "done", label: "Summary" },
];

export function ImportWizard({
  compact = false,
  limitNote,
}: {
  compact?: boolean;
  /** What this deployment will actually accept, resolved on the server. */
  limitNote?: string;
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<UploadStage>("idle");
  const [uploaded, setUploaded] = React.useState({ sent: 0, total: 0, parts: 0, totalParts: 0 });
  const [fileLabel, setFileLabel] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ImportPreviewResult | null>(null);
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  /**
   * An upload in flight when the page goes away is an upload nobody is waiting
   * for: abort it so its staged parts are dropped now rather than at expiry.
   *
   * Both halves are needed. Unmount covers navigating within the app; it does
   * **not** run when the tab is closed or the browser is quit, which is the
   * common way an upload is abandoned. `pagehide` covers that (and, unlike
   * `beforeunload`, fires on mobile Safari's bfcache path too). The abort makes
   * the upload client send its `keepalive` DELETE, which is the part that
   * actually outlives the document — otherwise the account keeps paying for a
   * slot it is no longer using.
   */
  React.useEffect(() => {
    const abandon = () => abortRef.current?.abort();
    window.addEventListener("pagehide", abandon);
    return () => {
      window.removeEventListener("pagehide", abandon);
      abandon();
    };
  }, []);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setOutcome(null);
    setFileLabel(`${file.name} · ${formatBytes(file.size)}`);
    setStage("preparing");
    setUploaded({ sent: 0, total: file.size, parts: 0, totalParts: 0 });

    const result = await stageHealthFile(file, {
      signal: controller.signal,
      onProgress: (progress) => {
        setStage(progress.stage);
        setUploaded({
          sent: progress.sent,
          total: progress.total,
          parts: progress.parts,
          totalParts: progress.totalParts,
        });
      },
    });

    abortRef.current = null;
    setBusy(false);

    if (!result.ok) {
      setStage("idle");
      setFileLabel(null);
      // A cancellation is the user's own doing; saying so as an error is noise.
      if (!result.cancelled) toast.error(result.error);
      return;
    }

    setStage("preview");
    setPreview(result.preview);
    setSelected(new Set(result.preview.categories.map((category) => category.key)));
    setOpen(true);
  }

  function cancelUpload() {
    abortRef.current?.abort();
    abortRef.current = null;
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
    setStage("importing");
    try {
      const result = await confirmHealthImportAction({
        token: preview.token,
        categories: [...selected],
      });
      if (!result.ok) {
        setStage("preview");
        toast.error(result.error);
        return;
      }
      setOutcome(result.data);
      setPreview(null);
      setStage("done");
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
    setStage("idle");
    setFileLabel(null);
    if (token) await cancelHealthImportAction(token);
  }

  function closeAfterDone() {
    setOpen(false);
    setOutcome(null);
    setStage("idle");
    setFileLabel(null);
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
      </div>

      {stage !== "idle" && (
        <StagePanel
          stage={stage}
          fileLabel={fileLabel}
          uploaded={uploaded}
          onCancel={busy && (stage === "preparing" || stage === "uploading") ? cancelUpload : null}
        />
      )}

      {!compact && (
        <p className="mt-2 text-xs text-muted-foreground">
          Apple Health <code>export.zip</code>, <code>export.xml</code> or a CSV. The file is sent in
          parts, reassembled and read on the server, in your account only, and every part is deleted
          the moment the preview is ready — nothing is saved to your health records until you
          confirm.
          {limitNote ? ` ${limitNote}` : ""}
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
                <OutcomeStat label="Merged" value={outcome.updated} />
                <OutcomeStat label="Already present" value={outcome.duplicates} />
                <OutcomeStat label="Kept as yours" value={outcome.protectedRows} />
                <OutcomeStat label="Workouts added" value={outcome.workoutsImported} />
                <OutcomeStat label="Workouts skipped" value={outcome.workoutsSkipped} />
                <OutcomeStat label="Health records" value={outcome.recordsImported} />
                <OutcomeStat label="Days recalculated" value={outcome.recomputedDays} />
              </div>
              {outcome.protectedRows > 0 && (
                <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {formatNumber(outcome.protectedRows)} reading
                    {outcome.protectedRows === 1 ? "" : "s"} were left exactly as they were.
                  </span>{" "}
                  You had edited them since importing, or entered them yourself — the file&rsquo;s
                  values for those days were not written over.
                </p>
              )}
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
                        {/* Added vs merged vs skipped vs protected, per
                            category, before anything is written. */}
                        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                          {category.newRows > 0 && (
                            <Badge variant="muted">{formatNumber(category.newRows)} new</Badge>
                          )}
                          {category.updatedRows > 0 && (
                            <Badge variant="muted">{formatNumber(category.updatedRows)} merged</Badge>
                          )}
                          {category.unchangedRows > 0 && (
                            <Badge variant="muted">
                              {formatNumber(category.unchangedRows)} already present
                            </Badge>
                          )}
                          {category.protectedRows > 0 && (
                            <Badge variant="outline" title="Left exactly as they are">
                              {formatNumber(category.protectedRows)} kept as yours
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

/** What each stage is actually doing, in the user's terms. */
const STAGE_DETAIL: Record<UploadStage, string> = {
  idle: "",
  preparing: "Preparing the upload…",
  uploading: "Uploading in parts — no single request is large enough to be refused.",
  parsing: "Reassembling and reading the export on the server…",
  preview: "Ready to preview. Nothing has been saved yet.",
  importing: "Writing the selected categories…",
  done: "Import complete.",
};

/**
 * Where the upload has got to.
 *
 * Rendered as named steps rather than one spinner because the stages take
 * genuinely different amounts of time: uploading a large export is minutes,
 * parsing it is seconds. A single "working…" leaves a user unable to tell a
 * slow upload from a stuck one, which is precisely the confusion this whole
 * change exists to remove.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader is told when a
 * stage changes without the announcement interrupting anything.
 */
function StagePanel({
  stage,
  fileLabel,
  uploaded,
  onCancel,
}: {
  stage: UploadStage;
  fileLabel: string | null;
  uploaded: { sent: number; total: number; parts: number; totalParts: number };
  onCancel: (() => void) | null;
}) {
  const current = STAGE_ORDER.findIndex((entry) => entry.key === stage);
  const percent = uploaded.total > 0 ? Math.round((uploaded.sent / uploaded.total) * 100) : 0;

  return (
    <div
      className="mt-3 rounded-lg border bg-muted/30 p-3"
      role="status"
      aria-live="polite"
      data-testid="import-stage"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="truncate text-xs font-medium">{fileLabel ?? "Health export"}</p>
        {onCancel && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
            Cancel upload
          </Button>
        )}
      </div>

      <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
        {STAGE_ORDER.map((entry, index) => (
          <li key={entry.key} className="flex items-center gap-1.5">
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                index < current && "text-muted-foreground",
                index === current && "bg-primary/10 font-medium text-foreground",
                index > current && "text-muted-foreground/50",
              )}
              aria-current={index === current ? "step" : undefined}
            >
              {entry.label}
            </span>
            {index < STAGE_ORDER.length - 1 && (
              <span aria-hidden className="text-muted-foreground/40">
                →
              </span>
            )}
          </li>
        ))}
      </ol>

      {stage === "uploading" && uploaded.totalParts > 0 && (
        <div className="mt-2 space-y-1">
          <Progress value={percent} className="h-1.5" />
          <p className="tabular text-[11px] text-muted-foreground">
            {formatBytes(uploaded.sent)} of {formatBytes(uploaded.total)} · part{" "}
            {formatNumber(Math.min(uploaded.parts + 1, uploaded.totalParts))} of{" "}
            {formatNumber(uploaded.totalParts)} · {percent}%
          </p>
        </div>
      )}

      <p className="mt-1.5 text-[11px] text-muted-foreground">{STAGE_DETAIL[stage]}</p>
    </div>
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
