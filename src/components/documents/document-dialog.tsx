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
import { DOCUMENT_KINDS, DOCUMENT_KIND_META, type DocumentKind } from "@/lib/enums";
import { saveDocument } from "@/server/actions/documents";

/** A document as the page serialises it. */
export interface DocumentDraft {
  id?: string;
  name: string;
  kind: string;
  issuer: string | null;
  expiryDate: string;
  notes: string | null;
  reminderEnabled: boolean;
  reminderDaysBefore: number;
}

/** The lead times worth offering; anything else is a number nobody picked. */
const LEAD_TIMES = [0, 7, 14, 30, 60, 90, 180] as const;

function leadLabel(days: number): string {
  if (days === 0) return "On the expiry day";
  if (days % 30 === 0 && days >= 30) return `${days / 30} month${days === 30 ? "" : "s"} before`;
  return `${days} days before`;
}

export function blankDocument(today: string): DocumentDraft {
  return {
    name: "",
    kind: "other",
    issuer: null,
    expiryDate: today,
    notes: null,
    reminderEnabled: true,
    reminderDaysBefore: 30,
  };
}

export function DocumentDialog({
  open,
  onOpenChange,
  document,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document?: DocumentDraft | null;
  today: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(document?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<DocumentDraft>(document ?? blankDocument(today));
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(document ?? blankDocument(today));
    setErrors({});
  }, [open, document, today]);

  function set<K extends keyof DocumentDraft>(key: K, value: DocumentDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.name.trim()) {
      setErrors({ name: ["Give it a name"] });
      return;
    }
    if (!form.expiryDate) {
      setErrors({ expiryDate: ["Pick the expiry or renewal date"] });
      return;
    }

    startTransition(async () => {
      const result = await saveDocument({
        id: form.id,
        name: form.name.trim(),
        kind: form.kind,
        issuer: form.issuer,
        expiryDate: form.expiryDate,
        notes: form.notes,
        reminderEnabled: form.reminderEnabled,
        reminderDaysBefore: form.reminderDaysBefore,
      });

      if (result.ok) {
        toast.success(isEdit ? "Document updated" : "Document added");
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
            <DialogTitle>{isEdit ? "Edit document" : "Add a document"}</DialogTitle>
            <DialogDescription>
              Something that expires — an ID, a policy, a lease, a warranty. The app records the
              date and reminds you before it runs out; the document itself stays where you keep it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="doc-name">Name</Label>
              <Input
                id="doc-name"
                autoFocus
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "doc-name-error" : undefined}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Passport"
              />
              {errors.name && (
                <p id="doc-name-error" className="text-xs text-destructive">
                  {errors.name[0]}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="doc-kind">Kind</Label>
                <Select value={form.kind} onValueChange={(value) => set("kind", value)}>
                  <SelectTrigger id="doc-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_KINDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {DOCUMENT_KIND_META[value as DocumentKind].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="doc-expiry">Expires / renews on</Label>
                <Input
                  id="doc-expiry"
                  type="date"
                  value={form.expiryDate}
                  aria-invalid={Boolean(errors.expiryDate)}
                  onChange={(event) => set("expiryDate", event.target.value)}
                />
                {errors.expiryDate && (
                  <p className="text-xs text-destructive">{errors.expiryDate[0]}</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="doc-issuer">Issuer (optional)</Label>
              <Input
                id="doc-issuer"
                value={form.issuer ?? ""}
                onChange={(event) => set("issuer", event.target.value || null)}
                placeholder="Northline Mutual"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="doc-notes">Notes (optional)</Label>
              <Textarea
                id="doc-notes"
                rows={2}
                value={form.notes ?? ""}
                onChange={(event) => set("notes", event.target.value || null)}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="doc-reminder">Reminder</Label>
                <p className="text-xs text-muted-foreground">
                  Reminds once ahead of the date, and once on the day
                </p>
              </div>
              <Switch
                id="doc-reminder"
                checked={form.reminderEnabled}
                onCheckedChange={(checked) => set("reminderEnabled", checked)}
              />
            </div>

            {form.reminderEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="doc-lead">Warn me</Label>
                <Select
                  value={String(form.reminderDaysBefore)}
                  onValueChange={(value) => set("reminderDaysBefore", Number(value))}
                >
                  <SelectTrigger id="doc-lead">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_TIMES.map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {leadLabel(days)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Renewing is an edit: move the date forward and the reminder arms itself again.
                </p>
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
                {isEdit ? "Save changes" : "Add document"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
