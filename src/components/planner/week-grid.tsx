"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { Plus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { formatDay, formatTimeRange, isToday, weekDays } from "@/lib/date";
import { conflictsByItem, findConflicts, summarizeConflicts } from "@/lib/logic/planner";
import { cn } from "@/lib/utils";
import { moveScheduleItem } from "@/server/actions/planner";
import { useUIStore } from "@/store/ui-store";
import { confirmMoveToast } from "@/components/planner/move-conflict";
import type { ScheduleRowItem } from "@/components/planner/schedule-row";

/** What one column knows about its overlaps — a count for the header, titles per card. */
interface DayConflicts {
  pairs: number;
  byItem: Map<string, string[]>;
}

/**
 * Week view with cross-day drag & drop: drag a card onto another column to move
 * it, keeping its time-of-day. This is the fastest way to reshuffle a week when
 * plans change, which is the whole point of the planner.
 */
export function WeekGrid({
  anchor,
  items,
  weekStartsOn = 1,
  todayKey,
  onSelect,
}: {
  anchor: string;
  items: ScheduleRowItem[];
  weekStartsOn?: 0 | 1;
  /** "Today" in the user's timezone; see `DateNav`. */
  todayKey?: string;
  onSelect?: (item: ScheduleRowItem) => void;
}) {
  const router = useRouter();
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);
  const [pendingMove, setPendingMove] = React.useState<Record<string, string>>({});
  const [, startTransition] = React.useTransition();

  const days = weekDays(anchor, weekStartsOn);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  React.useEffect(() => setPendingMove({}), [items]);

  const byDay = React.useMemo(() => {
    const map = new Map<string, ScheduleRowItem[]>(days.map((day) => [day, []]));
    for (const item of items) {
      const day = pendingMove[item.id] ?? item.date;
      map.get(day)?.push(item);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
        return (a.startMinute ?? 1e9) - (b.startMinute ?? 1e9);
      });
    }
    return map;
  }, [items, days, pendingMove]);

  // Same `findConflicts` as the day list's badges, scoped per column so the
  // header can flag the day and each card can name what it clashes with.
  const conflictsByDay = React.useMemo(() => {
    const map = new Map<string, DayConflicts>();
    for (const [day, list] of byDay) {
      map.set(day, { pairs: findConflicts(list).length, byItem: conflictsByItem(list) });
    }
    return map;
  }, [byDay]);

  function revert(itemId: string) {
    setPendingMove((state) => {
      const { [itemId]: _removed, ...rest } = state;
      return rest;
    });
  }

  function move(itemId: string, targetDay: string, confirm: boolean) {
    setPendingMove((state) => ({ ...state, [itemId]: targetDay }));

    startTransition(async () => {
      const result = await moveScheduleItem(itemId, targetDay, undefined, { confirm });

      if (!result.ok) {
        toast.error(result.error);
        revert(itemId);
        router.refresh();
        return;
      }

      // Occupied slot: nothing was written. Put the card back and let the
      // toast's "Move anyway" repeat the move deliberately.
      if (result.data.status === "conflict") {
        revert(itemId);
        confirmMoveToast(result.data.conflicts, () => move(itemId, targetDay, true));
        return;
      }

      toast.success(`Moved to ${formatDay(targetDay, "EEE, MMM d")}`);
      router.refresh();
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const itemId = String(event.active.id);
    const targetDay = event.over ? String(event.over.id) : null;
    if (!targetDay) return;

    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || item.date === targetDay) return;

    move(itemId, targetDay, false);
  }

  return (
    <DndContext
      // Stable id — see the note in day-schedule.tsx.
      id={`week-grid-${anchor}`}
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragEnd={onDragEnd}
    >
      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => (
          <DayColumn
            key={day}
            day={day}
            items={byDay.get(day) ?? []}
            conflicts={conflictsByDay.get(day)}
            todayKey={todayKey}
            onSelect={onSelect}
            onAdd={() => openQuickAdd(day)}
          />
        ))}
      </div>
    </DndContext>
  );
}

function DayColumn({
  day,
  items,
  conflicts,
  todayKey,
  onSelect,
  onAdd,
}: {
  day: string;
  items: ScheduleRowItem[];
  conflicts?: DayConflicts;
  todayKey?: string;
  onSelect?: (item: ScheduleRowItem) => void;
  onAdd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: day });
  const done = items.filter((item) => item.status === "done").length;
  const pairs = conflicts?.pairs ?? 0;
  const pairLabel = `${pairs} overlapping ${pairs === 1 ? "pair" : "pairs"} of blocks`;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-[340px] flex-col rounded-lg border bg-card/40 transition-colors",
        isOver && "border-primary bg-accent/60",
        isToday(day, todayKey) && "border-domain-planner/50 bg-domain-planner/[0.04]",
      )}
    >
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="min-w-0">
          <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {formatDay(day, "EEE")}
          </p>
          <p
            className={cn(
              "tabular text-sm font-semibold leading-tight",
              isToday(day, todayKey) && "text-domain-planner",
            )}
          >
            {formatDay(day, "d")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {pairs > 0 && (
            <span title={pairLabel}>
              <TriangleAlert
                className="h-3 w-3 text-amber-800 dark:text-amber-400"
                aria-hidden
              />
              <span className="sr-only">{pairLabel}</span>
            </span>
          )}
          {items.length > 0 && (
            <span className="tabular text-[10px] text-muted-foreground">
              {done}/{items.length}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-1 p-1.5">
        {items.map((item) => (
          <DraggableCard
            key={item.id}
            item={item}
            conflictsWith={conflicts?.byItem.get(item.id)}
            onSelect={onSelect}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="flex items-center justify-center gap-1 border-t px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> Add
      </button>
    </div>
  );
}

function DraggableCard({
  item,
  conflictsWith,
  onSelect,
}: {
  item: ScheduleRowItem;
  /** Titles of items whose time range overlaps this one. Informational only. */
  conflictsWith?: string[];
  onSelect?: (item: ScheduleRowItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });
  const meta = CATEGORY_META[item.category as ScheduleCategory] ?? CATEGORY_META.personal;
  const clash = conflictsWith ? summarizeConflicts(conflictsWith) : null;

  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      title={clash ? `Overlaps ${clash}` : undefined}
      className={cn(
        "cursor-grab rounded-md border border-l-[3px] bg-card px-1.5 py-1 shadow-sm transition-shadow active:cursor-grabbing",
        meta.bar,
        item.status === "done" && "opacity-55",
        item.status === "skipped" && "opacity-45",
        isDragging && "z-50 shadow-lg",
        clash && "border-amber-500/60",
      )}
      {...attributes}
      {...listeners}
      onClick={() => onSelect?.(item)}
    >
      <p
        className={cn(
          "truncate text-[11px] font-medium leading-tight",
          item.status === "done" && "line-through",
        )}
      >
        {clash && (
          <TriangleAlert
            className="mr-1 inline h-3 w-3 shrink-0 -translate-y-px text-amber-800 dark:text-amber-400"
            aria-hidden
          />
        )}
        {item.title}
        {clash && <span className="sr-only">, overlaps {clash}</span>}
      </p>
      {!item.allDay && item.startMinute !== null && (
        <p className="tabular truncate text-[10px] text-muted-foreground">
          {formatTimeRange(item.startMinute, item.endMinute, false)}
        </p>
      )}
    </div>
  );
}
