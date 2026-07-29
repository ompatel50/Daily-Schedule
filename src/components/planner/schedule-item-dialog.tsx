"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { WEEKDAY_LABELS, minuteToTimeValue, parseTimeToMinute } from "@/lib/date";
import { describeRule, parseRule, serializeRule, type RecurrenceRule } from "@/lib/logic/recurrence";
import type { SeriesScope } from "@/lib/validation";
import { createScheduleItem, deleteScheduleItem, updateScheduleItem } from "@/server/actions/planner";
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
}

export function ScheduleItemDialog({
  open,
  onOpenChange,
  item,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: ScheduleItemDraft | null;
  defaultDate: string;
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
  const [repeat, setRepeat] = React.useState<"none" | "daily" | "weekly" | "monthly">("none");
  const [weekdays, setWeekdays] = React.useState<number[]>([]);
  const [interval, setInterval] = React.useState(1);
  const [scope, setScope] = React.useState<SeriesScope>("one");

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
    setScope("one");

    const rule = parseRule(item?.recurrenceRule ?? null);
    setRepeat(rule ? rule.freq : "none");
    setWeekdays(rule?.byWeekday ?? []);
    setInterval(rule?.interval ?? 1);
  }, [open, item, defaultDate]);

  const rule: RecurrenceRule | null =
    repeat === "none"
      ? null
      : {
          freq: repeat,
          interval: Math.max(1, interval),
          byWeekday: repeat === "weekly" ? weekdays : [],
        };

  function submit() {
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
        toast.success(result.data.deleted > 1 ? `Deleted ${result.data.deleted} items` : "Item deleted");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const isSeries = Boolean(item?.seriesId) || Boolean(parseRule(item?.recurrenceRule ?? null));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
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

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Repeat</Label>
              <span className="text-xs text-muted-foreground">{describeRule(rule, date)}</span>
            </div>
            <Select value={repeat} onValueChange={(value) => setRepeat(value as typeof repeat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Does not repeat</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
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

            {repeat !== "none" && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">Every</span>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={interval}
                  onChange={(event) => setInterval(Number(event.target.value) || 1)}
                  className="h-8 w-16"
                />
                <span className="text-xs text-muted-foreground">
                  {repeat === "daily" ? "day(s)" : repeat === "weekly" ? "week(s)" : "month(s)"}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="item-notes">Notes</Label>
            <Textarea
              id="item-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Anything worth remembering…"
            />
          </div>

          {isEdit && isSeries && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <Label htmlFor="item-scope">Apply changes to</Label>
              <Select value={scope} onValueChange={(value) => setScope(value as SeriesScope)}>
                <SelectTrigger id="item-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one">This item only</SelectItem>
                  <SelectItem value="future">This and all future items</SelectItem>
                  <SelectItem value="all">All items in the series</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {scope === "one"
                  ? "Only this occurrence changes, and it stops following the series."
                  : "The date stays on each occurrence — only the details carry across."}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {isEdit ? (
            <div className="flex gap-2">
              {isSeries ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={pending} className="text-destructive">
                      <Trash2 /> Delete…
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuItem destructive onClick={() => remove("one")}>
                      This item only
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onClick={() => remove("future")}>
                      This and all future items
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onClick={() => remove("all")}>
                      All items in the series
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => remove("one")}
                  disabled={pending}
                  className="text-destructive"
                >
                  <Trash2 /> Delete
                </Button>
              )}
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !title.trim()}>
              {pending && <Loader2 className="animate-spin" />}
              {isEdit ? "Save changes" : "Add item"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
