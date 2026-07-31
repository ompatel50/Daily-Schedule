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
import { saveInboxItem } from "@/server/actions/inbox";

export interface InboxDraft {
  id?: string;
  title: string;
  notes: string | null;
}

export function InboxItemDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: InboxDraft | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(item?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<InboxDraft>(item ?? { title: "", notes: null });
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(item ?? { title: "", notes: null });
    setErrors({});
  }, [open, item]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.title.trim()) {
      setErrors({ title: ["Write something to capture"] });
      return;
    }

    startTransition(async () => {
      const result = await saveInboxItem({
        id: form.id,
        title: form.title.trim(),
        notes: form.notes,
      });

      if (result.ok) {
        toast.success(isEdit ? "Item updated" : "Captured");
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
            <DialogTitle>{isEdit ? "Edit item" : "Capture"}</DialogTitle>
            <DialogDescription>
              Just enough words to remember what this was. Deciding comes later.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="inbox-title">Title</Label>
              <Input
                id="inbox-title"
                autoFocus
                value={form.title}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? "inbox-title-error" : undefined}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
              />
              {errors.title && (
                <p id="inbox-title-error" className="text-xs text-destructive">
                  {errors.title[0]}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inbox-notes">Notes (optional)</Label>
              <Textarea
                id="inbox-notes"
                rows={3}
                value={form.notes ?? ""}
                onChange={(event) =>
                  setForm((current) => ({ ...current, notes: event.target.value || null }))
                }
              />
              {errors.notes && <p className="text-xs text-destructive">{errors.notes[0]}</p>}
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
                {isEdit ? "Save changes" : "Capture"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
