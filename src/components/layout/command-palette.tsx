"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Apple,
  ArrowRight,
  Bot,
  Dumbbell,
  FileDown,
  FileUp,
  HeartPulse,
  History,
  Inbox,
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
  CommandShortcut,
} from "@/components/ui/command";
import { readUIState, writeUIState } from "@/lib/client-state";
import { NAV_ITEMS } from "@/lib/navigation";
import type { SearchHit } from "@/lib/logic/search";
import { globalSearch } from "@/server/actions/search";
import { useUIStore } from "@/store/ui-store";

/** How many recently used commands the empty palette offers back. */
const MAX_RECENTS = 6;
const RECENTS_KEY = "palette-recents";

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
  const [recents, setRecents] = React.useState<string[]>([]);

  // Debounced server search — the palette stays responsive while the database
  // is hit at most every 180 ms.
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
    if (!open) {
      setQuery("");
      return;
    }
    // Session-scoped and ids-only: which commands were used, never any data.
    setRecents(readUIState<string[]>(RECENTS_KEY, []));
  }, [open]);

  const run = React.useCallback(
    (action: () => void, commandId?: string) => {
      if (commandId) {
        setRecents((current) => {
          const next = [commandId, ...current.filter((id) => id !== commandId)].slice(
            0,
            MAX_RECENTS,
          );
          writeUIState(RECENTS_KEY, next);
          return next;
        });
      }
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

  /**
   * Every re-runnable command in one table, so the Recent group can replay a
   * command by id. Search hits are deliberately excluded from recents: their
   * hrefs point at records that may be renamed or deleted.
   */
  const commands = React.useMemo<
    Array<{ id: string; label: string; keywords: string; icon: React.ReactNode; shortcut?: string; action: () => void }>
  >(
    () => [
      {
        id: "quick-add",
        label: "Quick add to planner",
        keywords: "quick add task schedule item new",
        icon: <Plus />,
        shortcut: "N",
        action: () => openQuickAdd(),
      },
      {
        id: "capture-inbox",
        label: "Capture an inbox item",
        keywords: "capture inbox note remember life admin",
        icon: <Inbox />,
        action: () => router.push("/inbox"),
      },
      {
        id: "ask-assistant",
        label: "Ask the assistant",
        keywords: "ask assistant ai chat question ollama",
        icon: <Bot />,
        action: () => router.push("/assistant"),
      },
      {
        id: "log-habit",
        label: "Log a habit",
        keywords: "log habit tick done today streak",
        icon: <Repeat />,
        action: () => router.push("/habits"),
      },
      {
        id: "log-food",
        label: "Log food",
        keywords: "log food meal nutrition",
        icon: <Apple />,
        action: () => router.push("/nutrition"),
      },
      {
        id: "log-workout",
        label: "Log a workout",
        keywords: "log workout training exercise",
        icon: <Dumbbell />,
        action: () => router.push("/workouts?new=1"),
      },
      {
        id: "new-habit",
        label: "Create a habit",
        keywords: "new habit create",
        icon: <Repeat />,
        action: () => router.push("/habits?new=1"),
      },
      {
        id: "log-health",
        label: "Log health data",
        keywords: "log health metric weight sleep steps",
        icon: <HeartPulse />,
        action: () => router.push("/health"),
      },
      {
        id: "import-health",
        label: "Import health data",
        keywords: "import health apple export csv",
        icon: <FileUp />,
        action: () => router.push("/health/import"),
      },
      {
        id: "backup",
        label: "Export a backup",
        keywords: "export backup json data",
        icon: <FileDown />,
        action: () => router.push("/settings#backup"),
      },
    ],
    [openQuickAdd, router],
  );

  const commandById = React.useMemo(() => {
    const map = new Map(commands.map((command) => [command.id, command]));
    for (const item of NAV_ITEMS) {
      map.set(`nav:${item.href}`, {
        id: `nav:${item.href}`,
        label: item.label,
        keywords: `go ${item.label} ${item.description}`,
        icon: <item.icon className={item.accent} />,
        shortcut: `G ${item.shortcut.toUpperCase()}`,
        action: () => router.push(item.href),
      });
    }
    return map;
  }, [commands, router]);

  const recentCommands = query.trim().length === 0
    ? recents.map((id) => commandById.get(id)).filter((command) => command !== undefined)
    : [];

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

        {recentCommands.length > 0 && (
          <CommandGroup heading="Recent">
            {recentCommands.map((command) => (
              <CommandItem
                key={`recent-${command.id}`}
                value={`recent ${command.label}`}
                onSelect={() => run(command.action, command.id)}
              >
                <History className="opacity-50" />
                {command.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Actions">
          {commands.map((command) => (
            <CommandItem
              key={command.id}
              value={command.keywords}
              onSelect={() => run(command.action, command.id)}
            >
              {command.icon}
              {command.label}
              {command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>


        <CommandGroup heading="Go to">
          {NAV_ITEMS.map((item) => (
            <CommandItem
              key={item.href}
              value={`go ${item.label} ${item.description}`}
              onSelect={() => run(() => router.push(item.href), `nav:${item.href}`)}
            >
              <item.icon className={item.accent} />
              {item.label}
              <CommandShortcut>G {item.shortcut.toUpperCase()}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>


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
