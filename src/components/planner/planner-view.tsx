"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DaySchedule } from "@/components/planner/day-schedule";
import { MonthGrid } from "@/components/planner/month-grid";
import { ScheduleItemDialog, type ScheduleItemDraft } from "@/components/planner/schedule-item-dialog";
import { Timeline } from "@/components/planner/timeline";
import { WeekGrid } from "@/components/planner/week-grid";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ScheduleRowItem } from "@/components/planner/schedule-row";

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
}: {
  date: string;
  view: PlannerScope;
  dayItems: ScheduleRowItem[];
  rangeItems: ScheduleRowItem[];
  weekStartsOn: 0 | 1;
  dayStartHour: number;
  dayEndHour: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [editing, setEditing] = React.useState<ScheduleItemDraft | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

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
      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="day">Day</TabsTrigger>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="month">Month</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "day" && (
        <div className="grid gap-6 xl:grid-cols-5">
          <div className="xl:col-span-3">
            <DaySchedule date={date} items={dayItems} />
          </div>
          <div className="xl:col-span-2">
            <Timeline
              date={date}
              items={dayItems}
              startHour={dayStartHour}
              endHour={dayEndHour}
              onSelect={open}
            />
          </div>
        </div>
      )}

      {view === "week" && (
        <WeekGrid anchor={date} items={rangeItems} weekStartsOn={weekStartsOn} onSelect={open} />
      )}

      {view === "month" && (
        <MonthGrid anchor={date} items={rangeItems} weekStartsOn={weekStartsOn} />
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
