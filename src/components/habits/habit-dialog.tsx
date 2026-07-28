"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Trash2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  HABIT_CATEGORIES,
  HABIT_CATEGORY_META,
  TIMES_OF_DAY,
  TIME_OF_DAY_META,
  type HabitCategory,
  type TimeOfDay,
} from "@/lib/enums";
import { WEEKDAY_LABELS, today } from "@/lib/date";
import { cn } from "@/lib/utils";
import { archiveHabit, deleteHabit, saveHabit } from "@/server/actions/habits";

export interface HabitDraft {
  id?: string;
  name: string;
  description: string | null;
  category: string;
  timeOfDay: string;
  frequency: string;
  weekdays: number[];
  targetPerWeek: number;
  startDate: string;
  archived: boolean;
}

export function HabitDialog({
  open,
  onOpenChange,
  habit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  habit?: HabitDraft | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(habit?.id);
  const [pending, startTransition] = React.useTransition();

  const [form, setForm] = React.useState<HabitDraft>({
    name: "",
    description: null,
    category: "health",
    timeOfDay: "anytime",
    frequency: "daily",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    targetPerWeek: 7,
    startDate: today(),
    archived: false,
  });

  React.useEffect(() => {
    if (!open) return;
    setForm(
      habit ?? {
        name: "",
        description: null,
        category: "health",
        timeOfDay: "anytime",
        frequency: "daily",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        targetPerWeek: 7,
        startDate: today(),
        archived: false,
      },
    );
  }, [open, habit]);

  function set<K extends keyof HabitDraft>(key: K, value: HabitDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    startTransition(async () => {
      const result = await saveHabit({ ...form, name: form.name.trim() });
      if (result.ok) {
        toast.success(isEdit ? "Habit updated" : "Habit created");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(message);
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit habit" : "New habit"}</DialogTitle>
          <DialogDescription>
            Habits attached to a part of the day are easier to actually do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="habit-name">Name</Label>
            <Input
              id="habit-name"
              autoFocus
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              placeholder="Read 20 pages"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(value) => set("category", value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HABIT_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {HABIT_CATEGORY_META[value as HabitCategory].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Time of day</Label>
              <Select value={form.timeOfDay} onValueChange={(value) => set("timeOfDay", value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMES_OF_DAY.map((value) => (
                    <SelectItem key={value} value={value}>
                      {TIME_OF_DAY_META[value as TimeOfDay].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <Label>Repeats</Label>
            <Select
              value={form.frequency}
              onValueChange={(value) => {
                set("frequency", value);
                if (value === "daily") set("weekdays", [0, 1, 2, 3, 4, 5, 6]);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Every day</SelectItem>
                <SelectItem value="custom">Specific days</SelectItem>
                <SelectItem value="weekly">A number of times per week</SelectItem>
              </SelectContent>
            </Select>

            {form.frequency === "custom" && (
              <div className="flex flex-wrap gap-1 pt-1">
                {WEEKDAY_LABELS.map((label, index) => {
                  const active = form.weekdays.includes(index);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() =>
                        set(
                          "weekdays",
                          active
                            ? form.weekdays.filter((day) => day !== index)
                            : [...form.weekdays, index],
                        )
                      }
                      className={cn(
                        "h-8 w-10 rounded-md border text-xs font-medium transition-colors",
                        active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                      )}
                    >
                      {label.slice(0, 2)}
                    </button>
                  );
                })}
              </div>
            )}

            {form.frequency === "weekly" && (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  type="number"
                  min={1}
                  max={7}
                  value={form.targetPerWeek}
                  onChange={(event) => set("targetPerWeek", Number(event.target.value) || 1)}
                  className="h-8 w-16"
                />
                <span className="text-xs text-muted-foreground">times per week</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="habit-start">Start date</Label>
              <Input
                id="habit-start"
                type="date"
                value={form.startDate}
                onChange={(event) => set("startDate", event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="habit-desc">Why it matters (optional)</Label>
            <Textarea
              id="habit-desc"
              value={form.description ?? ""}
              onChange={(event) => set("description", event.target.value || null)}
              placeholder="Keeps my evenings off screens."
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {isEdit ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    () => archiveHabit(habit!.id!, !form.archived),
                    form.archived ? "Habit restored" : "Habit archived",
                  )
                }
              >
                <Archive /> {form.archived ? "Restore" : "Archive"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={pending}
                onClick={() => run(() => deleteHabit(habit!.id!), "Habit deleted")}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !form.name.trim()}>
              {pending && <Loader2 className="animate-spin" />}
              {isEdit ? "Save changes" : "Create habit"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
