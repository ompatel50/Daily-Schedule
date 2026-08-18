"use client";

import * as React from "react";
import { MoreHorizontal, Trash2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The per-row overflow menu every finance section shares: regular actions,
 * then a two-step delete — the first click flips the item to a confirm, the
 * second commits. Closing the menu resets the confirmation, so a stray click
 * never destroys anything.
 */
export function RowMenu({
  label,
  items,
  onDelete,
  confirmLabel = "Confirm delete",
}: {
  label: string;
  items: Array<{ label: string; icon: LucideIcon; onClick: () => void }>;
  onDelete: () => void;
  confirmLabel?: string;
}) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <DropdownMenu onOpenChange={(open) => !open && setConfirming(false)}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" className="touch-target shrink-0" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map(({ label: itemLabel, icon: Icon, onClick }) => (
          <DropdownMenuItem key={itemLabel} onClick={onClick}>
            <Icon /> {itemLabel}
          </DropdownMenuItem>
        ))}
        {items.length > 0 && <DropdownMenuSeparator />}
        {confirming ? (
          <DropdownMenuItem destructive onClick={onDelete}>
            <Trash2 /> {confirmLabel}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            destructive
            onSelect={(event) => {
              event.preventDefault();
              setConfirming(true);
            }}
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
