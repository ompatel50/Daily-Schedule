import type { ReactNode } from "react";

import { CommandPalette } from "@/components/layout/command-palette";
import { KeyboardShortcuts } from "@/components/layout/keyboard-shortcuts";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { QuickAddDialog } from "@/components/planner/quick-add-dialog";
import { ReminderWatcher } from "@/components/shared/reminder-watcher";
import { UISync } from "@/components/layout/ui-sync";
import { getToday, getUser } from "@/server/queries";
import { getReminderFeed } from "@/server/reminders";

/**
 * Server Component shell: the chrome renders on the server, and only the
 * interactive bits (palette, shortcuts, quick add) ship as client components.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const [user, reminderFeed, todayKey] = await Promise.all([
    getUser(),
    // Schedule-aware: rest days, overrides, completions and archived habits
    // are already filtered out server-side.
    getReminderFeed(),
    getToday(),
  ]);

  return (
    <div className="flex min-h-screen">
      <Sidebar userName={user.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar todayKey={todayKey} account={{ name: user.name, email: user.email }} />
        <main className="flex-1 animate-fade-in px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>

      <UISync todayKey={todayKey} />
      <CommandPalette />
      <QuickAddDialog />
      <KeyboardShortcuts />
      <ReminderWatcher initial={reminderFeed} />
    </div>
  );
}
