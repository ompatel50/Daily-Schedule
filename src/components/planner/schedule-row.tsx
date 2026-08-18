"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowRight,
  Ban,
  Clock,
  Dumbbell,
  GripVertical,
  ListTodo,
  MoreHorizontal,
  Pencil,
  Repeat,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CATEGORY_META, PRIORITY_META, type Priority, type ScheduleCategory } from "@/lib/enums";
import { formatDay, formatTimeRange, shiftDay } from "@/lib/date";
import { DEFAULT_DAY_RESET_MINUTE, groupedWithDayHint } from "@/lib/logic/operational-day";
import { summarizeConflicts } from "@/lib/logic/planner";
import { crossesMidnight } from "@/lib/logic/schedule-span";
import { cn } from "@/lib/utils";
import { confirmMoveToast } from "@/components/planner/move-conflict";
import { SeriesScopeChooser, deleteScopeChoices } from "@/components/planner/series-scope-chooser";
import {
  deleteScheduleItem,
  moveScheduleItem,
  setScheduleItemStatus,
  toggleScheduleItem,
} from "@/server/actions/planner";
import { completeTask } from "@/server/actions/tasks";

export interface ScheduleRowItem {
  id: string;
  title: string;
  notes: string | null;
  /** Calendar date, `YYYY-MM-DD` — the real date of the item's times. */
  date: string;
  /**
   * The operational day this item groups under. Differs from `date` only for
   * timed items before the user's daily reset (an after-midnight block
   * belongs to the previous evening's schedule).
   */
  operationalDate: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  /** Manual drag order — the comparator's stable tiebreak on exact time ties. */
  sortOrder: number;
  category: string;
  priority: string;
  status: string;
  recurrenceRule: string | null;
  seriesId: string | null;
  /** The parent's rule when this row is an occurrence of a series. */
  seriesRule?: string | null;
  workoutId: string | null;
  /** The task this block was scheduled from ("add to planner"), if any. */
  task?: { id: string; title: string; status: string } | null;
  tags: Array<{ tag: { id: string; name: string } }>;
}

export function ScheduleRow({
  item,
  onEdit,
  sortable = false,
  compact = false,
  seriesActions = true,
  conflictsWith,
  dayResetMinute = DEFAULT_DAY_RESET_MINUTE,
}: {
  item: ScheduleRowItem;
  onEdit?: (item: ScheduleRowItem) => void;
  sortable?: boolean;
  compact?: boolean;
  /**
   * Offer the "this and future" / "whole series" scopes. False on Today, where
   * deleting every future Monday standup is not a thing you meant to do while
   * working through this Monday.
   */
  seriesActions?: boolean;
  /** Titles of items whose time range overlaps this one. Informational only. */
  conflictsWith?: string[];
  /** The user's daily reset, for the after-midnight grouping hint. */
  dayResetMinute?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [deleteChooserOpen, setDeleteChooserOpen] = React.useState(false);

  const sortableState = useSortable({ id: item.id, disabled: !sortable });
  const style = sortable
    ? {
        transform: CSS.Translate.toString(sortableState.transform),
        transition: sortableState.transition,
      }
    : undefined;

  const done = item.status === "done";
  const skipped = item.status === "skipped";
  const meta = CATEGORY_META[item.category as ScheduleCategory] ?? CATEGORY_META.personal;
  const recurring = Boolean(item.recurrenceRule || item.seriesId);

  // A warning, never a block — double-booking yourself is sometimes deliberate.
  const conflict = conflictsWith ? summarizeConflicts(conflictsWith) : null;

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, message?: string) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        if (message) toast.success(message);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });

  // The checkbox on a block scheduled from a task: marking it done OFFERS to
  // complete the task too — an explicit toast action, never automatic, because
  // one block can be one of several work sessions on the same task.
  const toggleDone = () =>
    startTransition(async () => {
      const result = await toggleScheduleItem(item.id);
      if (!result.ok) {
        toast.error(result.error ?? "Something went wrong");
        return;
      }
      router.refresh();
      const offer = result.data.taskOffer;
      if (offer) {
        toast(`Also complete the task “${offer.title}”?`, {
          action: {
            label: "Complete task",
            onClick: () =>
              startTransition(async () => {
                const completed = await completeTask(offer.id);
                if (!completed.ok) {
                  toast.error(completed.error);
                  return;
                }
                toast.success(
                  completed.data.status === "advanced" && completed.data.nextDue
                    ? `Task done — next on ${formatDay(completed.data.nextDue)}`
                    : "Task completed",
                );
                router.refresh();
              }),
          },
        });
      }
    });

  // "Push to tomorrow" can land on an occupied slot. The action reports the
  // clash without writing; the toast's "Move anyway" repeats it confirmed.
  // "Tomorrow" is the next OPERATIONAL day — a 1:00 AM block pushes to the
  // next night, not the same night again.
  const pushToTomorrow = (confirm = false) =>
    startTransition(async () => {
      const result = await moveScheduleItem(item.id, shiftDay(item.operationalDate, 1), undefined, {
        confirm,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Something went wrong");
        return;
      }
      if (result.data.status === "conflict") {
        confirmMoveToast(result.data.conflicts, () => pushToTomorrow(true));
        return;
      }
      toast.success("Moved to tomorrow");
      router.refresh();
    });

  return (
    <div
      ref={sortable ? sortableState.setNodeRef : undefined}
      style={style}
      className={cn(
        "group flex items-start gap-3 rounded-lg border border-l-[3px] bg-card px-3 py-2.5 transition-colors",
        meta.bar,
        done && "opacity-90",
        skipped && "opacity-90 grayscale",
        sortableState.isDragging && "z-10 opacity-80 shadow-lg",
        pending && "pointer-events-none opacity-70",
        !compact && "hover:bg-accent/40",
      )}
    >
      {sortable && (
        <button
          type="button"
          className="mt-0.5 cursor-grab text-muted-foreground/40 hover-reveal active:cursor-grabbing"
          aria-label="Reorder"
          {...sortableState.attributes}
          {...sortableState.listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}

      <Checkbox
        checked={done}
        className="touch-target mt-0.5"
        aria-label={done ? "Mark as not done" : "Mark as done"}
        onCheckedChange={toggleDone}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "text-sm font-medium leading-tight",
              done && "line-through",
              skipped && "line-through decoration-dashed",
            )}
          >
            {item.title}
          </span>
          {item.priority !== "medium" && (
            <span className={cn("text-[11px] font-semibold uppercase", PRIORITY_META[item.priority as Priority]?.chip)}>
              {item.priority}
            </span>
          )}
          {recurring && <Repeat className="h-3 w-3 text-muted-foreground" aria-label="Repeats" />}
          {item.workoutId && <Dumbbell className="h-3 w-3 text-domain-workout" aria-label="Workout" />}
        </div>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatTimeRange(item.startMinute, item.endMinute, item.allDay)}
            {crossesMidnight(item.startMinute, item.endMinute) && !item.allDay && (
              <span className="text-[10px] font-medium text-muted-foreground/80">
                ends {formatDay(shiftDay(item.date, 1), "MMM d")}
              </span>
            )}
          </span>
          <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", meta.chip)}>
            {meta.label}
          </Badge>
          {item.task && (
            <button
              type="button"
              onClick={() => router.push("/tasks")}
              title={
                item.task.status === "open"
                  ? `Scheduled from the task “${item.task.title}”`
                  : `Scheduled from the task “${item.task.title}” (${item.task.status})`
              }
              className="inline-flex max-w-48 items-center gap-1 rounded text-domain-task transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ListTodo className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className={cn("truncate", item.task.status === "done" && "line-through")}>
                {item.task.title}
              </span>
            </button>
          )}
          {item.tags.map(({ tag }) => (
            <span key={tag.id} className="text-[11px]">
              #{tag.name}
            </span>
          ))}
        </div>

        {conflict && (
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-800 dark:text-amber-400">
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            <span>Overlaps {conflict}</span>
          </p>
        )}

        {item.operationalDate !== item.date && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {groupedWithDayHint(formatDay(item.operationalDate, "EEEE"), dayResetMinute)}
          </p>
        )}

        {!compact && item.notes && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.notes}</p>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="touch-target hover-reveal"
            aria-label="Item actions"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(item)}>
              <Pencil /> Edit
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => pushToTomorrow()}>
            <ArrowRight /> Push to tomorrow
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              act(
                () => setScheduleItemStatus(item.id, skipped ? "planned" : "skipped"),
                skipped ? "Back on the schedule" : "Marked as skipped",
              )
            }
          >
            <Ban /> {skipped ? "Un-skip" : "Skip"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {recurring && seriesActions ? (
            // Deleting one occurrence of a series is a scoped decision — the
            // chooser asks it explicitly instead of a menu of destructive rows.
            <DropdownMenuItem destructive onClick={() => setDeleteChooserOpen(true)}>
              <Trash2 /> Delete…
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              destructive
              onClick={() => act(() => deleteScheduleItem(item.id, "one"), "Item deleted")}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {recurring && seriesActions && (
        <SeriesScopeChooser
          open={deleteChooserOpen}
          onOpenChange={setDeleteChooserOpen}
          mode="delete"
          occurrenceLabel={formatDay(item.operationalDate, "EEEE, MMM d")}
          choices={deleteScopeChoices(formatDay(item.operationalDate, "EEEE, MMM d"))}
          pending={pending}
          onChoose={(scope) => {
            setDeleteChooserOpen(false);
            act(
              () => deleteScheduleItem(item.id, scope),
              scope === "one" ? "Occurrence deleted" : "Deleted",
            );
          }}
        />
      )}
    </div>
  );
}
