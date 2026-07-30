"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Trash2, Undo2 } from "lucide-react";
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
  ScheduleEditor,
  emptyScheduleDraft,
  type ScheduleDraft,
} from "@/components/shared/schedule-editor";
import { HABIT_CATEGORIES, HABIT_CATEGORY_META, type HabitCategory } from "@/lib/enums";
import { archiveHabit, deleteHabit, saveHabit } from "@/server/actions/habits";
import { useUIStore } from "@/store/ui-store";

export interface HabitDraft {
  id?: string;
  name: string;
  description: string | null;
  category: string;
  startDate: string;
  endDate: string | null;
  archived: boolean;
  schedule: ScheduleDraft;
}

const APPLY_OPTIONS = [
  { value: "forward", label: "From today onward", hint: "Past days keep the old schedule" },
  { value: "all", label: "Recalculate all history", hint: "Past streaks and scores may change" },
];

function blankHabit(startDate: string): HabitDraft {
  return {
    name: "",
    description: null,
    category: "health",
    startDate,
    endDate: null,
    archived: false,
    schedule: emptyScheduleDraft(),
  };
}

export function HabitDialog({
  open,
  onOpenChange,
  habit,
  weekStartsOn = 1,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  habit?: HabitDraft | null;
  weekStartsOn?: 0 | 1;
}) {
  const router = useRouter();
  const isEdit = Boolean(habit?.id);
  const [pending, startTransition] = React.useTransition();
  // New habits start on the user's today (synced from the server), not the host's.
  const todayKey = useUIStore((state) => state.todayKey);
  const [form, setForm] = React.useState<HabitDraft>(habit ?? blankHabit(todayKey));
  const [apply, setApply] = React.useState("forward");
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm(habit ?? blankHabit(todayKey));
    setApply("forward");
    setErrors({});
    setConfirmingDelete(false);
  }, [open, habit, todayKey]);

  function set<K extends keyof HabitDraft>(key: K, value: HabitDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.name.trim()) {
      setErrors({ name: ["Give the habit a name"] });
      return;
    }
    if (form.schedule.mode === "weekdays" && form.schedule.weekdays.length === 0) {
      setErrors({ weekdays: ["Pick at least one day"] });
      return;
    }

    startTransition(async () => {
      const result = await saveHabit({
        habit: {
          id: form.id,
          name: form.name.trim(),
          description: form.description,
          category: form.category,
          startDate: form.startDate,
          endDate: form.endDate,
          archived: form.archived,
        },
        schedule: form.schedule,
        apply: { mode: apply },
      });

      if (result.ok) {
        toast.success(isEdit ? "Habit updated" : "Habit created");
        onOpenChange(false);
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
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
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit habit" : "New habit"}</DialogTitle>
            <DialogDescription>
              Days you do not schedule are rest days — they never count as missed and never break
              a streak.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="habit-name">Name</Label>
              <Input
                id="habit-name"
                autoFocus
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "habit-name-error" : undefined}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Read 20 pages"
              />
              {errors.name && (
                <p id="habit-name-error" className="text-xs text-destructive">
                  {errors.name[0]}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="habit-description">Description (optional)</Label>
              <Textarea
                id="habit-description"
                rows={2}
                value={form.description ?? ""}
                onChange={(event) => set("description", event.target.value || null)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="habit-category">Category</Label>
              <Select value={form.category} onValueChange={(value) => set("category", value)}>
                <SelectTrigger id="habit-category">
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

            <div className="space-y-3 rounded-lg border p-3">
              <p className="section-title">Schedule</p>
              <ScheduleEditor
                value={form.schedule}
                onChange={(schedule) => set("schedule", schedule)}
                weekStartsOn={weekStartsOn}
                idPrefix="habit-schedule"
                errors={errors}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="habit-start">Start date</Label>
                <Input
                  id="habit-start"
                  type="date"
                  value={form.startDate}
                  onChange={(event) => set("startDate", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="habit-end">End date (optional)</Label>
                <Input
                  id="habit-end"
                  type="date"
                  value={form.endDate ?? ""}
                  onChange={(event) => set("endDate", event.target.value || null)}
                />
              </div>
            </div>

            {isEdit && (
              <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <Label htmlFor="habit-apply">Apply schedule change</Label>
                <Select value={apply} onValueChange={setApply}>
                  <SelectTrigger id="habit-apply">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {APPLY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {APPLY_OPTIONS.find((option) => option.value === apply)?.hint}
                </p>
              </div>
            )}

            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">How days are counted</p>
              <ul className="space-y-0.5">
                <li>Completed extends the streak.</li>
                <li>Missed and skipped break it.</li>
                <li>Excused and rest days are neutral — the streak survives.</li>
                <li>Days you did not schedule never count at all.</li>
              </ul>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {isEdit ? (
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => archiveHabit(form.id as string, !form.archived),
                      form.archived ? "Habit restored" : "Habit archived",
                    )
                  }
                >
                  {form.archived ? <Undo2 /> : <Archive />}
                  {form.archived ? "Restore" : "Archive"}
                </Button>
                {confirmingDelete ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() =>
                        run(() => deleteHabit(form.id as string), "Habit and its logs deleted")
                      }
                    >
                      Delete everything
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 /> Delete
                  </Button>
                )}
              </div>
            ) : (
              <span />
            )}

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {isEdit ? "Save changes" : "Create habit"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
