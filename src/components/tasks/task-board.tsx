"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Archive,
  CalendarCheck2,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  Circle,
  Cloud,
  FolderKanban,
  MinusCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Repeat2,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { projectColorDot } from "@/components/tasks/project-colors";
import { ProjectDialog, type ProjectDraft } from "@/components/tasks/project-dialog";
import { TaskDialog, blankTask, type TaskDraft } from "@/components/tasks/task-dialog";
import { formatDay } from "@/lib/date";
import { PRIORITY_META, PROJECT_STATUS_META, type Priority, type ProjectStatus } from "@/lib/enums";
import { describeDueDistance, isOverdue } from "@/lib/logic/due";
import { describeRepeat } from "@/lib/logic/tasks";
import { cn, pluralize } from "@/lib/utils";
import {
  completeTask,
  deleteProject,
  deleteTask,
  dropTask,
  reopenTask,
  setProjectStatus,
} from "@/server/actions/tasks";
import type { ActionResult } from "@/lib/validation";

export type BucketKey = "overdue" | "today" | "upcoming" | "later" | "someday";

export interface SubtaskItem {
  id: string;
  title: string;
  status: string;
}

export interface TaskItem extends TaskDraft {
  id: string;
  project: { id: string; name: string; color: string; status: string } | null;
  subtasks: SubtaskItem[];
}

export interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  color: string;
  status: string;
  progress: { total: number; done: number; open: number; percent: number | null };
}

export interface DoneTaskItem {
  id: string;
  title: string;
  /** Day key derived from `completedAt`, null if the stamp is missing. */
  completedDay: string | null;
}

export interface TaskBoardData {
  today: string;
  buckets: Record<BucketKey, TaskItem[]>;
  projects: ProjectItem[];
  recentlyDone: DoneTaskItem[];
}

const BUCKET_META: Array<{ key: BucketKey; title: string; icon: LucideIcon; accent: string }> = [
  { key: "overdue", title: "Overdue", icon: AlertTriangle, accent: "text-red-500" },
  { key: "today", title: "Today", icon: CalendarCheck2, accent: "text-domain-task" },
  { key: "upcoming", title: "Upcoming", icon: CalendarDays, accent: "text-domain-task" },
  { key: "later", title: "Later", icon: CalendarRange, accent: "text-muted-foreground" },
  { key: "someday", title: "Someday", icon: Cloud, accent: "text-muted-foreground" },
];

/** Display order for the projects card: running work first, archive last. */
const PROJECT_STATUS_RANK: Record<string, number> = { active: 0, completed: 1, archived: 2 };

/**
 * The tasks page: due-date buckets on the left, projects and recent history on
 * the right. Completing a repeating task advances it instead of closing it.
 */
export function TaskBoard({ board }: { board: TaskBoardData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = React.useTransition();

  const [taskDialogOpen, setTaskDialogOpen] = React.useState(false);
  const [editingTask, setEditingTask] = React.useState<TaskDraft | null>(null);
  const [parentTitle, setParentTitle] = React.useState<string | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<ProjectDraft | null>(null);
  const [completing, setCompleting] = React.useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  // Optimistic checkmarks are cleared once fresh data arrives.
  React.useEffect(() => setCompleting({}), [board]);

  React.useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditingTask(null);
      setParentTitle(null);
      setTaskDialogOpen(true);
    }
  }, [searchParams]);

  function handleTaskDialogChange(next: boolean) {
    setTaskDialogOpen(next);
    // `?new=1` opened the dialog; strip it so the header button can reopen it.
    if (!next && searchParams.get("new") === "1") router.replace(pathname, { scroll: false });
  }

  function run(fn: () => Promise<ActionResult<unknown>>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) toast.success(message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  /** Checkbox click: complete an open task, reopen a checked subtask. */
  function toggleDone(id: string, status: string) {
    if (status !== "open") {
      run(() => reopenTask(id), "Task reopened");
      return;
    }
    setCompleting((state) => ({ ...state, [id]: true }));
    startTransition(async () => {
      const result = await completeTask(id);
      if (result.ok) {
        if (result.data.status === "advanced" && result.data.nextDue) {
          toast.success(`Done — next on ${formatDay(result.data.nextDue)}`);
        } else {
          toast.success("Task completed");
        }
      } else {
        toast.error(result.error);
        setCompleting((state) => {
          const { [id]: _removed, ...rest } = state;
          return rest;
        });
      }
      router.refresh();
    });
  }

  function openEditTask(task: TaskItem) {
    setEditingTask({
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
    });
    setParentTitle(null);
    setTaskDialogOpen(true);
  }

  function openAddSubtask(task: TaskItem) {
    setEditingTask({ ...blankTask(), parentId: task.id, projectId: task.projectId });
    setParentTitle(task.title);
    setTaskDialogOpen(true);
  }

  function openEditProject(project: ProjectItem) {
    setEditingProject({
      id: project.id,
      name: project.name,
      description: project.description,
      color: project.color,
    });
    setProjectDialogOpen(true);
  }

  const nothingDueNow = board.buckets.overdue.length === 0 && board.buckets.today.length === 0;
  const projects = [...board.projects].sort(
    (a, b) => (PROJECT_STATUS_RANK[a.status] ?? 9) - (PROJECT_STATUS_RANK[b.status] ?? 9),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {nothingDueNow && (
          <SectionCard title="Today" icon={CalendarCheck2} accent="text-domain-task">
            <EmptyState
              icon={CheckCircle2}
              title="Nothing due right now"
              description="Enjoy it — or pull something forward from Upcoming."
              className="py-6"
            />
          </SectionCard>
        )}

        {BUCKET_META.map(({ key, title, icon, accent }) => {
          const tasks = board.buckets[key];
          if (tasks.length === 0) return null;
          return (
            <SectionCard
              key={key}
              title={title}
              icon={icon}
              accent={accent}
              description={`${tasks.length} ${pluralize(tasks.length, "task")}`}
            >
              <div className="space-y-2">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    today={board.today}
                    completing={completing}
                    expanded={Boolean(expanded[task.id])}
                    onToggleExpand={() =>
                      setExpanded((state) => ({ ...state, [task.id]: !state[task.id] }))
                    }
                    onToggleDone={toggleDone}
                    onEdit={() => openEditTask(task)}
                    onAddSubtask={() => openAddSubtask(task)}
                    onDrop={() => run(() => dropTask(task.id), "Task dropped")}
                    onDelete={() => run(() => deleteTask(task.id), "Task deleted")}
                  />
                ))}
              </div>
            </SectionCard>
          );
        })}
      </div>

      <div className="space-y-6">
        <SectionCard
          title="Projects"
          icon={FolderKanban}
          accent="text-domain-task"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditingProject(null);
                setProjectDialogOpen(true);
              }}
            >
              <Plus /> New project
            </Button>
          }
        >
          {projects.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title="No projects yet"
              description="Group related tasks to see progress at a glance."
              className="py-6"
            />
          ) : (
            <div className="space-y-3">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  onEdit={() => openEditProject(project)}
                  onSetStatus={(status, message) =>
                    run(() => setProjectStatus(project.id, status), message)
                  }
                  onDelete={() =>
                    run(
                      () => deleteProject(project.id),
                      "Project deleted — its tasks are standalone now",
                    )
                  }
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Recently done"
          icon={CheckCircle2}
          accent="text-emerald-500"
          description="Last 14 days"
        >
          {board.recentlyDone.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing finished yet — it'll show up here"
              className="py-6"
            />
          ) : (
            <div className="space-y-0.5">
              {board.recentlyDone.map((task) => (
                <div key={task.id} className="flex items-center gap-2 rounded-md px-1 py-1">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">
                    {task.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {task.completedDay ? formatDay(task.completedDay, "MMM d") : "—"}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Reopen ${task.title}`}
                        onClick={() => run(() => reopenTask(task.id), "Task reopened")}
                      >
                        <Undo2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reopen</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={handleTaskDialogChange}
        task={editingTask}
        parentTitle={parentTitle}
        projects={board.projects}
      />
      <ProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        project={editingProject}
      />
    </div>
  );
}

function TaskRow({
  task,
  today,
  completing,
  expanded,
  onToggleExpand,
  onToggleDone,
  onEdit,
  onAddSubtask,
  onDrop,
  onDelete,
}: {
  task: TaskItem;
  today: string;
  completing: Record<string, boolean>;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleDone: (id: string, status: string) => void;
  onEdit: () => void;
  onAddSubtask: () => void;
  onDrop: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const checked = Boolean(completing[task.id]);
  const overdue = task.dueDate !== null && isOverdue(task.dueDate, today);
  const priorityMeta = PRIORITY_META[task.priority as Priority];
  const showPriority = task.priority === "high" || task.priority === "urgent";

  // Dropped subtasks are not obligations, so they count toward neither side.
  const countable = task.subtasks.filter((subtask) => subtask.status !== "dropped");
  const subtasksDone = countable.filter((subtask) => subtask.status === "done").length;

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onToggleDone(task.id, "open")}
          disabled={checked}
          aria-label={`Complete ${task.title}`}
          className="mt-0.5 shrink-0 rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        >
          {checked ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <Circle className="h-5 w-5" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-sm font-medium", checked && "line-through opacity-70")}>
              {task.title}
            </span>
            {task.project && (
              <span className="inline-flex max-w-40 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    projectColorDot(task.project.color),
                  )}
                />
                <span className="truncate">{task.project.name}</span>
              </span>
            )}
            {showPriority && (
              <Badge variant="outline" className={cn("text-[10px]", priorityMeta?.chip)}>
                {priorityMeta?.label}
              </Badge>
            )}
          </div>

          {(task.dueDate || task.repeat !== "none" || countable.length > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {task.dueDate && (
                <span className={cn(overdue && "font-medium text-red-700 dark:text-red-400")}>
                  {describeDueDistance(task.dueDate, today)}
                </span>
              )}
              {task.repeat !== "none" && (
                <span
                  className="inline-flex items-center gap-1"
                  title={describeRepeat(task.repeat, task.repeatEvery)}
                >
                  <Repeat2 className="h-3 w-3" aria-hidden="true" />
                  {describeRepeat(task.repeat, task.repeatEvery)}
                </span>
              )}
              {countable.length > 0 && (
                <button
                  type="button"
                  onClick={onToggleExpand}
                  aria-expanded={expanded}
                  className="tabular inline-flex items-center gap-0.5 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {subtasksDone}/{countable.length}
                  <ChevronDown
                    className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          )}

          {expanded && countable.length > 0 && (
            <div className="mt-2 space-y-1 border-l pl-3">
              {countable.map((subtask) => {
                const subChecked = subtask.status === "done" || Boolean(completing[subtask.id]);
                return (
                  <div key={subtask.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onToggleDone(subtask.id, subtask.status)}
                      disabled={Boolean(completing[subtask.id])}
                      aria-label={
                        subChecked ? `Reopen ${subtask.title}` : `Complete ${subtask.title}`
                      }
                      className="shrink-0 rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                    >
                      {subChecked ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <Circle className="h-4 w-4" />
                      )}
                    </button>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        subChecked && "text-muted-foreground line-through",
                      )}
                    >
                      {subtask.title}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DropdownMenu onOpenChange={(open) => !open && setConfirmingDelete(false)}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${task.title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddSubtask}>
              <Plus /> Add subtask
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDrop}>
              <MinusCircle /> Drop
            </DropdownMenuItem>
            {confirmingDelete ? (
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 /> Really delete?
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                destructive
                onSelect={(event) => {
                  event.preventDefault();
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  onEdit,
  onSetStatus,
  onDelete,
}: {
  project: ProjectItem;
  onEdit: () => void;
  onSetStatus: (status: ProjectStatus, message: string) => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const statusMeta = PROJECT_STATUS_META[project.status as ProjectStatus];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full", projectColorDot(project.color))}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
        {project.status !== "active" && statusMeta && (
          <Badge variant="outline" className={cn("text-[10px]", statusMeta.chip)}>
            {statusMeta.label}
          </Badge>
        )}
        <DropdownMenu onOpenChange={(open) => !open && setConfirmingDelete(false)}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${project.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            {project.status === "active" ? (
              <DropdownMenuItem onSelect={() => onSetStatus("completed", "Project completed")}>
                <CheckCircle2 /> Mark completed
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onSetStatus("active", "Project reactivated")}>
                <Undo2 /> Reactivate
              </DropdownMenuItem>
            )}
            {project.status !== "archived" && (
              <DropdownMenuItem onSelect={() => onSetStatus("archived", "Project archived")}>
                <Archive /> Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {confirmingDelete ? (
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 /> Really delete?
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                destructive
                onSelect={(event) => {
                  event.preventDefault();
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-2 pl-[18px]">
        {project.progress.percent === null ? (
          <span className="text-xs text-muted-foreground">No tasks yet</span>
        ) : (
          <>
            <Progress
              value={project.progress.percent}
              className="h-1.5 flex-1"
              indicatorClassName={projectColorDot(project.color)}
            />
            <span className="tabular shrink-0 text-xs text-muted-foreground">
              {project.progress.done}/{project.progress.total} done
            </span>
          </>
        )}
      </div>
    </div>
  );
}
