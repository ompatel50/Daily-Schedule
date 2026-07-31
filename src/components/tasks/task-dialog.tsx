"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TagInput } from "@/components/shared/tag-input";
import { projectColorDot } from "@/components/tasks/project-colors";
import {
  PRIORITIES,
  PRIORITY_META,
  REPEAT_UNITS,
  REPEAT_UNIT_META,
  type Priority,
  type RepeatUnit,
} from "@/lib/enums";
import { cn } from "@/lib/utils";
import { saveTask } from "@/server/actions/tasks";

export interface TaskDraft {
  id?: string;
  title: string;
  notes: string | null;
  projectId: string | null;
  parentId: string | null;
  priority: string;
  dueDate: string | null;
  repeat: string;
  repeatEvery: number;
  reminderEnabled: boolean;
  /** Tag names — a tag is created by typing it. */
  tags: string[];
}

export interface ProjectOption {
  id: string;
  name: string;
  color: string;
  status: string;
}

export function blankTask(): TaskDraft {
  return {
    title: "",
    notes: null,
    projectId: null,
    parentId: null,
    priority: "medium",
    dueDate: null,
    repeat: "none",
    repeatEvery: 1,
    reminderEnabled: false,
    tags: [],
  };
}

/** Radix Select cannot represent an empty value, so "no project" is a sentinel. */
const NO_PROJECT = "__none";

export function TaskDialog({
  open,
  onOpenChange,
  task,
  parentTitle,
  projects,
  tagSuggestions = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = blank create. A draft with `parentId` but no `id` = new subtask. */
  task?: TaskDraft | null;
  /** Shown when creating a subtask so the parent is visible in the dialog. */
  parentTitle?: string | null;
  projects: ProjectOption[];
  /** Tag names already in use, offered as completions. */
  tagSuggestions?: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(task?.id);
  const isSubtask = Boolean(task?.parentId);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<TaskDraft>(task ?? blankTask());
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(task ?? blankTask());
    setErrors({});
  }, [open, task]);

  function set<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  // Active projects only, plus the current selection even when it is not
  // active anymore — editing a task must not silently drop its project.
  const selectableProjects = projects.filter(
    (project) => project.status === "active" || project.id === form.projectId,
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.title.trim()) {
      setErrors({ title: ["Give the task a title"] });
      return;
    }
    if (form.repeat !== "none" && !form.dueDate) {
      setErrors({ repeat: ["A repeating task needs a due date to repeat from"] });
      return;
    }

    startTransition(async () => {
      const result = await saveTask({
        id: form.id,
        title: form.title.trim(),
        notes: form.notes,
        projectId: form.projectId,
        parentId: form.parentId,
        priority: form.priority,
        dueDate: form.dueDate,
        repeat: form.repeat,
        repeatEvery: form.repeatEvery,
        // A reminder without a due date has nothing to fire on.
        reminderEnabled: form.dueDate ? form.reminderEnabled : false,
        tags: form.tags,
      });

      if (result.ok) {
        toast.success(isEdit ? "Task updated" : isSubtask ? "Subtask added" : "Task created");
        onOpenChange(false);
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {isEdit ? "Edit task" : isSubtask ? "New subtask" : "New task"}
            </DialogTitle>
            <DialogDescription>
              {isSubtask && parentTitle
                ? `A step under "${parentTitle}" — it inherits the project.`
                : "A task is an obligation, not a calendar slot. Give it a due date only when one exists."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                autoFocus
                value={form.title}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? "task-title-error" : undefined}
                onChange={(event) => set("title", event.target.value)}
                placeholder="Renew passport"
              />
              {errors.title && (
                <p id="task-title-error" className="text-xs text-destructive">
                  {errors.title[0]}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-notes">Notes (optional)</Label>
              <Textarea
                id="task-notes"
                rows={3}
                value={form.notes ?? ""}
                onChange={(event) => set("notes", event.target.value || null)}
              />
              {errors.notes && <p className="text-xs text-destructive">{errors.notes[0]}</p>}
            </div>

            {!isSubtask && (
              <div className="space-y-1.5">
                <Label htmlFor="task-project">Project</Label>
                <Select
                  value={form.projectId ?? NO_PROJECT}
                  onValueChange={(value) => set("projectId", value === NO_PROJECT ? null : value)}
                >
                  <SelectTrigger id="task-project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROJECT}>None</SelectItem>
                    {selectableProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-full",
                              projectColorDot(project.color),
                            )}
                          />
                          {project.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="task-tags">Tags (optional)</Label>
              <TagInput
                id="task-tags"
                value={form.tags}
                onChange={(next) => set("tags", next)}
                suggestions={tagSuggestions}
                describedBy="task-tags-hint"
              />
              <p id="task-tags-hint" className="text-xs text-muted-foreground">
                Labels for slicing the list — the project is where a task belongs, tags are how
                you want to find it.
              </p>
              {errors.tags && <p className="text-xs text-destructive">{errors.tags[0]}</p>}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="task-priority">Priority</Label>
                <Select value={form.priority} onValueChange={(value) => set("priority", value)}>
                  <SelectTrigger id="task-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {PRIORITY_META[value as Priority].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-due">Due date (optional)</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.dueDate ?? ""}
                  aria-invalid={Boolean(errors.dueDate)}
                  onChange={(event) => set("dueDate", event.target.value || null)}
                />
                {errors.dueDate && (
                  <p className="text-xs text-destructive">{errors.dueDate[0]}</p>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="task-repeat">Repeat</Label>
                <Select
                  value={form.repeat}
                  onValueChange={(value) => set("repeat", value)}
                >
                  <SelectTrigger
                    id="task-repeat"
                    aria-invalid={Boolean(errors.repeat)}
                    aria-describedby={errors.repeat ? "task-repeat-error" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPEAT_UNITS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {REPEAT_UNIT_META[value as RepeatUnit].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.repeat && (
                  <p id="task-repeat-error" className="text-xs text-destructive">
                    {errors.repeat[0]}
                  </p>
                )}
              </div>
              {form.repeat !== "none" && (
                <div className="space-y-1.5">
                  <Label htmlFor="task-repeat-every">Every</Label>
                  <Input
                    id="task-repeat-every"
                    type="number"
                    min={1}
                    max={365}
                    value={form.repeatEvery}
                    aria-invalid={Boolean(errors.repeatEvery)}
                    onChange={(event) =>
                      set("repeatEvery", Math.max(1, Number(event.target.value) || 1))
                    }
                  />
                  {errors.repeatEvery && (
                    <p className="text-xs text-destructive">{errors.repeatEvery[0]}</p>
                  )}
                </div>
              )}
            </div>

            {form.repeat !== "none" && (
              <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                Completing this task moves its due date to the next occurrence instead of
                closing it — the repeat is the task.
              </p>
            )}

            {form.dueDate && (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="task-reminder">Reminder</Label>
                  <p className="text-xs text-muted-foreground">Reminds on the due date</p>
                </div>
                <Switch
                  id="task-reminder"
                  checked={form.reminderEnabled}
                  onCheckedChange={(checked) => set("reminderEnabled", checked)}
                />
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {isEdit ? "Save changes" : isSubtask ? "Add subtask" : "Create task"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
