"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleUser, LogOut, Menu, Sparkles } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { isNavItemActive, NAV_GROUPS, NAV_ITEMS } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { signOutAction } from "@/server/actions/auth";

/**
 * The phone navigation: a menu button opening a slide-over drawer.
 *
 * The Sheet (Radix Dialog underneath) supplies the focus trap, focus return
 * to this trigger, Escape close, backdrop close, background scroll lock and
 * `aria-modal`. This component adds the two things Radix cannot know: the
 * drawer closes itself after a navigation (watching the pathname covers
 * client-side transitions AND the already-on-this-page tap, which never
 * navigates), and every current destination is present — the drawer is the
 * sidebar's equal, not a digest of it.
 */
export function MobileNav({ account }: { account?: { name: string; email: string | null } }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Close after navigation. The dependency is the pathname itself: when a
  // link inside the drawer navigates, the new route closes it.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const itemsByHref = new Map(NAV_ITEMS.map((item) => [item.href, item]));

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="touch-target lg:hidden" aria-label="Open navigation">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="px-0 pt-safe" aria-label="Navigation">
        <SheetHeader className="border-b px-4 pb-3 pt-4">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            Personal OS
          </SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
        </SheetHeader>

        <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="Main">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </p>
              <ul>
                {group.hrefs.map((href) => {
                  const item = itemsByHref.get(href);
                  if (!item) return null;
                  const active = isNavItemActive(item.href, pathname);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        // Tapping the current page never navigates, so the
                        // pathname effect can't close the drawer — do it here.
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                          active
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <item.icon className={cn("h-4 w-4 shrink-0", active && item.accent)} aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {account && (
          <div className="border-t px-4 py-3 pb-safe">
            <div className="flex items-center gap-3">
              <CircleUser className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{account.name}</p>
                {account.email && (
                  <p className="truncate text-xs text-muted-foreground">{account.email}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="touch-target shrink-0"
                aria-label="Sign out"
                onClick={() => void signOutAction()}
              >
                <LogOut />
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
