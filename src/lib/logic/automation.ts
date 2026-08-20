import type { DayKey } from "@/lib/date";
import { weekdayOf } from "@/lib/date";

/**
 * The rules engine's pure core: trigger/condition/action vocabulary,
 * validation of stored definitions, condition evaluation, template
 * rendering, and the save-time safety checks. Everything here is data-in
 * data-out so the safety rules are unit-testable.
 *
 * SAFETY, BY CONSTRUCTION:
 *
 *  * **Rules never delete.** There is no delete verb in the action
 *    vocabulary — not soft, not hard. `parseActions` rejects anything
 *    outside `ACTION_TYPES`, so a definition cannot smuggle one in.
 *  * **Bounded shapes.** Condition trees at most `MAX_CONDITION_DEPTH`
 *    deep and `MAX_CONDITION_NODES` nodes; at most `MAX_ACTIONS_PER_RULE`
 *    actions per rule; template output clamped.
 *  * **Self-triggering rejected at save.** `selfTriggerProblem` refuses a
 *    rule whose actions produce (or update) records of the same module its
 *    trigger listens to — the direct loop cannot even be stored. Indirect
 *    loops (rule A creates a task, rule B fires on tasks) are cut by the
 *    execution depth bound (`MAX_AUTOMATION_DEPTH`, enforced by the
 *    server engine): rule-produced changes evaluate one level deep, never
 *    further.
 *
 * SCHEDULE-EVENT TRIGGERS, DOCUMENTED SCOPE: the app has no minute-level
 * scheduler and this update is forbidden from adding one, so "a schedule
 * event starting/ending" maps onto what genuinely exists — record triggers
 * on planner blocks (created / updated: marking a block done IS its end in
 * a manual-first app) plus the daily `date` trigger for day-level timing.
 * Nothing pretends to fire at an exact minute server-side.
 */

// --- vocabulary ---------------------------------------------------------------

export const RECORD_MODULES = [
  "transaction",
  "task",
  "schedule_item",
  "habit_log",
  "meal",
  "workout",
  "health_metric",
  "inbox",
] as const;
export type RecordModule = (typeof RECORD_MODULES)[number];

export const RECORD_EVENTS = ["created", "updated"] as const;
export type RecordEvent = (typeof RECORD_EVENTS)[number];

/** DailyFact metrics a threshold trigger may watch (yesterday's fact). */
export const FACT_METRICS = [
  "score",
  "sleepHours",
  "spendCents",
  "plannedMinutes",
  "calories",
  "steps",
  "workoutCount",
  "tasksCompleted",
  "habitsMissed",
] as const;
export type FactMetric = (typeof FACT_METRICS)[number];

export type AutomationTrigger =
  | { type: "record"; module: RecordModule; event: RecordEvent }
  | { type: "fact"; metric: FactMetric; direction: "above" | "below"; value: number }
  | { type: "date"; weekdays?: number[]; date?: DayKey }
  | { type: "anomaly"; category?: string };

export const CONDITION_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { field: string; op: ConditionOp; value: string | number | Array<string | number> }
  | { weekday: number[] }
  | { dateRange: { from?: DayKey; to?: DayKey } };

export const MAX_CONDITION_DEPTH = 3;
export const MAX_CONDITION_NODES = 20;

export const ACTION_TYPES = [
  "set_category",
  "create_task",
  "create_inbox",
  "create_reminder",
  "create_block",
  "log_habit",
  "link_bill",
  "notify",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type AutomationAction =
  | { type: "set_category"; category: string }
  | {
      type: "create_task";
      title: string;
      notes?: string;
      priority?: "low" | "medium" | "high";
      due?: "today" | "tomorrow" | null;
    }
  | { type: "create_inbox"; title: string; notes?: string }
  | { type: "create_reminder"; title: string; message?: string; minute?: number }
  | {
      type: "create_block";
      title: string;
      category?: string;
      startMinute?: number | null;
      endMinute?: number | null;
    }
  | { type: "log_habit"; habit: string }
  | { type: "link_bill"; bill?: string }
  | { type: "notify"; title: string; message?: string };

export const MAX_ACTIONS_PER_RULE = 5;

/** How deep rule-produced changes may cascade: a user write evaluates at
 * depth 0; records the rules create evaluate at depth 1; their products do
 * not evaluate at all. */
export const MAX_AUTOMATION_DEPTH = 2;

/** Consecutive failures before a rule disables itself and says why. */
export const RULE_FAILURE_LIMIT = 3;

/** How far back a dry run replays real data. */
export const DRY_RUN_DAYS = 30;

// --- definition parsing (storage is JSON strings) -----------------------------

export interface RuleDefinition {
  trigger: AutomationTrigger;
  conditions: ConditionNode;
  actions: AutomationAction[];
}

/** Parse + validate a stored trigger. Throws with a readable message. */
export function parseTrigger(raw: string): AutomationTrigger {
  const value = JSON.parse(raw) as AutomationTrigger;
  if (!value || typeof value !== "object") throw new Error("Trigger must be an object");
  switch (value.type) {
    case "record":
      if (!RECORD_MODULES.includes(value.module)) throw new Error("Unknown trigger module");
      if (!RECORD_EVENTS.includes(value.event)) throw new Error("Unknown trigger event");
      return { type: "record", module: value.module, event: value.event };
    case "fact":
      if (!FACT_METRICS.includes(value.metric)) throw new Error("Unknown fact metric");
      if (value.direction !== "above" && value.direction !== "below")
        throw new Error("Fact direction must be above or below");
      if (typeof value.value !== "number" || !Number.isFinite(value.value))
        throw new Error("Fact threshold must be a number");
      return { type: "fact", metric: value.metric, direction: value.direction, value: value.value };
    case "date": {
      const weekdays = Array.isArray(value.weekdays)
        ? value.weekdays.filter(
            (day): day is number => Number.isInteger(day) && day >= 0 && day <= 6,
          )
        : undefined;
      const date =
        typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
          ? value.date
          : undefined;
      return { type: "date", weekdays, date };
    }
    case "anomaly":
      return {
        type: "anomaly",
        category: typeof value.category === "string" ? value.category : undefined,
      };
    default:
      throw new Error("Unknown trigger type");
  }
}

/** Parse + bound a stored condition tree. Throws with a readable message. */
export function parseConditions(raw: string): ConditionNode {
  const value = JSON.parse(raw) as ConditionNode;
  let nodes = 0;
  const walk = (node: ConditionNode, depth: number): ConditionNode => {
    nodes += 1;
    if (nodes > MAX_CONDITION_NODES) throw new Error(`At most ${MAX_CONDITION_NODES} conditions`);
    if (depth > MAX_CONDITION_DEPTH)
      throw new Error(`Conditions can nest at most ${MAX_CONDITION_DEPTH} levels`);
    if (!node || typeof node !== "object") throw new Error("Condition must be an object");
    if ("all" in node && Array.isArray(node.all)) {
      return { all: node.all.map((child) => walk(child, depth + 1)) };
    }
    if ("any" in node && Array.isArray(node.any)) {
      return { any: node.any.map((child) => walk(child, depth + 1)) };
    }
    if ("weekday" in node && Array.isArray(node.weekday)) {
      return {
        weekday: node.weekday.filter(
          (day): day is number => Number.isInteger(day) && day >= 0 && day <= 6,
        ),
      };
    }
    if ("dateRange" in node && node.dateRange && typeof node.dateRange === "object") {
      return { dateRange: node.dateRange };
    }
    if ("field" in node && "op" in node) {
      if (typeof node.field !== "string" || node.field.length === 0 || node.field.length > 60)
        throw new Error("Condition field must be a short name");
      if (!CONDITION_OPS.includes(node.op)) throw new Error("Unknown condition operator");
      return { field: node.field, op: node.op, value: node.value };
    }
    throw new Error("Unrecognised condition shape");
  };
  return walk(value, 1);
}

/** Parse + validate stored actions. Throws with a readable message. The
 * whitelist here IS the never-delete guarantee — no delete verb exists. */
export function parseActions(raw: string): AutomationAction[] {
  const value = JSON.parse(raw) as AutomationAction[];
  if (!Array.isArray(value) || value.length === 0) throw new Error("A rule needs an action");
  if (value.length > MAX_ACTIONS_PER_RULE)
    throw new Error(`At most ${MAX_ACTIONS_PER_RULE} actions per rule`);
  return value.map((action) => {
    if (!action || typeof action !== "object" || !ACTION_TYPES.includes(action.type)) {
      throw new Error("Unknown action type");
    }
    for (const key of ["title", "category", "habit", "bill", "message", "notes"] as const) {
      const text = (action as Record<string, unknown>)[key];
      if (text !== undefined && (typeof text !== "string" || text.length > 300)) {
        throw new Error(`Action ${key} must be short text`);
      }
    }
    if (
      (action.type === "create_task" ||
        action.type === "create_inbox" ||
        action.type === "create_reminder" ||
        action.type === "create_block" ||
        action.type === "notify") &&
      (!("title" in action) || !action.title || !action.title.trim())
    ) {
      throw new Error("This action needs a title");
    }
    if (action.type === "set_category" && !action.category?.trim()) {
      throw new Error("set_category needs a category");
    }
    if (action.type === "log_habit" && !action.habit?.trim()) {
      throw new Error("log_habit needs a habit name");
    }
    return action;
  });
}

export function parseRuleDefinition(rule: {
  trigger: string;
  conditions: string;
  actions: string;
}): RuleDefinition {
  return {
    trigger: parseTrigger(rule.trigger),
    conditions: parseConditions(rule.conditions),
    actions: parseActions(rule.actions),
  };
}

// --- save-time safety ---------------------------------------------------------

/** What record module each action writes (creates or updates), if any. */
function actionTouches(action: AutomationAction): {
  creates?: RecordModule;
  updates?: RecordModule;
} {
  switch (action.type) {
    case "create_task":
      return { creates: "task" };
    case "create_inbox":
      return { creates: "inbox" };
    case "create_block":
      return { creates: "schedule_item" };
    case "log_habit":
      return { creates: "habit_log" };
    case "set_category":
      // Updates the triggering record itself (transaction or planner block).
      return { updates: undefined };
    case "link_bill":
      return { updates: "transaction" };
    case "create_reminder":
    case "notify":
      return {};
  }
}

/**
 * The direct loop that must be impossible to store: a rule whose actions
 * produce records of the very module+event its trigger listens to. Returns
 * a human-readable refusal, or null when the definition is safe to save.
 */
export function selfTriggerProblem(definition: RuleDefinition): string | null {
  const trigger = definition.trigger;
  if (trigger.type !== "record") return null;
  for (const action of definition.actions) {
    const touches = actionTouches(action);
    if (trigger.event === "created" && touches.creates === trigger.module) {
      return `This rule would trigger itself: it fires when a ${trigger.module.replace("_", " ")} is created and its "${action.type}" action creates one.`;
    }
    if (trigger.event === "updated") {
      if (action.type === "set_category" && (trigger.module === "transaction" || trigger.module === "schedule_item")) {
        return `This rule would trigger itself: it fires when a ${trigger.module.replace("_", " ")} is updated and "set_category" updates that same record.`;
      }
      if (touches.updates === trigger.module) {
        return `This rule would trigger itself: it fires when a ${trigger.module.replace("_", " ")} is updated and its "${action.type}" action updates one.`;
      }
    }
  }
  return null;
}

// --- evaluation ---------------------------------------------------------------

/** The values a trigger event exposes to conditions and templates. */
export type EventContext = Record<string, string | number | null>;

export interface EventMeta {
  /** The operational day the event belongs to. */
  date: DayKey;
}

export function evaluateConditions(
  node: ConditionNode,
  context: EventContext,
  meta: EventMeta,
): boolean {
  if ("all" in node) return node.all.every((child) => evaluateConditions(child, context, meta));
  if ("any" in node) {
    // An empty ANY matches nothing — a rule that says "any of: (none)"
    // should never fire rather than always fire.
    return node.any.some((child) => evaluateConditions(child, context, meta));
  }
  if ("weekday" in node) return node.weekday.includes(weekdayOf(meta.date));
  if ("dateRange" in node) {
    const { from, to } = node.dateRange;
    if (from && meta.date < from) return false;
    if (to && meta.date > to) return false;
    return true;
  }

  const actual = context[node.field];
  if (actual === undefined || actual === null) return false;
  switch (node.op) {
    case "eq":
      return normalize(actual) === normalize(node.value);
    case "neq":
      return normalize(actual) !== normalize(node.value);
    case "contains":
      return textOf(actual).includes(textOf(node.value));
    case "not_contains":
      return !textOf(actual).includes(textOf(node.value));
    case "gt":
      return numberOf(actual) !== null && numberOf(node.value) !== null
        ? numberOf(actual)! > numberOf(node.value)!
        : false;
    case "gte":
      return numberOf(actual) !== null && numberOf(node.value) !== null
        ? numberOf(actual)! >= numberOf(node.value)!
        : false;
    case "lt":
      return numberOf(actual) !== null && numberOf(node.value) !== null
        ? numberOf(actual)! < numberOf(node.value)!
        : false;
    case "lte":
      return numberOf(actual) !== null && numberOf(node.value) !== null
        ? numberOf(actual)! <= numberOf(node.value)!
        : false;
    case "in":
      return Array.isArray(node.value)
        ? node.value.map(normalize).includes(normalize(actual))
        : false;
  }
}

function normalize(value: unknown): string | number {
  if (typeof value === "number") return value;
  return String(value).trim().toLowerCase();
}

function textOf(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- templates ----------------------------------------------------------------

/**
 * "{{payee}} needs filing" → "Planet Fitness needs filing". Unknown keys
 * render empty; output clamped so a rule cannot manufacture huge strings.
 */
export function renderTemplate(template: string, context: EventContext): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
      const value = context[key];
      return value === null || value === undefined ? "" : String(value);
    })
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200);
}

// --- plain language -----------------------------------------------------------

const MODULE_LABELS: Record<RecordModule, string> = {
  transaction: "a transaction",
  task: "a task",
  schedule_item: "a planner block",
  habit_log: "a habit log",
  meal: "a meal",
  workout: "a workout",
  health_metric: "a health reading",
  inbox: "an inbox item",
};

const FACT_LABELS: Record<FactMetric, string> = {
  score: "the day score",
  sleepHours: "sleep",
  spendCents: "spending",
  plannedMinutes: "planned time",
  calories: "calories logged",
  steps: "steps",
  workoutCount: "workouts",
  tasksCompleted: "tasks completed",
  habitsMissed: "habits missed",
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeTrigger(trigger: AutomationTrigger): string {
  switch (trigger.type) {
    case "record":
      return `When ${MODULE_LABELS[trigger.module]} is ${trigger.event}`;
    case "fact":
      return `When yesterday's ${FACT_LABELS[trigger.metric]} is ${trigger.direction} ${trigger.value}`;
    case "date": {
      if (trigger.date) return `On ${trigger.date}`;
      if (trigger.weekdays && trigger.weekdays.length > 0) {
        return `Every ${trigger.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")}`;
      }
      return "Every day";
    }
    case "anomaly":
      return trigger.category
        ? `When a ${trigger.category.replace("_", " ")} observation appears`
        : "When any anomaly observation appears";
  }
}

const OP_LABELS: Record<ConditionOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  gt: "is over",
  gte: "is at least",
  lt: "is under",
  lte: "is at most",
  in: "is one of",
};

function describeCondition(node: ConditionNode): string {
  if ("all" in node) {
    const parts = node.all.map(describeCondition).filter(Boolean);
    return parts.join(" and ");
  }
  if ("any" in node) {
    const parts = node.any.map(describeCondition).filter(Boolean);
    return parts.length > 0 ? `(${parts.join(" or ")})` : "";
  }
  if ("weekday" in node) {
    return `it's a ${node.weekday.map((day) => WEEKDAY_NAMES[day]).join("/")}`;
  }
  if ("dateRange" in node) {
    const { from, to } = node.dateRange;
    if (from && to) return `between ${from} and ${to}`;
    if (from) return `from ${from}`;
    if (to) return `until ${to}`;
    return "";
  }
  const value = Array.isArray(node.value) ? node.value.join(", ") : String(node.value);
  return `${node.field} ${OP_LABELS[node.op]} “${value}”`;
}

function describeAction(action: AutomationAction): string {
  switch (action.type) {
    case "set_category":
      return `set the category to ${action.category}`;
    case "create_task":
      return `create the task “${action.title}”`;
    case "create_inbox":
      return `capture “${action.title}” to the Inbox`;
    case "create_reminder":
      return `set a reminder “${action.title}”`;
    case "create_block":
      return `add “${action.title}” to the planner`;
    case "log_habit":
      return `log ${action.habit} as done`;
    case "link_bill":
      return action.bill ? `link it to the ${action.bill} bill` : "link it to its matching bill";
    case "notify":
      return `send the notification “${action.title}”`;
  }
}

/**
 * The one plain-English sentence the builder shows at the top: "When a
 * transaction is created, if payee contains “planet”, set the category to
 * health and link it to its matching bill."
 */
export function describeRule(definition: RuleDefinition): string {
  const trigger = describeTrigger(definition.trigger);
  const conditions = describeCondition(definition.conditions);
  const actions = definition.actions.map(describeAction);
  const actionText =
    actions.length <= 1
      ? actions[0]
      : `${actions.slice(0, -1).join(", ")} and ${actions[actions.length - 1]}`;
  return `${trigger}${conditions ? `, if ${conditions}` : ""}, ${actionText}.`;
}

/** The condition/template fields each record module exposes — what the
 * builder offers in its field dropdown. */
export const MODULE_FIELDS: Record<RecordModule, string[]> = {
  transaction: ["payee", "category", "amount", "direction", "date", "notes"],
  task: ["title", "priority", "status", "dueDate", "notes"],
  schedule_item: ["title", "category", "status", "date", "startMinute"],
  habit_log: ["habit", "status", "date"],
  meal: ["mealType", "date"],
  workout: ["name", "workoutType", "status", "date"],
  health_metric: ["metric", "value", "unit", "date"],
  inbox: ["title", "notes"],
};

// --- definition hashing (dry-run-before-enable) -------------------------------

/**
 * A stable fingerprint of a rule's behaviour-defining parts. Enabling a
 * rule requires the LAST DRY RUN to have been of exactly this definition
 * (`AutomationRule.reviewedHash`), so no rule ever runs unreviewed. Pure
 * djb2 over the canonical JSON — collision-resistance is not the point,
 * change-detection is.
 */
export function definitionFingerprint(rule: {
  trigger: string;
  conditions: string;
  actions: string;
}): string {
  const text = `${rule.trigger} ${rule.conditions} ${rule.actions}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `v1:${(hash >>> 0).toString(16)}:${text.length}`;
}
