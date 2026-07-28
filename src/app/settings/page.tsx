import type { Metadata } from "next";
import { Bell, Database, Keyboard } from "lucide-react";

import { BackupPanel } from "@/components/settings/backup-panel";
import { GoalsPanel } from "@/components/settings/goals-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { KEYBOARD_SHORTCUTS } from "@/lib/navigation";
import { getGoalRows, getHabitOptions, getLatestMetrics, getUser } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const [goals, habits, latest] = await Promise.all([
    getGoalRows(),
    getHabitOptions(),
    getLatestMetrics(),
  ]);
  const weight = latest.get("body_weight");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Your profile, goals, reminders and backups. All stored locally."
      />

      <div className="space-y-6">
        <SettingsForm
          initial={{
            name: user.name,
            timezone: user.timezone,
            birthDate: user.birthDate,
            heightCm: user.heightCm,
            sex: user.sex,
            activityLevel: user.activityLevel,
            weekStartsOn: user.weekStartsOn,
            unitSystem: user.unitSystem,
            dayStartHour: user.dayStartHour,
            dayEndHour: user.dayEndHour,
          }}
          latestWeight={weight?.value ?? null}
        />

        <GoalsPanel
          goals={goals}
          habits={habits}
          weekStartsOn={settings.weekStartsOn}
          today={settings.today}
        />

        <NotificationsPanel />

        <div id="backup">
          <BackupPanel />
        </div>

        <SectionCard
          title="Keyboard shortcuts"
          icon={Keyboard}
          accent="text-muted-foreground"
          description="Press ? anywhere to see this list"
        >
          <div className="grid gap-1 sm:grid-cols-2">
            {KEYBOARD_SHORTCUTS.map((shortcut) => (
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
        </SectionCard>

        <SectionCard
          title="About this app"
          icon={Database}
          accent="text-muted-foreground"
          description="How your data is stored"
        >
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Everything lives in a local SQLite file (<code className="text-xs">prisma/dev.db</code>).
              No account, no sync, no third-party API calls — the food database ships with the app
              rather than querying a nutrition service.
            </p>
            <p>
              To back up manually, copy that file, or use the JSON export above. Health metrics and
              workouts carry <code className="text-xs">source</code> and{" "}
              <code className="text-xs">externalId</code> columns so an Apple Health or watch export
              can be imported later without touching anything you entered by hand.
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
