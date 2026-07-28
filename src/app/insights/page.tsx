import type { Metadata } from "next";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Flame,
  HeartPulse,
  Lightbulb,
  Moon,
  Scale,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { MetricEntry } from "@/components/health/metric-entry";
import { TrendAreaChart, TrendLineChart } from "@/components/shared/charts";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import type { HealthMetricType } from "@/lib/enums";
import { formatDay, formatDuration, lastNDays, shiftDay, today } from "@/lib/date";
import { buildInsights, suggestFocus } from "@/lib/logic/insights";
import { movingAverage } from "@/lib/logic/scoring";
import { cn, formatNumber, pct } from "@/lib/utils";
import {
  getGoalMap,
  getHabitsWithStats,
  getHealthMetrics,
  getUser,
  getWindowStats,
} from "@/server/queries";

export const metadata: Metadata = { title: "Insights" };
export const dynamic = "force-dynamic";

const TREND_DAYS = 60;

export default async function InsightsPage() {
  const date = today();
  const user = await getUser();

  const [thisWeek, lastWeek, habits, goals, metrics] = await Promise.all([
    getWindowStats(shiftDay(date, -6), date),
    getWindowStats(shiftDay(date, -13), shiftDay(date, -7)),
    getHabitsWithStats(date, { historyDays: 90 }),
    getGoalMap(),
    getHealthMetrics(shiftDay(date, -(TREND_DAYS - 1)), date),
  ]);

  const calorieGoal = goals.get("calories")?.target ?? 0;
  const workoutGoal = goals.get("workouts_per_week")?.target ?? 0;
  const stepGoal = goals.get("steps")?.target ?? 0;
  const sleepGoal = goals.get("sleep_hours")?.target ?? 0;

  const ranked = habits.slice().sort((a, b) => b.streak - a.streak);
  const bestHabit = ranked[0];
  // Only habits that have actually had a scheduled opportunity can be "weak" —
  // a habit with nothing scheduled yet reports null, not 0%.
  const weakestHabit = habits
    .filter((habit): habit is typeof habit & { completionRate: number } =>
      habit.completionRate !== null,
    )
    .sort((a, b) => a.completionRate - b.completionRate)
    .find((habit) => habit.completionRate < 60);

  const insights = buildInsights(thisWeek, lastWeek, {
    scores: thisWeek.summaries.map((summary) => summary.score),
    bestHabit: bestHabit ? { name: bestHabit.name, streak: bestHabit.streak } : undefined,
    weakestHabit: weakestHabit
      ? { name: weakestHabit.name, completionRate: weakestHabit.completionRate }
      : undefined,
    calorieGoal,
    workoutGoal,
  });

  const focus = suggestFocus(insights);

  // Health series.
  const days = lastNDays(TREND_DAYS, date);
  const metricByTypeDate = new Map<string, number>();
  for (const metric of metrics) metricByTypeDate.set(`${metric.type}:${metric.date}`, metric.value);

  const series = (type: HealthMetricType) =>
    days.map((day) => metricByTypeDate.get(`${type}:${day}`) ?? null);

  const weightRaw = series("body_weight");
  const weightSmoothed = movingAverage(weightRaw, 7);
  const weightData = days.map((day, index) => ({
    label: formatDay(day, "M/d"),
    weight: weightRaw[index],
    average: weightSmoothed[index] === null ? null : Math.round(weightSmoothed[index]! * 10) / 10,
  }));

  const stepsData = days.map((day, index) => ({
    label: formatDay(day, "M/d"),
    steps: series("steps")[index] ?? 0,
  }));

  const sleepData = days.map((day, index) => ({
    label: formatDay(day, "M/d"),
    sleep: series("sleep_hours")[index],
    hr: series("resting_hr")[index],
  }));

  const latest = (type: HealthMetricType) => {
    for (let index = days.length - 1; index >= 0; index -= 1) {
      const value = metricByTypeDate.get(`${type}:${days[index]}`);
      if (value !== undefined) return value;
    }
    return null;
  };

  const latestWeight = latest("body_weight");
  const latestSteps = latest("steps");
  const latestSleep = latest("sleep_hours");
  const latestHr = latest("resting_hr");

  const weightUnit = user.unitSystem === "metric" ? "kg" : "lb";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Insights"
        description="What changed this week, what's improving, and what to focus on next."
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Weekly score"
          value={`${thisWeek.averageScore}`}
          hint={`last week ${lastWeek.averageScore}`}
          icon={Flame}
          accent="text-emerald-500"
          progress={thisWeek.averageScore}
          progressClassName="bg-emerald-500"
          delta={
            lastWeek.averageScore > 0
              ? Math.round(
                  ((thisWeek.averageScore - lastWeek.averageScore) / lastWeek.averageScore) * 100,
                )
              : undefined
          }
        />
        <StatCard
          label="Completion"
          value={`${thisWeek.planned > 0 ? pct(thisWeek.completed, thisWeek.planned) : 0}%`}
          hint={`${thisWeek.completed} of ${thisWeek.planned} items`}
          icon={CheckCircle2}
          accent="text-domain-planner"
          progress={thisWeek.planned > 0 ? pct(thisWeek.completed, thisWeek.planned) : 0}
          progressClassName="bg-domain-planner"
        />
        <StatCard
          label="Habit rate"
          value={`${thisWeek.habitsDue > 0 ? pct(thisWeek.habitsDone, thisWeek.habitsDue) : 0}%`}
          hint={`${thisWeek.habitsDone} of ${thisWeek.habitsDue} due`}
          icon={TrendingUp}
          accent="text-domain-habit"
          progress={thisWeek.habitsDue > 0 ? pct(thisWeek.habitsDone, thisWeek.habitsDue) : 0}
          progressClassName="bg-domain-habit"
        />
        <StatCard
          label="Training"
          value={`${thisWeek.workouts}`}
          hint={formatDuration(thisWeek.workoutMinutes)}
          icon={Activity}
          accent="text-domain-workout"
          progress={pct(thisWeek.workouts, workoutGoal)}
          progressClassName="bg-domain-workout"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="Weekly review"
            icon={Sparkles}
            accent="text-amber-500"
            description="Last 7 days versus the week before"
          >
            {insights.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Track a few days and this fills in with real observations.
              </p>
            ) : (
              <div className="space-y-2">
                {insights.map((insight) => (
                  <div
                    key={insight.id}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border border-l-[3px] px-3 py-2.5",
                      insight.tone === "positive"
                        ? "border-l-emerald-500 bg-emerald-500/[0.04]"
                        : insight.tone === "attention"
                          ? "border-l-amber-500 bg-amber-500/[0.04]"
                          : "border-l-border",
                    )}
                  >
                    {insight.tone === "positive" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    ) : insight.tone === "attention" ? (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    ) : (
                      <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{insight.title}</p>
                      <p className="text-xs text-muted-foreground">{insight.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Body weight"
            icon={Scale}
            accent="text-domain-health"
            description={`Raw entries with a 7-day average (${weightUnit})`}
          >
            <TrendLineChart
              data={weightData}
              unit={` ${weightUnit}`}
              lines={[
                { dataKey: "weight", name: "Weight", color: "hsl(var(--domain-health) / 0.45)" },
                { dataKey: "average", name: "7-day avg", color: "hsl(var(--domain-health))" },
              ]}
            />
          </SectionCard>

          <div className="grid gap-6 md:grid-cols-2">
            <SectionCard title="Steps" icon={Activity} accent="text-emerald-500">
              <TrendAreaChart
                data={stepsData}
                dataKey="steps"
                color="hsl(var(--domain-habit))"
                goal={stepGoal}
                height={170}
              />
            </SectionCard>

            <SectionCard title="Sleep & resting HR" icon={Moon} accent="text-domain-planner">
              <TrendLineChart
                data={sleepData}
                height={170}
                lines={[
                  { dataKey: "sleep", name: "Sleep (h)", color: "hsl(var(--domain-planner))" },
                  { dataKey: "hr", name: "Resting HR", color: "hsl(var(--destructive))" },
                ]}
              />
            </SectionCard>
          </div>
        </div>

        <div className="space-y-6">
          <SectionCard title="Focus next" icon={Lightbulb} accent="text-amber-500">
            <p className="rounded-lg bg-amber-500/10 px-3 py-3 text-sm">{focus}</p>
          </SectionCard>

          <SectionCard title="Log health data" icon={HeartPulse} accent="text-domain-health">
            <MetricEntry date={date} unitSystem={user.unitSystem} />
            <p className="mt-3 text-xs text-muted-foreground">
              Entries are stored per day and per source, so an Apple Health import can be added later
              without overwriting anything you typed by hand.
            </p>
          </SectionCard>

          <SectionCard title="Latest readings" icon={Activity} accent="text-domain-health">
            <div className="space-y-2 text-sm">
              <Reading
                label="Body weight"
                value={latestWeight !== null ? `${formatNumber(latestWeight, 1)} ${weightUnit}` : "—"}
              />
              <Reading
                label="Steps"
                value={latestSteps !== null ? formatNumber(latestSteps) : "—"}
                goal={stepGoal > 0 ? `goal ${formatNumber(stepGoal)}` : undefined}
              />
              <Reading
                label="Sleep"
                value={latestSleep !== null ? `${formatNumber(latestSleep, 1)} h` : "—"}
                goal={sleepGoal > 0 ? `goal ${formatNumber(sleepGoal, 1)} h` : undefined}
              />
              <Reading
                label="Resting HR"
                value={latestHr !== null ? `${formatNumber(latestHr)} bpm` : "—"}
              />
            </div>
          </SectionCard>

          <SectionCard title="Habit leaderboard" icon={TrendingUp} accent="text-domain-habit">
            {ranked.length === 0 ? (
              <p className="text-sm text-muted-foreground">No habits yet.</p>
            ) : (
              <div className="space-y-1.5">
                {ranked.slice(0, 6).map((habit) => (
                  <div key={habit.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{habit.name}</span>
                    <Badge variant="muted" className="shrink-0 text-[10px]">
                      {habit.completionRate}%
                    </Badge>
                    <span className="tabular w-10 shrink-0 text-right text-xs text-orange-500">
                      🔥 {habit.streak}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function Reading({ label, value, goal }: { label: string; value: string; goal?: string }) {
  return (
    <div className="flex items-center justify-between border-b pb-1.5 last:border-0">
      <div>
        <p className="text-muted-foreground">{label}</p>
        {goal && <p className="text-[10px] text-muted-foreground/70">{goal}</p>}
      </div>
      <span className="tabular font-medium">{value}</span>
    </div>
  );
}
