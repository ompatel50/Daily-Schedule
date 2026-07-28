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
import { HEALTH_METRIC_META, HEALTH_METRIC_TYPES, type HealthMetricType } from "@/lib/enums";
import { logHealthMetric } from "@/server/actions/health";

/** Compact manual entry for any health metric — one row, two fields, done. */
export function MetricEntry({ date, unitSystem }: { date: string; unitSystem: string }) {
  const router = useRouter();
  const [type, setType] = React.useState<HealthMetricType>("steps");
  const [value, setValue] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const meta = HEALTH_METRIC_META[type];
  const unitLabel =
    type === "body_weight" ? (unitSystem === "metric" ? "kg" : "lb") : meta.unit;

  function submit() {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.error("Enter a number greater than zero");
      return;
    }

    startTransition(async () => {
      const result = await logHealthMetric({ date, type, value: numeric });
      if (result.ok) {
        toast.success(`${meta.label} logged`);
        setValue("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[150px] flex-1 space-y-1.5">
        <Label>Metric</Label>
        <Select value={type} onValueChange={(next) => setType(next as HealthMetricType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HEALTH_METRIC_TYPES.filter((key) => key !== "mood" && key !== "energy").map((key) => (
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

      <Button onClick={submit} disabled={pending || !value}>
        {pending ? <Loader2 className="animate-spin" /> : <Plus />}
        Log
      </Button>
    </div>
  );
}
