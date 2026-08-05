"use client";

import { usePathname } from "next/navigation";
import { CircleUser, Command, Keyboard, LogOut, Plus } from "lucide-react";

import { isNavItemActive, NAV_ITEMS } from "@/lib/navigation";
import { formatDayLong, today } from "@/lib/date";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { clearClientUIState } from "@/lib/client-state";
import { signOutAction } from "@/server/actions/auth";
import { useUIStore } from "@/store/ui-store";

export function Topbar({
  todayKey,
  account,
}: {
  todayKey?: string;
  account?: { name: string; email: string | null };
}) {
  const pathname = usePathname();
  const setCommandOpen = useUIStore((state) => state.setCommandOpen);
  const setShortcutsOpen = useUIStore((state) => state.setShortcutsOpen);
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);

  const current = NAV_ITEMS.find((item) => isNavItemActive(item.href, pathname)) ?? NAV_ITEMS[0];

  return (
    // pt-safe: with viewport-fit=cover the header owns the area under the
    // iPhone status bar; the sticky offset must include it too.
    <header className="pt-safe sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:h-16 lg:px-8">
      {/* Phone navigation: the slide-over drawer, hidden where the sidebar shows. */}
      <MobileNav account={account} />

      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold leading-tight">{current.label}</h1>
        {/* The user's day, resolved on the server. Reading the host clock here
            had the chrome insisting it was Wednesday above a page correctly
            showing Tuesday. */}
        <p className="hidden truncate text-xs text-muted-foreground sm:block">
          {formatDayLong(todayKey ?? today())}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="hidden items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex"
        >
          <Command className="h-3.5 w-3.5" />
          <span>Search or jump to…</span>
          <kbd className="rounded border px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        </button>

        <Button
          variant="ghost"
          size="icon"
          className="touch-target md:hidden"
          onClick={() => setCommandOpen(true)}
          aria-label="Command palette"
        >
          <Command />
        </Button>

        <Button size="sm" className="touch-target gap-1.5" aria-label="Quick add" onClick={() => openQuickAdd()}>
          <Plus />
          <span className="hidden sm:inline">Add</span>
        </Button>

        {/* Keyboard shortcuts are a hardware-keyboard affordance; the header
            space matters more on a phone. */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden sm:inline-flex"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Keyboard shortcuts"
        >
          <Keyboard />
        </Button>

        <ThemeToggle />

        {account ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="touch-target hidden lg:inline-flex"
                aria-label="Account"
              >
                <CircleUser />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <span className="block truncate text-sm font-medium">{account.name}</span>
                {account.email ? (
                  <span className="block truncate text-xs text-muted-foreground">{account.email}</span>
                ) : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  clearClientUIState();
                  void signOutAction();
                }}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      </div>
    </header>
  );
}
