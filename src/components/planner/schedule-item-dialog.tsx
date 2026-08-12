"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  CATEGORY_META,
  ITEM_STATUSES,
  PRIORITIES,
  PRIORITY_META,
  SCHEDULE_CATEGORIES,
  type ItemStatus,
  type Priority,
  type ScheduleCategory,
} from "@/lib/enums";
import { WEEKDAY_LABELS, formatDay, minuteToTimeValue, parseTimeToMinute } from "@/lib/date";
import {
  describeRecurrence,
  parseRule,
  rulesEqual,
  serializeRule,
  type RecurrenceRule,
} from "@/lib/logic/recurrence";
import type { SeriesScope } from "@/lib/validation";
import {
  createScheduleItem,
  deleteScheduleItem,
  previewScheduleItemConflicts,
  updateScheduleItem,
} from "@/server/actions/planner";
import {
  SeriesScopeChooser,
  deleteScopeChoices,
  editScopeChoices,
} from "@/components/planner/series-scope-chooser";
import { cn } from "@/lib/utils";

export interface ScheduleItemDraft {
  id?: string;
  title: string;
  notes: string | null;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  category: string;
  priority: string;
  status: string;
  recurrenceRule: string | null;
  seriesId?: string | null;
  /** The parent's rule when editing an occurrence — pre-fills the controls. */
  seriesRule?: string | null;
}

/** The Repeat select's values. "weekdays" is weekly Mon–Fri, spelled out. */
type RepeatChoice = "none" | "daily" | "weekdays" | "weekly" | "monthly";

const WEEKDAY_SET = [1, 2, 3, 4, 5];

function repeatChoiceOf(rule: RecurrenceRule | null): RepeatChoice {
  if (!rule) return "none";
  if (
    rule.freq === "weekly" &&
    rule.interval === 1 &&
    rule.byWeekday?.length === 5 &&
    WEEKDAY_SET.every((day) => rule.byWeekday?.includes(day))
  ) {
    return "weekdays";
  }
  return rule.freq;
}

export function ScheduleItemDialog({
  open,
  onOpenChange,
  item,
  defaultDate,
  seriesActions = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: ScheduleItemDraft | null;
  defaultDate: string;
  /**
   * Offer the series scopes on save and delete. False on Today, where an
   * edit always means "this occurrence"; reshaping the series is the planner's
   * job and the dialog says so rather than silently narrowing the scope.
   */
  seriesActions?: boolean;
}) {
  const router = useRouter();
  const isEdit = Boolean(item?.id);
  const [pending, startTransition] = React.useTransition();

  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [date, setDate] = React.useState(defaultDate);
  const [allDay, setAllDay] = React.useState(false);
  const [start, setStart] = React.useState("09:00");
  const [end, setEnd] = React.useState("10:00");
  const [category, setCategory] = React.useState<ScheduleCategory>("personal");
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [status, setStatus] = React.useState<ItemStatus>("planned");
  const [repeat, setRepeat] = React.useState<RepeatChoice>("none");
  const [weekdays, setWeekdays] = React.useState<number[]>([]);
  const [interval, setInterval] = React.useState(1);
  const [ends, setEnds] = React.useState<"never" | "on">("never");
  const [endDate, setEndDate] = React.useState("");
  const [chooser, setChooser] = React.useState<"edit" | "delete" | null>(null);
  const [conflicts, setConflicts] = React.useState<string[]>([]);

  // Reset the form each time the dialog opens so a stale draft can't leak
  // between edits.
  React.useEffect(() => {
    if (!open) return;

    setTitle(item?.title ?? "");
    setNotes(item?.notes ?? "");
    setDate(item?.date ?? defaultDate);
    setAllDay(item?.allDay ?? false);
    setStart(item?.startMinute != null ? minuteToTimeValue(item.startMinute) : "09:00");
    setEnd(item?.endMinute != null ? minuteToTimeValue(item.endMinute) : "10:00");
    setCategory((item?.category as ScheduleCategory) ?? "personal");
    setPriority((item?.priority as Priority) ?? "medium");
    setStatus((item?.status as ItemStatus) ?? "planned");
    setChooser(null);
    setConflicts([]);

    // An occurrence's own rule is null; the series' rule lives on the parent.
    const rule = parseRule(item?.recurrenceRule ?? item?.seriesRule ?? null);
    setRepeat(repeatChoiceOf(rule));
    setWeekdays(rule?.byWeekday ?? []);
    setInterval(rule?.interval ?? 1);
    // The end date is pre-filled from the stored rule, which is exactly what
    // makes a series split INHERIT its end date unless the user changes it.
    setEnds(rule?.until ? "on" : "never");
    setEndDate(rule?.until ?? "");
  }, [open, item, defaultDate]);

  const storedRule = React.useMemo(
    () => parseRule(item?.recurrenceRule ?? item?.seriesRule ?? null),
    [item?.recurrenceRule, item?.seriesRule],
  );

  const rule: RecurrenceRule | null =
    repeat === "none"
      ? null
      : {
          freq: repeat === "weekdays" ? "weekly" : repeat,
          interval: repeat === "weekdays" ? 1 : Math.max(1, interval),
          byWeekday: repeat === "weekly" ? weekdays : repeat === "weekdays" ? WEEKDAY_SET : [],
          until: ends === "on" && endDate ? endDate : undefined,
        };

  const endDateError =
    ends === "on" && !endDate
      ? "Pick an end date, or choose Never."
      : ends === "on" && endDate && endDate < date
        ? "The end date cannot be before the start date."
        : null;

  // On the parent (or a plain item) the rule is editable; recurrence changes
  // reach from the edited occurrence forward, so they force that scope.
  const ruleChanged = isEdit && !rulesEqual(rule, storedRule);
  const recurring = Boolean(item?.seriesId) || Boolean(storedRule);
  const isSeries = recurring && seriesActions;

  // Live double-booking check, debounced. Informational only — the same
  // tolerant rule as every other warning, so adjacent blocks stay quiet.
  React.useEffect(() => {
    if (!open || allDay) {
      setConflicts([]);
      return;
    }
    const startMinute = parseTimeToMinute(start);
    const endMinute = parseTimeToMinute(end);
    if (startMinute === null || endMinute === null) {
      setConflicts([]);
      return;
    }
    const handle = setTimeout(async () => {
      const result = await previewScheduleItemConflicts({
        date,
        startMinute,
        endMinute,
        allDay: false,
        excludeId: item?.id,
      });
      setConflicts(result.ok ? result.data.conflicts : []);
    }, 300);
    return () => clearTimeout(handle);
  }, [open, allDay, start, end, date, item?.id]);

  function submit(scope: SeriesScope) {
    const startMinute = allDay ? null : parseTimeToMinute(start);
    const endMinute = allDay ? null : parseTimeToMinute(end);

    const payload = {
      id: item?.id,
      title: title.trim(),
      notes: notes.trim() || null,
      date,
      startMinute,
      endMinute,
      allDay,
      category,
      priority,
      status,
      recurrenceRule: serializeRule(rule),
      tagIds: [],
    };

    startTransition(async () => {
      const result = isEdit
        ? await updateScheduleItem(payload, scope)
        : await createScheduleItem(payload);

      if (result.ok) {
        toast.success(isEdit ? "Item updated" : "Item added");
        setChooser(null);
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove(deleteScope: SeriesScope) {
    if (!item?.id) return;
    startTransition(async () => {
      const result = await deleteScheduleItem(item.id!, deleteScope);
      if (result.ok) {
        toast.success(
          result.data.deleted > 1 ? `Deleted ${result.data.deleted} items` : "Item deleted",
        );
        setChooser(null);
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  /** Save tap: recurring items pick a scope first, everything else just saves. */
  function requestSave() {
    if (endDateError) {
      toast.error(endDateError);
      return;
    }
    if (isEdit && isSeries) {
      setChooser("edit");
      return;
    }
    submit("one");
  }

  /** Delete tap: recurring items pick a scope; plain items delete directly. */
  function requestDelete() {
    if (isSeries) {
      setChooser("delete");
      return;
    }
    remove("one");
  }

  const occurrenceLabel = formatDay(date, "EEEE, MMM d");
  const chooserNote =
    chooser === "edit"
      ? [
          ruleChanged ? "The repeat settings changed, so this applies from this occurrence forward." : null,
          conflicts.length > 0
            ? `The new time overlaps ${conflicts.join(", ")} on this day. Future occurrences aren't checked — the changed series may create conflicts on other days.`
            : "Future occurrences aren't checked ahead of time — the changed series may create conflicts on other days.",
        ]
          .filter(Boolean)
          .join(" ")
      : null;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit item" : "New item"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update the details for this schedule item." : "Add something to your day."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="item-title">Title</Label>
            <Input
              id="item-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Deep work block"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="item-date">Date</Label>
              <Input
                id="item-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as ScheduleCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex items-center gap-2">
                        <span className={cn("h-2 w-2 rounded-full", CATEGORY_META[value].dot)} />
                        {CATEGORY_META[value].label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={allDay} onCheckedChange={(value) => setAllDay(value === true)} />
              All day
            </label>
            {!allDay && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="item-start">Start</Label>
                  <Input
                    id="item-start"
                    type="time"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="item-end">End</Label>
                  <Input
                    id="item-end"
                    type="time"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </div>
              </div>
            )}
            {conflicts.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Overlaps {conflicts.join(", ")}. Double-booking is allowed — this is a warning,
                  not a block.
                </span>
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {PRIORITY_META[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as ItemStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "done" ? "Done" : value === "skipped" ? "Skipped" : "Planned"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!seriesActions ? (
            // Today edits one occurrence. The rule is shown so nothing is
            // hidden, but changing it reshapes every future day, which is the
            // planner's job — and the form says where to go rather than
            // silently accepting an edit with a narrower scope than it looks.
            <div className="space-y-1 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <Label>Repeat</Label>
                <span className="text-xs text-muted-foreground">{describeRecurrence(rule, date)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {recurring
                  ? "Changes here apply to this day only. Edit the series in the planner."
                  : "Set up a repeat in the planner."}
              </p>
            </div>
          ) : (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Repeat</Label>
              <span className="text-xs text-muted-foreground">{describeRecurrence(rule, date)}</span>
            </div>
            <Select value={repeat} onValueChange={(value) => setRepeat(value as RepeatChoice)}>
              <SelectTrigger aria-label="Repeats">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Does not repeat</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekdays">Every weekday</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>

            {repeat === "weekly" && (
              <div className="flex flex-wrap gap-1 pt-1">
                {WEEKDAY_LABELS.map((label, index) => {
                  const active = weekdays.includes(index);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() =>
                        setWeekdays((current) =>
                          active ? current.filter((day) => day !== index) : [...current, index],
                        )
                      }
                      className={cn(
                        "h-8 w-10 rounded-md border text-xs font-medium transition-colors",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "hover:bg-accent",
                      )}
                    >
                      {label.slice(0, 2)}
                    </button>
                  );
                })}
              </div>
            )}

            {repeat !== "none" && repeat !== "weekdays" && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">Every</span>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={interval}
                  onChange={(event) => setInterval(Number(event.target.value) || 1)}
                  className="h-8 w-16"
                  aria-label="Repeat interval"
                />
                <span className="text-xs text-muted-foreground">
                  {repeat === "daily" ? "day(s)" : repeat === "weekly" ? "week(s)" : "month(s)"}
                </span>
              </div>
            )}

            {repeat !== "none" && (
              <div className="space-y-2 border-t pt-2">
                <p className="text-xs text-muted-foreground">
                  Starts {formatDay(date, "EEE, MMM d, yyyy")} — the item&apos;s date above.
                </p>
                <div className="grid grid-cols-2 items-end gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="item-ends">Ends</Label>
                    <Select value={ends} onValueChange={(value) => setEnds(value as "never" | "on")}>
                      <SelectTrigger id="item-ends">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="on">On date</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {ends === "on" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="item-end-date">End date</Label>
                      <Input
                        id="item-end-date"
                        type="date"
                        value={endDate}
                        min={date}
                        onChange={(event) => setEndDate(event.target.value)}
                        aria-invalid={Boolean(endDateError)}
                      />
                    </div>
                  )}
                </div>
                {endDateError && (
                  <p className="text-xs text-destructive" role="alert">
                    {endDateError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  The end date is included: an occurrence lands on it when it matches the pattern.
                </p>
              </div>
            )}
          </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="item-notes">Notes</Label>
            <Textarea
              id="item-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Anything worth remembering…"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {isEdit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={requestDelete}
              disabled={pending}
              className="text-destructive"
            >
              <Trash2 /> {isSeries ? "Delete…" : "Delete"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={requestSave} disabled={pending || !title.trim() || Boolean(endDateError)}>
              {pending && <Loader2 className="animate-spin" />}
              {isEdit ? (isSeries ? "Save…" : "Save changes") : "Add item"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <SeriesScopeChooser
      open={chooser !== null}
      onOpenChange={(next) => {
        if (!next) setChooser(null);
      }}
      mode={chooser === "delete" ? "delete" : "edit"}
      occurrenceLabel={occurrenceLabel}
      choices={
        chooser === "delete"
          ? deleteScopeChoices(occurrenceLabel)
          : editScopeChoices(occurrenceLabel, ruleChanged)
      }
      note={chooserNote}
      pending={pending}
      onChoose={(scope) => (chooser === "delete" ? remove(scope) : submit(scope))}
    />
    </>
  );
}
