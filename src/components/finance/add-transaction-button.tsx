"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AccountView } from "@/components/finance/account-dialog";
import { TransactionDialog } from "@/components/finance/transaction-dialog";

/**
 * The page-header primary action. Owns its own dialog so the header stays a
 * server component, and handles `?new=1` (quick actions link here).
 */
export function AddTransactionButton({
  accounts,
  today,
}: {
  /** Unarchived accounts; an empty list disables the button. */
  accounts: AccountView[];
  today: string;
}) {
  const searchParams = useSearchParams();
  const [open, setOpen] = React.useState(false);
  const hasAccounts = accounts.length > 0;

  React.useEffect(() => {
    if (searchParams.get("new") === "1" && hasAccounts) setOpen(true);
  }, [searchParams, hasAccounts]);

  if (!hasAccounts) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Disabled buttons swallow pointer events; the span keeps the tooltip alive. */}
          <span tabIndex={0} className="inline-flex rounded-md">
            <Button disabled>
              <Plus /> Add transaction
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Create an account first — transactions need somewhere to live.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> Add transaction
      </Button>
      <TransactionDialog open={open} onOpenChange={setOpen} accounts={accounts} today={today} />
    </>
  );
}
