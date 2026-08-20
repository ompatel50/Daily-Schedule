"use client";

import * as React from "react";
import { BellOff, Radar, X } from "lucide-react";
import { toast } from "sonner";

import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ANOMALY_CATEGORIES,
  ANOMALY_WEEKLY_LIMIT,
  CLINICIAN_NOTE,
  type AnomalyCategory,
  type AnomalySignal,
} from "@/lib/logic/anomalies";
import { dismissAnomaly, setAnomalyMuted } from "@/server/actions/anomalies";

/**
 * The anomaly observations surface: what the detectors currently see against
 * the user's own baselines, with the two controls the feature promises —
 * dismiss (which raises that category's future threshold) and per-category
 * mute. Delivery as notifications runs through the reminder ledger
 * separately; this card is the always-visible record, so a nudge missed as
 * a toast is never lost.
 */

const CATEGORY_LABELS: Record<AnomalyCategory, string> = {
  resting_hr: "Resting heart rate",
  sleep_debt: "Sleep",
  habit_streak: "Habit streaks",
  workout_frequency: "Training frequency",
  spending: "Spending",
};

export function ObservationsCard({
  observations,
  ready,
  muted,
}: {
  observations: AnomalySignal[];
  ready: AnomalyCategory[];
  muted: AnomalyCategory[];
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [showMutes, setShowMutes] = React.useState(false);

  async function onDismiss(signal: AnomalySignal) {
    setPending(signal.key);
    const result = await dismissAnomaly({ category: signal.category, key: signal.key });
    setPending(null);
    if (result.ok) {
      toast("Dismissed", {
        description: "Noted — this kind of observation will need a larger deviation to return.",
      });
    } else {
      toast.error(result.error);
    }
  }

  async function onMute(category: AnomalyCategory, value: boolean) {
    const result = await setAnomalyMuted({ category, muted: value });
    if (!result.ok) toast.error(result.error);
  }

  return (
    <SectionCard
      title="Observations"
      icon={Radar}
      accent="text-domain-health"
      description={`Deviations from your own recent baselines — observations, never diagnosis or advice. Capped at ${ANOMALY_WEEKLY_LIMIT} nudges a week.`}
      action={
        <Button variant="ghost" size="sm" onClick={() => setShowMutes((value) => !value)}>
          <BellOff className="mr-1.5 h-3.5 w-3.5" />
          Mute
        </Button>
      }
    >
      {showMutes && (
        <div className="mb-3 grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
          {ANOMALY_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center justify-between gap-3 text-sm">
              <span>{CATEGORY_LABELS[category]}</span>
              <Switch
                defaultChecked={muted.includes(category)}
                onCheckedChange={(value) => void onMute(category, value === true)}
                aria-label={`Mute ${CATEGORY_LABELS[category]} observations`}
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            A muted category is not checked at all until you unmute it.
          </p>
        </div>
      )}

      {observations.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
          {ready.length === 0
            ? "Baselines are still forming — these checks need a few weeks of history before they can say anything about your data."
            : "Nothing unusual against your own baselines right now."}
        </p>
      ) : (
        <div className="space-y-2">
          {observations.map((signal) => (
            <div
              key={signal.key}
              className="flex items-start gap-3 rounded-lg border border-l-[3px] border-l-domain-health/60 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">{signal.title}</p>
                <p className="text-xs text-muted-foreground">
                  {signal.message}
                  {signal.clinicianNote ? ` ${CLINICIAN_NOTE}` : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={pending === signal.key}
                onClick={() => void onDismiss(signal)}
                aria-label={`Dismiss ${signal.title}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
