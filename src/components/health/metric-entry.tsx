"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HEALTH_METRIC_META, MANUAL_ENTRY_METRICS, type HealthMetricType } from "@/lib/enums";
import { displayUnitFor } from "@/lib/logic/health";
import { logHealthMetric } from "@/server/actions/health";

/**
 * Manual health entry. One implementation, two postures: the compact row the
 * Insights sidebar embeds, and the detailed form on the Health page
 * (`withDetails`) that adds the date, an optional time and a note. Both call
 * the same server action; an entry sets the day's manual value for that metric
 * and entering again replaces it.
 */
export function MetricEntry({
  date,
  unitSystem,
  withDetails = false,
}: {
  date: string;
  unitSystem: string;
  withDetails?: boolean;
}) {
  const router = useRouter();
  const [type, setType] = React.useState<HealthMetricType>("steps");
  const [value, setValue] = React.useState("");
  const [entryDate, setEntryDate] = React.useState(date);
  const [time, setTime] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const meta = HEALTH_METRIC_META[type];
  // The same table the server converts through, so the label and the stored
  // value can never disagree about which unit was typed.
  const unitLabel = displayUnitFor(type, unitSystem);

  function submit() {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.error("Enter a number greater than zero");
      return;
    }
    const targetDate = withDetails ? entryDate : date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      toast.error("Pick a date");
      return;
    }

    startTransition(async () => {
      const result = await logHealthMetric({
        date: targetDate,
        type,
        value: numeric,
        time: withDetails && time ? time : null,
        notes: withDetails && notes.trim() ? notes.trim() : null,
      });
      if (result.ok) {
        toast.success(`${meta.label} logged`);
        setValue("");
        setNotes("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[150px] flex-1 space-y-1.5">
          <Label htmlFor="metric-type">Metric</Label>
          <Select value={type} onValueChange={(next) => setType(next as HealthMetricType)}>
            <SelectTrigger id="metric-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MANUAL_ENTRY_METRICS.map((key) => (
                <SelectItem key={key} value={key}>
                  {HEALTH_METRIC_META[key].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-32 space-y-1.5">
          <Label htmlFor="metric-value">Value {unitLabel && `(${unitLabel})`}</Label>
          <Input
            id="metric-value"
            type="number"
            min={0}
            step={meta.decimals > 0 ? 0.1 : 1}
            value={value}
            placeholder={String(meta.typical)}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
        </div>

        {!withDetails && (
          <Button onClick={submit} disabled={pending || !value}>
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            Log
          </Button>
        )}
      </div>

      {withDetails && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40 space-y-1.5">
              <Label htmlFor="metric-date">Date</Label>
              <Input
                id="metric-date"
                type="date"
                value={entryDate}
                max={date}
                onChange={(event) => setEntryDate(event.target.value)}
              />
            </div>
            <div className="w-32 space-y-1.5">
              <Label htmlFor="metric-time">Time (optional)</Label>
              <Input
                id="metric-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
            <div className="min-w-[150px] flex-1 space-y-1.5">
              <Label htmlFor="metric-notes">Note (optional)</Label>
              <Input
                id="metric-notes"
                value={notes}
                maxLength={500}
                placeholder="e.g. after the run"
                onChange={(event) => setNotes(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submit()}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Sets the day&apos;s manual value for the metric — logging again replaces it. Imported
              records are never overwritten.
            </p>
            <Button onClick={submit} disabled={pending || !value}>
              {pending ? <Loader2 className="animate-spin" /> : <Plus />}
              Log
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
