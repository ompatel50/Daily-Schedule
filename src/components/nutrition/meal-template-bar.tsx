"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2, Utensils } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { MEAL_TYPE_META, type MealType } from "@/lib/enums";
import { formatNumber } from "@/lib/utils";
import { applyMealTemplate, deleteMealTemplate } from "@/server/actions/nutrition";

export interface MealTemplateSummary {
  id: string;
  name: string;
  mealType: string;
  itemCount: number;
  calories: number;
  useCount: number;
}

export function MealTemplateBar({
  date,
  templates,
}: {
  date: string;
  templates: MealTemplateSummary[];
}) {
  const router = useRouter();
  const [applying, setApplying] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

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
            onClick={() => {
              setApplying(template.id);
              startTransition(async () => {
                const result = await applyMealTemplate(template.id, date);
                setApplying(null);
                if (result.ok) {
                  toast.success(`Logged ${result.data.added} items`);
                  router.refresh();
                } else {
                  toast.error(result.error);
                }
              });
            }}
          >
            {applying === template.id && <Loader2 className="animate-spin" />}
            Log
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${template.name}`}
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
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
    </div>
  );
}
