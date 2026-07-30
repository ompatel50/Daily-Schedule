"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Apple,
  ArrowRight,
  CalendarPlus,
  Dumbbell,
  FileDown,
  FileUp,
  HeartPulse,
  Loader2,
  Moon,
  Plus,
  Repeat,
  Sun,
  Keyboard,
} from "lucide-react";
import { useTheme } from "next-themes";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV_ITEMS } from "@/lib/navigation";
import type { SearchHit } from "@/lib/logic/search";
import { globalSearch } from "@/server/actions/search";
import { useUIStore } from "@/store/ui-store";

export function CommandPalette() {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();

  const open = useUIStore((state) => state.commandOpen);
  const setOpen = useUIStore((state) => state.setCommandOpen);
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);
  const setShortcutsOpen = useUIStore((state) => state.setShortcutsOpen);

  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [searching, setSearching] = React.useState(false);

  // Debounced server search — the palette stays responsive while SQLite is hit
  // at most every 180 ms.
  React.useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const results = await globalSearch(term);
        if (!cancelled) setHits(results);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const run = React.useCallback(
    (action: () => void) => {
      setOpen(false);
      // Let the dialog close before navigating, otherwise focus jumps oddly.
      setTimeout(action, 0);
    },
    [setOpen],
  );

  const grouped = React.useMemo(() => {
    const groups = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const list = groups.get(hit.group) ?? [];
      list.push(hit);
      groups.set(hit.group, list);
    }
    return Array.from(groups.entries());
  }, [hits]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={query.trim().length < 2}>
      <CommandInput
        placeholder="Search your data, or jump to a page…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {searching ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
            </span>
          ) : (
            "No results found."
          )}
        </CommandEmpty>

        {grouped.map(([group, groupHits]) => (
          <CommandGroup key={group} heading={group}>
            {groupHits.map((hit) => (
              <CommandItem
                key={hit.id}
                value={`${hit.title} ${hit.subtitle} ${hit.id}`}
                onSelect={() => run(() => router.push(hit.href))}
              >
                <ArrowRight className="opacity-50" />
                <div className="min-w-0">
                  <p className="truncate">{hit.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{hit.subtitle}</p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <CommandGroup heading="Actions">
          <CommandItem value="quick add task schedule item new" onSelect={() => run(() => openQuickAdd())}>
            <Plus /> Quick add to planner
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem value="log food meal nutrition" onSelect={() => run(() => router.push("/nutrition"))}>
            <Apple /> Log food
          </CommandItem>
          <CommandItem value="log workout training exercise" onSelect={() => run(() => router.push("/workouts?new=1"))}>
            <Dumbbell /> Log a workout
          </CommandItem>
          <CommandItem value="new habit create" onSelect={() => run(() => router.push("/habits?new=1"))}>
            <Repeat /> Create a habit
          </CommandItem>
          <CommandItem
            value="log health metric weight sleep steps"
            onSelect={() => run(() => router.push("/health"))}
          >
            <HeartPulse /> Log health data
          </CommandItem>
          <CommandItem
            value="import health apple export csv"
            onSelect={() => run(() => router.push("/health"))}
          >
            <FileUp /> Import health data
          </CommandItem>
          <CommandItem value="plan tomorrow planner" onSelect={() => run(() => router.push("/planner"))}>
            <CalendarPlus /> Open the planner
          </CommandItem>
          <CommandItem value="export backup json data" onSelect={() => run(() => router.push("/settings#backup"))}>
            <FileDown /> Export a backup
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Go to">
          {NAV_ITEMS.map((item) => (
            <CommandItem
              key={item.href}
              value={`go ${item.label} ${item.description}`}
              onSelect={() => run(() => router.push(item.href))}
            >
              <item.icon className={item.accent} />
              {item.label}
              <CommandShortcut>G {item.shortcut.toUpperCase()}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Preferences">
          <CommandItem
            value="toggle theme dark light mode"
            onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            Switch to {resolvedTheme === "dark" ? "light" : "dark"} mode
          </CommandItem>
          <CommandItem value="keyboard shortcuts help" onSelect={() => run(() => setShortcutsOpen(true))}>
            <Keyboard /> Keyboard shortcuts
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
