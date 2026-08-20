"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import {
  definitionFingerprint,
  parseRuleDefinition,
  selfTriggerProblem,
} from "@/lib/logic/automation";
import {
  dryRunDefinition,
  getRuleExecutions,
  undoExecution,
  undoRuleBatch,
  type AutomationExecutionView,
  type DryRunResult,
} from "@/server/automation";
import { fail, fromZod, succeed, type ActionResult } from "@/lib/validation";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * Rule CRUD, with the safety flow the engine promises:
 *
 *  * A rule is stored DISABLED. Enabling requires a dry run of the exact
 *    current definition (`reviewedHash` must match the definition's
 *    fingerprint) — the mandatory review the checkpoint demands.
 *  * Editing a rule's behaviour re-disables it and invalidates the review:
 *    the changed rule must be dry-run again before it runs.
 *  * Direct self-triggering is rejected here, at save time.
 */

const ruleSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Give the rule a name").max(120),
  /** JSON strings, validated structurally by parseRuleDefinition below. */
  trigger: z.string().min(2).max(2_000),
  conditions: z.string().min(2).max(8_000),
  actions: z.string().min(2).max(8_000),
});

export async function saveAutomationRule(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;

  let definition;
  try {
    definition = parseRuleDefinition(data);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid rule definition");
  }
  const loop = selfTriggerProblem(definition);
  if (loop) return fail(loop);

  if (id) {
    const existing = await prisma.automationRule.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Rule not found");
    const changed = definitionFingerprint(data) !== definitionFingerprint(existing);
    await prisma.automationRule.update({
      where: { id },
      data: {
        ...data,
        // A changed behaviour must be reviewed again before it runs.
        ...(changed ? { enabled: false, reviewedHash: null, consecutiveFailures: 0, disabledReason: null } : {}),
      },
    });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.automationRule.create({
    data: { ...data, userId: user.id, enabled: false },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

/**
 * The mandatory pre-enable review: replay the rule against the last 30
 * days of the caller's real data, write nothing, and stamp the definition
 * as reviewed so `setAutomationRuleEnabled` will accept it.
 */
export async function dryRunAutomationRule(
  id: string,
): Promise<ActionResult<DryRunResult>> {
  const user = await getCurrentUser();
  const rule = await prisma.automationRule.findFirst({ where: { id, userId: user.id } });
  if (!rule) return fail("Rule not found");

  let definition;
  try {
    definition = parseRuleDefinition(rule);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid rule definition");
  }

  const result = await dryRunDefinition(user.id, definition);
  await prisma.automationRule.update({
    where: { id },
    data: { reviewedHash: definitionFingerprint(rule) },
  });
  revalidateAll();
  return succeed(result);
}

export async function setAutomationRuleEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const rule = await prisma.automationRule.findFirst({ where: { id, userId: user.id } });
  if (!rule) return fail("Rule not found");

  if (enabled) {
    if (!rule.reviewedHash || rule.reviewedHash !== definitionFingerprint(rule)) {
      return fail("Run the dry run first — a rule only enables from its preview.");
    }
  }

  await prisma.automationRule.update({
    where: { id },
    data: {
      enabled,
      ...(enabled ? { consecutiveFailures: 0, disabledReason: null } : {}),
    },
  });
  revalidateAll();
  return succeed(null);
}

/** Deleting a rule is the user's explicit act (the UI confirms); its
 * execution log goes with it. Rules themselves never delete anything. */
export async function deleteAutomationRule(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.automationRule.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

/** A rule's execution history, newest first — the per-rule audit view. */
export async function listAutomationExecutions(
  ruleId: string,
): Promise<ActionResult<AutomationExecutionView[]>> {
  const user = await getCurrentUser();
  const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, userId: user.id } });
  if (!rule) return fail("Rule not found");
  return succeed(await getRuleExecutions(user.id, ruleId));
}

export async function undoAutomationExecution(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await undoExecution(user.id, id);
  if (!result.undone) return fail(result.reason ?? "Could not undo");
  revalidateAll();
  return succeed(null);
}

export async function undoAutomationRuleExecutions(
  ruleId: string,
): Promise<ActionResult<{ undone: number }>> {
  const user = await getCurrentUser();
  const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, userId: user.id } });
  if (!rule) return fail("Rule not found");
  const result = await undoRuleBatch(user.id, ruleId);
  revalidateAll();
  return succeed(result);
}
