"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import {
  isAssistantActionKind,
  type AssistantActionKind,
  type AssistantMode,
} from "@/lib/logic/assistant";
import {
  assistantSettingsSchema,
  fail,
  fromZod,
  succeed,
  type ActionResult,
} from "@/lib/validation";
import { listAuditEntries, writeAuditEntry, type AuditEntryView } from "@/server/ai/audit";
import { getOllamaStatus, normalizeOllamaBaseUrl, type OllamaModel } from "@/server/ai/ollama";
import {
  listRecentProposals,
  reparsePayload,
  toPreview,
  type ProposalPreview,
} from "@/server/ai/proposals";
import { logRedactedError } from "@/server/safe-error";
import { completeTask, deleteTask, saveTask } from "@/server/actions/tasks";
import { saveInboxItem, setInboxItemStatus } from "@/server/actions/inbox";
import { logHabit } from "@/server/actions/habits";
import { deleteReminder, saveReminder } from "@/server/actions/health";
import { saveTransaction } from "@/server/actions/finance";
import { createScheduleItem } from "@/server/actions/planner";

/**
 * The assistant's server actions: settings, connection test, activity, and —
 * the heart of the safety model — proposal decisions. Confirming a proposal
 * is the ONLY path from "the model suggested something" to "data changed",
 * it requires the account to be in confirm mode, and it executes by calling
 * the same server actions the buttons in the app call, so every ownership
 * check, validation rule and revalidation they carry applies unchanged.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

// --- settings ----------------------------------------------------------------

export interface AssistantSettingsView {
  baseUrl: string | null;
  model: string | null;
  mode: AssistantMode;
}

export async function saveAssistantSettings(input: unknown): Promise<ActionResult<null>> {
  const parsed = assistantSettingsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  let baseUrl: string | null = null;
  if (parsed.data.baseUrl !== "") {
    const checked = normalizeOllamaBaseUrl(parsed.data.baseUrl);
    if (!checked.ok) return fail(checked.error, { baseUrl: [checked.error] });
    baseUrl = checked.url;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      assistantBaseUrl: baseUrl,
      assistantModel: parsed.data.model?.trim() ? parsed.data.model.trim() : null,
      assistantMode: parsed.data.mode,
    },
  });
  revalidateAll();
  return succeed(null);
}

// --- connection test ---------------------------------------------------------

export interface AssistantConnectionResult {
  reachable: boolean;
  version: string | null;
  models: OllamaModel[];
  error: string | null;
}

/**
 * Probe the Ollama server — the one in `input.baseUrl` if given (so the
 * settings form can test before saving), the stored one otherwise. Only an
 * explicit test (`record: true`) lands in the audit log; the assistant page's
 * passive status check on load does not, or the log would be all heartbeats.
 */
export async function testAssistantConnection(input?: {
  baseUrl?: string;
  record?: boolean;
}): Promise<ActionResult<AssistantConnectionResult>> {
  const user = await getCurrentUser();
  const raw = typeof input?.baseUrl === "string" ? input.baseUrl : (user.assistantBaseUrl ?? "");
  if (!raw.trim()) {
    return succeed({
      reachable: false,
      version: null,
      models: [],
      error: "The assistant is not set up yet — enter your Ollama server URL.",
    });
  }
  const checked = normalizeOllamaBaseUrl(raw);
  if (!checked.ok) {
    return succeed({ reachable: false, version: null, models: [], error: checked.error });
  }

  const status = await getOllamaStatus(checked.url);
  const outcome: AssistantConnectionResult = status.ok
    ? { reachable: true, version: status.data.version, models: status.data.models, error: null }
    : { reachable: false, version: null, models: [], error: status.failure.message };

  if (input?.record) {
    await writeAuditEntry({
      userId: user.id,
      kind: "connection",
      status: outcome.reachable ? "ok" : "error",
      summary: outcome.reachable
        ? `Connection test succeeded (Ollama ${outcome.version}, ${outcome.models.length} model${outcome.models.length === 1 ? "" : "s"})`
        : `Connection test failed: ${outcome.error}`,
    });
  }

  return succeed(outcome);
}

// --- proposal decisions ------------------------------------------------------

export interface ProposalDecisionOutcome {
  proposal: ProposalPreview;
}

/**
 * Execute a proposal the user confirmed. Guarded four ways: the account must
 * be in confirm mode; the row must be this user's, still undecided and not
 * expired (claimed atomically, so a double click executes once); the stored
 * payload is re-validated with the kind's schema; and the target action
 * re-checks ownership and validity itself.
 */
export async function confirmAssistantProposal(
  id: string,
): Promise<ActionResult<ProposalDecisionOutcome>> {
  const user = await getCurrentUser();
  if ((user.assistantMode as AssistantMode) !== "confirm") {
    return fail("Switch the assistant to Confirm mode to execute proposals.");
  }

  const claimed = await prisma.assistantProposal.updateMany({
    where: { id, userId: user.id, status: "proposed", expiresAt: { gt: new Date() } },
    data: { status: "confirmed", decidedAt: new Date() },
  });
  if (claimed.count === 0) {
    return fail("This proposal is no longer open — it was already decided or has expired.");
  }
  const row = await prisma.assistantProposal.findFirst({ where: { id, userId: user.id } });
  if (!row || !isAssistantActionKind(row.kind)) {
    // The claim above already stamped the row "confirmed", so leaving now
    // would record a change that never ran. Reachable in one real case: a
    // proposal staged by a newer deployment, decided after a rollback that
    // no longer knows the kind. Stamp it failed and audit it like any other
    // failure, so the trail never claims something happened.
    const error = "This proposal could not be read.";
    if (row) {
      await prisma.assistantProposal.update({
        where: { id: row.id },
        data: { status: "failed", resultSummary: error },
      });
      await writeAuditEntry({
        userId: user.id,
        kind: "action",
        status: "error",
        summary: `Confirmed but failed: ${row.summary} — ${error}`,
        proposalId: row.id,
      });
    }
    return fail(error);
  }

  const executed = await executeProposalKind(row.kind, row.payload);
  const updated = await prisma.assistantProposal.update({
    where: { id: row.id },
    data: executed.ok
      ? {
          status: "confirmed",
          resultSummary: executed.summary,
          executedRecordId: executed.recordId,
        }
      : { status: "failed", resultSummary: executed.error },
  });

  await writeAuditEntry({
    userId: user.id,
    kind: "action",
    status: executed.ok ? "ok" : "error",
    summary: executed.ok
      ? `Confirmed: ${row.summary} — ${executed.summary}`
      : `Confirmed but failed: ${row.summary} — ${executed.error}`,
    proposalId: row.id,
  });

  if (!executed.ok) return fail(executed.error);
  revalidateAll();
  return succeed({ proposal: toPreview(updated) });
}

export async function rejectAssistantProposal(
  id: string,
): Promise<ActionResult<ProposalDecisionOutcome>> {
  const user = await getCurrentUser();
  const claimed = await prisma.assistantProposal.updateMany({
    where: { id, userId: user.id, status: "proposed" },
    data: { status: "rejected", decidedAt: new Date() },
  });
  if (claimed.count === 0) {
    return fail("This proposal is no longer open — it was already decided or has expired.");
  }
  const row = await prisma.assistantProposal.findFirst({ where: { id, userId: user.id } });
  if (!row) return fail("This proposal could not be read.");

  await writeAuditEntry({
    userId: user.id,
    kind: "action",
    status: "cancelled",
    summary: `Cancelled: ${row.summary}`,
    proposalId: row.id,
  });
  return succeed({ proposal: toPreview(row) });
}

type ExecutionOutcome =
  | { ok: true; summary: string; recordId: string | null }
  | { ok: false; error: string };

/**
 * The one dispatch table from proposal kind to existing server action. Every
 * arm calls an action that validates its own input and scopes every query to
 * the signed-in user — this function adds no database access of its own.
 */
async function executeProposalKind(
  kind: AssistantActionKind,
  rawPayload: string,
): Promise<ExecutionOutcome> {
  const parsed = reparsePayload(kind, rawPayload);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const payload = parsed.payload;

  try {
    switch (kind) {
      case "create_task": {
        const result = await saveTask(payload);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Task created", recordId: result.data.id };
      }
      case "complete_task": {
        const { id } = payload as { id: string };
        const result = await completeTask(id);
        if (!result.ok) return { ok: false, error: result.error };
        return {
          ok: true,
          summary:
            result.data.status === "advanced"
              ? `Repeating task advanced to ${result.data.nextDue}`
              : "Task completed",
          recordId: id,
        };
      }
      case "create_reminder": {
        const result = await saveReminder(payload);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Reminder created", recordId: result.data.id };
      }
      case "create_inbox_item": {
        const result = await saveInboxItem(payload);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Inbox note added", recordId: result.data.id };
      }
      case "create_transaction": {
        const result = await saveTransaction(payload);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Transaction recorded", recordId: result.data.id };
      }
      case "create_planner_block": {
        const result = await createScheduleItem(payload);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Planner block added", recordId: result.data.id };
      }
      case "log_habit": {
        const result = await logHabit(payload);
        if (!result.ok) return { ok: false, error: result.error };
        const { habitId } = payload as { habitId: string };
        return { ok: true, summary: `Habit logged as ${result.data.status}`, recordId: habitId };
      }
      case "complete_inbox_item": {
        const { id } = payload as { id: string };
        const result = await setInboxItemStatus(id, "done");
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Inbox note completed", recordId: id };
      }
      case "delete_task": {
        const { id } = payload as { id: string };
        const result = await deleteTask(id);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Task deleted", recordId: null };
      }
      case "delete_reminder": {
        const { id } = payload as { id: string };
        const result = await deleteReminder(id);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: "Reminder deleted", recordId: null };
      }
    }
  } catch (error) {
    const reference = logRedactedError("assistant-execute", error);
    return { ok: false, error: `The action failed unexpectedly (reference ${reference}).` };
  }
}

// --- activity ----------------------------------------------------------------

export interface AssistantActivity {
  proposals: ProposalPreview[];
  audit: AuditEntryView[];
}

export async function getAssistantActivity(): Promise<ActionResult<AssistantActivity>> {
  const user = await getCurrentUser();
  const [proposals, audit] = await Promise.all([
    listRecentProposals(user.id, 20),
    listAuditEntries(user.id, 20),
  ]);
  return succeed({ proposals, audit });
}
