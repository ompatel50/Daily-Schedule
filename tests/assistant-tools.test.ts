import { describe, expect, it } from "vitest";

import type { ScheduleSettings } from "@/lib/logic/schedule";
import type { CurrentUser } from "@/server/auth/current-user";
import {
  ASSISTANT_TOOLS,
  runTool,
  serializeToolResult,
  toolsForMode,
} from "@/server/ai/tools";
import { ASSISTANT_LIMITS } from "@/lib/logic/assistant";

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
  it("advertises only the fields the previews can describe", () => {
    const tool = ASSISTANT_TOOLS.find((entry) => entry.name === "propose_action")!;
    // The description IS the model's contract; if it ever advertises a field
    // the preview sentence does not mention, the "what you confirm is what
    // runs" promise breaks. Recurrence is the specific trap: a planner block
    // that repeats writes ~120 rows from one confirmed sentence.
    expect(tool.description).toContain("Send ONLY the fields listed");
    expect(tool.description).toContain("never recurring");
    expect(tool.description).not.toMatch(/recurrenceRule|repeatEvery|parentId|tagIds|habitId/);
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
