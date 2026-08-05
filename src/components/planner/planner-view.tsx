"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { TriangleAlert } from "lucide-react";

import { DaySchedule } from "@/components/planner/day-schedule";
import { MonthGrid } from "@/components/planner/month-grid";
import { ScheduleItemDialog, type ScheduleItemDraft } from "@/components/planner/schedule-item-dialog";
import { Timeline } from "@/components/planner/timeline";
import { WeekGrid } from "@/components/planner/week-grid";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ScheduleRowItem } from "@/components/planner/schedule-row";
import { findConflicts } from "@/lib/logic/planner";

export type PlannerScope = "day" | "week" | "month";

/**
 * Client wrapper that owns the view switch and the shared edit dialog. Data
 * comes pre-fetched from the server for all three scopes' ranges.
 */
export function PlannerView({
  date,
  view,
  dayItems,
  rangeItems,
  weekStartsOn,
  dayStartHour,
  dayEndHour,
  dayResetMinute,
  todayKey,
}: {
  date: string;
  view: PlannerScope;
  dayItems: ScheduleRowItem[];
  rangeItems: ScheduleRowItem[];
  weekStartsOn: 0 | 1;
  dayStartHour: number;
  dayEndHour: number;
  /** The user's daily reset (minutes after midnight). */
  dayResetMinute: number;
  /** "Today" in the user's timezone, so every grid highlights the same day. */
  todayKey: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [editing, setEditing] = React.useState<ScheduleItemDraft | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  // The planner owns conflicts now that Today no longer shows them, so the
  // count belongs here rather than only as a badge you have to scroll to find.
  // Same `findConflicts` the rows use — one definition of what an overlap is.
  const dayConflicts = React.useMemo(() => findConflicts(dayItems), [dayItems]);

  function setView(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "day") params.delete("view");
    else params.set("view", next);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function open(item: ScheduleRowItem) {
    setEditing({
      id: item.id,
      title: item.title,
      notes: item.notes,
      // The dialog edits the OPERATIONAL day — the day the user sees the item
      // under. The server converts a pre-reset time back to its real calendar
      // date on save, so the round trip is stable.
      date: item.operationalDate,
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
      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="day">Day</TabsTrigger>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="month">Month</TabsTrigger>
        </TabsList>
        {/* The real panels render below, outside the Tabs tree. These mounted,
            empty stubs keep every trigger's aria-controls pointing at a real
            element, which assistive tech (and axe) require. */}
        <TabsContent value="day" forceMount hidden />
        <TabsContent value="week" forceMount hidden />
        <TabsContent value="month" forceMount hidden />
      </Tabs>

      {view === "day" && dayConflicts.length > 0 && (
        <p className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            {dayConflicts.length} overlapping{" "}
            {dayConflicts.length === 1 ? "pair of blocks" : "pairs of blocks"} on this day. Double-booking
            is allowed — this is a warning, not a block.
          </span>
        </p>
      )}

      {view === "day" && (
        <div className="grid gap-6 xl:grid-cols-5">
          <div className="xl:col-span-3">
            <DaySchedule
              date={date}
              items={dayItems}
              surface="planner"
              todayKey={todayKey}
              dayResetMinute={dayResetMinute}
            />
          </div>
          <div className="xl:col-span-2">
            <Timeline
              date={date}
              items={dayItems}
              startHour={dayStartHour}
              endHour={dayEndHour}
              dayResetMinute={dayResetMinute}
              todayKey={todayKey}
              onSelect={open}
            />
          </div>
        </div>
      )}

      {view === "week" && (
        <WeekGrid
          anchor={date}
          items={rangeItems}
          weekStartsOn={weekStartsOn}
          todayKey={todayKey}
          onSelect={open}
        />
      )}

      {view === "month" && (
        <MonthGrid anchor={date} items={rangeItems} weekStartsOn={weekStartsOn} todayKey={todayKey} />
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
