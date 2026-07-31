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
import { Textarea } from "@/components/ui/textarea";
import { PROJECT_COLORS, PROJECT_COLOR_CLASS } from "@/components/tasks/project-colors";
import { cn } from "@/lib/utils";
import { saveProject } from "@/server/actions/tasks";

export interface ProjectDraft {
  id?: string;
  name: string;
  description: string | null;
  color: string;
}

function blankProject(): ProjectDraft {
  return { name: "", description: null, color: "slate" };
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: ProjectDraft | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(project?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<ProjectDraft>(project ?? blankProject());
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(project ?? blankProject());
    setErrors({});
  }, [open, project]);

  function set<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.name.trim()) {
      setErrors({ name: ["Give the project a name"] });
      return;
    }

    startTransition(async () => {
      const result = await saveProject({
        id: form.id,
        name: form.name.trim(),
        description: form.description,
        color: form.color,
      });

      if (result.ok) {
        toast.success(isEdit ? "Project updated" : "Project created");
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
            <DialogTitle>{isEdit ? "Edit project" : "New project"}</DialogTitle>
            <DialogDescription>
              A project groups related tasks and shows how far along they are.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                autoFocus
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "project-name-error" : undefined}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Spring garden overhaul"
              />
              {errors.name && (
                <p id="project-name-error" className="text-xs text-destructive">
                  {errors.name[0]}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-description">Description (optional)</Label>
              <Textarea
                id="project-description"
                rows={2}
                value={form.description ?? ""}
                onChange={(event) => set("description", event.target.value || null)}
              />
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description[0]}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {PROJECT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={PROJECT_COLOR_CLASS[color].label}
                    aria-label={PROJECT_COLOR_CLASS[color].label}
                    aria-pressed={form.color === color}
                    onClick={() => set("color", color)}
                    className={cn(
                      "h-7 w-7 rounded-full transition-transform hover:scale-110",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      PROJECT_COLOR_CLASS[color].dot,
                      form.color === color &&
                        "ring-2 ring-ring ring-offset-2 ring-offset-background",
                    )}
                  />
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {isEdit ? "Save changes" : "Create project"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
