import type { Metadata } from "next";
import { Suspense } from "react";
import { AlertTriangle, CalendarCheck2, FolderKanban, ListTodo } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { NewTaskButton } from "@/components/tasks/new-task-button";
import {
  TaskBoard,
  type TaskBoardData,
  type TaskItem,
} from "@/components/tasks/task-board";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDay, toDayKey } from "@/lib/date";
import { pluralize } from "@/lib/utils";
import { getTaskBoard } from "@/server/tasks";

export const metadata: Metadata = { title: "Tasks" };
export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const board = await getTaskBoard();

  // Prisma rows carry Date objects; the client board gets plain serializable
  // props only, so every task is mapped field by field here.
  const mapTask = (task: (typeof board.buckets.overdue)[number]): TaskItem => ({
    id: task.id,
    title: task.title,
    notes: task.notes,
    projectId: task.projectId,
    parentId: task.parentId,
    priority: task.priority,
    dueDate: task.dueDate,
    repeat: task.repeat,
    repeatEvery: task.repeatEvery,
    reminderEnabled: task.reminderEnabled,
    project: task.project
      ? {
          id: task.project.id,
          name: task.project.name,
          color: task.project.color,
          status: task.project.status,
        }
      : null,
    subtasks: task.subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.title,
      status: subtask.status,
    })),
    plannerItems: task.scheduleItems.map((item) => ({
      id: item.id,
      date: item.date,
      status: item.status,
    })),
  });

  const boardData: TaskBoardData = {
    today: board.today,
    buckets: {
      overdue: board.buckets.overdue.map(mapTask),
      today: board.buckets.today.map(mapTask),
      upcoming: board.buckets.upcoming.map(mapTask),
      later: board.buckets.later.map(mapTask),
      someday: board.buckets.someday.map(mapTask),
    },
    projects: board.projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      color: project.color,
      status: project.status,
      progress: project.progress,
    })),
    recentlyDone: board.recentlyDone.map((task) => ({
      id: task.id,
      title: task.title,
      completedDay: task.completedAt ? toDayKey(task.completedAt) : null,
    })),
  };

  const overdueCount = boardData.buckets.overdue.length;
  const dueTodayCount = boardData.buckets.today.length;
  const activeProjects = boardData.projects.filter(
    (project) => project.status === "active",
  ).length;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Tasks"
        description="Next actions, projects and due dates. Repeating tasks come back on their own."
        actions={<NewTaskButton />}
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Overdue"
          value={`${overdueCount}`}
          hint={overdueCount > 0 ? "needs attention" : "all clear"}
          icon={AlertTriangle}
          accent={overdueCount > 0 ? "text-red-500" : "text-muted-foreground"}
        />
        <StatCard
          label="Due today"
          value={`${dueTodayCount}`}
          hint={formatDay(board.today)}
          icon={CalendarCheck2}
          accent="text-domain-task"
        />
        <StatCard
          label="Open tasks"
          value={`${board.openCount}`}
          hint={`${boardData.buckets.someday.length} without a date`}
          icon={ListTodo}
          accent="text-domain-task"
        />
        <StatCard
          label="Active projects"
          value={`${activeProjects}`}
          hint={`${boardData.projects.length} ${pluralize(boardData.projects.length, "project")} total`}
          icon={FolderKanban}
          accent="text-domain-task"
        />
      </div>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <TaskBoard board={boardData} />
      </Suspense>
    </div>
  );
}
