"use client";

import * as React from "react";
import { FileUp, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { formatDay } from "@/lib/date";

/** One CSV import run, as the page serialises it for the history list. */
export interface ImportBatchView {
  id: string;
  fileName: string;
  accountName: string | null;
  importedDay: string;
  createdCount: number;
  skippedCount: number;
  rejectedCount: number;
  /** Ledger rows still linked to this batch right now. */
  remainingCount: number;
  undone: boolean;
  undoneCount: number;
  keptCount: number;
}

/**
 * The CSV import history — the surface undo hangs off. Bounded to the most
 * recent runs; an import that has been rolled back stays listed (as an audit
 * record) rather than disappearing.
 */
export function ImportBatchesSection({
  batches,
  onUndo,
}: {
  batches: ImportBatchView[];
  onUndo: (batch: ImportBatchView) => void;
}) {
  return (
    <SectionCard
      title="CSV imports"
      icon={FileUp}
      accent="text-domain-finance"
      description="Every import run, and how to roll one back"
    >
      {batches.length === 0 ? (
        <EmptyState
          icon={FileUp}
          title="No imports yet"
          description="Import a CSV from an account's menu — you can undo it here afterwards."
          className="py-6"
        />
      ) : (
        <div className="space-y-2">
          {batches.map((batch) => (
            <ImportBatchRow key={batch.id} batch={batch} onUndo={() => onUndo(batch)} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ImportBatchRow({ batch, onUndo }: { batch: ImportBatchView; onUndo: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{batch.fileName}</p>
          {batch.undone && (
            <Badge variant="muted" className="gap-1 text-[10px]">
              <Undo2 className="h-2.5 w-2.5" aria-hidden="true" />
              Undone
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatDay(batch.importedDay)}
          {batch.accountName ? ` · ${batch.accountName}` : ""} · {batch.createdCount} imported
          {batch.skippedCount > 0 ? `, ${batch.skippedCount} skipped` : ""}
          {batch.rejectedCount > 0 ? `, ${batch.rejectedCount} rejected` : ""}
          {batch.undone
            ? ` · ${batch.undoneCount} removed${batch.keptCount > 0 ? `, ${batch.keptCount} kept` : ""}`
            : ""}
        </p>
      </div>
      {!batch.undone && batch.remainingCount > 0 && (
        <Button size="sm" variant="outline" onClick={onUndo}>
          <Undo2 /> Undo
        </Button>
      )}
    </div>
  );
}
