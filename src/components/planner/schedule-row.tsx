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
import { formatTimeRange, shiftDay } from "@/lib/date";
import { summarizeConflicts } from "@/lib/logic/planner";
import { cn } from "@/lib/utils";
import { confirmMoveToast } from "@/components/planner/move-conflict";
import {
  deleteScheduleItem,
  moveScheduleItem,
  setScheduleItemStatus,
  toggleScheduleItem,
} from "@/server/actions/planner";

export interface ScheduleRowItem {
  id: string;
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
  seriesId: string | null;
  workoutId: string | null;
  tags: Array<{ tag: { id: string; name: string } }>;
}

export function ScheduleRow({
  item,
  onEdit,
  sortable = false,
  compact = false,
  seriesActions = true,
  conflictsWith,
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
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

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

  // "Push to tomorrow" can land on an occupied slot. The action reports the
  // clash without writing; the toast's "Move anyway" repeats it confirmed.
  const pushToTomorrow = (confirm = false) =>
    startTransition(async () => {
      const result = await moveScheduleItem(item.id, shiftDay(item.date, 1), undefined, { confirm });
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
          className="mt-0.5 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
          aria-label="Reorder"
          {...sortableState.attributes}
          {...sortableState.listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}

      <Checkbox
        checked={done}
        className="mt-0.5"
        aria-label={done ? "Mark as not done" : "Mark as done"}
        onCheckedChange={() => act(() => toggleScheduleItem(item.id))}
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
          </span>
          <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", meta.chip)}>
            {meta.label}
          </Badge>
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

        {!compact && item.notes && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.notes}</p>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
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
          <DropdownMenuItem
            destructive
            onClick={() => act(() => deleteScheduleItem(item.id, "one"), "Item deleted")}
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
          {recurring && seriesActions && (
            <>
              <DropdownMenuItem
                destructive
                onClick={() =>
                  act(() => deleteScheduleItem(item.id, "future"), "This and future deleted")
                }
              >
                <Trash2 /> Delete this and future
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                onClick={() => act(() => deleteScheduleItem(item.id, "all"), "Series deleted")}
              >
                <Trash2 /> Delete whole series
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
