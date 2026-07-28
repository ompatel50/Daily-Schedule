"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { KEYBOARD_SHORTCUTS, NAV_ITEMS } from "@/lib/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUIStore } from "@/store/ui-store";

/** True when the user is typing — shortcuts must not hijack real input. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

/**
 * Global keyboard layer. Uses a small `g`-prefix chord for navigation (like
 * GitHub/Linear) so single letters stay free for page-level actions.
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  const toggleCommand = useUIStore((state) => state.toggleCommand);
  const setCommandOpen = useUIStore((state) => state.setCommandOpen);
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);
  const setShortcutsOpen = useUIStore((state) => state.setShortcutsOpen);
  const shortcutsOpen = useUIStore((state) => state.shortcutsOpen);

  const pendingG = React.useRef<number | null>(null);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommand();
        return;
      }

      if (isTypingTarget(event.target) || event.altKey || meta) return;

      // `g` starts a navigation chord that expires after 1.2 s.
      if (pendingG.current !== null) {
        const match = NAV_ITEMS.find((item) => item.shortcut === event.key.toLowerCase());
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        if (match) {
          event.preventDefault();
          router.push(match.href);
          return;
        }
      }

      switch (event.key) {
        case "g":
          event.preventDefault();
          pendingG.current = window.setTimeout(() => {
            pendingG.current = null;
          }, 1200);
          break;
        case "n":
          event.preventDefault();
          openQuickAdd();
          break;
        case "/":
          event.preventDefault();
          setCommandOpen(true);
          break;
        case "?":
          event.preventDefault();
          setShortcutsOpen(true);
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, toggleCommand, setCommandOpen, openQuickAdd, setShortcutsOpen]);

  const groups = React.useMemo(() => {
    const map = new Map<string, typeof KEYBOARD_SHORTCUTS>();
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      const list = map.get(shortcut.group) ?? [];
      list.push(shortcut);
      map.set(shortcut.group, list);
    }
    return Array.from(map.entries());
  }, []);

  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Built for fast daily use — no mouse required.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {groups.map(([group, shortcuts]) => (
            <div key={group}>
              <p className="section-title mb-2">{group}</p>
              <div className="space-y-1">
                {shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm odd:bg-muted/40"
                  >
                    <span className="text-muted-foreground">{shortcut.action}</span>
                    <kbd className="rounded border bg-background px-2 py-0.5 text-xs font-medium">
                      {shortcut.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
