import type { Metadata } from "next";
import { Database, Keyboard } from "lucide-react";

import { BackupPanel } from "@/components/settings/backup-panel";
import { DemoPanel } from "@/components/settings/demo-panel";
import { GoalsPanel } from "@/components/settings/goals-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { PushPanel } from "@/components/settings/push-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/policy";
import { countRemainingRecoveryCodes } from "@/server/auth/recovery";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { KEYBOARD_SHORTCUTS } from "@/lib/navigation";
import { parseOnboardingState } from "@/lib/logic/onboarding";
import { getDemoStatus } from "@/server/demo";
import { getGoalRows, getHabitOptions, getUser } from "@/server/queries";
import { getLatestMetricValues } from "@/server/health";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const [goals, habits, latest, demoStatus, recoveryCodesRemaining] = await Promise.all([
    getGoalRows(),
    getHabitOptions(),
    getLatestMetricValues(),
    getDemoStatus(user.id),
    countRemainingRecoveryCodes(user.id),
  ]);
  const weight = latest.get("body_weight");
  const onboarding = parseOnboardingState(user.onboardingState);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Your profile, goals, reminders, security and backups. Private to your account."
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
        <PushPanel />
        <SecurityPanel
          minPasswordLength={MIN_PASSWORD_LENGTH}
          lastLoginAt={user.lastLoginAt?.toISOString() ?? null}
          lastFailedLoginAt={user.lastFailedLoginAt?.toISOString() ?? null}
          recoveryCodesRemaining={recoveryCodesRemaining}
          email={user.email}
        />

        <DemoPanel
          demoLoaded={demoStatus.batch !== null}
          demoRecordCount={demoStatus.batch?.recordCount ?? 0}
          canLoad={demoStatus.canLoad}
          checklistDismissed={onboarding.dismissed}
        />

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
              Everything lives in this deployment&apos;s PostgreSQL database, scoped to your
              account — sign-in is a private email + password, with no external identity
              provider. Online food search is optional, sends only your search term, and never
              your records.
            </p>
            <p>
              To back up, use the JSON export above — it captures every record you own and
              imports cleanly into any deployment. Apple Health and CSV imports happen on the
              Health page — files are parsed in your browser, deduplicated, and removable again
              batch by batch without touching anything you entered by hand.
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
