"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BookmarkPlus,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { MEAL_TYPE_META, MEAL_TYPES, type MealType, type ServingUnit } from "@/lib/enums";
import { shiftDay } from "@/lib/date";
import { formatNumber } from "@/lib/utils";
import {
  deleteMealEntry,
  duplicateMealEntry,
  moveMealEntry,
  saveMealAsTemplate,
  updateMealEntry,
} from "@/server/actions/nutrition";

export interface MealEntryView {
  id: string;
  foodName: string;
  quantity: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Units this food can honestly be measured in — see `lib/logic/servings`. */
  units: string[];
  /** Which meal the entry currently sits in, so "move" knows where it is. */
  mealType: string;
  /** The day it is logged on. */
  date: string;
}

export interface MealView {
  id: string;
  type: string;
  label: string | null;
  entries: MealEntryView[];
  totals: { calories: number; protein: number; carbs: number; fat: number };
}

export function MealList({ meals }: { meals: MealView[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<MealEntryView | null>(null);
  const [savingTemplate, setSavingTemplate] = React.useState<MealView | null>(null);
  const [, startTransition] = React.useTransition();

  if (meals.length === 0) {
    return (
      <EmptyState
        icon={UtensilsCrossed}
        title="Nothing logged yet"
        description="Search for a food above, or apply a meal template."
      />
    );
  }

  function remove(entry: MealEntryView) {
    startTransition(async () => {
      const result = await deleteMealEntry(entry.id);
      // Deleting recomputes the day, the goals, the score and the calendar —
      // one path, in `recomputeDay`, shared with every other nutrition write.
      if (result.ok) router.refresh();
      else toast.error(result.error);
    });
  }

  function move(entry: MealEntryView, to: { mealType?: MealType; date?: string }) {
    startTransition(async () => {
      const result = await moveMealEntry({ id: entry.id, ...to });
      if (result.ok) {
        toast.success(
          to.date ? `Moved to ${to.date}` : `Moved to ${MEAL_TYPE_META[to.mealType as MealType].label.toLowerCase()}`,
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function duplicate(entry: MealEntryView) {
    startTransition(async () => {
      const result = await duplicateMealEntry(entry.id);
      if (result.ok) {
        toast.success(`Duplicated ${entry.foodName}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      {meals.map((meal) => (
        <div key={meal.id} className="overflow-hidden rounded-lg border">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b bg-muted/40 px-3 py-2">
            <p className="min-w-0 truncate text-sm font-semibold">
              {meal.label || MEAL_TYPE_META[meal.type as MealType]?.label || meal.type}
            </p>
            <div className="flex min-w-0 items-center gap-1">
              <span className="tabular min-w-0 truncate text-xs text-muted-foreground">
                {formatNumber(meal.totals.calories)} kcal · P {formatNumber(meal.totals.protein)} · C{" "}
                {formatNumber(meal.totals.carbs)} · F {formatNumber(meal.totals.fat)}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                className="touch-target"
                aria-label="Save as template"
                onClick={() => setSavingTemplate(meal)}
              >
                <BookmarkPlus />
              </Button>
            </div>
          </div>

          <div className="divide-y">
            {meal.entries.map((entry) => (
              <div key={entry.id} className="group flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{entry.foodName}</p>
                  <p className="tabular truncate text-xs text-muted-foreground">
                    {formatNumber(entry.quantity, 2)} {entry.unit} · P{" "}
                    {formatNumber(entry.protein, 1)} · C {formatNumber(entry.carbs, 1)} · F{" "}
                    {formatNumber(entry.fat, 1)}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm font-medium">
                  {formatNumber(entry.calories)}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="touch-target hover-reveal"
                  onClick={() => setEditing(entry)}
                  aria-label="Edit entry"
                >
                  <Pencil />
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="touch-target hover-reveal"
                      aria-label="Entry actions"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onClick={() => setEditing(entry)}>
                      <Pencil /> Edit quantity
                    </DropdownMenuItem>

                    {MEAL_TYPES.filter((type) => type !== entry.mealType).map((type) => (
                      <DropdownMenuItem
                        key={type}
                        onClick={() => move(entry, { mealType: type })}
                      >
                        Move to {MEAL_TYPE_META[type].label.toLowerCase()}
                      </DropdownMenuItem>
                    ))}

                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => move(entry, { date: shiftDay(entry.date, -1) })}>
                      Move to yesterday
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => move(entry, { date: shiftDay(entry.date, 1) })}>
                      Move to tomorrow
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />
                    {/* Deliberate duplication, separate from the accidental
                        kind the idempotency key rejects. */}
                    <DropdownMenuItem onClick={() => duplicate(entry)}>
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onClick={() => remove(entry)}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        </div>
      ))}

      <EditEntryDialog entry={editing} onClose={() => setEditing(null)} />
      <SaveTemplateDialog meal={savingTemplate} onClose={() => setSavingTemplate(null)} />
    </div>
  );
}

function EditEntryDialog({ entry, onClose }: { entry: MealEntryView | null; onClose: () => void }) {
  const router = useRouter();
  const [quantity, setQuantity] = React.useState(1);
  const [unit, setUnit] = React.useState<ServingUnit>("serving");
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!entry) return;
    setQuantity(entry.quantity);
    setUnit(entry.unit as ServingUnit);
  }, [entry]);

  if (!entry) return null;

  function submit() {
    if (!entry) return;
    startTransition(async () => {
      const result = await updateMealEntry({ id: entry.id, quantity, unit });
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
          <DialogTitle>{entry.foodName}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-qty">Quantity</Label>
            <Input
              id="edit-qty"
              type="number"
              min={0.1}
              step={0.25}
              autoFocus
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value) || 0)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit</Label>
            <Select value={unit} onValueChange={(value) => setUnit(value as ServingUnit)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Only what this food converts to. A unit that would need a
                    density we do not have is not offered at all. */}
                {entry.units.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || quantity <= 0}>
            {pending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SaveTemplateDialog({ meal, onClose }: { meal: MealView | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (meal) {
      setName(meal.label || MEAL_TYPE_META[meal.type as MealType]?.label || "");
    }
  }, [meal]);

  if (!meal) return null;

  function submit() {
    if (!meal) return;
    startTransition(async () => {
      const result = await saveMealAsTemplate(meal.id, name);
      if (result.ok) {
        toast.success("Saved as a meal template");
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
          <DialogTitle>Save as template</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="template-name">Name</Label>
          <Input
            id="template-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
            placeholder="Post-workout shake"
          />
          <p className="text-xs text-muted-foreground">
            {meal.entries.length} {meal.entries.length === 1 ? "item" : "items"} will be saved.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending && <Loader2 className="animate-spin" />}
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
