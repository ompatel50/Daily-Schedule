import type { Metadata } from "next";
import Link from "next/link";
import { Database, Keyboard, Trash2, Workflow } from "lucide-react";

import { AssistantPanel } from "@/components/settings/assistant-panel";
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
import { isAssistantMode } from "@/lib/logic/assistant";
import { parseOnboardingState } from "@/lib/logic/onboarding";
import { getDemoStatus } from "@/server/demo";
import { getTrashCount } from "@/server/trash";
import { TRASH_RETENTION_DAYS } from "@/lib/soft-delete";
import { getGoalRows, getHabitOptions, getUser } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const [goals, habits, demoStatus, recoveryCodesRemaining, trashCount] =
    await Promise.all([
      getGoalRows(),
      getHabitOptions(),
      getDemoStatus(user.id),
      countRemainingRecoveryCodes(user.id),
      getTrashCount(),
    ]);
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
            dayResetMinute: user.dayResetMinute,
          }}
        />

        <GoalsPanel
          goals={goals}
          habits={habits}
          weekStartsOn={settings.weekStartsOn}
          today={settings.today}
        />

        <AssistantPanel
          initial={{
            baseUrl: user.assistantBaseUrl,
            model: user.assistantModel,
            mode: isAssistantMode(user.assistantMode) ? user.assistantMode : "readonly",
          }}
        />

        {/* Anchored so reminder search hits can land here directly. */}
        <div id="reminders">
          <NotificationsPanel />
        </div>
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
          title="Your data"
          icon={Database}
          accent="text-muted-foreground"
          description="Record counts, oldest and newest entries, import and backup recency"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>
              A read-only, module-by-module view of everything this account holds — the same
              numbers the assistant reports, surfaced for you.
            </p>
            <Link
              href="/settings/data"
              className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              View your data
            </Link>
          </div>
        </SectionCard>

        <SectionCard
          title="Automations"
          icon={Workflow}
          accent="text-domain-goal"
          description="If-this-then-that rules over your own data"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>
              Categorise merchants, link recurring charges to bills, log habits after workouts,
              protect short-sleep days. Rules never delete anything, log every run, and only
              enable after a dry run against your real data.
            </p>
            <Link
              href="/settings/rules"
              className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Open automations
            </Link>
          </div>
        </SectionCard>

        <SectionCard
          title="Trash"
          icon={Trash2}
          accent="text-muted-foreground"
          description="Deleted items wait here before they are removed for good"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>
              Deleting anything — a task, a transaction, a planner block — moves it to the
              trash, where it can be restored for {TRASH_RETENTION_DAYS} days.
              {trashCount > 0
                ? ` ${trashCount === 1 ? "1 item is" : `${trashCount} items are`} in the trash now.`
                : " It is currently empty."}
            </p>
            <Link
              href="/settings/trash"
              className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Open trash
            </Link>
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
