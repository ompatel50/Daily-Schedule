"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Trash2, Utensils } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MEAL_TYPE_META, type MealType } from "@/lib/enums";
import type { TemplateApplyMode } from "@/lib/logic/planner";
import { formatNumber } from "@/lib/utils";
import {
  applyMealTemplate,
  deleteMealTemplate,
  renameMealTemplate,
} from "@/server/actions/nutrition";

export interface MealTemplateSummary {
  id: string;
  name: string;
  mealType: string;
  itemCount: number;
  calories: number;
  useCount: number;
}

/**
 * Saved meals, one click to log.
 *
 * Applying the same template to the same meal twice writes nothing and asks
 * instead — the same four-way choice the planner's routines use, backed by the
 * same `planTemplateApplication` and the same kind of database constraint.
 * Doubling a meal on purpose is a real thing people do, so it stays available;
 * it just has to be chosen.
 */
export function MealTemplateBar({
  date,
  templates,
}: {
  date: string;
  templates: MealTemplateSummary[];
}) {
  const router = useRouter();
  const [applying, setApplying] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<{ template: MealTemplateSummary; existing: number } | null>(
    null,
  );
  const [renaming, setRenaming] = React.useState<MealTemplateSummary | null>(null);
  const [, startTransition] = React.useTransition();

  function apply(template: MealTemplateSummary, mode: TemplateApplyMode) {
    setApplying(template.id);
    startTransition(async () => {
      const result = await applyMealTemplate(template.id, date, undefined, mode);
      setApplying(null);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      if (result.data.status === "duplicate") {
        setConflict({ template, existing: result.data.existing });
        return;
      }

      setConflict(null);
      if (result.data.status === "kept") {
        toast.info("Left as it was");
      } else if (result.data.removed > 0) {
        toast.success(`Replaced ${result.data.removed} items with ${result.data.added}`);
      } else {
        toast.success(`Logged ${result.data.added} items`);
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      {templates.map((template) => (
        <div key={template.id} className="group flex items-center gap-2 rounded-lg border px-3 py-2">
          <Utensils className="h-3.5 w-3.5 shrink-0 text-domain-nutrition" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{template.name}</p>
            <p className="tabular truncate text-xs text-muted-foreground">
              {template.itemCount} items · {formatNumber(template.calories)} kcal ·{" "}
              {MEAL_TYPE_META[template.mealType as MealType]?.label ?? template.mealType}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={applying !== null}
            onClick={() => apply(template, "auto")}
          >
            {applying === template.id && <Loader2 className="animate-spin" />}
            Log
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Rename ${template.name}`}
            className="text-muted-foreground hover-reveal"
            onClick={() => setRenaming(template)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${template.name}`}
            className="text-muted-foreground hover-reveal"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteMealTemplate(template.id);
                if (result.ok) router.refresh();
                else toast.error(result.error);
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Already logged today</DialogTitle>
            <DialogDescription>
              “{conflict?.template.name}” has already put {conflict?.existing}{" "}
              {conflict?.existing === 1 ? "item" : "items"} on this day. Nothing has been changed yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={() => conflict && apply(conflict.template, "keep")}
            >
              Keep what&apos;s there
            </Button>
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={() => conflict && apply(conflict.template, "replace")}
            >
              Replace it with a fresh copy
            </Button>
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={() => conflict && apply(conflict.template, "duplicate")}
            >
              Add another copy on purpose
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflict(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RenameTemplateDialog template={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}

function RenameTemplateDialog({
  template,
  onClose,
}: {
  template: MealTemplateSummary | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (template) setName(template.name);
  }, [template]);

  if (!template) return null;

  function submit() {
    if (!template) return;
    startTransition(async () => {
      const result = await renameMealTemplate(template.id, name);
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename template</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="template-name">Name</Label>
          <Input
            id="template-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
