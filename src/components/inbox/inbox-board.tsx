"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Inbox,
  ListTodo,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ConvertTaskDialog,
  type ConvertSource,
  type ProjectOption,
} from "@/components/inbox/convert-task-dialog";
import { InboxItemDialog, type InboxDraft } from "@/components/inbox/inbox-item-dialog";
import { relativeDayLabel } from "@/lib/date";
import { cn } from "@/lib/utils";
import { deleteInboxItem, saveInboxItem, setInboxItemStatus } from "@/server/actions/inbox";
import type { ActionResult } from "@/lib/validation";
import type { InboxStatus } from "@/lib/enums";

export interface InboxListItem {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  /** Set when this capture was converted into a task. */
  taskId: string | null;
  /** Day key derived from `createdAt`. */
  createdDay: string;
  /** Day key derived from `updatedAt` — when the item was resolved. */
  resolvedDay: string;
}

/** Local chips only — the inbox is too small a module to earn an enums entry. */
const INBOX_STATUS_META: Record<string, { label: string; chip: string }> = {
  done: {
    label: "Done",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  archived: {
    label: "Archived",
    chip: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20",
  },
};

/**
 * The inbox: a capture bar, the open queue, and a muted history. Deliberately
 * light — anything that grows a due date or a project belongs in Tasks.
 */
export function InboxBoard({
  open,
  resolved,
  projects,
  today,
}: {
  open: InboxListItem[];
  resolved: InboxListItem[];
  /** Active projects the convert-to-task dialog offers. */
  projects: ProjectOption[];
  today: string;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<InboxDraft | null>(null);
  const [converting, setConverting] = React.useState<ConvertSource | null>(null);
  /** Optimistically checked while their "done" call is in flight. */
  const [resolving, setResolving] = React.useState<Record<string, boolean>>({});
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);

  React.useEffect(() => setResolving({}), [open]);

  function capture(event: React.FormEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title) {
      inputRef.current?.focus();
      return;
    }
    startTransition(async () => {
      const result = await saveInboxItem({ title });
      if (result.ok) {
        toast.success("Captured");
        setDraft("");
        inputRef.current?.focus();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function run(fn: () => Promise<ActionResult<unknown>>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) toast.success(message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  function setStatus(item: InboxListItem, status: InboxStatus, message: string) {
    if (status === "done") setResolving((state) => ({ ...state, [item.id]: true }));
    startTransition(async () => {
      const result = await setInboxItemStatus(item.id, status);
      if (result.ok) {
        toast.success(message);
      } else {
        toast.error(result.error);
        setResolving((state) => {
          const { [item.id]: _removed, ...rest } = state;
          return rest;
        });
      }
      router.refresh();
    });
  }

  function openEdit(item: InboxListItem) {
    setEditing({ id: item.id, title: item.title, notes: item.notes });
    setDialogOpen(true);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={capture} className="flex items-center gap-2">
        <Input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What's on your mind?"
          aria-label="Capture something"
        />
        <Button type="submit" disabled={pending} className="shrink-0">
          <Plus /> Capture
        </Button>
      </form>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard title="Open" icon={Inbox} accent="text-domain-task">
            {open.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Inbox zero"
                description="Capture anything with the box above."
                className="py-6"
              />
            ) : (
              <div className="space-y-2">
                {open.map((item) => {
                  const checked = Boolean(resolving[item.id]);
                  return (
                    <div key={item.id} className="flex items-start gap-3 rounded-lg border px-3 py-2">
                      <Checkbox
                        className="mt-0.5 rounded-full"
                        checked={checked}
                        disabled={checked}
                        onCheckedChange={() => setStatus(item, "done", "Done")}
                        aria-label={`Mark "${item.title}" done`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm", checked && "text-muted-foreground line-through")}>
                          {item.title}
                        </p>
                        {item.notes && (
                          <p className="truncate text-xs text-muted-foreground">{item.notes}</p>
                        )}
                      </div>
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
                        {relativeDayLabel(item.createdDay, today)}
                      </span>
                      {item.taskId === null ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Make ${item.title} a task`}
                              onClick={() =>
                                setConverting({
                                  id: item.id,
                                  title: item.title,
                                  notes: item.notes,
                                })
                              }
                            >
                              <ListTodo />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Make a task</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
                          Task
                        </Badge>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Archive ${item.title}`}
                            onClick={() => setStatus(item, "archived", "Archived")}
                          >
                            <Archive />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Archive</TooltipContent>
                      </Tooltip>
                      <ItemMenu
                        title={item.title}
                        onEdit={() => openEdit(item)}
                        onDelete={() => run(() => deleteInboxItem(item.id), "Item deleted")}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </div>

        <div>
          <SectionCard
            title="Resolved"
            icon={Archive}
            accent="text-muted-foreground"
            description="Done and archived"
          >
            {resolved.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Nothing resolved yet.
              </p>
            ) : (
              <div className="space-y-0.5">
                {resolved.map((item) => {
                  const meta = INBOX_STATUS_META[item.status];
                  return (
                    <div key={item.id} className="flex items-center gap-2 rounded-md px-1 py-1">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm text-muted-foreground",
                          item.status === "done" && "line-through",
                        )}
                      >
                        {item.title}
                      </span>
                      {item.taskId !== null ? (
                        <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
                          <ListTodo className="h-2.5 w-2.5" aria-hidden="true" /> Became a task
                        </Badge>
                      ) : (
                        meta && (
                          <Badge
                            variant="outline"
                            className={cn("shrink-0 text-[10px]", meta.chip)}
                          >
                            {meta.label}
                          </Badge>
                        )
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {relativeDayLabel(item.resolvedDay, today)}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Reopen ${item.title}`}
                            onClick={() => setStatus(item, "open", "Back in the inbox")}
                          >
                            <Undo2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Reopen</TooltipContent>
                      </Tooltip>
                      {confirmingDeleteId === item.id ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setConfirmingDeleteId(null);
                            run(() => deleteInboxItem(item.id), "Item deleted");
                          }}
                        >
                          Sure?
                        </Button>
                      ) : (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${item.title}`}
                          onClick={() => setConfirmingDeleteId(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      <InboxItemDialog open={dialogOpen} onOpenChange={setDialogOpen} item={editing} />
      <ConvertTaskDialog
        item={converting}
        projects={projects}
        onClose={() => setConverting(null)}
      />
    </div>
  );
}

function ItemMenu({
  title,
  onEdit,
  onDelete,
}: {
  title: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  return (
    <DropdownMenu onOpenChange={(open) => !open && setConfirmingDelete(false)}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${title}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil /> Edit
        </DropdownMenuItem>
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
  );
}
