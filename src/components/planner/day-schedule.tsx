"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CalendarCheck2, CalendarPlus, ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { ScheduleRow, type ScheduleRowItem } from "@/components/planner/schedule-row";
import { ScheduleItemDialog, type ScheduleItemDraft } from "@/components/planner/schedule-item-dialog";
import { reorderScheduleItems, rolloverUnfinished } from "@/server/actions/planner";
import { conflictsByItem } from "@/lib/logic/planner";
import { isPast, isToday } from "@/lib/date";
import { useUIStore } from "@/store/ui-store";

/**
 * The day list. Drag & drop reorders within the day and persists `sortOrder`;
 * timed items keep their chronological order, so dragging is most useful for
 * the untimed backlog.
 */
export function DaySchedule({
  date,
  items: initialItems,
  showRollover = true,
}: {
  date: string;
  items: ScheduleRowItem[];
  showRollover?: boolean;
}) {
  const router = useRouter();
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);

  const [items, setItems] = React.useState(initialItems);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ScheduleItemDraft | null>(null);
  const [, startTransition] = React.useTransition();

  // Server data is the source of truth; local state exists only so a drag feels
  // instant. Re-sync whenever the server sends a new list.
  React.useEffect(() => setItems(initialItems), [initialItems]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const timed = items.filter((item) => !item.allDay && item.startMinute !== null);
  const untimed = items.filter((item) => item.allDay || item.startMinute === null);
  const unfinished = items.filter((item) => item.status === "planned").length;

  // Overlaps are surfaced, not prevented — see `conflictsByItem` for what does
  // and does not count as one.
  const conflicts = React.useMemo(() => conflictsByItem(items), [items]);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = untimed.findIndex((item) => item.id === active.id);
    const newIndex = untimed.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(untimed, oldIndex, newIndex);
    setItems([...timed, ...reordered]);

    startTransition(async () => {
      const result = await reorderScheduleItems(
        date,
        reordered.map((item) => item.id),
      );
      if (!result.ok) {
        toast.error(result.error);
        router.refresh();
      }
    });
  }

  function edit(item: ScheduleRowItem) {
    setEditing({
      id: item.id,
      title: item.title,
      notes: item.notes,
      date: item.date,
      startMinute: item.startMinute,
      endMinute: item.endMinute,
      allDay: item.allDay,
      category: item.category,
      priority: item.priority,
      status: item.status,
      recurrenceRule: item.recurrenceRule,
      seriesId: item.seriesId,
    });
    setDialogOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus /> New item
        </Button>
        <Button size="sm" variant="outline" onClick={() => openQuickAdd(date)}>
          <ListChecks /> Quick add
        </Button>
        {showRollover && unfinished > 0 && isPast(date) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              startTransition(async () => {
                const result = await rolloverUnfinished(date);
                if (result.ok) {
                  toast.success(`Moved ${result.data.moved} unfinished to the next day`);
                  router.refresh();
                } else {
                  toast.error(result.error);
                }
              })
            }
          >
            <CalendarPlus /> Roll over {unfinished} unfinished
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={CalendarCheck2}
          title={isToday(date) ? "Nothing planned yet" : "No items for this day"}
          description="Add a block, or use quick add to type it in one line."
          action={
            <Button size="sm" onClick={() => openQuickAdd(date)}>
              <Plus /> Add your first item
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {timed.length > 0 && (
            <div className="space-y-1.5">
              {timed.map((item) => (
                <ScheduleRow
                  key={item.id}
                  item={item}
                  onEdit={edit}
                  conflictsWith={conflicts.get(item.id)}
                />
              ))}
            </div>
          )}

          {untimed.length > 0 && (
            <div className="space-y-1.5">
              {timed.length > 0 && <p className="section-title pt-1">Anytime</p>}
              <DndContext
                // Stable id: dnd-kit derives its aria ids from this, and an
                // auto-generated one differs between SSR and hydration.
                id={`day-schedule-${date}`}
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={untimed.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {untimed.map((item) => (
                      <ScheduleRow key={item.id} item={item} onEdit={edit} sortable />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}
        </div>
      )}

      <ScheduleItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        item={editing}
        defaultDate={date}
      />
    </div>
  );
}
