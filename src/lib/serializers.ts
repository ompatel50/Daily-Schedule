import type { ScheduleRowItem } from "@/components/planner/schedule-row";
import type { ScheduleItemWithRelations } from "@/server/queries";

/**
 * Prisma rows carry Date objects and relations that Client Components don't
 * need. These mappers produce the minimal serialisable shape crossing the
 * server/client boundary — which also keeps the payload small.
 */
export function toScheduleRowItem(item: ScheduleItemWithRelations): ScheduleRowItem {
  return {
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
    workoutId: item.workoutId,
    tags: item.tags.map(({ tag }) => ({ tag: { id: tag.id, name: tag.name } })),
  };
}

export function toScheduleRowItems(items: ScheduleItemWithRelations[]): ScheduleRowItem[] {
  return items.map(toScheduleRowItem);
}
