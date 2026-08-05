"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CopyPlus, Loader2, RefreshCw, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { relativeDayLabel } from "@/lib/date";
import type { TemplateApplyMode } from "@/lib/logic/planner";
import { cn } from "@/lib/utils";
import { applyScheduleTemplate, deleteScheduleTemplate } from "@/server/actions/planner";

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  category: string;
  itemCount: number;
  useCount: number;
}

/** The routine is already on this day — what the user is being asked about. */
interface DuplicatePrompt {
  templateId: string;
  templateName: string;
  existing: number;
  itemCount: number;
}

export function TemplateBar({ date, templates }: { date: string; templates: TemplateSummary[] }) {
  const router = useRouter();
  const [applying, setApplying] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState<DuplicatePrompt | null>(null);
  const [, startTransition] = React.useTransition();

  function apply(template: TemplateSummary, mode: TemplateApplyMode = "auto") {
    setApplying(template.id);
    startTransition(async () => {
      const result = await applyScheduleTemplate(template.id, date, mode);
      setApplying(null);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      // Already on this day: nothing was written, so ask instead of doubling it.
      if (result.data.status === "duplicate") {
        setPrompt({
          templateId: template.id,
          templateName: result.data.templateName,
          existing: result.data.existing,
          itemCount: result.data.itemCount,
        });
        return;
      }

      setPrompt(null);

      if (result.data.status === "unchanged") {
        toast.info(`${template.name} is already on ${relativeDayLabel(date)}`);
        return;
      }

      const { created, removed } = result.data;
      toast.success(
        removed > 0
          ? `Replaced ${removed} with ${created} items on ${relativeDayLabel(date)}`
          : `Added ${created} items to ${relativeDayLabel(date)}`,
      );
      router.refresh();
    });
  }

  function resolve(mode: TemplateApplyMode) {
    if (!prompt) return;
    const template = templates.find((candidate) => candidate.id === prompt.templateId);
    if (!template) {
      setPrompt(null);
      return;
    }
    apply(template, mode);
  }

  function remove(template: TemplateSummary) {
    startTransition(async () => {
      const result = await deleteScheduleTemplate(template.id);
      if (result.ok) {
        toast.success("Routine deleted");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {templates.map((template) => {
          const meta = CATEGORY_META[template.category as ScheduleCategory] ?? CATEGORY_META.personal;
          return (
            <div
              key={template.id}
              className={cn("group flex items-center gap-2 rounded-lg border border-l-[3px] px-3 py-2", meta.bar)}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{template.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {template.itemCount} {template.itemCount === 1 ? "item" : "items"}
                  {template.useCount > 0 ? ` · used ${template.useCount}×` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => apply(template)}
                disabled={applying !== null}
              >
                {applying === template.id ? <Loader2 className="animate-spin" /> : <Wand2 />}
                Apply
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover-reveal"
                onClick={() => remove(template)}
                aria-label={`Delete ${template.name}`}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
      </div>

      <Dialog open={prompt !== null} onOpenChange={(open) => !open && setPrompt(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Already applied</DialogTitle>
            <DialogDescription>
              {prompt
                ? `“${prompt.templateName}” already has ${prompt.existing} ${
                    prompt.existing === 1 ? "item" : "items"
                  } on ${relativeDayLabel(date)}. Nothing has been changed yet.`
                : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 py-3 text-left"
              onClick={() => resolve("keep")}
              disabled={applying !== null}
            >
              <Wand2 className="shrink-0" />
              <span>
                <span className="block text-sm font-medium">Keep what&rsquo;s there</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  Leave the day exactly as it is.
                </span>
              </span>
            </Button>

            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 py-3 text-left"
              onClick={() => resolve("replace")}
              disabled={applying !== null}
            >
              <RefreshCw className="shrink-0" />
              <span>
                <span className="block text-sm font-medium">Replace with a fresh copy</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  Removes the {prompt?.existing} existing {prompt?.existing === 1 ? "item" : "items"}{" "}
                  and applies the routine again.
                </span>
              </span>
            </Button>

            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 py-3 text-left"
              onClick={() => resolve("duplicate")}
              disabled={applying !== null}
            >
              <CopyPlus className="shrink-0" />
              <span>
                <span className="block text-sm font-medium">Add another copy anyway</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  Adds {prompt?.itemCount} more {prompt?.itemCount === 1 ? "item" : "items"} on top.
                </span>
              </span>
            </Button>

            <Button
              variant="ghost"
              className="h-auto w-full justify-start gap-3 py-3 text-left"
              onClick={() => setPrompt(null)}
              disabled={applying !== null}
            >
              <X className="shrink-0" />
              <span className="text-sm font-medium">Cancel</span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
