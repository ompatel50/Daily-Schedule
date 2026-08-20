"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  History,
  Pencil,
  Play,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { RuleBuilderDialog } from "@/components/automation/rule-builder-dialog";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { StarterRule } from "@/lib/logic/automation-library";
import type { AutomationExecutionView, AutomationRuleView, DryRunResult } from "@/server/automation";
import {
  deleteAutomationRule,
  dryRunAutomationRule,
  listAutomationExecutions,
  saveAutomationRule,
  setAutomationRuleEnabled,
  undoAutomationExecution,
  undoAutomationRuleExecutions,
} from "@/server/actions/automation";

/**
 * The rules surface: the user's rules with their plain-language summaries,
 * enable switches (guarded server-side by the mandatory dry run), per-rule
 * execution history with undo, and the starter library — templates that
 * are added DISABLED and only run once reviewed and dry-run.
 */
export function RulesBoard({
  rules,
  starters,
}: {
  rules: AutomationRuleView[];
  starters: readonly StarterRule[];
}) {
  const router = useRouter();
  const [building, setBuilding] = React.useState<AutomationRuleView | "new" | null>(null);
  const [preview, setPreview] = React.useState<{ rule: AutomationRuleView; result: DryRunResult } | null>(null);
  const [history, setHistory] = React.useState<{
    rule: AutomationRuleView;
    entries: AutomationExecutionView[];
  } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(null);

  async function onToggle(rule: AutomationRuleView, enabled: boolean) {
    const result = await setAutomationRuleEnabled(rule.id, enabled);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast(enabled ? "Rule enabled" : "Rule disabled");
    router.refresh();
  }

  async function onDryRun(rule: AutomationRuleView) {
    const result = await dryRunAutomationRule(rule.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setPreview({ rule, result: result.data });
    router.refresh();
  }

  async function onHistory(rule: AutomationRuleView) {
    const result = await listAutomationExecutions(rule.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setHistory({ rule, entries: result.data });
  }

  async function onDelete(rule: AutomationRuleView) {
    if (confirmingDelete !== rule.id) {
      setConfirmingDelete(rule.id);
      return;
    }
    const result = await deleteAutomationRule(rule.id);
    setConfirmingDelete(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast("Rule deleted");
    router.refresh();
  }

  async function onAddStarter(starter: StarterRule) {
    const result = await saveAutomationRule({
      name: starter.name,
      trigger: starter.trigger,
      conditions: starter.conditions,
      actions: starter.actions,
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast("Added to your rules — review it and run the dry run before enabling.");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="Your rules"
        icon={Play}
        accent="text-domain-goal"
        description="Rules never delete anything, log every run, and can be undone from their history. A rule only enables after its dry run."
        action={
          <Button size="sm" onClick={() => setBuilding("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New rule
          </Button>
        }
      >
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No rules yet. Build one, or start from a template below.
          </p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className="rounded-lg border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</p>
                  {rule.lastStatus && (
                    <Badge variant="outline" className="text-[10px]">
                      last run: {rule.lastStatus}
                      {rule.lastRunAt ? ` · ${new Date(rule.lastRunAt).toLocaleDateString()}` : ""}
                    </Badge>
                  )}
                  {!rule.reviewed && (
                    <Badge variant="outline" className="gap-1 text-[10px] text-amber-600">
                      <CircleDashed className="h-3 w-3" /> needs dry run
                    </Badge>
                  )}
                  {rule.enabled && (
                    <Badge variant="outline" className="gap-1 text-[10px] text-emerald-600">
                      <CircleCheck className="h-3 w-3" /> on
                    </Badge>
                  )}
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(value) => void onToggle(rule, value === true)}
                    aria-label={`Enable ${rule.name}`}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{rule.summary}</p>
                {rule.disabledReason && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {rule.disabledReason}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => void onDryRun(rule)}>
                    <Play className="mr-1 h-3 w-3" /> Dry run
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setBuilding(rule)}>
                    <Pencil className="mr-1 h-3 w-3" /> Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void onHistory(rule)}>
                    <History className="mr-1 h-3 w-3" /> History ({rule.executionCount})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={confirmingDelete === rule.id ? "border-red-500 text-red-600" : ""}
                    onClick={() => void onDelete(rule)}
                    onBlur={() => setConfirmingDelete(null)}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    {confirmingDelete === rule.id ? "Really delete?" : "Delete"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Starter library"
        icon={Plus}
        accent="text-muted-foreground"
        description="Optional templates. Adding one stores it disabled — edit it, run the dry run, then enable."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {starters.map((starter) => (
            <div key={starter.key} className="flex flex-col rounded-lg border px-3 py-2.5">
              <p className="text-sm font-medium">{starter.name}</p>
              <p className="mt-0.5 flex-1 text-xs text-muted-foreground">{starter.blurb}</p>
              {starter.editHint && (
                <p className="mt-1 text-xs text-muted-foreground">Before enabling: {starter.editHint}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="mt-2 self-start"
                onClick={() => void onAddStarter(starter)}
              >
                <Plus className="mr-1 h-3 w-3" /> Add to my rules
              </Button>
            </div>
          ))}
        </div>
      </SectionCard>

      <RuleBuilderDialog
        open={building !== null}
        onOpenChange={(open) => {
          if (!open) setBuilding(null);
        }}
        initial={building === "new" ? null : building}
        onSaved={() => {
          setBuilding(null);
          router.refresh();
        }}
      />

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Dry run · {preview?.rule.name}</DialogTitle>
            <DialogDescription>
              What this rule would have done over the last {preview?.result.windowDays} days of
              your real data. Nothing was written.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {preview.result.samples} candidates examined · {preview.result.matches.length}{" "}
                would have matched
              </p>
              {preview.result.matches.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  No matches in the window. The rule can still be enabled — it simply hasn't had
                  anything to act on recently.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {preview.result.matches.map((match, index) => (
                    <li key={index} className="rounded-lg border px-3 py-2 text-xs">
                      <p className="font-medium">{match.when}</p>
                      <p className="text-muted-foreground">{match.matched}</p>
                      {match.actions.map((action, actionIndex) => (
                        <p key={actionIndex} className="text-muted-foreground">
                          → {action}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
              <Button
                className="w-full"
                onClick={async () => {
                  await onToggle(preview.rule, true);
                  setPreview(null);
                }}
              >
                Enable this rule
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={history !== null} onOpenChange={(open) => !open && setHistory(null)}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>History · {history?.rule.name}</DialogTitle>
            <DialogDescription>
              Every run: what triggered it, what matched, what was done. Undo puts created records
              in the Trash and restores changed fields.
            </DialogDescription>
          </DialogHeader>
          {history && (
            <div className="space-y-2">
              {history.entries.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  This rule hasn't run yet.
                </p>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const result = await undoAutomationRuleExecutions(history.rule.id);
                      if (result.ok) {
                        toast(`Undid ${result.data.undone} run${result.data.undone === 1 ? "" : "s"}`);
                        setHistory(null);
                        router.refresh();
                      } else {
                        toast.error(result.error);
                      }
                    }}
                  >
                    <Undo2 className="mr-1 h-3 w-3" /> Undo all
                  </Button>
                  <ul className="space-y-1.5">
                    {history.entries.map((entry) => (
                      <li key={entry.id} className="rounded-lg border px-3 py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">
                            {new Date(entry.firedAt).toLocaleString()} · {entry.status}
                          </p>
                          {entry.status === "success" && !entry.undoneAt && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={async () => {
                                const result = await undoAutomationExecution(entry.id);
                                if (result.ok) {
                                  toast("Undone");
                                  setHistory(null);
                                  router.refresh();
                                } else {
                                  toast.error(result.error);
                                }
                              }}
                            >
                              <Undo2 className="mr-1 h-3 w-3" /> Undo
                            </Button>
                          )}
                        </div>
                        {entry.matched && <p className="text-muted-foreground">{entry.matched}</p>}
                        {entry.outcomes.map((outcome, index) => (
                          <p key={index} className="text-muted-foreground">
                            → {outcome.summary}
                          </p>
                        ))}
                        {entry.error && <p className="text-red-600">{entry.error}</p>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
