import { describe, expect, it } from "vitest";

import {
  ACTION_TYPES,
  MAX_ACTIONS_PER_RULE,
  MAX_CONDITION_DEPTH,
  MODULE_FIELDS,
  RECORD_MODULES,
  definitionFingerprint,
  describeRule,
  evaluateConditions,
  parseActions,
  parseConditions,
  parseRuleDefinition,
  parseTrigger,
  renderTemplate,
  selfTriggerProblem,
} from "@/lib/logic/automation";
import { STARTER_RULES } from "@/lib/logic/automation-library";

/**
 * The rules engine's pure core: definition validation (bounded, whitelisted,
 * no delete verb), condition evaluation, templates, and the save-time
 * self-trigger rejection.
 */

describe("trigger parsing", () => {
  it("accepts the four trigger families", () => {
    expect(parseTrigger('{"type":"record","module":"transaction","event":"created"}')).toEqual({
      type: "record",
      module: "transaction",
      event: "created",
    });
    expect(parseTrigger('{"type":"fact","metric":"sleepHours","direction":"below","value":6}')).toEqual({
      type: "fact",
      metric: "sleepHours",
      direction: "below",
      value: 6,
    });
    expect(parseTrigger('{"type":"date","weekdays":[1]}')).toMatchObject({ type: "date" });
    expect(parseTrigger('{"type":"anomaly","category":"spending"}')).toMatchObject({
      type: "anomaly",
      category: "spending",
    });
  });

  it("rejects unknown modules, events, metrics and types", () => {
    expect(() => parseTrigger('{"type":"record","module":"user","event":"created"}')).toThrow();
    expect(() => parseTrigger('{"type":"record","module":"task","event":"deleted"}')).toThrow();
    expect(() => parseTrigger('{"type":"fact","metric":"password","direction":"above","value":1}')).toThrow();
    expect(() => parseTrigger('{"type":"exec"}')).toThrow();
  });
});

describe("condition parsing bounds", () => {
  it("rejects nesting beyond the documented depth", () => {
    const deep = '{"all":[{"any":[{"all":[{"any":[{"field":"x","op":"eq","value":1}]}]}]}]}';
    expect(() => parseConditions(deep)).toThrow(/nest at most/);
    const okay = '{"all":[{"any":[{"field":"x","op":"eq","value":1}]}]}';
    expect(parseConditions(okay)).toBeTruthy();
    expect(MAX_CONDITION_DEPTH).toBe(3);
  });

  it("rejects unknown operators and oversized trees", () => {
    expect(() => parseConditions('{"field":"x","op":"regex","value":".*"}')).toThrow();
    const wide = JSON.stringify({
      all: Array.from({ length: 25 }, () => ({ field: "x", op: "eq", value: 1 })),
    });
    expect(() => parseConditions(wide)).toThrow(/At most/);
  });
});

describe("action parsing — the never-delete whitelist", () => {
  it("has no delete verb at all", () => {
    for (const type of ACTION_TYPES) {
      expect(type).not.toMatch(/delete|remove|purge|trash|clear/i);
    }
  });

  it("rejects unknown verbs and over-long lists", () => {
    expect(() => parseActions('[{"type":"delete_task","id":"x"}]')).toThrow(/Unknown action/);
    expect(() => parseActions('[{"type":"drop_table"}]')).toThrow(/Unknown action/);
    const many = JSON.stringify(
      Array.from({ length: MAX_ACTIONS_PER_RULE + 1 }, () => ({
        type: "create_inbox",
        title: "x",
      })),
    );
    expect(() => parseActions(many)).toThrow(/At most/);
    expect(() => parseActions("[]")).toThrow(/needs an action/);
  });

  it("requires the fields each verb needs", () => {
    expect(() => parseActions('[{"type":"create_task"}]')).toThrow(/needs a title/);
    expect(() => parseActions('[{"type":"set_category"}]')).toThrow(/needs a category/);
    expect(() => parseActions('[{"type":"log_habit"}]')).toThrow(/needs a habit/);
    expect(parseActions('[{"type":"link_bill"}]')).toHaveLength(1);
  });
});

describe("self-trigger rejection at save time", () => {
  const definition = (trigger: string, actions: string) =>
    parseRuleDefinition({ trigger, conditions: '{"all":[]}', actions });

  it("refuses a task-created rule that creates a task", () => {
    const problem = selfTriggerProblem(
      definition(
        '{"type":"record","module":"task","event":"created"}',
        '[{"type":"create_task","title":"loop"}]',
      ),
    );
    expect(problem).toMatch(/trigger itself/);
  });

  it("refuses a transaction-updated rule that sets the category", () => {
    const problem = selfTriggerProblem(
      definition(
        '{"type":"record","module":"transaction","event":"updated"}',
        '[{"type":"set_category","category":"dining"}]',
      ),
    );
    expect(problem).toMatch(/trigger itself/);
  });

  it("allows the classic cross-module rules", () => {
    // Transaction created → set category: the update event differs from the
    // create event, so this cannot re-fire itself.
    expect(
      selfTriggerProblem(
        definition(
          '{"type":"record","module":"transaction","event":"created"}',
          '[{"type":"set_category","category":"dining"},{"type":"link_bill"}]',
        ),
      ),
    ).toBeNull();
    expect(
      selfTriggerProblem(
        definition(
          '{"type":"record","module":"workout","event":"created"}',
          '[{"type":"log_habit","habit":"Train"}]',
        ),
      ),
    ).toBeNull();
    expect(
      selfTriggerProblem(
        definition('{"type":"fact","metric":"sleepHours","direction":"below","value":6}', "[]".replace("[]", '[{"type":"create_block","title":"Wind down"}]')),
      ),
    ).toBeNull();
  });
});

describe("condition evaluation", () => {
  const meta = { date: "2026-03-09" }; // a Monday

  it("matches field comparisons case-insensitively and numerically", () => {
    const context = { payee: "Planet Fitness", amount: 25.99, category: "other" };
    expect(
      evaluateConditions({ field: "payee", op: "contains", value: "planet" }, context, meta),
    ).toBe(true);
    expect(evaluateConditions({ field: "amount", op: "gt", value: 20 }, context, meta)).toBe(true);
    expect(evaluateConditions({ field: "amount", op: "lt", value: 20 }, context, meta)).toBe(false);
    expect(
      evaluateConditions({ field: "category", op: "in", value: ["other", "fees"] }, context, meta),
    ).toBe(true);
    expect(evaluateConditions({ field: "category", op: "eq", value: "OTHER" }, context, meta)).toBe(
      true,
    );
  });

  it("treats a missing field as no match — never an error", () => {
    expect(evaluateConditions({ field: "missing", op: "eq", value: 1 }, {}, meta)).toBe(false);
    expect(evaluateConditions({ field: "missing", op: "neq", value: 1 }, {}, meta)).toBe(false);
  });

  it("composes AND/OR and evaluates weekday and date-range filters", () => {
    const node = {
      all: [
        { field: "payee", op: "contains" as const, value: "coffee" },
        {
          any: [{ weekday: [1, 2, 3, 4, 5] }, { field: "amount", op: "gt" as const, value: 50 }],
        },
      ],
    };
    expect(evaluateConditions(node, { payee: "Coffee Corner", amount: 4 }, meta)).toBe(true); // Monday
    expect(
      evaluateConditions(node, { payee: "Coffee Corner", amount: 4 }, { date: "2026-03-08" }),
    ).toBe(false); // Sunday, small amount
    expect(
      evaluateConditions({ dateRange: { from: "2026-03-01", to: "2026-03-31" } }, {}, meta),
    ).toBe(true);
    expect(
      evaluateConditions({ dateRange: { from: "2026-04-01" } }, {}, meta),
    ).toBe(false);
  });

  it("an empty ALL matches everything; an empty ANY matches nothing", () => {
    expect(evaluateConditions({ all: [] }, {}, meta)).toBe(true);
    expect(evaluateConditions({ any: [] }, {}, meta)).toBe(false);
  });
});

describe("templates", () => {
  it("substitutes context values and clamps output", () => {
    expect(renderTemplate("File {{payee}} · {{amount}}", { payee: "Rent Co", amount: 1200 })).toBe(
      "File Rent Co · 1200",
    );
    expect(renderTemplate("{{missing}} kept tidy", {})).toBe("kept tidy");
    expect(renderTemplate("x".repeat(500), {}).length).toBeLessThanOrEqual(200);
  });
});

describe("plain-language summaries", () => {
  it("reads as one sentence: trigger, conditions, actions", () => {
    const definition = parseRuleDefinition({
      trigger: '{"type":"record","module":"transaction","event":"created"}',
      conditions: '{"field":"payee","op":"contains","value":"planet"}',
      actions:
        '[{"type":"set_category","category":"health"},{"type":"link_bill"}]',
    });
    expect(describeRule(definition)).toBe(
      "When a transaction is created, if payee contains “planet”, set the category to health and link it to its matching bill.",
    );
  });

  it("describes fact, date and anomaly triggers", () => {
    expect(
      describeRule(
        parseRuleDefinition({
          trigger: '{"type":"fact","metric":"sleepHours","direction":"below","value":6}',
          conditions: '{"all":[]}',
          actions: '[{"type":"create_block","title":"Wind down early"}]',
        }),
      ),
    ).toBe("When yesterday's sleep is below 6, add “Wind down early” to the planner.");
    expect(
      describeRule(
        parseRuleDefinition({
          trigger: '{"type":"anomaly","category":"resting_hr"}',
          conditions: '{"all":[]}',
          actions: '[{"type":"create_inbox","title":"Note it"}]',
        }),
      ),
    ).toMatch(/^When a resting hr observation appears, capture/);
  });
});

describe("the starter library", () => {
  it("every template parses through the same validation as a hand-built rule", () => {
    for (const starter of STARTER_RULES) {
      const definition = parseRuleDefinition(starter);
      expect(selfTriggerProblem(definition)).toBeNull();
      expect(describeRule(definition)).toMatch(/^When |^Every |^On /);
    }
  });

  it("covers the four promised templates", () => {
    const keys = STARTER_RULES.map((starter) => starter.key);
    expect(keys).toEqual([
      "merchant-categorisation",
      "recurring-transaction-linking",
      "post-workout-habit",
      "low-sleep-protection",
    ]);
  });
});

describe("builder field metadata", () => {
  it("lists condition fields for every record module", () => {
    for (const module of RECORD_MODULES) {
      expect(MODULE_FIELDS[module].length).toBeGreaterThan(0);
    }
  });
});

describe("definition fingerprint (dry-run-before-enable)", () => {
  it("changes with any behavioural edit and is stable otherwise", () => {
    const rule = {
      trigger: '{"type":"record","module":"transaction","event":"created"}',
      conditions: '{"all":[]}',
      actions: '[{"type":"set_category","category":"dining"}]',
    };
    const same = definitionFingerprint({ ...rule });
    expect(definitionFingerprint(rule)).toBe(same);
    expect(
      definitionFingerprint({ ...rule, actions: '[{"type":"set_category","category":"travel"}]' }),
    ).not.toBe(same);
    expect(
      definitionFingerprint({ ...rule, conditions: '{"all":[{"field":"payee","op":"eq","value":"x"}]}' }),
    ).not.toBe(same);
  });
});
