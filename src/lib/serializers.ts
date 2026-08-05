import type { ScheduleRowItem } from "@/components/planner/schedule-row";
import { DEFAULT_DAY_RESET_MINUTE, operationalDayOfRecord } from "@/lib/logic/operational-day";
import type { ScheduleItemWithRelations } from "@/server/queries";

/**
 * Prisma rows carry Date objects and relations that Client Components don't
 * need. These mappers produce the minimal serialisable shape crossing the
 * server/client boundary — which also keeps the payload small.
 *
 * `resetMinute` is the user's daily reset: the serialized row carries its
 * operational day so client components group and label without re-deriving
 * the boundary.
 */
export function toScheduleRowItem(
  item: ScheduleItemWithRelations,
  resetMinute: number = DEFAULT_DAY_RESET_MINUTE,
): ScheduleRowItem {
  return {
    id: item.id,
    title: item.title,
    notes: item.notes,
    date: item.date,
    operationalDate: operationalDayOfRecord(item, resetMinute),
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

export function toScheduleRowItems(
  items: ScheduleItemWithRelations[],
  resetMinute: number = DEFAULT_DAY_RESET_MINUTE,
): ScheduleRowItem[] {
  return items.map((item) => toScheduleRowItem(item, resetMinute));
}
