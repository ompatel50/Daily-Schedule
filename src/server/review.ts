import "server-only";

import { getCurrentUser, prisma } from "@/lib/db";
import { formatWeekRange, shiftDay, type DayKey } from "@/lib/date";
import { getWeekBounds } from "@/lib/logic/schedule";
import { getBudgetSnapshot, type BudgetSnapshot } from "@/server/finance";
import { getWeeklyReview, type WeeklyReview } from "@/server/insights";
import { scheduleSettingsFor } from "@/server/schedule";

/**
 * The weekly review page's read model. Deliberately assembled from the SAME
 * computations the assistant and insights already use — `getWeeklyReview`
 * behind `get_week_review`, the finance page's budget progress — plus the
 * two review-specific slices: the week's unfinished tasks and the journal
 * entry the reflection note saves into.
 */
export interface WeeklyReviewPage {
  week: { start: DayKey; end: DayKey; label: string };
  /** The week this one rolls tasks into. */
  nextWeekStart: DayKey;
  /** Anchors for the prev/next navigation. */
  previousAnchor: DayKey;
  nextAnchor: DayKey | null;
  isCurrentWeek: boolean;
  review: WeeklyReview;
  /** Open tasks due inside (or before) this week — the roll-forward list. */
  unfinishedTasks: Array<{
    id: string;
    title: string;
    priority: string;
    dueDate: DayKey;
    projectName: string | null;
  }>;
  money: BudgetSnapshot;
  /**
   * The reflection note's home: the day it saves under and what that day's
   * journal already holds, so saving never silently overwrites a page the
   * user can't see.
   */
  reflection: { date: DayKey; title: string | null; content: string | null };
}

export async function getWeeklyReviewPage(anchor?: DayKey): Promise<WeeklyReviewPage> {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const week = getWeekBounds(anchor ?? settings.today, settings);
  const isCurrentWeek = settings.today >= week.start && settings.today <= week.end;

  // Mid-week, the reflection belongs to today — a journal entry dated in the
  // future would be odd to meet on the Journal page. Reviewing a past week
  // writes under that week's own last day.
  const reflectionDate = isCurrentWeek ? settings.today : week.end;

  const [review, unfinished, money, journal] = await Promise.all([
    getWeeklyReview(user.id, week.start, week.end, settings),
    prisma.task.findMany({
      where: { userId: user.id, status: "open", dueDate: { lte: week.end } },
      include: { project: { select: { name: true, deletedAt: true } } },
      orderBy: [{ dueDate: "asc" }, { sortOrder: "asc" }],
      take: 50,
    }),
    getBudgetSnapshot(),
    prisma.journalEntry.findFirst({ where: { userId: user.id, date: reflectionDate } }),
  ]);

  return {
    week: {
      start: week.start,
      end: week.end,
      label: formatWeekRange(week.start, settings.weekStartsOn),
    },
    nextWeekStart: shiftDay(week.start, 7),
    previousAnchor: shiftDay(week.start, -7),
    nextAnchor: isCurrentWeek ? null : shiftDay(week.start, 7),
    isCurrentWeek,
    review,
    unfinishedTasks: unfinished.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate as DayKey,
      // The to-one Trash boundary (src/lib/soft-delete.ts): a trashed
      // project is no project.
      projectName: task.project && !task.project.deletedAt ? task.project.name : null,
    })),
    money,
    reflection: {
      date: reflectionDate,
      title: journal?.title ?? null,
      content: journal?.content ?? null,
    },
  };
}
