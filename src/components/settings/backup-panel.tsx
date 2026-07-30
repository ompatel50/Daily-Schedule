"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, FileJson, Loader2, Upload } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/shared/section-card";
import type { BackupCompatibility, CsvTable } from "@/lib/backup-format";
import { toDayKey } from "@/lib/date";
import { formatNumber } from "@/lib/utils";
import {
  exportBackup,
  exportCsv,
  importBackup,
  previewBackup,
  resetAllData,
} from "@/server/actions/backup";

const CSV_TABLES: Array<{ value: CsvTable; label: string }> = [
  { value: "schedule", label: "Schedule items" },
  { value: "habits", label: "Habit logs" },
  { value: "nutrition", label: "Nutrition entries" },
  { value: "workouts", label: "Workouts" },
  { value: "health", label: "Health metrics" },
];

/**
 * Backup panel. Everything is generated on the server and downloaded straight
 * from the browser — no file ever leaves the machine.
 */
export function BackupPanel() {
  const router = useRouter();
  const [csvTable, setCsvTable] = React.useState<CsvTable>("nutrition");
  const [mode, setMode] = React.useState<"merge" | "replace">("merge");
  const [busy, setBusy] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function download(filename: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function doExportJson() {
    setBusy("json");
    try {
      const result = await exportBackup();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      download(
        `personal-os-backup-${toDayKey(new Date())}.json`,
        JSON.stringify(result.data, null, 2),
        "application/json",
      );
      toast.success("Backup downloaded");
    } finally {
      setBusy(null);
    }
  }

  async function doExportCsv() {
    setBusy("csv");
    try {
      const result = await exportCsv(csvTable);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      download(result.data.filename, result.data.csv, "text/csv");
      toast.success(`${result.data.filename} downloaded`);
    } finally {
      setBusy(null);
    }
  }

  const [pending, setPending] = React.useState<{
    parsed: unknown;
    inspection: BackupCompatibility;
    fileName: string;
  } | null>(null);

  // Step 1: parse and inspect — nothing is written until the preview is
  // confirmed, and the preview says exactly what the file contains.
  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy("import");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await previewBackup(parsed);
      if (!result.ok || !result.data.ok) {
        toast.error(!result.ok ? result.error : (result.data.error ?? "That file cannot be imported"));
        return;
      }
      setPending({ parsed, inspection: result.data, fileName: file.name });
    } catch {
      toast.error("That file isn't valid JSON");
    } finally {
      setBusy(null);
    }
  }

  // Step 2: confirm — a backup of the *current* data downloads first, so even
  // a replace import always leaves a local way back.
  async function confirmImport() {
    if (!pending) return;
    setBusy("import");
    try {
      const safety = await exportBackup();
      if (safety.ok) {
        download(
          `pre-import-backup-${toDayKey(new Date())}.json`,
          JSON.stringify(safety.data),
          "application/json",
        );
      }

      const result = await importBackup(pending.parsed, mode);
      if (result.ok) {
        toast.success(`Imported ${result.data.imported} records`, {
          description:
            result.data.tables.slice(0, 8).join(", ") +
            (result.data.tables.length > 8 ? "…" : ""),
        });
        setPending(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  async function doReset() {
    if (!window.confirm("This permanently deletes every record. Are you sure?")) return;
    if (!window.confirm("Really sure? Export a backup first if you might want this back.")) return;

    setBusy("reset");
    try {
      const result = await resetAllData();
      if (result.ok) {
        toast.success("All data cleared");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Export"
        icon={Download}
        accent="text-domain-planner"
        description="Your data, in a format you own"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium">Full JSON backup</p>
              <p className="text-xs text-muted-foreground">
                Everything, restorable back into this app.
              </p>
            </div>
            <Button onClick={doExportJson} disabled={busy !== null}>
              {busy === "json" ? <Loader2 className="animate-spin" /> : <FileJson />}
              Export JSON
            </Button>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label htmlFor="backup-csv-table">CSV export</Label>
              <Select value={csvTable} onValueChange={(value) => setCsvTable(value as CsvTable)}>
                <SelectTrigger id="backup-csv-table">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CSV_TABLES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={doExportCsv} disabled={busy !== null}>
              {busy === "csv" ? <Loader2 className="animate-spin" /> : <Download />}
              Export CSV
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Import"
        icon={Upload}
        accent="text-domain-habit"
        description="Restore from a JSON backup"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1 space-y-1.5">
            <Label htmlFor="backup-import-mode">Import mode</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "merge" | "replace")}>
              <SelectTrigger id="backup-import-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="merge">Merge — keep existing, add/update</SelectItem>
                <SelectItem value="replace">Replace — wipe first, then import</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            {busy === "import" ? <Loader2 className="animate-spin" /> : <Upload />}
            Choose file
          </Button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          You&apos;ll see what the file contains before anything is written, and a backup of your
          current data downloads automatically first. Records are matched by id, so importing the
          same backup twice won&apos;t create duplicates. The restore runs in one transaction — a
          failure rolls everything back — and day summaries are recomputed afterwards.
        </p>

        <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
            {pending && (
              <>
                <DialogHeader>
                  <DialogTitle>Import this backup?</DialogTitle>
                  <DialogDescription>
                    {pending.fileName} · {formatNumber(pending.inspection.total)} records ·{" "}
                    {mode === "replace"
                      ? "replace mode deletes all current data first"
                      : "merge mode keeps existing records and adds or updates"}
                  </DialogDescription>
                </DialogHeader>

                {pending.inspection.warnings.length > 0 && (
                  <ul className="list-disc space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 pl-7 text-xs">
                    {pending.inspection.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-wrap gap-1">
                  {Object.entries(pending.inspection.counts)
                    .filter(([, count]) => count > 0)
                    .sort(([, a], [, b]) => b - a)
                    .map(([table, count]) => (
                      <Badge key={table} variant="muted" className="text-[10px]">
                        {table} × {formatNumber(count)}
                      </Badge>
                    ))}
                </div>

                <p className="text-xs text-muted-foreground">
                  A backup of your current data downloads automatically before anything is written,
                  and a copy is kept in the system temp folder. A failure rolls the whole import
                  back.
                </p>

                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={() => setPending(null)} disabled={busy !== null}>
                    Cancel — import nothing
                  </Button>
                  <Button
                    variant={mode === "replace" ? "destructive" : "default"}
                    onClick={confirmImport}
                    disabled={busy !== null}
                  >
                    {busy === "import" && <Loader2 className="animate-spin" />}
                    {mode === "replace" ? "Replace my data with this backup" : "Import backup"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </SectionCard>

      <SectionCard title="Danger zone" icon={AlertTriangle} accent="text-destructive">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Delete all data</p>
            <p className="text-xs text-muted-foreground">
              Clears every record in the local database. This cannot be undone.
            </p>
          </div>
          <Button variant="destructive" onClick={doReset} disabled={busy !== null}>
            {busy === "reset" && <Loader2 className="animate-spin" />}
            Reset everything
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
