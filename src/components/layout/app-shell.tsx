import type { ReactNode } from "react";

import { CommandPalette, QuickAddDialog } from "@/components/layout/shell-extras";
import { KeyboardShortcuts } from "@/components/layout/keyboard-shortcuts";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { PwaRegister } from "@/components/shared/pwa-register";
import { ReminderWatcher } from "@/components/shared/reminder-watcher";
import { UISync } from "@/components/layout/ui-sync";
import { getToday, getUser } from "@/server/queries";

/**
 * Server Component shell: the chrome renders on the server, and only the
 * interactive bits (palette, shortcuts, quick add) ship as client components.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  // Deliberately NOT awaited here: the reminder feed is ~15 queries of
  // schedule resolution, and blocking every navigation on it made each page
  // pay for a feature that fires at most once a minute. The watcher fetches
  // it client-side right after mount instead.
  const [user, todayKey] = await Promise.all([getUser(), getToday()]);

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
      <ReminderWatcher />
      <PwaRegister />
    </div>
  );
}
