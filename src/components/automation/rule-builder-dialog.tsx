"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SCHEDULE_CATEGORIES, FINANCE_CATEGORIES } from "@/lib/enums";
import { WEEKDAY_LABELS, minuteToTimeValue, parseTimeToMinute } from "@/lib/date";
import {
  ACTION_TYPES,
  CONDITION_OPS,
  FACT_METRICS,
  MODULE_FIELDS,
  RECORD_MODULES,
  type ActionType,
  type AutomationAction,
  type ConditionOp,
  describeRule,
  parseRuleDefinition,
} from "@/lib/logic/automation";
import type { AutomationRuleView } from "@/server/automation";
import { saveAutomationRule } from "@/server/actions/automation";

/**
 * The rule builder: trigger, conditions, actions — each a plain form row —
 * with the rule's plain-English summary rendered live at the top from the
 * same `describeRule` the list uses. Definitions the simple form cannot
 * represent (hand-nested condition groups) fall back to editing the JSON
 * directly rather than silently flattening them.
 */

interface ConditionRow {
  field: string;
  op: ConditionOp;
  value: string;
}

interface ActionRow {
  type: ActionType;
  title: string;
  category: string;
  habit: string;
  bill: string;
  message: string;
  priority: string;
  due: string;
  time: string;
}

const EMPTY_ACTION: ActionRow = {
  type: "create_task",
  title: "",
  category: "",
  habit: "",
  bill: "",
  message: "",
  priority: "medium",
  due: "none",
  time: "",
};

const ACTION_LABELS: Record<ActionType, string> = {
  set_category: "Set the category",
  create_task: "Create a task",
  create_inbox: "Capture to the Inbox",
  create_reminder: "Set a reminder",
  create_block: "Add a planner block",
  log_habit: "Log a habit done",
  link_bill: "Link to a bill",
  notify: "Send a notification",
};

const MODULE_LABELS: Record<string, string> = {
  transaction: "Transaction",
  task: "Task",
  schedule_item: "Planner block",
  habit_log: "Habit log",
  meal: "Meal",
  workout: "Workout",
  health_metric: "Health reading",
  inbox: "Inbox item",
};

const OP_LABELS: Record<ConditionOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  gt: "is over",
  gte: "is at least",
  lt: "is under",
  lte: "is at most",
  in: "is one of (comma-separated)",
};

export function RuleBuilderDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: AutomationRuleView | null;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState("");
  const [triggerType, setTriggerType] = React.useState("record");
  const [module, setModule] = React.useState("transaction");
  const [event, setEvent] = React.useState("created");
  const [factMetric, setFactMetric] = React.useState("sleepHours");
  const [factDirection, setFactDirection] = React.useState("below");
  const [factValue, setFactValue] = React.useState("6");
  const [weekdays, setWeekdays] = React.useState<number[]>([]);
  const [anomalyCategory, setAnomalyCategory] = React.useState("any");
  const [conditionMode, setConditionMode] = React.useState<"all" | "any">("all");
  const [conditions, setConditions] = React.useState<ConditionRow[]>([]);
  const [actions, setActions] = React.useState<ActionRow[]>([{ ...EMPTY_ACTION }]);
  const [advanced, setAdvanced] = React.useState<null | {
    trigger: string;
    conditions: string;
    actions: string;
  }>(null);
  const [saving, setSaving] = React.useState(false);

  // Load (or reset) state when the dialog opens for a rule / for "new".
  React.useEffect(() => {
    if (!open) return;
    if (!initial) {
      setName("");
      setTriggerType("record");
      setModule("transaction");
      setEvent("created");
      setFactMetric("sleepHours");
      setFactDirection("below");
      setFactValue("6");
      setWeekdays([]);
      setAnomalyCategory("any");
      setConditionMode("all");
      setConditions([]);
      setActions([{ ...EMPTY_ACTION }]);
      setAdvanced(null);
      return;
    }
    setName(initial.name);
    try {
      const definition = parseRuleDefinition(initial);
      const trigger = definition.trigger;
      setTriggerType(trigger.type);
      if (trigger.type === "record") {
        setModule(trigger.module);
        setEvent(trigger.event);
      } else if (trigger.type === "fact") {
        setFactMetric(trigger.metric);
        setFactDirection(trigger.direction);
        setFactValue(String(trigger.value));
      } else if (trigger.type === "date") {
        setWeekdays(trigger.weekdays ?? []);
      } else if (trigger.type === "anomaly") {
        setAnomalyCategory(trigger.category ?? "any");
      }

      // Conditions the simple form can hold: a single flat ALL/ANY group of
      // field rows (or one bare field row / empty). Anything else → JSON.
      const tree = definition.conditions;
      const asRows = (nodes: unknown[]): ConditionRow[] | null => {
        const rows: ConditionRow[] = [];
        for (const node of nodes) {
          if (!node || typeof node !== "object" || !("field" in node)) return null;
          const field = node as { field: string; op: ConditionOp; value: unknown };
          rows.push({
            field: field.field,
            op: field.op,
            value: Array.isArray(field.value) ? field.value.join(", ") : String(field.value),
          });
        }
        return rows;
      };
      let rows: ConditionRow[] | null = null;
      if ("all" in tree) {
        rows = asRows(tree.all);
        setConditionMode("all");
      } else if ("any" in tree) {
        rows = asRows(tree.any);
        setConditionMode("any");
      } else if ("field" in tree) {
        rows = asRows([tree]);
        setConditionMode("all");
      }

      const actionRows: ActionRow[] = definition.actions.map((action) => ({
        ...EMPTY_ACTION,
        type: action.type,
        title: "title" in action ? (action.title ?? "") : "",
        category: "category" in action ? (action.category ?? "") : "",
        habit: "habit" in action ? (action.habit ?? "") : "",
        bill: "bill" in action ? (action.bill ?? "") : "",
        message: "message" in action ? (action.message ?? "") : "",
        priority: "priority" in action ? (action.priority ?? "medium") : "medium",
        due: "due" in action ? (action.due ?? "none") : "none",
        time:
          action.type === "create_reminder" && action.minute !== undefined
            ? minuteToTimeValue(action.minute)
            : action.type === "create_block" && typeof action.startMinute === "number"
              ? minuteToTimeValue(action.startMinute)
              : "",
      }));

      if (rows === null) {
        setAdvanced({
          trigger: initial.trigger,
          conditions: initial.conditions,
          actions: initial.actions,
        });
      } else {
        setAdvanced(null);
        setConditions(rows);
        setActions(actionRows.length ? actionRows : [{ ...EMPTY_ACTION }]);
      }
    } catch {
      setAdvanced({
        trigger: initial.trigger,
        conditions: initial.conditions,
        actions: initial.actions,
      });
    }
  }, [open, initial]);

  const serialized = React.useMemo(() => {
    if (advanced) return advanced;
    const trigger =
      triggerType === "record"
        ? { type: "record", module, event }
        : triggerType === "fact"
          ? { type: "fact", metric: factMetric, direction: factDirection, value: Number(factValue) }
          : triggerType === "date"
            ? { type: "date", weekdays }
            : { type: "anomaly", ...(anomalyCategory !== "any" ? { category: anomalyCategory } : {}) };

    const rows = conditions
      .filter((row) => row.field && row.value !== "")
      .map((row) => ({
        field: row.field,
        op: row.op,
        value:
          row.op === "in"
            ? row.value.split(",").map((part) => part.trim())
            : Number.isFinite(Number(row.value)) && row.value.trim() !== ""
              ? Number(row.value)
              : row.value,
      }));
    const conditionTree = { [conditionMode]: rows };

    const actionList: AutomationAction[] = actions.map((row) => {
      switch (row.type) {
        case "set_category":
          return { type: "set_category", category: row.category };
        case "create_task":
          return {
            type: "create_task",
            title: row.title,
            priority: (row.priority || "medium") as "low" | "medium" | "high",
            due: row.due === "none" ? null : (row.due as "today" | "tomorrow"),
          };
        case "create_inbox":
          return { type: "create_inbox", title: row.title };
        case "create_reminder":
          return {
            type: "create_reminder",
            title: row.title,
            ...(row.message ? { message: row.message } : {}),
            ...(row.time ? { minute: parseTimeToMinute(row.time) ?? undefined } : {}),
          };
        case "create_block":
          return {
            type: "create_block",
            title: row.title,
            ...(row.category ? { category: row.category } : {}),
            ...(row.time ? { startMinute: parseTimeToMinute(row.time) } : {}),
          };
        case "log_habit":
          return { type: "log_habit", habit: row.habit };
        case "link_bill":
          return { type: "link_bill", ...(row.bill ? { bill: row.bill } : {}) };
        case "notify":
          return {
            type: "notify",
            title: row.title,
            ...(row.message ? { message: row.message } : {}),
          };
      }
    });

    return {
      trigger: JSON.stringify(trigger),
      conditions: JSON.stringify(conditionTree),
      actions: JSON.stringify(actionList),
    };
  }, [
    advanced,
    triggerType,
    module,
    event,
    factMetric,
    factDirection,
    factValue,
    weekdays,
    anomalyCategory,
    conditionMode,
    conditions,
    actions,
  ]);

  const summary = React.useMemo(() => {
    try {
      return { ok: true as const, text: describeRule(parseRuleDefinition(serialized)) };
    } catch (error) {
      return { ok: false as const, text: error instanceof Error ? error.message : "Invalid rule" };
    }
  }, [serialized]);

  const fieldOptions =
    triggerType === "record"
      ? MODULE_FIELDS[module as (typeof RECORD_MODULES)[number]]
      : triggerType === "fact"
        ? ["metric", "value", "date"]
        : triggerType === "anomaly"
          ? ["category", "title", "message", "date"]
          : ["date"];

  async function onSave() {
    setSaving(true);
    const result = await saveAutomationRule({
      ...(initial ? { id: initial.id } : {}),
      name,
      ...serialized,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast(
      initial
        ? "Saved. Changed rules are disabled until their next dry run."
        : "Saved. Run the dry run to review it before enabling.",
    );
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            When the trigger fires and every condition holds, the actions run — logged, undoable,
            and never deleting anything.
          </DialogDescription>
        </DialogHeader>

        <p
          className={`rounded-lg border px-3 py-2 text-sm ${summary.ok ? "" : "border-amber-500 text-amber-600"}`}
          data-testid="rule-summary"
        >
          {summary.text}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="rule-name">Name</Label>
          <Input
            id="rule-name"
            value={name}
            onChange={(element) => setName(element.target.value)}
            placeholder="Categorise my gym"
          />
        </div>

        {advanced ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              This rule uses nested conditions the simple form can't show — edit the JSON directly.
            </p>
            {(["trigger", "conditions", "actions"] as const).map((key) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`advanced-${key}`} className="capitalize">
                  {key}
                </Label>
                <textarea
                  id={`advanced-${key}`}
                  className="min-h-16 w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
                  value={advanced[key]}
                  onChange={(element) =>
                    setAdvanced({ ...advanced, [key]: element.target.value })
                  }
                />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">When…</p>
              <div className="flex flex-wrap gap-2">
                <Select value={triggerType} onValueChange={setTriggerType}>
                  <SelectTrigger className="w-44" aria-label="Trigger type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="record">A record event</SelectItem>
                    <SelectItem value="fact">A daily number</SelectItem>
                    <SelectItem value="date">A day of the week</SelectItem>
                    <SelectItem value="anomaly">An anomaly observation</SelectItem>
                  </SelectContent>
                </Select>

                {triggerType === "record" && (
                  <>
                    <Select value={module} onValueChange={setModule}>
                      <SelectTrigger className="w-40" aria-label="Module">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RECORD_MODULES.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {MODULE_LABELS[entry]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={event} onValueChange={setEvent}>
                      <SelectTrigger className="w-32" aria-label="Event">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="created">is created</SelectItem>
                        <SelectItem value="updated">is updated</SelectItem>
                      </SelectContent>
                    </Select>
                  </>
                )}

                {triggerType === "fact" && (
                  <>
                    <Select value={factMetric} onValueChange={setFactMetric}>
                      <SelectTrigger className="w-40" aria-label="Metric">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FACT_METRICS.map((metric) => (
                          <SelectItem key={metric} value={metric}>
                            {metric}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={factDirection} onValueChange={setFactDirection}>
                      <SelectTrigger className="w-28" aria-label="Direction">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="below">below</SelectItem>
                        <SelectItem value="above">above</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      className="w-24"
                      type="number"
                      aria-label="Threshold"
                      value={factValue}
                      onChange={(element) => setFactValue(element.target.value)}
                    />
                  </>
                )}

                {triggerType === "date" && (
                  <div className="flex flex-wrap gap-1">
                    {WEEKDAY_LABELS.map((label, day) => (
                      <Button
                        key={label}
                        type="button"
                        size="sm"
                        variant={weekdays.includes(day) ? "default" : "outline"}
                        onClick={() =>
                          setWeekdays((current) =>
                            current.includes(day)
                              ? current.filter((entry) => entry !== day)
                              : [...current, day].sort(),
                          )
                        }
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                )}

                {triggerType === "anomaly" && (
                  <Select value={anomalyCategory} onValueChange={setAnomalyCategory}>
                    <SelectTrigger className="w-48" aria-label="Anomaly category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any observation</SelectItem>
                      <SelectItem value="resting_hr">Resting heart rate</SelectItem>
                      <SelectItem value="sleep_debt">Sleep</SelectItem>
                      <SelectItem value="habit_streak">Habit streaks</SelectItem>
                      <SelectItem value="workout_frequency">Training frequency</SelectItem>
                      <SelectItem value="spending">Spending</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase text-muted-foreground">If…</p>
                <Select
                  value={conditionMode}
                  onValueChange={(value) => setConditionMode(value as "all" | "any")}
                >
                  <SelectTrigger className="h-7 w-36 text-xs" aria-label="Condition mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all must hold</SelectItem>
                    <SelectItem value="any">any may hold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {conditions.map((row, index) => (
                <div key={index} className="flex flex-wrap items-center gap-1.5">
                  <Select
                    value={row.field}
                    onValueChange={(value) =>
                      setConditions((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, field: value } : entry,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="w-32" aria-label="Field">
                      <SelectValue placeholder="field" />
                    </SelectTrigger>
                    <SelectContent>
                      {fieldOptions.map((field) => (
                        <SelectItem key={field} value={field}>
                          {field}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={row.op}
                    onValueChange={(value) =>
                      setConditions((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, op: value as ConditionOp } : entry,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="w-40" aria-label="Operator">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONDITION_OPS.map((op) => (
                        <SelectItem key={op} value={op}>
                          {OP_LABELS[op]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="w-40 flex-1"
                    aria-label="Value"
                    value={row.value}
                    onChange={(element) =>
                      setConditions((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, value: element.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Remove condition"
                    onClick={() =>
                      setConditions((current) =>
                        current.filter((_, entryIndex) => entryIndex !== index),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setConditions((current) => [
                    ...current,
                    { field: fieldOptions[0], op: "contains", value: "" },
                  ])
                }
              >
                <Plus className="mr-1 h-3 w-3" /> Add condition
              </Button>
              {conditions.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No conditions — the rule fires on every trigger event.
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Then…</p>
              {actions.map((row, index) => (
                <div key={index} className="space-y-1.5 rounded-md border p-2">
                  <div className="flex items-center gap-1.5">
                    <Select
                      value={row.type}
                      onValueChange={(value) =>
                        setActions((current) =>
                          current.map((entry, entryIndex) =>
                            entryIndex === index
                              ? { ...EMPTY_ACTION, type: value as ActionType }
                              : entry,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="w-52" aria-label="Action type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTION_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {ACTION_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {actions.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove action"
                        onClick={() =>
                          setActions((current) =>
                            current.filter((_, entryIndex) => entryIndex !== index),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>

                  <ActionFields
                    row={row}
                    onChange={(next) =>
                      setActions((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? next : entry,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              {actions.length < 5 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setActions((current) => [...current, { ...EMPTY_ACTION }])}
                >
                  <Plus className="mr-1 h-3 w-3" /> Add action
                </Button>
              )}
            </div>
          </>
        )}

        <Button className="w-full" disabled={saving || !summary.ok || !name.trim()} onClick={() => void onSave()}>
          {initial ? "Save changes" : "Save rule"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Rules save disabled. Enabling requires the dry run of exactly this definition.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function ActionFields({
  row,
  onChange,
}: {
  row: ActionRow;
  onChange: (row: ActionRow) => void;
}) {
  const text = (
    key: keyof ActionRow,
    label: string,
    placeholder = "",
    props: Record<string, unknown> = {},
  ) => (
    <Input
      aria-label={label}
      placeholder={placeholder || label}
      value={row[key] as string}
      onChange={(element) => onChange({ ...row, [key]: element.target.value })}
      {...props}
    />
  );

  switch (row.type) {
    case "set_category":
      return (
        <Select value={row.category} onValueChange={(value) => onChange({ ...row, category: value })}>
          <SelectTrigger aria-label="Category">
            <SelectValue placeholder="Pick a category" />
          </SelectTrigger>
          <SelectContent>
            {FINANCE_CATEGORIES.filter(
              (category) => category !== "transfer" && category !== "adjustment",
            ).map((category) => (
              <SelectItem key={category} value={category}>
                {category} (finance)
              </SelectItem>
            ))}
            {SCHEDULE_CATEGORIES.map((category) => (
              <SelectItem key={`s-${category}`} value={category}>
                {category} (planner)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "create_task":
      return (
        <div className="flex flex-wrap gap-1.5">
          <div className="min-w-40 flex-1">{text("title", "Task title", "Check {{payee}} charge")}</div>
          <Select value={row.due} onValueChange={(value) => onChange({ ...row, due: value })}>
            <SelectTrigger className="w-32" aria-label="Due">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">no due date</SelectItem>
              <SelectItem value="today">due today</SelectItem>
              <SelectItem value="tomorrow">due tomorrow</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case "create_inbox":
      return text("title", "Inbox note", "From {{title}}");
    case "create_reminder":
      return (
        <div className="flex flex-wrap gap-1.5">
          <div className="min-w-40 flex-1">{text("title", "Reminder title")}</div>
          <Input
            className="w-28"
            type="time"
            aria-label="Reminder time"
            value={row.time}
            onChange={(element) => onChange({ ...row, time: element.target.value })}
          />
        </div>
      );
    case "create_block":
      return (
        <div className="flex flex-wrap gap-1.5">
          <div className="min-w-40 flex-1">{text("title", "Block title")}</div>
          <Select value={row.category || "admin"} onValueChange={(value) => onChange({ ...row, category: value })}>
            <SelectTrigger className="w-32" aria-label="Block category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="w-28"
            type="time"
            aria-label="Start time"
            value={row.time}
            onChange={(element) => onChange({ ...row, time: element.target.value })}
          />
        </div>
      );
    case "log_habit":
      return text("habit", "Habit name", "Exactly as it is named in Habits");
    case "link_bill":
      return text("bill", "Bill name (optional — matches the payee otherwise)");
    case "notify":
      return (
        <div className="space-y-1.5">
          {text("title", "Notification title")}
          {text("message", "Message (optional)")}
        </div>
      );
  }
}
