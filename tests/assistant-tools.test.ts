import { describe, expect, it } from "vitest";

import type { ScheduleSettings } from "@/lib/logic/schedule";
import type { CurrentUser } from "@/server/auth/current-user";
import {
  ASSISTANT_TOOLS,
  runTool,
  serializeToolResult,
  toolsForMode,
} from "@/server/ai/tools";
import {
  ASSISTANT_ACTION_KINDS,
  ASSISTANT_LIMITS,
  ASSISTANT_TOOL_LABELS,
} from "@/lib/logic/assistant";

/**
 * The tool registry's own guarantees — the parts that hold before any
 * database is involved: what each mode may see, how bad calls are refused,
 * and how results are bounded. Ownership behaviour runs against real
 * PostgreSQL in tests/integration/assistant.test.ts.
 */

const user = { id: "user-1", timezone: "UTC", unitSystem: "imperial" } as unknown as CurrentUser;
const settings: ScheduleSettings = { weekStartsOn: 1, timezone: "UTC", today: "2026-08-01" };

describe("the registry", () => {
  it("is pinned: these tools, and no silent additions", () => {
    expect(ASSISTANT_TOOLS.map((tool) => tool.name)).toEqual([
      "search_records",
      "get_needs_attention",
      "get_day_overview",
      "get_week_review",
      "get_schedule",
      "list_tasks",
      "list_inbox",
      "get_habit_status",
      "get_finance_overview",
      "list_transactions",
      "list_bills",
      "list_reminders",
      "get_reminder_feed",
      "get_health_trends",
      "list_documents",
      "get_import_history",
      "get_backup_status",
      "propose_action",
    ]);
  });

  it("declares a JSON schema and a validator for every tool", () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(tool.parameters, tool.name).toMatchObject({ type: "object" });
      expect(tool.validate, tool.name).toBeTruthy();
    }
  });

  it("gives every tool a human name for the activity chips", () => {
    // Without this, a tool added to the registry shows the user its raw
    // identifier ("get_habit_status") mid-answer.
    for (const tool of ASSISTANT_TOOLS) {
      expect(ASSISTANT_TOOL_LABELS[tool.name], tool.name).toBeTruthy();
    }
    // And nothing lingers in the map for a tool that no longer exists.
    const names = new Set(ASSISTANT_TOOLS.map((tool) => tool.name));
    for (const labelled of Object.keys(ASSISTANT_TOOL_LABELS)) {
      expect(names.has(labelled), labelled).toBe(true);
    }
  });

  it("withholds propose_action from read-only mode — and only that", () => {
    const readonly = toolsForMode("readonly").map((tool) => tool.name);
    expect(readonly).not.toContain("propose_action");
    expect(readonly).toHaveLength(ASSISTANT_TOOLS.length - 1);
    expect(toolsForMode("draft").map((tool) => tool.name)).toContain("propose_action");
    expect(toolsForMode("confirm").map((tool) => tool.name)).toContain("propose_action");
  });
});

describe("refusals", () => {
  it("refuses a tool that does not exist, readably", async () => {
    const outcome = await runTool({ user, settings, mode: "readonly" }, "drop_tables", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toMatchObject({ error: expect.stringContaining("Unknown tool") });
  });

  it("refuses propose_action in read-only mode before touching anything", async () => {
    const outcome = await runTool({ user, settings, mode: "readonly" }, "propose_action", {
      kind: "create_task",
      payload: { title: "x" },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toMatchObject({ error: expect.stringContaining("read-only") });
    expect(outcome.proposal).toBeUndefined();
  });

  it("refuses invalid arguments with the field named", async () => {
    const outcome = await runTool({ user, settings, mode: "readonly" }, "search_records", {
      query: "a",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toMatchObject({
      error: expect.stringContaining("Invalid arguments for search_records"),
    });
  });

  it("refuses a malformed date range", async () => {
    const outcome = await runTool({ user, settings, mode: "readonly" }, "get_schedule", {
      from: "next tuesday",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toMatchObject({ error: expect.stringContaining("from") });
  });
});

describe("the propose_action contract", () => {
  const tool = ASSISTANT_TOOLS.find((entry) => entry.name === "propose_action")!;

  /** The advertised fields for one kind, e.g. "title, notes?, dueDate?…". */
  function clauseFor(kind: string): string {
    const match = new RegExp(`${kind} \\{([^}]*)\\}`).exec(tool.description);
    expect(match, `${kind} is not described`).toBeTruthy();
    return match![1];
  }

  it("advertises only the fields the previews can describe", () => {
    // The description IS the model's contract; if it ever advertises a field
    // the preview sentence does not mention, the "what you confirm is what
    // runs" promise breaks. Recurrence is the specific trap: a planner block
    // that repeats writes ~120 rows from one confirmed sentence.
    expect(tool.description).toContain("Send ONLY the fields listed");
    expect(tool.description).toContain("never recurring");
    expect(tool.description).not.toMatch(/recurrenceRule|repeatEvery|parentId|tagIds/);
    // A planner block is a plain block: no recurrence, no tags, and no habit
    // link — `habitId` belongs to log_habit and nowhere else.
    expect(clauseFor("create_planner_block")).not.toMatch(/habitId|recurrence|tag/i);
    expect(clauseFor("create_task")).not.toMatch(/repeat|reminder|parent|tag|project/i);
    // Notes stay out of a habit log: the preview sentence cannot quote them.
    expect(clauseFor("log_habit")).not.toMatch(/notes/i);
  });

  it("offers exactly the kinds the safety model classifies", () => {
    const enumerated = (
      tool.parameters as { properties: { kind: { enum: string[] } } }
    ).properties.kind.enum;
    expect(enumerated).toEqual([...ASSISTANT_ACTION_KINDS]);
    // Every advertised kind is also spelled out in the description, so the
    // model is never told a kind exists without being told its fields.
    for (const kind of ASSISTANT_ACTION_KINDS) {
      expect(tool.description, kind).toContain(kind);
    }
  });
});

describe("get_habit_status arguments", () => {
  const tool = ASSISTANT_TOOLS.find((entry) => entry.name === "get_habit_status")!;

  it("takes no arguments at all — the common case is 'today'", () => {
    expect(tool.validate.safeParse({}).success).toBe(true);
  });

  it("refuses a date it cannot resolve rather than guessing", async () => {
    const outcome = await runTool({ user, settings, mode: "readonly" }, "get_habit_status", {
      date: "yesterday",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toMatchObject({ error: expect.stringContaining("date") });
  });

  it("bounds the name filter", () => {
    expect(tool.validate.safeParse({ name: "sleep" }).success).toBe(true);
    expect(tool.validate.safeParse({ name: "x".repeat(200) }).success).toBe(false);
    expect(tool.validate.safeParse({ name: "   " }).success).toBe(false);
  });

  it("drops a userId the model invents — identity is closed over, never sent", () => {
    // The schema advertises no such field, and the validator strips it, so
    // the read model can only ever be called with the signed-in user's id.
    expect(
      (tool.parameters as { properties: Record<string, unknown> }).properties.userId,
    ).toBeUndefined();
    const parsed = tool.validate.safeParse({ userId: "someone-else" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({});
  });
});

describe("bounded results", () => {
  it("passes small results through verbatim", () => {
    expect(serializeToolResult({ ok: true, result: { a: 1 } })).toBe('{"a":1}');
  });

  it("cuts oversized results and says so", () => {
    const big = { rows: "y".repeat(ASSISTANT_LIMITS.maxToolResultChars * 2) };
    const serialized = serializeToolResult({ ok: true, result: big });
    const parsed = JSON.parse(serialized) as { truncated: boolean; partial: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.partial.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.maxToolResultChars);
  });
});
