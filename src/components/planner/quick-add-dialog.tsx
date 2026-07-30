"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import { formatTimeRange, relativeDayLabel } from "@/lib/date";
import { parseQuickAdd } from "@/lib/logic/quick-add";
import { quickAddScheduleItem } from "@/server/actions/planner";
import { useUIStore } from "@/store/ui-store";

const EXAMPLES = [
  "Deep work 9-11am !high",
  "Gym 6:30-7:30pm tomorrow",
  "Meal prep sunday #meal",
  "Call the dentist #admin",
];

/**
 * The fastest path into the app: one text field that understands times, dates,
 * categories and priorities. A live preview shows exactly what will be created,
 * so the syntax is discoverable instead of hidden.
 */
export function QuickAddDialog() {
  const router = useRouter();
  const open = useUIStore((state) => state.quickAddOpen);
  const setOpen = useUIStore((state) => state.setQuickAddOpen);
  const contextDate = useUIStore((state) => state.contextDate);
  const todayKey = useUIStore((state) => state.todayKey);

  const [text, setText] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) setText("");
  }, [open]);

  const preview = React.useMemo(
    () => (text.trim() ? parseQuickAdd(text, contextDate) : null),
    [text, contextDate],
  );

  function submit() {
    const value = text.trim();
    if (!value || pending) return;

    startTransition(async () => {
      const result = await quickAddScheduleItem({ text: value, date: contextDate });
      if (result.ok) {
        toast.success("Added to your planner", {
          description: preview
            ? `${preview.title} · ${relativeDayLabel(preview.date, todayKey)}`
            : undefined,
        });
        setText("");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-domain-planner" />
            Quick add
          </DialogTitle>
          <DialogDescription>
            Type naturally — times, dates, <code className="text-xs">#category</code> and{" "}
            <code className="text-xs">!priority</code> are all understood.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            autoFocus
            value={text}
            placeholder="Deep work 9-11am !high"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            className="h-11 text-base"
          />

          {preview ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
              <span className="font-medium">{preview.title}</span>
              <Badge variant="outline" className={CATEGORY_META[preview.category as ScheduleCategory]?.chip}>
                {CATEGORY_META[preview.category as ScheduleCategory]?.label}
              </Badge>
              <Badge variant="muted">{relativeDayLabel(preview.date, todayKey)}</Badge>
              <Badge variant="muted">
                {formatTimeRange(preview.startMinute, preview.endMinute, preview.allDay)}
              </Badge>
              {preview.priority !== "medium" && (
                <Badge variant="outline">{preview.priority}</Badge>
              )}
              {preview.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  #{tag}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5 rounded-lg border border-dashed px-3 py-2.5">
              <p className="text-xs font-medium text-muted-foreground">Try one of these</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setText(example)}
                    className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Adding to <span className="font-medium">{relativeDayLabel(contextDate, todayKey)}</span>
            </p>
            <Button onClick={submit} disabled={!text.trim() || pending} className="gap-1.5">
              {pending ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
              Add item
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
