/**
 * The rules engine end to end: the mandatory dry-run-before-enable flow,
 * record triggers firing from the real server actions, execution logging,
 * loop prevention (save-time rejection AND the runtime depth bound), undo
 * through the trash, failure self-disabling, tick triggers with per-day
 * dedup, isolation, and the v15 backup round trip.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { prismaIncludingTrashed } from "@/lib/prisma";
import { shiftDay } from "@/lib/date";
import {
  deleteAutomationRule,
  dryRunAutomationRule,
  saveAutomationRule,
  setAutomationRuleEnabled,
  undoAutomationExecution,
} from "@/server/actions/automation";
import { exportBackup, importBackup } from "@/server/actions/backup";
import { saveFinanceAccount, saveTransaction } from "@/server/actions/finance";
import { saveTask } from "@/server/actions/tasks";
import { saveInboxItem } from "@/server/actions/inbox";
import { runDailyAutomationsFor } from "@/server/automation";
import { scheduleSettingsFor } from "@/server/schedule";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

const TRANSACTION_TRIGGER = '{"type":"record","module":"transaction","event":"created"}';
const NO_CONDITIONS = '{"all":[]}';

async function checkingAccount(): Promise<string> {
  const result = await saveFinanceAccount({ name: "Checking", openingBalance: 500 });
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

/** Save + dry-run + enable, the full mandatory flow. */
async function enabledRule(input: {
  name: string;
  trigger: string;
  conditions?: string;
  actions: string;
}): Promise<string> {
  const saved = await saveAutomationRule({ conditions: NO_CONDITIONS, ...input });
  if (!saved.ok) throw new Error(saved.error);
  const reviewed = await dryRunAutomationRule(saved.data.id);
  if (!reviewed.ok) throw new Error(reviewed.error);
  const enabled = await setAutomationRuleEnabled(saved.data.id, true);
  if (!enabled.ok) throw new Error(enabled.error);
  return saved.data.id;
}

describe("the mandatory dry run", () => {
  it("a rule saves disabled and cannot enable before its preview", async () => {
    const saved = await saveAutomationRule({
      name: "Categorise gym",
      trigger: TRANSACTION_TRIGGER,
      conditions: NO_CONDITIONS,
      actions: '[{"type":"set_category","category":"health"}]',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id: saved.data.id } });
    expect(rule.enabled).toBe(false);

    const premature = await setAutomationRuleEnabled(saved.data.id, true);
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error).toMatch(/dry run/i);

    const preview = await dryRunAutomationRule(saved.data.id);
    expect(preview.ok).toBe(true);
    const enabled = await setAutomationRuleEnabled(saved.data.id, true);
    expect(enabled.ok).toBe(true);
  });

  it("previews against the last 30 days of real data without writing", async () => {
    const accountId = await checkingAccount();
    const settings = scheduleSettingsFor(
      await prisma.user.findUniqueOrThrow({ where: { id: alice.id } }),
    );
    await saveTransaction({
      accountId,
      date: shiftDay(settings.today, -3),
      amount: -30,
      payee: "Planet Fitness",
      category: "other",
    });
    await saveTransaction({
      accountId,
      date: shiftDay(settings.today, -2),
      amount: -12,
      payee: "Corner Store",
      category: "other",
    });

    const saved = await saveAutomationRule({
      name: "Categorise gym",
      trigger: TRANSACTION_TRIGGER,
      conditions: '{"field":"payee","op":"contains","value":"planet"}',
      actions: '[{"type":"set_category","category":"health"}]',
    });
    if (!saved.ok) throw new Error(saved.error);
    const preview = await dryRunAutomationRule(saved.data.id);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.matches).toHaveLength(1);
    expect(preview.data.matches[0].when).toContain("Planet Fitness");
    expect(preview.data.matches[0].actions[0]).toMatch(/Would set category to health/);

    // Nothing was written: the transaction still carries its old category.
    const rows = await prisma.financeTransaction.findMany({ where: { userId: alice.id } });
    expect(rows.every((row) => row.category === "other")).toBe(true);
    expect(await prisma.automationExecution.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("editing a rule's behaviour disables it and voids the review", async () => {
    const id = await enabledRule({
      name: "Categorise gym",
      trigger: TRANSACTION_TRIGGER,
      actions: '[{"type":"set_category","category":"health"}]',
    });
    const edited = await saveAutomationRule({
      id,
      name: "Categorise gym",
      trigger: TRANSACTION_TRIGGER,
      conditions: NO_CONDITIONS,
      actions: '[{"type":"set_category","category":"entertainment"}]',
    });
    expect(edited.ok).toBe(true);
    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id } });
    expect(rule.enabled).toBe(false);
    const premature = await setAutomationRuleEnabled(id, true);
    expect(premature.ok).toBe(false);
  });

  it("rejects a self-triggering rule at save time", async () => {
    const saved = await saveAutomationRule({
      name: "Loop",
      trigger: '{"type":"record","module":"task","event":"created"}',
      conditions: NO_CONDITIONS,
      actions: '[{"type":"create_task","title":"again"}]',
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error).toMatch(/trigger itself/);
  });
});

describe("record triggers through the real actions", () => {
  it("categorises, links and logs — with ids and previous values recorded", async () => {
    const accountId = await checkingAccount();
    await prisma.bill.create({
      data: {
        userId: alice.id,
        name: "Planet Fitness",
        amount: 25,
        amountCents: 2500,
        category: "health",
        recurrence: "monthly",
        nextDueDate: "2026-09-01",
        anchorDate: "2026-09-01",
      },
    });
    await enabledRule({
      name: "Gym pipeline",
      trigger: TRANSACTION_TRIGGER,
      conditions: '{"field":"payee","op":"contains","value":"planet"}',
      actions:
        '[{"type":"set_category","category":"health"},{"type":"link_bill"},{"type":"create_task","title":"Check {{payee}} charge"}]',
    });

    const saved = await saveTransaction({
      accountId,
      date: "2026-08-10",
      amount: -25,
      payee: "Planet Fitness",
      category: "other",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const transaction = await prisma.financeTransaction.findUniqueOrThrow({
      where: { id: saved.data.id },
    });
    expect(transaction.category).toBe("health");
    expect(transaction.billId).not.toBeNull();

    const task = await prisma.task.findFirst({ where: { userId: alice.id } });
    expect(task?.title).toBe("Check Planet Fitness charge");

    const execution = await prisma.automationExecution.findFirstOrThrow({
      where: { userId: alice.id },
    });
    expect(execution.status).toBe("success");
    const outcomes = JSON.parse(execution.actions) as Array<Record<string, unknown>>;
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({
      type: "set_category",
      previous: { field: "category", value: "other" },
    });
    expect(outcomes[2]).toMatchObject({ created: { table: "task", id: task!.id } });

    const rule = await prisma.automationRule.findFirstOrThrow({ where: { userId: alice.id } });
    expect(rule.lastStatus).toBe("matched");
  });

  it("a non-matching write leaves no trace", async () => {
    const accountId = await checkingAccount();
    await enabledRule({
      name: "Gym pipeline",
      trigger: TRANSACTION_TRIGGER,
      conditions: '{"field":"payee","op":"contains","value":"planet"}',
      actions: '[{"type":"set_category","category":"health"}]',
    });
    await saveTransaction({
      accountId,
      date: "2026-08-10",
      amount: -8,
      payee: "Bakery",
      category: "dining",
    });
    expect(await prisma.automationExecution.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("cascades exactly one level, then stops — the depth bound", async () => {
    // A: task created → capture to inbox. B: inbox created → create a task.
    // A user task fires A → inbox → B → task (depth 1) → that task's event
    // dispatches at depth 2 and is NOT evaluated: A must not fire again.
    await enabledRule({
      name: "A",
      trigger: '{"type":"record","module":"task","event":"created"}',
      actions: '[{"type":"create_inbox","title":"From task: {{title}}"}]',
    });
    await enabledRule({
      name: "B",
      trigger: '{"type":"record","module":"inbox","event":"created"}',
      actions: '[{"type":"create_task","title":"From inbox: {{title}}"}]',
    });

    const saved = await saveTask({ title: "Seed" });
    expect(saved.ok).toBe(true);

    const executions = await prisma.automationExecution.findMany({
      where: { userId: alice.id },
      include: { rule: { select: { name: true } } },
    });
    expect(executions.filter((entry) => entry.rule.name === "A")).toHaveLength(1);
    expect(executions.filter((entry) => entry.rule.name === "B")).toHaveLength(1);
    // Two tasks in total: the user's and B's. A third would mean a loop.
    expect(await prisma.task.count({ where: { userId: alice.id } })).toBe(2);
    expect(await prisma.inboxItem.count({ where: { userId: alice.id } })).toBe(1);
  });
});

describe("undo through the trash", () => {
  it("reverts field changes and trashes created records, once", async () => {
    const accountId = await checkingAccount();
    await enabledRule({
      name: "Gym pipeline",
      trigger: TRANSACTION_TRIGGER,
      conditions: '{"field":"payee","op":"contains","value":"planet"}',
      actions:
        '[{"type":"set_category","category":"health"},{"type":"create_task","title":"Check charge"}]',
    });
    const saved = await saveTransaction({
      accountId,
      date: "2026-08-10",
      amount: -25,
      payee: "Planet Fitness",
      category: "other",
    });
    if (!saved.ok) throw new Error(saved.error);

    const execution = await prisma.automationExecution.findFirstOrThrow({
      where: { userId: alice.id },
    });
    const undone = await undoAutomationExecution(execution.id);
    expect(undone.ok).toBe(true);

    // The category is back; the task is in the Trash (soft-deleted, live
    // queries no longer see it, the raw client still does).
    const transaction = await prisma.financeTransaction.findUniqueOrThrow({
      where: { id: saved.data.id },
    });
    expect(transaction.category).toBe("other");
    expect(await prisma.task.count({ where: { userId: alice.id } })).toBe(0);
    const trashed = await prismaIncludingTrashed.task.findFirst({
      where: { userId: alice.id },
    });
    expect(trashed?.deletedAt).not.toBeNull();

    const again = await undoAutomationExecution(execution.id);
    expect(again.ok).toBe(false);
  });
});

describe("failure self-disabling", () => {
  it("a rule that keeps erroring disables itself and says why", async () => {
    const accountId = await checkingAccount();
    await enabledRule({
      name: "Broken",
      trigger: TRANSACTION_TRIGGER,
      actions: '[{"type":"log_habit","habit":"No Such Habit"}]',
    });

    for (let index = 0; index < 3; index += 1) {
      await saveTransaction({
        accountId,
        date: "2026-08-10",
        amount: -5 - index,
        payee: `Shop ${index}`,
        category: "other",
      });
    }

    const rule = await prisma.automationRule.findFirstOrThrow({ where: { userId: alice.id } });
    expect(rule.enabled).toBe(false);
    expect(rule.disabledReason).toMatch(/3 consecutive failures/);
    expect(rule.disabledReason).toMatch(/No Such Habit/);
    const errors = await prisma.automationExecution.count({
      where: { userId: alice.id, status: "error" },
    });
    expect(errors).toBe(3);
  });
});

describe("tick triggers", () => {
  it("fires a fact-threshold rule once per day, deduplicated", async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    const settings = scheduleSettingsFor(row);
    const yesterday = shiftDay(settings.today, -1);
    await prisma.calendarDaySummary.create({
      data: { userId: alice.id, date: yesterday, sleepHours: 5.0 },
    });

    await enabledRule({
      name: "Low sleep",
      trigger: '{"type":"fact","metric":"sleepHours","direction":"below","value":6}',
      actions: '[{"type":"create_block","title":"Wind down early","category":"rest"}]',
    });

    expect((await runDailyAutomationsFor(row)).fired).toBe(1);
    expect((await runDailyAutomationsFor(row)).fired).toBe(0); // same day: deduped

    const block = await prisma.scheduleItem.findFirst({ where: { userId: alice.id } });
    expect(block?.title).toBe("Wind down early");
    expect(block?.category).toBe("rest");
  });

  it("a missing metric never crosses a threshold", async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    // No summary rows at all: sleepHours is unknown, not zero.
    await enabledRule({
      name: "Low sleep",
      trigger: '{"type":"fact","metric":"sleepHours","direction":"below","value":6}',
      actions: '[{"type":"create_inbox","title":"x"}]',
    });
    expect((await runDailyAutomationsFor(row)).fired).toBe(0);
  });

  it("an anomaly trigger fires from a live observation", async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    const settings = scheduleSettingsFor(row);
    for (let daysAgo = 1; daysAgo <= 35; daysAgo += 1) {
      await prisma.calendarDaySummary.create({
        data: {
          userId: alice.id,
          date: shiftDay(settings.today, -daysAgo),
          restingHr: daysAgo <= 5 ? 64 : 55,
        },
      });
    }
    await enabledRule({
      name: "HR watch",
      trigger: '{"type":"anomaly","category":"resting_hr"}',
      actions: '[{"type":"create_inbox","title":"Note: {{title}}"}]',
    });
    expect((await runDailyAutomationsFor(row)).fired).toBe(1);
    const item = await prisma.inboxItem.findFirstOrThrow({ where: { userId: alice.id } });
    expect(item.title).toContain("Resting heart rate");
  });
});

describe("isolation", () => {
  it("one user's rules never see another's writes", async () => {
    await enabledRule({
      name: "Alice rule",
      trigger: '{"type":"record","module":"inbox","event":"created"}',
      actions: '[{"type":"create_task","title":"For Alice"}]',
    });

    actAs(bob);
    const saved = await saveInboxItem({ title: "Bob's note" });
    expect(saved.ok).toBe(true);
    expect(await prisma.task.count({ where: { userId: bob.id } })).toBe(0);
    expect(await prisma.automationExecution.count()).toBe(0);
  });
});

describe("backup v15", () => {
  it("rules ride the backup and restore disabled pending review", async () => {
    const id = await enabledRule({
      name: "Gym pipeline",
      trigger: TRANSACTION_TRIGGER,
      actions: '[{"type":"set_category","category":"health"}]',
    });

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const file = exported.data as {
      version: number;
      data: Record<string, Array<{ name?: string; enabled?: boolean }>>;
    };
    expect(file.version).toBe(15);
    expect(file.data.automationRules).toHaveLength(1);

    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const bobRule = await prisma.automationRule.findFirstOrThrow({ where: { userId: bob.id } });
    expect(bobRule.name).toBe("Gym pipeline");
    expect(bobRule.enabled).toBe(false); // must be re-reviewed here
    expect(bobRule.reviewedHash).toBeNull();

    // Cleanup path: deleting a rule is explicit and takes its log with it.
    actAs(alice);
    const deleted = await deleteAutomationRule(id);
    expect(deleted.ok).toBe(true);
    expect(await prisma.automationRule.count({ where: { userId: alice.id } })).toBe(0);
  });
});
