"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  BellOff,
  BellRing,
  FileClock,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
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
import {
  DocumentDialog,
  type DocumentDraft,
} from "@/components/documents/document-dialog";
import { formatDay } from "@/lib/date";
import { DOCUMENT_KIND_META, type DocumentKind } from "@/lib/enums";
import { describeExpiryDistance } from "@/lib/logic/documents";
import { cn, pluralize } from "@/lib/utils";
import { deleteDocument, setDocumentArchived } from "@/server/actions/documents";

/** A document plus the expiry state the server computed. */
export interface DocumentListItem extends DocumentDraft {
  id: string;
  bucket: "overdue" | "today" | "soon" | "later";
  daysUntilExpiry: number;
  expired: boolean;
  /** True when today is inside this document's own reminder window. */
  reminderArmed: boolean;
}

const EXPIRY_CLASSES: Record<DocumentListItem["bucket"], string> = {
  overdue: "font-medium text-red-700 dark:text-red-400",
  today: "font-medium text-amber-800 dark:text-amber-400",
  soon: "font-medium text-amber-800 dark:text-amber-400",
  later: "text-muted-foreground",
};

/**
 * Documents & renewals: the life-admin things that expire, most urgent first.
 * Reminder state is visible on the row itself — "armed" means today falls
 * inside that document's own run-up window, so nothing about whether you will
 * be told has to be inferred.
 */
export function DocumentsPanel({
  documents,
  today,
}: {
  documents: DocumentListItem[];
  today: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DocumentDraft | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(message);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });
  }

  const expiringSoon = documents.filter((document) => document.daysUntilExpiry <= 30);

  return (
    <>
      <SectionCard
        title="Renewals & documents"
        icon={FileClock}
        accent="text-domain-task"
        description={
          documents.length === 0
            ? "Things that expire"
            : `${expiringSoon.length} of ${documents.length} need attention within 30 days`
        }
        action={
          <Button
            size="sm"
            variant="ghost"
            // A bare "Add" is ambiguous on a page with several cards.
            aria-label="Add a document"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus /> Add
          </Button>
        }
      >
        {documents.length === 0 ? (
          <EmptyState
            icon={FileClock}
            title="Nothing tracked yet"
            description="Add a passport, a policy or a lease and the app will warn you before it lapses."
            className="py-6"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setOpen(true);
                }}
              >
                <Plus /> Add a document
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {documents.map((document) => {
              const kindLabel =
                DOCUMENT_KIND_META[document.kind as DocumentKind]?.label ?? document.kind;
              return (
                <div
                  key={document.id}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{document.name}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          DOCUMENT_KIND_META[document.kind as DocumentKind]?.chip,
                        )}
                      >
                        {kindLabel}
                      </Badge>
                      {document.expired && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-red-500/30 text-[10px] text-red-700 dark:text-red-400"
                        >
                          <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" />
                          Expired
                        </Badge>
                      )}
                      {document.reminderArmed && !document.expired && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-amber-500/30 text-[10px] text-amber-800 dark:text-amber-400"
                        >
                          <BellRing className="h-2.5 w-2.5" aria-hidden="true" />
                          Reminding
                        </Badge>
                      )}
                      {!document.reminderEnabled && (
                        <Badge variant="muted" className="gap-1 text-[10px]">
                          <BellOff className="h-2.5 w-2.5" aria-hidden="true" />
                          No reminder
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {document.issuer ? `${document.issuer} · ` : ""}
                      <span className={EXPIRY_CLASSES[document.bucket]}>
                        {describeExpiryDistance(document.expiryDate, today)}
                      </span>{" "}
                      · {formatDay(document.expiryDate, "MMM d, yyyy")}
                      {document.reminderEnabled
                        ? ` · warns ${
                            document.reminderDaysBefore === 0
                              ? "on the day"
                              : `${document.reminderDaysBefore} ${pluralize(document.reminderDaysBefore, "day")} ahead`
                          }`
                        : ""}
                    </p>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Actions for ${document.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setEditing(document);
                          setOpen(true);
                        }}
                      >
                        <Pencil /> Edit / renew
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          run(
                            () => setDocumentArchived(document.id, true),
                            "Document archived",
                          )
                        }
                      >
                        <Archive /> Archive
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        onSelect={() =>
                          run(() => deleteDocument(document.id), "Document deleted")
                        }
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <DocumentDialog open={open} onOpenChange={setOpen} document={editing} today={today} />
    </>
  );
}
