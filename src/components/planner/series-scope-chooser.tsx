"use client";

import * as React from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/lib/use-is-mobile";
import { cn } from "@/lib/utils";
import type { SeriesScope } from "@/lib/validation";

/**
 * The recurring-item scope question — "how far should this reach?" — asked
 * the moment it matters: saving an edit to, or deleting, one occurrence of a
 * series. Non-recurring items never see this; their save and delete stay one
 * step.
 *
 * On a phone it is a bottom sheet (thumb-reachable, safe-area padded); on
 * desktop a compact centred dialog. Same options, same wording, same
 * semantics either way. Radix supplies focus trapping, Escape and screen-
 * reader wiring; deletion focuses Cancel first so the destructive choice is
 * never the accidental default.
 */

export interface ScopeChoice {
  scope: SeriesScope;
  label: string;
  description: string;
}

export function editScopeChoices(occurrenceLabel: string, ruleChanged: boolean): ScopeChoice[] {
  const choices: ScopeChoice[] = [];
  if (!ruleChanged) {
    choices.push({
      scope: "one",
      label: "This occurrence only",
      description: `Only ${occurrenceLabel} changes. Every other occurrence stays as it is.`,
    });
  }
  choices.push({
    scope: "future",
    label: "This and all future occurrences",
    description: `${occurrenceLabel} onward follows the change. Earlier occurrences keep their history.`,
  });
  if (!ruleChanged) {
    choices.push({
      scope: "all",
      label: "All occurrences",
      description: "Every occurrence in the series, past and future, takes the new details.",
    });
  }
  return choices;
}

export function deleteScopeChoices(occurrenceLabel: string): ScopeChoice[] {
  return [
    {
      scope: "one",
      label: "Delete this occurrence",
      description: `Removes only ${occurrenceLabel}. It stays deleted — the series will not recreate it.`,
    },
    {
      scope: "future",
      label: "Delete this and all future occurrences",
      description: `Ends the series at ${occurrenceLabel}. Earlier occurrences are kept.`,
    },
    {
      scope: "all",
      label: "Delete the entire series",
      description: "Removes every occurrence, including the past. This cannot be undone.",
    },
  ];
}

export function SeriesScopeChooser({
  open,
  onOpenChange,
  mode,
  occurrenceLabel,
  choices,
  note,
  pending = false,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "edit" | "delete";
  /** The selected occurrence's day, e.g. "Tuesday, Aug 18". */
  occurrenceLabel: string;
  choices: ScopeChoice[];
  /** Optional context line — a conflict warning or a rule-change note. */
  note?: string | null;
  pending?: boolean;
  onChoose: (scope: SeriesScope) => void;
}) {
  const isMobile = useIsMobile();
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const title = mode === "delete" ? "Delete recurring item" : "Save recurring item";
  const description = `This item repeats. Choose what ${
    mode === "delete" ? "to delete" : "the change applies to"
  }.`;

  const body = (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
        <span>
          Selected occurrence: <span className="font-medium text-foreground">{occurrenceLabel}</span>
        </span>
      </p>

      {note && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{note}</span>
        </p>
      )}

      <div className="space-y-2" role="group" aria-label="How far should this reach?">
        {choices.map((choice) => (
          <button
            key={choice.scope}
            type="button"
            disabled={pending}
            onClick={() => onChoose(choice.scope)}
            className={cn(
              "block w-full rounded-lg border px-4 py-3 text-left transition-colors",
              "min-h-[3.25rem] disabled:opacity-60",
              mode === "delete"
                ? "border-destructive/30 text-destructive hover:bg-destructive/10 focus-visible:ring-destructive"
                : "hover:bg-accent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <span className="block text-sm font-medium">{choice.label}</span>
            <span
              className={cn(
                "mt-0.5 block text-xs",
                mode === "delete" ? "text-destructive/80" : "text-muted-foreground",
              )}
            >
              {choice.description}
            </span>
          </button>
        ))}
      </div>

      <Button
        ref={cancelRef}
        type="button"
        variant="outline"
        className="h-11 w-full"
        disabled={pending}
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
    </div>
  );

  // Deleting must never have a destructive default: focus starts on Cancel.
  const focusCancel = (event: Event) => {
    if (mode !== "delete") return;
    event.preventDefault();
    cancelRef.current?.focus();
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" onOpenAutoFocus={focusCancel} aria-describedby={undefined}>
          <SheetHeader className="text-left">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="px-1 pb-1 pt-3">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" onOpenAutoFocus={focusCancel}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
