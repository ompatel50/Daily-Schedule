"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Rocket, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionCard } from "@/components/shared/section-card";
import {
  checklistProgress,
  ONBOARDING_STEPS,
  type OnboardingState,
} from "@/lib/logic/onboarding";
import {
  loadSampleDataAction,
  setOnboardingStepAction,
  setOnboardingVisibilityAction,
} from "@/server/actions/demo";

/**
 * The optional first-run checklist. Steps are ticked by hand and the whole
 * card is dismissible; when the database is empty it also offers the
 * sample-data start. Rendered only while not dismissed.
 */
export function OnboardingCard({
  state,
  canLoadSample,
}: {
  state: OnboardingState;
  canLoadSample: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const progress = checklistProgress(state);
  const done = new Set(state.done);

  async function toggle(stepId: string, next: boolean) {
    setBusy(stepId);
    try {
      await setOnboardingStepAction({ stepId, done: next });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy("dismiss");
    try {
      await setOnboardingVisibilityAction(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function loadSample() {
    setBusy("sample");
    try {
      const result = await loadSampleDataAction();
      if (result.ok) {
        toast.success("Sample data loaded", {
          description: "Explore freely — Settings → Sample data removes it again in one step.",
        });
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <SectionCard
      title={`Getting started · ${progress.done} of ${progress.total}`}
      icon={Rocket}
      accent="text-amber-500"
      description="Optional — tick things off as you set the app up, or dismiss this"
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          disabled={busy !== null}
          aria-label="Dismiss the getting-started checklist"
        >
          {busy === "dismiss" ? <Loader2 className="animate-spin" /> : <X />}
        </Button>
      }
      className="mb-6"
    >
      {canLoadSample && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Start with sample data?</p>
            <p className="text-xs text-muted-foreground">
              Ten weeks of realistic demo history to explore. Clearly separated from your own
              records, removable again in one step.
            </p>
          </div>
          <Button size="sm" onClick={loadSample} disabled={busy !== null}>
            {busy === "sample" && <Loader2 className="animate-spin" />}
            Load sample data
          </Button>
        </div>
      )}

      <ul className="grid gap-1.5 sm:grid-cols-2">
        {ONBOARDING_STEPS.map((step) => (
          <li key={step.id} className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
            <Checkbox
              id={`onboarding-${step.id}`}
              checked={done.has(step.id)}
              disabled={busy !== null}
              onCheckedChange={(checked) => toggle(step.id, checked === true)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <label
                htmlFor={`onboarding-${step.id}`}
                className={
                  done.has(step.id)
                    ? "cursor-pointer text-sm font-medium text-muted-foreground line-through"
                    : "cursor-pointer text-sm font-medium"
                }
              >
                {step.label}
              </label>
              <p className="text-xs text-muted-foreground">{step.detail}</p>
            </div>
            <Button asChild variant="ghost" size="sm" className="shrink-0">
              <Link href={step.href} aria-label={`Go to ${step.label}`}>
                <ArrowRight />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
