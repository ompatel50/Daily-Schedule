import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ACTION_KINDS,
  ASSISTANT_ACTION_META,
  ASSISTANT_LIMITS,
  ASSISTANT_MODES,
  ASSISTANT_MODE_META,
  PROPOSAL_STATUSES,
  assistantStatusLabel,
  isAssistantActionKind,
  isAssistantMode,
  parseAuditToolCalls,
  requestPreviewOf,
  riskOf,
  truncateText,
} from "@/lib/logic/assistant";

/** The assistant's shared vocabulary — pure, and pinned like the app's other enums. */

describe("modes", () => {
  it("read-only exists, is first, and every mode has display copy", () => {
    expect(ASSISTANT_MODES[0]).toBe("readonly");
    for (const mode of ASSISTANT_MODES) {
      expect(ASSISTANT_MODE_META[mode].label.length).toBeGreaterThan(0);
      expect(ASSISTANT_MODE_META[mode].description.length).toBeGreaterThan(0);
    }
  });

  it("narrows unknown values", () => {
    expect(isAssistantMode("draft")).toBe(true);
    expect(isAssistantMode("yolo")).toBe(false);
    expect(isAssistantMode(null)).toBe(false);
  });
});

describe("action kinds and risk", () => {
  it("classifies every kind, and every delete is destructive", () => {
    for (const kind of ASSISTANT_ACTION_KINDS) {
      expect(["normal", "sensitive", "destructive"]).toContain(riskOf(kind));
      expect(ASSISTANT_ACTION_META[kind].label.length).toBeGreaterThan(0);
      if (kind.startsWith("delete_")) expect(riskOf(kind)).toBe("destructive");
    }
  });

  it("puts finance, reminders and schedule changes behind the harder confirmation", () => {
    expect(riskOf("create_transaction")).toBe("sensitive");
    expect(riskOf("create_reminder")).toBe("sensitive");
    expect(riskOf("create_planner_block")).toBe("sensitive");
    expect(riskOf("create_task")).toBe("normal");
  });

  it("keeps the everyday ticks — habits and inbox notes — on one click", () => {
    // Logging a habit and closing an inbox note are undone by clicking the
    // same control in the app; a restating dialog for either would train the
    // user to click through the dialogs that do matter.
    expect(riskOf("log_habit")).toBe("normal");
    expect(riskOf("complete_inbox_item")).toBe("normal");
  });

  it("narrows unknown kinds", () => {
    expect(isAssistantActionKind("create_task")).toBe(true);
    expect(isAssistantActionKind("drop_database")).toBe(false);
  });
});

describe("status wording", () => {
  it("says what happened, not what the column stores", () => {
    expect(assistantStatusLabel("ok")).toBe("Done");
    expect(assistantStatusLabel("rejected")).toBe("Cancelled");
    expect(assistantStatusLabel("failed")).toBe("Failed");
    for (const status of PROPOSAL_STATUSES) {
      expect(assistantStatusLabel(status), status).not.toBe(status);
    }
  });

  it("passes an unknown status through rather than hiding it", () => {
    expect(assistantStatusLabel("something-new")).toBe("something-new");
  });
});

describe("bounded text", () => {
  it("flattens whitespace and marks the cut", () => {
    expect(truncateText("a  b\n\nc", 100)).toBe("a b c");
    const cut = truncateText("x".repeat(300), 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("previews a request within the audit bound", () => {
    const preview = requestPreviewOf(`${"long ".repeat(100)}end`);
    expect(preview.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.maxRequestPreviewChars);
  });
});

describe("parseAuditToolCalls", () => {
  it("parses well-formed entries and drops everything else", () => {
    const raw = JSON.stringify([
      { tool: "search_records", args: "{}" },
      { tool: 42, args: "x" },
      "junk",
      { tool: "list_tasks" },
    ]);
    expect(parseAuditToolCalls(raw)).toEqual([
      { tool: "search_records", args: "{}" },
      { tool: "list_tasks", args: "" },
    ]);
  });

  it("treats bad JSON as an empty list", () => {
    expect(parseAuditToolCalls("not json")).toEqual([]);
    expect(parseAuditToolCalls('{"tool":"x"}')).toEqual([]);
  });
});
