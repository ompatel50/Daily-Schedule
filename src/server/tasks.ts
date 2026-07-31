import "server-only";

import { cache } from "react";

import { getCurrentUser, prisma } from "@/lib/db";
import { shiftDay, type DayKey } from "@/lib/date";
import { bucketTasks, projectProgress, tasksDueNow } from "@/lib/logic/tasks";
import { scheduleSettingsFor } from "@/server/schedule";

/**
 * Tasks & projects read model — user-scoped, bounded, with the bucketing done
 * by the pure module so the tasks page and the dashboard agree.
 */

/** Open tasks are capped here; a personal task list beyond this is a data
 *  problem, not a rendering problem. */
const OPEN_TASKS_CAP = 500;

async function openTasksImpl(userId: string) {
  return prisma.task.findMany({
    where: { userId, status: "open" },
    include: {
      project: { select: { id: true, name: true, color: true, status: true } },
      subtasks: {
        select: { id: true, title: true, status: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
    },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { sortOrder: "asc" }],
    take: OPEN_TASKS_CAP,
  });
}

const openTasksMemo = cache(openTasksImpl);

export type TaskWithRefs = Awaited<ReturnType<typeof openTasksImpl>>[number];

export async function getOpenTasks(): Promise<TaskWithRefs[]> {
  const user = await getCurrentUser();
  return openTasksMemo(user.id);
}

/** Everything the tasks page renders. */
export async function getTaskBoard() {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const today = settings.today;
  const doneSince = shiftDay(today, -14);

  const [openTasks, projects, taskCounts, recentlyDone] = await Promise.all([
    openTasksMemo(user.id),
    prisma.project.findMany({
      where: { userId: user.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: 100,
    }),
    // Progress per project from grouped counts — never a full task scan.
    prisma.task.groupBy({
      by: ["projectId", "status"],
      where: { userId: user.id, projectId: { not: null } },
      _count: { _all: true },
    }),
    prisma.task.findMany({
      where: {
        userId: user.id,
        status: "done",
        completedAt: { gte: new Date(`${doneSince}T00:00:00`) },
      },
      include: { project: { select: { id: true, name: true, color: true } } },
      orderBy: { completedAt: "desc" },
      take: 30,
    }),
  ]);

  const countsByProject = new Map<string, Array<{ status: string }>>();
  for (const row of taskCounts) {
    if (!row.projectId) continue;
    const list = countsByProject.get(row.projectId) ?? [];
    for (let i = 0; i < row._count._all; i += 1) list.push({ status: row.status });
    countsByProject.set(row.projectId, list);
  }

  return {
    today,
    buckets: bucketTasks(openTasks, today),
    openCount: openTasks.filter((task) => task.parentId === null).length,
    projects: projects.map((project) => ({
      ...project,
      progress: projectProgress(countsByProject.get(project.id) ?? []),
    })),
    recentlyDone,
  };
}

export type TaskBoard = Awaited<ReturnType<typeof getTaskBoard>>;

/** The bounded slice of tasks the dashboard shows. */
export async function getTaskSummary() {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const today = settings.today;

  const [openTasks, activeProjects] = await Promise.all([
    openTasksMemo(user.id),
    prisma.project.count({ where: { userId: user.id, status: "active" } }),
  ]);

  const buckets = bucketTasks(openTasks, today);
  const dueNow = tasksDueNow(openTasks, today);

  return {
    today,
    openCount: openTasks.filter((task) => task.parentId === null).length,
    overdueCount: buckets.overdue.length,
    dueTodayCount: buckets.today.length,
    activeProjects,
    top: dueNow.slice(0, 5).map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate as DayKey | null,
      projectName: task.project?.name ?? null,
      projectColor: task.project?.color ?? null,
    })),
  };
}

export type TaskSummary = Awaited<ReturnType<typeof getTaskSummary>>;
