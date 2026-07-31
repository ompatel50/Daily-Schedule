"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { Textarea } from "@/components/ui/textarea";
import { PRIORITIES, PRIORITY_META, type Priority } from "@/lib/enums";
import { convertInboxItemToTask } from "@/server/actions/inbox";

export interface ConvertSource {
  id: string;
  title: string;
  notes: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
}

const NO_PROJECT = "none";

/**
 * The bridge out of the inbox: one capture becomes one task, with the fields
 * the task dialog would have asked. The item leaves the open queue (archived,
 * linked) and the work continues on /tasks.
 */
export function ConvertTaskDialog({
  item,
  projects,
  onClose,
}: {
  /** The inbox item being converted; null closes the dialog. */
  item: ConvertSource | null;
  projects: ProjectOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [projectId, setProjectId] = React.useState(NO_PROJECT);
  const [priority, setPriority] = React.useState<string>("medium");
  const [dueDate, setDueDate] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!item) return;
    setTitle(item.title);
    setNotes(item.notes ?? "");
    setProjectId(NO_PROJECT);
    setPriority("medium");
    setDueDate("");
    setErrors({});
  }, [item]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!item) return;
    setErrors({});

    if (!title.trim()) {
      setErrors({ title: ["Give the task a title"] });
      return;
    }

    startTransition(async () => {
      const result = await convertInboxItemToTask({
        id: item.id,
        title: title.trim(),
        notes: notes.trim() || null,
        projectId: projectId === NO_PROJECT ? null : projectId,
        priority,
        dueDate: dueDate || null,
      });

      if (result.ok) {
        toast.success("Now a task", {
          description: "The capture moved to your task list.",
          action: { label: "Open Tasks", onClick: () => router.push("/tasks") },
        });
        onClose();
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Make this a task</DialogTitle>
            <DialogDescription>
              The capture leaves the inbox and continues on{" "}
              <Link href="/tasks" className="underline-offset-2 hover:underline">
                Tasks
              </Link>
              . Nothing is duplicated — converting again is blocked while the task exists.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="convert-title">Title</Label>
              <Input
                id="convert-title"
                autoFocus
                value={title}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? "convert-title-error" : undefined}
                onChange={(event) => setTitle(event.target.value)}
              />
              {errors.title && (
                <p id="convert-title-error" className="text-xs text-destructive">
                  {errors.title[0]}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="convert-due">Due date (optional)</Label>
                <Input
                  id="convert-due"
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="convert-priority">Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="convert-priority">
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
            </div>

            {projects.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="convert-project">Project (optional)</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="convert-project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROJECT}>No project</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="convert-notes">Notes (optional)</Label>
              <Textarea
                id="convert-notes"
                rows={3}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                Create task
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
