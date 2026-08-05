import type { Metadata } from "next";
import { Moon } from "lucide-react";

import { HealthGroupPage } from "@/components/health/group-page";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/db";
import { formatDay } from "@/lib/date";
import { rangeFromParam } from "@/lib/health-ranges";
import { SLEEP_STAGE_META, type SleepStage } from "@/lib/logic/health";
import { formatNumber } from "@/lib/utils";
import { getGroupView, getSleepSessions, resolveRange } from "@/server/health-module";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Sleep · Health" };
export const dynamic = "force-dynamic";

/** Bedtime and wake time, rendered in the timezone the export was made in. */
function clock(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

export default async function HealthSleepPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const user = await getCurrentUser();
  const today = scheduleSettingsFor(user).today;
  const window = await resolveRange(user.id, range, today);

  const [view, sessions] = await Promise.all([
    getGroupView("sleep", range),
    getSleepSessions(user.id, window.from, window.to, 120),
  ]);

  return (
    <HealthGroupPage
      title="Sleep"
      description="Time asleep, time in bed and the stages behind them"
      icon={Moon}
      view={view}
      range={range}
      empty={view.empty && sessions.length === 0}
    >
      {sessions.length > 0 && (
        <SectionCard
          title="Nights"
          icon={Moon}
          accent="text-domain-planner"
          description={`${sessions.length} ${sessions.length === 1 ? "night" : "nights"} in this range · the fullest source per night`}
          className="mb-6"
        >
          {/* Phones get the same nights as stacked cards; the table needs 560px. */}
          <div className="space-y-2 md:hidden">
            {sessions.map((session) => (
              <div key={`${session.date}-${session.source}`} className="rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {formatDay(session.date, "EEE, MMM d")}
                  </p>
                  <p className="tabular shrink-0 text-sm font-semibold">
                    {formatNumber(session.asleepHours, 1)}h asleep
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {session.startAt ? `${clock(session.startAt)}–${clock(session.endAt)} · ` : ""}
                  {session.inBedHours === null
                    ? "in bed —"
                    : `${formatNumber(session.inBedHours, 1)}h in bed`}{" "}
                  · {session.source}
                </p>
                {session.stages.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {session.stages.map((entry) => (
                      <Badge key={entry.stage} variant="muted" className="text-[10px]">
                        {SLEEP_STAGE_META[entry.stage as SleepStage]?.label ?? entry.stage}{" "}
                        {formatNumber(entry.hours, 1)}h
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Night
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Asleep
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    In bed
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Stages
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={`${session.date}-${session.source}`} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{formatDay(session.date, "EEE, MMM d")}</span>
                      {session.startAt && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {clock(session.startAt)}–{clock(session.endAt)}
                        </span>
                      )}
                    </td>
                    <td className="tabular py-2 pr-3">{formatNumber(session.asleepHours, 1)}h</td>
                    <td className="tabular py-2 pr-3 text-muted-foreground">
                      {session.inBedHours === null ? "—" : `${formatNumber(session.inBedHours, 1)}h`}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {session.stages.length === 0 ? (
                          <span className="text-xs text-muted-foreground">no breakdown</span>
                        ) : (
                          session.stages.map((entry) => (
                            <Badge key={entry.stage} variant="muted" className="text-[10px]">
                              {SLEEP_STAGE_META[entry.stage as SleepStage]?.label ?? entry.stage}{" "}
                              {formatNumber(entry.hours, 1)}h
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{session.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Time asleep counts only the asleep stages (core, deep, REM, or a plain &ldquo;asleep&rdquo;
            record). Awake time and time in bed are shown but never added to it — that is what stops
            &ldquo;8h in bed and 7h asleep&rdquo; reading as fifteen hours.
          </p>
        </SectionCard>
      )}
    </HealthGroupPage>
  );
}
