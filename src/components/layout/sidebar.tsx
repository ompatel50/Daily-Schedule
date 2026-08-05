"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Command, Plus, Sparkles } from "lucide-react";

import { isNavItemActive, NAV_ITEMS } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useUIStore } from "@/store/ui-store";

export function Sidebar({ userName }: { userName: string }) {
  const pathname = usePathname();
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);
  const setCommandOpen = useUIStore((state) => state.setCommandOpen);

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/50 lg:flex">
      <div className="flex h-16 items-center gap-2.5 border-b px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">Personal OS</p>
          <p className="truncate text-xs text-muted-foreground">{userName}</p>
        </div>
      </div>

      <div className="p-3">
        <Button className="w-full justify-start gap-2" onClick={() => openQuickAdd()}>
          <Plus />
          Quick add
          <kbd className="ml-auto rounded border border-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium">
            N
          </kbd>
        </Button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("h-4 w-4 shrink-0", active && item.accent)} />
              <span className="truncate">{item.label}</span>
              <kbd
                className={cn(
                  "ml-auto text-[10px] font-medium uppercase text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
                  active && "opacity-100",
                )}
              >
                g {item.shortcut}
              </kbd>
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Command className="h-3.5 w-3.5" />
          Command palette
          <kbd className="ml-auto rounded border px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        </button>
      </div>
    </aside>
  );
}
