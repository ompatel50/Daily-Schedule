"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { relativeDayLabel } from "@/lib/date";
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

export function TemplateBar({ date, templates }: { date: string; templates: TemplateSummary[] }) {
  const router = useRouter();
  const [applying, setApplying] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  function apply(template: TemplateSummary) {
    setApplying(template.id);
    startTransition(async () => {
      const result = await applyScheduleTemplate(template.id, date);
      setApplying(null);
      if (result.ok) {
        toast.success(`Added ${result.data.created} items to ${relativeDayLabel(date)}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
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
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => remove(template)}
              aria-label={`Delete ${template.name}`}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
