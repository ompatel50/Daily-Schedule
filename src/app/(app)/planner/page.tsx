import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, LayoutTemplate } from "lucide-react";

import { PlannerView, type PlannerScope } from "@/components/planner/planner-view";
import { TemplateBar } from "@/components/planner/template-bar";
import { DateNav } from "@/components/shared/date-nav";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { isDayKey, monthGridDays, weekRange } from "@/lib/date";
import { SURFACE_ROLES, surfaceHref } from "@/lib/logic/surfaces";
import { toScheduleRowItems } from "@/lib/serializers";
import { extendSeriesFor } from "@/server/series";
import {
  getToday, getScheduleItems, getScheduleTemplates, getUser } from "@/server/queries";

export const metadata: Metadata = { title: "Planner" };
export const dynamic = "force-dynamic";

export default async function PlannerPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string }>;
}) {
  const params = await searchParams;
  const todayKey = await getToday();
  const date = params.date && isDayKey(params.date) ? params.date : todayKey;
  const view: PlannerScope =
    params.view === "week" || params.view === "month" ? params.view : "day";

  const user = await getUser();
  const weekStartsOn = user.weekStartsOn === 0 ? 0 : 1;

  // Top the materialised recurring series back up to the horizon whenever the
  // planner is opened. Idempotent and cheap.
  await extendSeriesFor(user.id, todayKey);

  const range =
    view === "month"
      ? (() => {
          const days = monthGridDays(date, weekStartsOn);
          return { from: days[0], to: days[days.length - 1] };
        })()
      : view === "week"
        ? (() => {
            const { start, end } = weekRange(date, weekStartsOn);
            return { from: start, to: end };
          })()
        : { from: date, to: date };

  const [rangeItems, templates] = await Promise.all([
    getScheduleItems(range.from, range.to),
    getScheduleTemplates(),
  ]);

  const rows = toScheduleRowItems(rangeItems);
  const dayItems = rows.filter((item) => item.date === date);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={SURFACE_ROLES.planner.label}
        description={`${SURFACE_ROLES.planner.purpose}. Working through the day happens in ${SURFACE_ROLES.today.label}.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DateNav date={date} scope={view} weekStartsOn={weekStartsOn} todayKey={todayKey} />
            <Button asChild variant="outline" size="sm">
              <Link href={surfaceHref("today", date)}>
                Open in {SURFACE_ROLES.today.label} <ArrowRight />
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-6">
        {templates.length > 0 && (
          <SectionCard
            title="Routines"
            icon={LayoutTemplate}
            accent="text-domain-planner"
            description="Stamp a saved routine onto this day"
          >
            <TemplateBar
              date={date}
              templates={templates.map((template) => ({
                id: template.id,
                name: template.name,
                description: template.description,
                category: template.category,
                itemCount: template.parsedItems.length,
                useCount: template.useCount,
              }))}
            />
          </SectionCard>
        )}

        <PlannerView
          date={date}
          view={view}
          dayItems={dayItems}
          rangeItems={rows}
          weekStartsOn={weekStartsOn}
          dayStartHour={user.dayStartHour}
          dayEndHour={user.dayEndHour}
          todayKey={todayKey}
        />
      </div>
    </div>
  );
}
