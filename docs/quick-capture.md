# Quick capture

One text field that routes a line of plain language to the right module. It
lives in three places, all sharing the same parser:

* **Capture** (`N` anywhere, or the Capture button): the full dialog with an
  editable preview — the parser proposes, you confirm.
* **Quick add** in the planner and the command palette: the planner-only
  grammar (the original quick-add), unchanged.
* **Mobile**: the Capture button in the app shell.

Nothing commits without you: the preview shows exactly what will be written,
every field is editable, and anything the parser cannot place lands in the
**Inbox** rather than being guessed at. A capture is never lost.

## How a line is read

The classifier looks at the shape of the line and proposes an intent — you
can always override it with the intent chips in the dialog.

| You type | It becomes |
| --- | --- |
| `Gym session 6pm #fitness` | **Planner block** — the planner grammar in full (see below) |
| `todo call the plumber tomorrow !high` | **Task** — due date and priority parsed, `#words` become tags |
| `spent 12.50 lunch at Bao House` | **Expense** — amount, payee, category suggestion |
| `received 2500 salary` | **Income** |
| `weight 82.5kg` / `slept 7.5h` / `bp 120/80` | **Health reading** — explicit units win; bare numbers use your display unit |
| `ate 2 eggs and 100g rice for breakfast` | **Food** — items split, quantities and units parsed, meal inferred from the word or the time of day |
| `did bench 3x8 135` / `ran 5k in 25min` | **Workout** — strength sets (`3x8 135`) or cardio distance/time |
| `meditated` (matching a habit name) | **Habit tick** — matched against your own habits, both directions |
| anything else | **Inbox** — kept verbatim as a note |

### The planner grammar (quick add)

* **Times**: `6pm`, `18:00`, `6-7pm`, `9:30am to 11am`. An end time before
  the start means the block crosses midnight.
* **Dates**: `today`, `tomorrow`, `mon`/`monday`, `jan 5`, `2026-02-01`.
  No date word means the day you are looking at.
* **Category**: `#work`, `#fitness`, … (the planner's own categories).
* **Priority**: `!high`, `!low`.

The same `#tag`, `!priority` and date tokens work in task lines; for tasks,
`#words` that are not schedule categories become task tags.

### Units and amounts

* Health readings accept explicit units (`kg`, `lb`, `ml`, `l`, `h`,
  `min`); a bare number is read in your display unit for that metric.
* Food quantities accept counts (`2 eggs`) and attached units
  (`100g chicken`); unknown foods offer a search rather than a guess.
* Money is parsed as positive dollars — expense vs income is the intent.

### Disambiguation, not guessing

When a line could be more than one thing (`did bench…` could be a workout
or a habit called "Bench"), the preview shows the alternatives as chips and
asks. When a food phrase matches nothing in your food list, the row asks you
to pick a match before the commit button arms. When nothing fits at all, the
line goes to the Inbox — from there it can be converted to a task later.

## Automations

Everything quick capture writes goes through the same server actions as the
forms, so [automation rules](./automation-rules.md) with record triggers
(a planner block is created, a transaction is created, …) fire for captured
records exactly as they do for hand-entered ones — with the same loop
protection.
