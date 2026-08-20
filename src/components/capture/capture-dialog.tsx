"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { minuteToTimeValue, parseTimeToMinute, relativeDayLabel, type DayKey } from "@/lib/date";
import {
  CATEGORY_META,
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_META,
  HEALTH_METRIC_META,
  MANUAL_ENTRY_METRICS,
  MEAL_TYPES,
  MEAL_TYPE_META,
  PRIORITIES,
  SCHEDULE_CATEGORIES,
  SERVING_UNITS,
  WORKOUT_TYPES,
  WORKOUT_TYPE_META,
  type FinanceCategory,
  type HealthMetricType,
  type MealType,
  type Priority,
  type ScheduleCategory,
  type WorkoutType,
} from "@/lib/enums";
import {
  CAPTURE_INTENT_META,
  CAPTURE_INTENTS,
  parseCapture,
  parseCaptureAs,
  type CaptureDraft,
  type CaptureIntent,
} from "@/lib/logic/capture";
import {
  commitCapture,
  previewCapture,
  type CaptureContext,
  type FoodCandidate,
  type HabitCandidate,
} from "@/server/actions/capture";
import { useUIStore } from "@/store/ui-store";

const EXAMPLES = [
  "Deep work 9-11am !high",
  "todo call insurance friday",
  "spent 12.40 at chipotle",
  "ate 2 eggs and toast",
  "ran 3.2 miles 28 min",
  "did meditation",
];

/** Per-item state for the nutrition intent — resolved food + amounts. */
interface FoodRowState {
  phrase: string;
  quantity: number;
  unit: string;
  candidates: FoodCandidate[];
  selected: FoodCandidate | null;
  idempotencyKey: string;
  removed: boolean;
}

function freshKey(): string {
  return `cap-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

/**
 * Unified quick-capture. One text field that classifies what you typed —
 * planner block, task, expense, income, health reading, food, workout, habit
 * tick, or a plain inbox note — shows every parsed field editable, and only
 * writes when you confirm. Ambiguity (two plausible readings, an unknown
 * habit, an unresolved food) always asks instead of guessing, and anything
 * unclassifiable is captured to the Inbox rather than lost.
 */
export function CaptureDialog() {
  const router = useRouter();
  const open = useUIStore((state) => state.quickAddOpen);
  const setOpen = useUIStore((state) => state.setQuickAddOpen);
  const contextDate = useUIStore((state) => state.contextDate);
  const todayKey = useUIStore((state) => state.todayKey);

  const [text, setText] = React.useState("");
  const [chosenIntent, setChosenIntent] = React.useState<CaptureIntent | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Server-resolved context, fetched per intent when needed.
  const [habitCandidates, setHabitCandidates] = React.useState<HabitCandidate[]>([]);
  const [financeContext, setFinanceContext] = React.useState<CaptureContext | null>(null);
  const [foodRows, setFoodRows] = React.useState<FoodRowState[]>([]);
  const [resolving, setResolving] = React.useState(false);

  // Field-level edits layered over the parse; reset when the parse moves.
  const [edits, setEdits] = React.useState<Record<string, unknown>>({});
  const [habitChoice, setHabitChoice] = React.useState<string | null>(null);

  const nowMinute = React.useMemo(() => {
    if (!open) return null;
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }, [open]);

  const parse = React.useMemo(
    () => parseCapture(text, { baseDate: contextDate, nowMinute }),
    [text, contextDate, nowMinute],
  );

  const draft: CaptureDraft = React.useMemo(
    () =>
      chosenIntent
        ? parseCaptureAs(chosenIntent, text.trim(), { baseDate: contextDate, nowMinute })
        : parse.draft,
    [chosenIntent, text, contextDate, nowMinute, parse],
  );

  const ambiguous = !chosenIntent && parse.alternates.length > 0;

  React.useEffect(() => {
    if (!open) {
      setText("");
      setChosenIntent(null);
      setEdits({});
      setHabitChoice(null);
      setFoodRows([]);
      setHabitCandidates([]);
    }
  }, [open]);

  // Render-time resets (the react.dev "adjusting state when a prop changes"
  // pattern — no effect, no cascading render): new text discards a manual
  // intent choice; a moved parse discards field edits.
  const [lastText, setLastText] = React.useState(text);
  if (text !== lastText) {
    setLastText(text);
    setChosenIntent(null);
  }
  const editsKey = `${text}::${draft.intent}`;
  const [lastEditsKey, setLastEditsKey] = React.useState(editsKey);
  if (editsKey !== lastEditsKey) {
    setLastEditsKey(editsKey);
    setEdits({});
    setHabitChoice(null);
  }

  // --- server resolution (debounced) --------------------------------------
  React.useEffect(() => {
    if (!open) return;
    const needsHabits = draft.intent === "habit" ? draft.query : null;
    const needsFoods =
      draft.intent === "nutrition" ? draft.items.map((item) => item.phrase) : null;
    const needsAccounts = draft.intent === "expense" || draft.intent === "income";
    if (!needsHabits && !needsFoods && !needsAccounts) {
      setResolving(false);
      return;
    }

    setResolving(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await previewCapture({
          habitQuery: needsHabits ?? undefined,
          habitDate: draft.intent === "habit" ? draft.date : undefined,
          foodPhrases: needsFoods ?? undefined,
          wantAccounts: needsAccounts || undefined,
        });
        if (cancelled || !result.ok) return;
        setHabitCandidates(result.data.habits);
        if (needsAccounts) setFinanceContext(result.data.context);
        if (needsFoods && draft.intent === "nutrition") {
          setFoodRows(
            draft.items.map((item) => {
              const candidates = result.data.foods[item.phrase] ?? [];
              const confident = candidates.find((candidate) => candidate.confident) ?? null;
              return {
                phrase: item.phrase,
                quantity: item.quantity,
                unit: item.unit ?? "serving",
                candidates,
                selected: confident ?? (candidates.length === 1 ? candidates[0] : null),
                idempotencyKey: freshKey(),
                removed: false,
              };
            }),
          );
        }
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // draft.items identity changes with every parse; key on the phrases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    draft.intent,
    draft.intent === "habit" ? draft.query : "",
    draft.intent === "habit" ? draft.date : "",
    draft.intent === "nutrition" ? draft.items.map((item) => item.phrase).join("|") : "",
  ]);

  function edit<T>(key: string, value: T) {
    setEdits((current) => ({ ...current, [key]: value }));
  }
  function field<T>(key: string, fallback: T): T {
    return key in edits ? (edits[key] as T) : fallback;
  }

  // --- commit ---------------------------------------------------------------

  const resolvedHabitId =
    habitChoice ??
    (draft.intent === "habit" && habitCandidates.length === 1 ? habitCandidates[0].id : null);

  const activeFoodRows = foodRows.filter((row) => !row.removed);
  const unresolvedFood =
    draft.intent === "nutrition" &&
    (activeFoodRows.length === 0 || activeFoodRows.some((row) => row.selected === null));

  const commitDisabled =
    pending ||
    !text.trim() ||
    ambiguous ||
    (draft.intent === "habit" && resolvedHabitId === null) ||
    unresolvedFood ||
    ((draft.intent === "expense" || draft.intent === "income") &&
      !(field("accountId", financeContext?.defaultAccountId ?? "") as string));

  function submit() {
    if (commitDisabled) return;
    const payload = buildPayload();
    if (!payload) return;

    startTransition(async () => {
      const result = await commitCapture(payload);
      if (result.ok) {
        toast.success(result.data.message, {
          action: {
            label: "View",
            onClick: () => router.push(result.data.href),
          },
        });
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function buildPayload(): Record<string, unknown> | null {
    switch (draft.intent) {
      case "planner": {
        const startMinute = field("startMinute", draft.planner.startMinute);
        const endMinute = field("endMinute", draft.planner.endMinute);
        return {
          intent: "planner",
          title: field("title", draft.planner.title),
          date: field("date", draft.planner.date),
          startMinute,
          endMinute,
          allDay: field("allDay", draft.planner.allDay || startMinute === null),
          category: field("category", draft.planner.category),
          priority: field("priority", draft.planner.priority),
        };
      }
      case "task":
        return {
          intent: "task",
          title: field("title", draft.title),
          dueDate: field("dueDate", draft.dueDate) || null,
          priority: field("priority", draft.priority),
          tags: draft.tags,
        };
      case "expense":
      case "income":
        return {
          intent: draft.intent,
          accountId: field("accountId", financeContext?.defaultAccountId ?? ""),
          amount: Number(field("amount", draft.amount)),
          payee: (field("payee", draft.payee ?? "") as string).trim() || null,
          category: field(
            "category",
            draft.category ?? (draft.intent === "income" ? "income" : "other"),
          ),
          date: field("date", draft.date),
        };
      case "health":
        return {
          intent: "health",
          metric: field("metric", draft.metric),
          value: Number(field("value", draft.value)),
          unit: draft.unit,
          secondaryValue:
            field("secondaryValue", draft.secondaryValue) === null
              ? null
              : Number(field("secondaryValue", draft.secondaryValue)),
          date: field("date", draft.date),
        };
      case "nutrition":
        return {
          intent: "nutrition",
          date: field("date", draft.date),
          mealType: field("mealType", draft.mealType),
          items: activeFoodRows.map((row) => ({
            foodItemId: row.selected?.foodItemId ?? null,
            provider: row.selected?.provider ?? null,
            externalId: row.selected?.externalId ?? null,
            quantity: row.quantity,
            unit: row.unit,
            idempotencyKey: row.idempotencyKey,
          })),
        };
      case "workout": {
        const strength = draft.strength
          ? {
              exercise: field("exercise", draft.strength.exercise),
              sets: Number(field("sets", draft.strength.sets)),
              reps: Number(field("reps", draft.strength.reps)),
              weight:
                field("weight", draft.strength.weight) === null
                  ? null
                  : Number(field("weight", draft.strength.weight)),
              weightUnit: field("weightUnit", draft.strength.weightUnit),
            }
          : null;
        return {
          intent: "workout",
          date: field("date", draft.date),
          name: field("name", draft.name),
          type: field("type", draft.type),
          durationMin:
            field("durationMin", draft.durationMin) === null
              ? null
              : Number(field("durationMin", draft.durationMin)),
          distanceKm:
            field("distanceKm", draft.distanceKm) === null
              ? null
              : Number(field("distanceKm", draft.distanceKm)),
          strength,
        };
      }
      case "habit":
        if (!resolvedHabitId) return null;
        return {
          intent: "habit",
          habitId: resolvedHabitId,
          status: field("status", draft.status),
          date: field("date", draft.date),
        };
      case "inbox":
        return {
          intent: "inbox",
          title: field("title", draft.title),
          notes: (field("notes", draft.notes ?? "") as string).trim() || null,
        };
    }
  }

  // --- render ---------------------------------------------------------------

  const intentMeta = CAPTURE_INTENT_META[draft.intent];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-domain-planner" />
            Capture
          </DialogTitle>
          <DialogDescription>
            One line for anything — plans, tasks, money, food, training, habits, readings.
            Nothing is saved until you confirm what it understood.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            autoFocus
            value={text}
            placeholder="Try: spent 12.40 at chipotle — or just type a plan"
            aria-label="Capture anything"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            className="h-11 text-base"
          />

          {text.trim() ? (
            <>
              {/* Intent row: what it read this as, and the way out of a wrong guess. */}
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Capture type">
                {ambiguous ? (
                  <>
                    <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      Which is it?
                    </span>
                    {[parse.draft.intent, ...parse.alternates].map((intent) => (
                      <Button
                        key={intent}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setChosenIntent(intent)}
                      >
                        {CAPTURE_INTENT_META[intent].label}
                      </Button>
                    ))}
                  </>
                ) : (
                  <>
                    <Badge variant="secondary">{intentMeta.label}</Badge>
                    <span className="text-xs text-muted-foreground">{intentMeta.hint}</span>
                    <Select
                      value={draft.intent}
                      onValueChange={(value) => setChosenIntent(value as CaptureIntent)}
                    >
                      <SelectTrigger
                        aria-label="Change capture type"
                        className="ml-auto h-7 w-auto gap-1 border-dashed px-2 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CAPTURE_INTENTS.map((intent) => (
                          <SelectItem key={intent} value={intent}>
                            {CAPTURE_INTENT_META[intent].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>

              {!ambiguous && (
                <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
                  {draft.intent === "planner" && (
                    <PlannerFields draft={draft} field={field} edit={edit} todayKey={todayKey} />
                  )}
                  {draft.intent === "task" && (
                    <TaskFields draft={draft} field={field} edit={edit} />
                  )}
                  {(draft.intent === "expense" || draft.intent === "income") && (
                    <MoneyFields
                      draft={draft}
                      field={field}
                      edit={edit}
                      context={financeContext}
                      resolving={resolving}
                    />
                  )}
                  {draft.intent === "health" && (
                    <HealthFields draft={draft} field={field} edit={edit} />
                  )}
                  {draft.intent === "nutrition" && (
                    <NutritionFields
                      draft={draft}
                      field={field}
                      edit={edit}
                      rows={foodRows}
                      setRows={setFoodRows}
                      resolving={resolving}
                    />
                  )}
                  {draft.intent === "workout" && (
                    <WorkoutFields draft={draft} field={field} edit={edit} />
                  )}
                  {draft.intent === "habit" && (
                    <HabitFields
                      draft={draft}
                      field={field}
                      edit={edit}
                      candidates={habitCandidates}
                      choice={resolvedHabitId}
                      setChoice={setHabitChoice}
                      resolving={resolving}
                    />
                  )}
                  {draft.intent === "inbox" && (
                    <InboxFields draft={draft} field={field} edit={edit} />
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-1.5 rounded-lg border border-dashed px-3 py-2.5">
              <p className="text-xs font-medium text-muted-foreground">Try one of these</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setText(example)}
                    className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Capturing for{" "}
              <span className="font-medium">{relativeDayLabel(contextDate, todayKey)}</span>
            </p>
            <Button onClick={submit} disabled={commitDisabled} className="gap-1.5">
              {pending ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
              {intentMeta.commitLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- field groups --------------------------------------------------------------

interface FieldTools {
  field: <T>(key: string, fallback: T) => T;
  edit: <T>(key: string, value: T) => void;
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">{children}</div>;
}

/**
 * Label + control cell. Plain elements (Input) get the id cloned on; Radix
 * Selects render no root DOM node, so those cells pass function children and
 * put the id on their SelectTrigger themselves.
 */
function FieldCell({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode | ((id: string) => React.ReactNode);
  wide?: boolean;
}) {
  const id = React.useId();
  return (
    <div className={`space-y-1 ${wide ? "col-span-2 sm:col-span-3" : ""}`}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {typeof children === "function"
        ? children(id)
        : React.isValidElement(children)
          ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
          : children}
    </div>
  );
}

function PlannerFields({
  draft,
  field,
  edit,
  todayKey,
}: FieldTools & {
  draft: Extract<CaptureDraft, { intent: "planner" }>;
  todayKey: DayKey;
}) {
  const startMinute = field("startMinute", draft.planner.startMinute);
  const endMinute = field("endMinute", draft.planner.endMinute);
  const allDay = field("allDay", draft.planner.allDay);
  return (
    <>
      <FieldGrid>
        <FieldCell label="Title" wide>
          <Input
            value={field("title", draft.planner.title)}
            onChange={(event) => edit("title", event.target.value)}
          />
        </FieldCell>
        <FieldCell label="Date">
          <Input
            type="date"
            value={field("date", draft.planner.date)}
            onChange={(event) => edit("date", event.target.value)}
          />
        </FieldCell>
        <FieldCell label="Category">
          {(id) => (
          <Select
            value={field("category", draft.planner.category)}
            onValueChange={(value) => edit("category", value as ScheduleCategory)}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {CATEGORY_META[category]?.label ?? category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
        </FieldCell>
        <FieldCell label="Priority">
          {(id) => (
          <PrioritySelect
            id={id}
            value={field("priority", draft.planner.priority)}
            onChange={(value) => edit("priority", value)}
          />
          )}
        </FieldCell>
        {!allDay && (
          <>
            <FieldCell label="Start">
              <Input
                type="time"
                value={startMinute === null ? "" : minuteToTimeValue(startMinute)}
                onChange={(event) => edit("startMinute", parseTimeToMinute(event.target.value))}
              />
            </FieldCell>
            <FieldCell label="End">
              <Input
                type="time"
                value={endMinute === null ? "" : minuteToTimeValue(endMinute)}
                onChange={(event) => edit("endMinute", parseTimeToMinute(event.target.value))}
              />
            </FieldCell>
          </>
        )}
        <FieldCell label="All day">
          <div className="flex h-9 items-center">
            <Checkbox
              checked={allDay}
              onCheckedChange={(checked) => edit("allDay", checked === true)}
              aria-label="All day"
            />
          </div>
        </FieldCell>
      </FieldGrid>
      {draft.planner.tags.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Tags are kept for tasks; planner quick-capture ignores{" "}
          {draft.planner.tags.map((tag) => `#${tag}`).join(" ")} (as before).
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {relativeDayLabel(field("date", draft.planner.date), todayKey)}
      </p>
    </>
  );
}

function TaskFields({
  draft,
  field,
  edit,
}: FieldTools & { draft: Extract<CaptureDraft, { intent: "task" }> }) {
  return (
    <FieldGrid>
      <FieldCell label="Title" wide>
        <Input
          value={field("title", draft.title)}
          onChange={(event) => edit("title", event.target.value)}
        />
      </FieldCell>
      <FieldCell label="Due date">
        <Input
          type="date"
          value={field("dueDate", draft.dueDate) ?? ""}
          onChange={(event) => edit("dueDate", event.target.value || null)}
        />
      </FieldCell>
      <FieldCell label="Priority">
        {(id) => (
        <PrioritySelect
          id={id}
          value={field("priority", draft.priority)}
          onChange={(value) => edit("priority", value)}
        />
        )}
      </FieldCell>
      {draft.tags.length > 0 && (
        <FieldCell label="Tags">
          <div className="flex h-9 flex-wrap items-center gap-1">
            {draft.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                #{tag}
              </Badge>
            ))}
          </div>
        </FieldCell>
      )}
    </FieldGrid>
  );
}

function MoneyFields({
  draft,
  field,
  edit,
  context,
  resolving,
}: FieldTools & {
  draft: Extract<CaptureDraft, { intent: "expense" | "income" }>;
  context: CaptureContext | null;
  resolving: boolean;
}) {
  const accounts = context?.accounts ?? [];
  const accountId = field("accountId", context?.defaultAccountId ?? "");
  return (
    <>
      <FieldGrid>
        <FieldCell label="Amount">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={String(field("amount", draft.amount))}
            onChange={(event) => edit("amount", Number(event.target.value))}
          />
        </FieldCell>
        <FieldCell label={draft.intent === "expense" ? "Payee" : "Source"}>
          <Input
            value={field("payee", draft.payee ?? "")}
            onChange={(event) => edit("payee", event.target.value)}
          />
        </FieldCell>
        <FieldCell label="Category">
          {(id) => (
          <Select
            value={field(
              "category",
              draft.category ?? (draft.intent === "income" ? "income" : "other"),
            )}
            onValueChange={(value) => edit("category", value as FinanceCategory)}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FINANCE_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {FINANCE_CATEGORY_META[category]?.label ?? category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
        </FieldCell>
        <FieldCell label="Date">
          <Input
            type="date"
            value={field("date", draft.date)}
            onChange={(event) => edit("date", event.target.value)}
          />
        </FieldCell>
        <FieldCell label="Account" wide>
          {(id) =>
            accounts.length > 0 ? (
            <Select value={accountId} onValueChange={(value) => edit("accountId", value)}>
              <SelectTrigger id={id}>
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="flex h-9 items-center text-xs text-muted-foreground">
              {resolving
                ? "Loading accounts…"
                : "No accounts yet — create one on the Finance page first, or capture this to your Inbox."}
            </p>
          )}
        </FieldCell>
      </FieldGrid>
    </>
  );
}

function HealthFields({
  draft,
  field,
  edit,
}: FieldTools & { draft: Extract<CaptureDraft, { intent: "health" }> }) {
  const metric = field("metric", draft.metric);
  const meta = HEALTH_METRIC_META[metric as HealthMetricType];
  return (
    <FieldGrid>
      <FieldCell label="Metric" wide>
        {(id) => (
        <Select value={metric} onValueChange={(value) => edit("metric", value)}>
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MANUAL_ENTRY_METRICS.map((type) => (
              <SelectItem key={type} value={type}>
                {HEALTH_METRIC_META[type].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        )}
      </FieldCell>
      <FieldCell label={`Value${draft.unit ? ` (${draft.unit})` : meta ? ` (${meta.unit})` : ""}`}>
        <Input
          type="number"
          step="any"
          inputMode="decimal"
          value={String(field("value", draft.value))}
          onChange={(event) => edit("value", Number(event.target.value))}
        />
      </FieldCell>
      {draft.secondaryValue !== null && (
        <FieldCell label="Diastolic">
          <Input
            type="number"
            step="any"
            value={String(field("secondaryValue", draft.secondaryValue))}
            onChange={(event) => edit("secondaryValue", Number(event.target.value))}
          />
        </FieldCell>
      )}
      <FieldCell label="Date">
        <Input
          type="date"
          value={field("date", draft.date)}
          onChange={(event) => edit("date", event.target.value)}
        />
      </FieldCell>
    </FieldGrid>
  );
}

function NutritionFields({
  draft,
  field,
  edit,
  rows,
  setRows,
  resolving,
}: FieldTools & {
  draft: Extract<CaptureDraft, { intent: "nutrition" }>;
  rows: FoodRowState[];
  setRows: React.Dispatch<React.SetStateAction<FoodRowState[]>>;
  resolving: boolean;
}) {
  function updateRow(index: number, patch: Partial<FoodRowState>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  }

  return (
    <div className="space-y-3">
      <FieldGrid>
        <FieldCell label="Meal">
          {(id) => (
          <Select
            value={field("mealType", draft.mealType)}
            onValueChange={(value) => edit("mealType", value as MealType)}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEAL_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {MEAL_TYPE_META[type]?.label ?? type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
        </FieldCell>
        <FieldCell label="Date">
          <Input
            type="date"
            value={field("date", draft.date)}
            onChange={(event) => edit("date", event.target.value)}
          />
        </FieldCell>
      </FieldGrid>

      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {resolving ? "Matching against your food catalogue…" : "No items recognised."}
          </p>
        )}
        {rows.map((row, index) =>
          row.removed ? null : (
            <div key={`${row.phrase}-${index}`} className="rounded-md border bg-background p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{row.phrase}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => updateRow(index, { removed: true })}
                >
                  Remove
                </Button>
              </div>
              {row.candidates.length > 0 ? (
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="col-span-2">
                    <Select
                      value={row.selected ? candidateValue(row.selected) : ""}
                      onValueChange={(value) =>
                        updateRow(index, {
                          selected:
                            row.candidates.find(
                              (candidate) => candidateValue(candidate) === value,
                            ) ?? null,
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label={`Food match for ${row.phrase}`}
                        className={row.selected ? "" : "border-amber-500"}
                      >
                        <SelectValue placeholder="Pick a match…" />
                      </SelectTrigger>
                      <SelectContent>
                        {row.candidates.map((candidate) => (
                          <SelectItem
                            key={candidateValue(candidate)}
                            value={candidateValue(candidate)}
                          >
                            {candidate.name}
                            {candidate.brand ? ` · ${candidate.brand}` : ""} ·{" "}
                            {Math.round(candidate.calories)} kcal
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Input
                    type="number"
                    min="0.1"
                    step="any"
                    aria-label={`Quantity for ${row.phrase}`}
                    value={String(row.quantity)}
                    onChange={(event) =>
                      updateRow(index, { quantity: Number(event.target.value) })
                    }
                  />
                  <Select
                    value={row.unit}
                    onValueChange={(value) => updateRow(index, { unit: value })}
                  >
                    <SelectTrigger aria-label={`Unit for ${row.phrase}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SERVING_UNITS.map((unit) => (
                        <SelectItem key={unit} value={unit}>
                          {unit}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {resolving
                    ? "Searching…"
                    : "No match in your catalogue — remove this item, or switch the capture to Inbox so nothing is lost. You can add the food on the Nutrition page (search or barcode) and recapture."}
                </p>
              )}
            </div>
          ),
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Ambiguous items need a picked match — nothing is guessed.
      </p>
    </div>
  );
}

function candidateValue(candidate: FoodCandidate): string {
  return candidate.foodItemId ?? `${candidate.provider}:${candidate.externalId}`;
}

function WorkoutFields({
  draft,
  field,
  edit,
}: FieldTools & { draft: Extract<CaptureDraft, { intent: "workout" }> }) {
  return (
    <FieldGrid>
      <FieldCell label="Name" wide>
        <Input
          value={field("name", draft.name)}
          onChange={(event) => edit("name", event.target.value)}
        />
      </FieldCell>
      <FieldCell label="Type">
        {(id) => (
        <Select
          value={field("type", draft.type)}
          onValueChange={(value) => edit("type", value as WorkoutType)}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKOUT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {WORKOUT_TYPE_META[type]?.label ?? type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        )}
      </FieldCell>
      <FieldCell label="Duration (min)">
        <Input
          type="number"
          min="0"
          value={field("durationMin", draft.durationMin) === null ? "" : String(field("durationMin", draft.durationMin))}
          onChange={(event) =>
            edit("durationMin", event.target.value === "" ? null : Number(event.target.value))
          }
        />
      </FieldCell>
      <FieldCell label="Distance (km)">
        <Input
          type="number"
          min="0"
          step="any"
          value={field("distanceKm", draft.distanceKm) === null ? "" : String(field("distanceKm", draft.distanceKm))}
          onChange={(event) =>
            edit("distanceKm", event.target.value === "" ? null : Number(event.target.value))
          }
        />
      </FieldCell>
      <FieldCell label="Date">
        <Input
          type="date"
          value={field("date", draft.date)}
          onChange={(event) => edit("date", event.target.value)}
        />
      </FieldCell>
      {draft.strength && (
        <>
          <FieldCell label="Exercise">
            <Input
              value={field("exercise", draft.strength.exercise)}
              onChange={(event) => edit("exercise", event.target.value)}
            />
          </FieldCell>
          <FieldCell label="Sets × reps">
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min="1"
                aria-label="Sets"
                value={String(field("sets", draft.strength.sets))}
                onChange={(event) => edit("sets", Number(event.target.value))}
              />
              <span className="text-xs text-muted-foreground">×</span>
              <Input
                type="number"
                min="1"
                aria-label="Reps"
                value={String(field("reps", draft.strength.reps))}
                onChange={(event) => edit("reps", Number(event.target.value))}
              />
            </div>
          </FieldCell>
          <FieldCell label="Weight">
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min="0"
                step="any"
                aria-label="Weight"
                value={
                  field("weight", draft.strength.weight) === null
                    ? ""
                    : String(field("weight", draft.strength.weight))
                }
                onChange={(event) =>
                  edit("weight", event.target.value === "" ? null : Number(event.target.value))
                }
              />
              <Select
                value={field("weightUnit", draft.strength.weightUnit) ?? "default"}
                onValueChange={(value) =>
                  edit("weightUnit", value === "default" ? null : (value as "kg" | "lb"))
                }
              >
                <SelectTrigger aria-label="Weight unit" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">your unit</SelectItem>
                  <SelectItem value="kg">kg</SelectItem>
                  <SelectItem value="lb">lb</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
        </>
      )}
    </FieldGrid>
  );
}

function HabitFields({
  draft,
  field,
  edit,
  candidates,
  choice,
  setChoice,
  resolving,
}: FieldTools & {
  draft: Extract<CaptureDraft, { intent: "habit" }>;
  candidates: HabitCandidate[];
  choice: string | null;
  setChoice: (id: string | null) => void;
  resolving: boolean;
}) {
  const status = field("status", draft.status);
  const chosen = candidates.find((candidate) => candidate.id === choice) ?? null;
  return (
    <div className="space-y-2.5">
      <FieldGrid>
        <FieldCell label="Habit" wide>
          {(id) =>
            candidates.length > 0 ? (
            <Select value={choice ?? ""} onValueChange={(value) => setChoice(value)}>
              <SelectTrigger id={id} className={choice ? "" : "border-amber-500"}>
                <SelectValue placeholder={`Which habit is "${draft.query}"?`} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.loggedStatus ? ` · already ${candidate.loggedStatus}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="flex min-h-9 items-center text-xs text-amber-600 dark:text-amber-400">
              {resolving
                ? "Looking for a matching habit…"
                : `No habit matches "${draft.query}" — switch to Inbox to keep the note, or create the habit first.`}
            </p>
          )}
        </FieldCell>
        <FieldCell label="Status">
          {(id) => (
          <Select value={status} onValueChange={(value) => edit("status", value)}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="done">Done</SelectItem>
              <SelectItem value="skipped">Skipped</SelectItem>
            </SelectContent>
          </Select>
          )}
        </FieldCell>
        <FieldCell label="Date">
          <Input
            type="date"
            value={field("date", draft.date)}
            onChange={(event) => edit("date", event.target.value)}
          />
        </FieldCell>
      </FieldGrid>
      {chosen?.loggedStatus && (
        <p className="text-xs text-muted-foreground">
          Already logged as “{chosen.loggedStatus}” for this day — capturing will overwrite it.
        </p>
      )}
    </div>
  );
}

function InboxFields({
  draft,
  field,
  edit,
}: FieldTools & { draft: Extract<CaptureDraft, { intent: "inbox" }> }) {
  return (
    <FieldGrid>
      <FieldCell label="Title" wide>
        <Input
          value={field("title", draft.title)}
          onChange={(event) => edit("title", event.target.value)}
        />
      </FieldCell>
      <FieldCell label="Notes" wide>
        <Input
          value={field("notes", draft.notes ?? "")}
          placeholder="Optional details"
          onChange={(event) => edit("notes", event.target.value)}
        />
      </FieldCell>
    </FieldGrid>
  );
}

function PrioritySelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: Priority;
  onChange: (value: Priority) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Priority)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((priority) => (
          <SelectItem key={priority} value={priority}>
            {priority}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
