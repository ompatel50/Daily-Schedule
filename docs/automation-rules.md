# Automation rules

Settings → Automations. A rule is one sentence: **when** a trigger fires,
**if** every condition holds, **then** the actions run. The builder shows
that sentence live at the top while you edit, and the rule list shows it for
every saved rule.

## Triggers

* **A record event** — something is created or updated in a module:
  transactions, tasks, planner blocks, habit logs, meals, workouts, health
  readings, inbox items. These fire immediately, inside the save itself.
* **A daily number** — yesterday's value from your day summary (sleep, day
  score, spending, planned time, steps, workouts, tasks completed, habits
  missed) crossing a threshold. Evaluated once a day by the maintenance
  tick.
* **A day of the week** (or a specific date) — evaluated once a day.
* **An anomaly observation** — when the Observations card (Insights) has a
  live signal, optionally filtered to one category.

There is no minute-level scheduler: "when a block ends" is expressed as a
record trigger on planner blocks being updated (marking a block done is its
end), and day-level timing uses the date trigger.

## Conditions

Field comparisons (`is`, `contains`, `is over`, `is one of`, …) on the
triggering record's fields, plus weekday and date-range filters, combined
with *all must hold* or *any may hold*. Text matching is case-insensitive.
Deeper nesting is possible in the stored definition (up to three levels);
the builder's simple form covers one group, and switches to direct JSON
editing for anything deeper rather than flattening it.

## Actions

Set the category (transactions, planner blocks) · create a task · capture
to the Inbox · set a reminder · add a planner block · log a habit done
(never overwriting a log you made yourself) · link a transaction to its
bill · send a notification. Up to five actions per rule. Text fields accept
`{{placeholders}}` from the triggering record — `{{payee}}`, `{{title}}`,
`{{amount}}`, `{{date}}`, and so on.

**Rules never delete anything.** There is no delete action, and there never
will be one by accident: the vocabulary is a whitelist.

## The safety model

* **Dry run before enable, always.** A rule is saved disabled. The dry run
  replays it against your last 30 days of real data — showing exactly what
  it *would* have done, writing nothing — and only then can it be enabled.
  Editing a rule's behaviour disables it again until its next dry run.
* **No self-triggering.** A rule whose actions would produce the very event
  it listens to is refused at save time. Chains between rules run one step
  and stop — a rule-created record can trigger one more rule, and what that
  one creates triggers nothing.
* **Every run is logged.** Each rule's History shows every execution: what
  triggered it, what matched, what was done, with the resulting records.
* **Everything is undoable.** Undo a single run or a rule's whole history:
  records the rule created go to the Trash (restorable like any other
  delete), changed fields revert to their previous values.
* **Failures disable themselves.** A rule that errors three times in a row
  turns itself off and shows you the error, rather than failing silently
  forever.
* **Per-user, always.** Rules see and touch only your own data.

## The starter library

Four templates on the Automations page — categorise a merchant, link a
recurring charge to its bill, log a habit after training, protect a
short-sleep day. Adding one stores it **disabled**; edit the placeholder
values (your merchant, your habit's name), run the dry run, then enable.

## Backups

Rules ride the backup file (format v15). On restore they arrive disabled
with their review cleared — a restored rule must be dry-run against the
destination account's data before it can run there. Execution logs stay
with the account that ran them and are not exported.

## Performance

Rule evaluation is one indexed query per write when you have enabled rules,
and nothing at all otherwise. Measured on the integration benchmark:
`saveTransaction` averaged ~20 ms without rules and ~23 ms with five
enabled rules (one of which matched and wrote two records per run).
