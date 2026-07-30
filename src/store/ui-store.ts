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
  /**
   * The user's today as the *server* resolved it from their timezone. Synced
   * by the app shell on every render; the host clock is only the pre-sync
   * fallback. Anything that needs "today" reads this, so a browser and a
   * profile in different timezones cannot disagree about the date.
   */
  todayKey: DayKey;

  setCommandOpen: (open: boolean) => void;
  toggleCommand: () => void;
  setQuickAddOpen: (open: boolean) => void;
  openQuickAdd: (date?: DayKey) => void;
  setShortcutsOpen: (open: boolean) => void;
  setContextDate: (date: DayKey) => void;
  syncTodayKey: (todayKey: DayKey) => void;
}

export const useUIStore = create<UIState>((set) => ({
  commandOpen: false,
  quickAddOpen: false,
  shortcutsOpen: false,
  contextDate: today(),
  todayKey: today(),

  setCommandOpen: (commandOpen) => set({ commandOpen }),
  toggleCommand: () => set((state) => ({ commandOpen: !state.commandOpen })),
  setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen }),
  openQuickAdd: (date) =>
    set((state) => ({ quickAddOpen: true, contextDate: date ?? state.todayKey })),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setContextDate: (contextDate) => set({ contextDate }),
  syncTodayKey: (todayKey) =>
    set((state) => ({
      todayKey,
      // A stale default context (the host's idea of today) follows the sync;
      // a date the user deliberately chose does not.
      contextDate: state.quickAddOpen ? state.contextDate : todayKey,
    })),
}));
