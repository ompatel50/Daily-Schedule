"use client";

import { create } from "zustand";
import { today, type DayKey } from "@/lib/date";

/**
 * Client-side UI state only. All *data* lives in SQLite and is fetched by
 * Server Components — this store never caches domain records, which keeps the
 * "one source of truth" property and avoids stale-state bugs.
 */
interface UIState {
  commandOpen: boolean;
  quickAddOpen: boolean;
  shortcutsOpen: boolean;
  /** Day pre-selected when a dialog opens from a specific date context. */
  contextDate: DayKey;

  setCommandOpen: (open: boolean) => void;
  toggleCommand: () => void;
  setQuickAddOpen: (open: boolean) => void;
  openQuickAdd: (date?: DayKey) => void;
  setShortcutsOpen: (open: boolean) => void;
  setContextDate: (date: DayKey) => void;
}

export const useUIStore = create<UIState>((set) => ({
  commandOpen: false,
  quickAddOpen: false,
  shortcutsOpen: false,
  contextDate: today(),

  setCommandOpen: (commandOpen) => set({ commandOpen }),
  toggleCommand: () => set((state) => ({ commandOpen: !state.commandOpen })),
  setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen }),
  openQuickAdd: (date) =>
    set((state) => ({ quickAddOpen: true, contextDate: date ?? state.contextDate })),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setContextDate: (contextDate) => set({ contextDate }),
}));
