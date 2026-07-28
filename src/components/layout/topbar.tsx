"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Command, Keyboard, Menu, Plus } from "lucide-react";

import { NAV_ITEMS } from "@/lib/navigation";
import { formatDayLong, today } from "@/lib/date";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { useUIStore } from "@/store/ui-store";

export function Topbar() {
  const pathname = usePathname();
  const setCommandOpen = useUIStore((state) => state.setCommandOpen);
  const setShortcutsOpen = useUIStore((state) => state.setShortcutsOpen);
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);

  const current =
    NAV_ITEMS.find((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))) ??
    NAV_ITEMS[0];

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:px-8">
      {/* Compact nav for narrow windows — the app targets desktop, but a
          half-width browser window shouldn't lose navigation. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Menu">
            <Menu />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {NAV_ITEMS.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href}>
                <item.icon className={cn("h-4 w-4", item.accent)} />
                {item.label}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold leading-tight">{current.label}</h1>
        <p className="hidden truncate text-xs text-muted-foreground sm:block">
          {formatDayLong(today())}
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

        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setCommandOpen(true)} aria-label="Command palette">
          <Command />
        </Button>

        <Button size="sm" className="gap-1.5" onClick={() => openQuickAdd()}>
          <Plus />
          <span className="hidden sm:inline">Add</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Keyboard shortcuts"
        >
          <Keyboard />
        </Button>

        <ThemeToggle />
      </div>
    </header>
  );
}
