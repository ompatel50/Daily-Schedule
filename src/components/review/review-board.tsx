"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpenCheck, Loader2, NotebookPen } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Textarea } from "@/components/ui/textarea";
import { formatDay } from "@/lib/date";
import { formatCents } from "@/lib/logic/money";
import { cn } from "@/lib/utils";
import { saveJournalEntry } from "@/server/actions/health";
import { rollTaskForward } from "@/server/actions/tasks";
import type { WeeklyReviewPage } from "@/server/review";

/**
 * The guided weekly review: the week's facts (the same computation behind
 * the assistant's get_week_review), the unfinished tasks with one-click
 * roll-forward, the money snapshot, and a reflection note that saves as an
 * ordinary journal entry — prefilled with that day's page so saving never
 * silently overwrites it.
 */
export function ReviewBoard({ page }: { page: WeeklyReviewPage }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [rolled, setRolled] = React.useState<Record<string, boolean>>({});
  const [note, setNote] = React.useState(page.reflection.content ?? "");

  React.useEffect(() => setNote(page.reflection.content ?? ""), [page.reflection.content]);
  React.useEffect(() => setRolled({}), [page.week.start]);

  const { review } = page;
  const remaining = page.unfinishedTasks.filter((task) => !rolled[task.id]);

  function roll(taskIds: string[]) {
    startTransition(async () => {
      let moved = 0;
      for (const id of taskIds) {
        const result = await rollTaskForward(id, page.nextWeekStart);
        if (result.ok) {
          moved += 1;
          setRolled((state) => ({ ...state, [id]: true }));
        } else {
          toast.error(result.error);
        }
      }
      if (moved > 0) {
        toast.success(
          `${moved === 1 ? "1 task" : `${moved} tasks`} rolled to the week of ${formatDay(
            page.nextWeekStart,
            "MMM d",
          )}`,
        );
        router.refresh();
      }
    });
  }

  function saveNote() {
    startTransition(async () => {
      const result = await saveJournalEntry({
        date: page.reflection.date,
        title: page.reflection.title ?? "Weekly review",
        content: note,
      });
      if (result.ok) toast.success("Reflection saved to your journal");
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* --- score recap ---------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Average score"
          value={review.averageScore === null ? "—" : `${review.averageScore}`}
          hint={`${review.scoredDays} scored ${review.scoredDays === 1 ? "day" : "days"} · ${review.restDays} rest`}
          icon={BookOpenCheck}
          accent="text-domain-habit"
        />
        <StatCard
          label="Planner"
          value={review.planner.rate === null ? "—" : `${review.planner.rate}%`}
          hint={`${review.planner.completed}/${review.planner.scheduled} blocks done`}
          icon={BookOpenCheck}
          accent="text-domain-task"
        />
        <StatCard
          label="Habits"
          value={review.habits.rate === null ? "—" : `${review.habits.rate}%`}
          hint={`${review.habits.completed}/${review.habits.scheduled} opportunities`}
          icon={BookOpenCheck}
          accent="text-emerald-500"
        />
      </div>

      <SectionCard
        title="How the week went"
        icon={BookOpenCheck}
        accent="text-domain-habit"
        description={review.focus}
      >
        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {review.strongest && (
            <p>
              <span className="text-muted-foreground">Strongest area:</span>{" "}
              {review.strongest.label} ({review.strongest.completed}/{review.strongest.scheduled})
            </p>
          )}
          {review.mostMissed && review.mostMissed.missed > 0 && (
            <p>
              <span className="text-muted-foreground">Most missed:</span>{" "}
              {review.mostMissed.label} ({review.mostMissed.missed} missed)
            </p>
          )}
          <p>
            <span className="text-muted-foreground">Workouts:</span> {review.workouts.completed}{" "}
            completed · {review.workouts.minutes} min
          </p>
          <p>
            <span className="text-muted-foreground">Nutrition:</span> {review.nutrition.loggedDays}{" "}
            {review.nutrition.loggedDays === 1 ? "day" : "days"} logged
            {review.nutrition.averageCalories !== null &&
              ` · ~${review.nutrition.averageCalories} kcal/day`}
          </p>
        </div>
      </SectionCard>

      {/* --- unfinished tasks ----------------------------------------------- */}
      <SectionCard
        title="Unfinished tasks"
        icon={ArrowRight}
        accent="text-domain-task"
        description={
          remaining.length === 0
            ? "Nothing due this week is still open. Clean slate."
            : `${remaining.length} still open — roll what still matters into next week`
        }
        action={
          remaining.length > 1 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => roll(remaining.map((task) => task.id))}
            >
              Roll all to next week
            </Button>
          ) : undefined
        }
      >
        {remaining.length > 0 && (
          <ul className="space-y-1.5">
            {remaining.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                {task.projectName && (
                  <Badge variant="outline" className="text-[10px]">
                    {task.projectName}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  due {formatDay(task.dueDate, "MMM d")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => roll([task.id])}
                >
                  <ArrowRight /> Next week
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* --- money snapshot -------------------------------------------------- */}
      <SectionCard
        title="Money this month"
        icon={BookOpenCheck}
        accent="text-domain-finance"
        description={`${formatCents(page.money.month.spending)} spent · ${formatCents(page.money.month.income)} in`}
      >
        {page.money.budgets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No budgets set up.</p>
        ) : (
          <ul className="space-y-2">
            {page.money.budgets.map((budget) => (
              <li key={budget.id} className="text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>
                    {budget.label}
                    <span className="ml-1 text-xs text-muted-foreground">/{budget.period}</span>
                  </span>
                  <span
                    className={cn(
                      "tabular text-xs",
                      budget.over ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground",
                    )}
                  >
                    {formatCents(budget.spent)} of {formatCents(budget.effectiveAmount)} ·{" "}
                    {budget.percent}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      budget.over ? "bg-red-500" : "bg-domain-finance",
                    )}
                    style={{ width: `${Math.min(100, budget.percent)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* --- reflection ------------------------------------------------------ */}
      <SectionCard
        title="Reflection"
        icon={NotebookPen}
        accent="text-domain-journal"
        description={`Saves to your journal for ${formatDay(page.reflection.date)} — prefilled with that day's entry, so nothing is overwritten unseen`}
      >
        <div className="space-y-2">
          <Textarea
            aria-label="Weekly reflection"
            rows={5}
            placeholder="What worked? What didn't? What changes next week?"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex justify-end">
            <Button disabled={pending || !note.trim()} onClick={saveNote}>
              {pending && <Loader2 className="animate-spin" />}
              Save reflection
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
