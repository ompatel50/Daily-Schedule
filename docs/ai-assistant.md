# The AI assistant — private, Ollama-only

Personal OS includes an assistant that can answer questions about your data,
summarize your days, weeks, finances, tasks and health, search across the app,
and — only when you explicitly approve — make changes.

It runs against **your own [Ollama](https://ollama.com) server and nothing
else**. There is no cloud AI provider, no API key, no subscription, no credit
card, and no fallback that quietly sends your data somewhere. If your Ollama
server is off, the assistant is off; the rest of the app is unaffected.

## Setting it up

1. **Install Ollama** on this machine or another computer on your network
   (an iMac across the room works fine): <https://ollama.com/download>.
2. **Pull a model that supports tool calling** — the assistant reads your data
   through tools, so the model must speak that protocol. Good starting points:

   ```bash
   ollama pull llama3.1        # ~8B, solid all-rounder
   ollama pull qwen2.5         # strong at structured/tool output
   ```

3. **If Ollama runs on another machine**, tell it to listen on the network
   before starting it (by default it only listens on localhost):

   ```bash
   OLLAMA_HOST=0.0.0.0 ollama serve
   ```

4. In Personal OS, open **Settings → AI assistant**, enter the server URL
   (`http://localhost:11434`, or `http://<that-machine>:11434`), and press
   **Test connection**. The panel shows the server version and the models it
   found; pick one, pick a mode, save.

The assistant page (sidebar → **Assistant**, or `g` then `x`) shows the
connection state, the model and the mode at all times. If the server becomes
unreachable, the page says so plainly and offers everything else as normal —
retry by reloading once the server is back.

## Modes

The mode is a hard, server-enforced ceiling on what the assistant may do —
not a UI preference. **Read-only is the default.**

| Mode | What it may do |
| --- | --- |
| **Read-only** | Answer questions and summarize. Proposing changes is refused server-side. |
| **Draft** | Additionally propose changes, shown as preview cards. Nothing can execute — the Confirm button does not exist in this mode, and the server refuses execution regardless. |
| **Confirm** | Proposal cards gain a Confirm button. A change happens only after you press it — and sensitive or destructive changes open a second dialog restating exactly what will happen. |

## What it can do

Ask things like:

- “What should I focus on today?”
- “Did I do my habits today?”
- “Which habits am I missing this week?”
- “What is my current streak on sleep?”
- “What habits are due next?”
- “Summarize my finances this month.”
- “Find overdue bills and tasks.”
- “Summarize my sleep and heart trends.”
- “Show me the most important things that happened this week.”
- “Create a reminder to renew my passport.” *(draft/confirm modes)*
- “Mark my water habit as done.” *(draft/confirm modes)*
- “Add this bill to my finances.” *(draft/confirm modes)*

Under the hood the model never touches the database. It calls a fixed,
server-side set of tools — search, day/week summaries, the needs-attention
digest, tasks, inbox, habits, finance, bills, budgets, reminders, health
trends, documents, the planner, import history, and backup row-counts — each
of which wraps an existing, ownership-checked, bounded read model. The one
non-read tool stages a **proposal**; it cannot execute anything.

### Habits — `get_habit_status`

Habit questions get their own tool rather than being guessed at from the day
overview, because habits are the one area where the honest answer needs
several numbers at once. For a date (today unless you say otherwise) it
returns, per habit:

- whether it is **due** on that date, and how the date resolved — done,
  missed, skipped, excused, still pending, or simply not scheduled;
- the **current and longest streak**, counted in scheduled opportunities (or
  in weeks, for a “3× per week” habit);
- **this week's progress** against its target — “3 of 4”, never “3 of 7”;
- **which days this week were already missed**, so “what am I missing?” is
  answered with dates rather than a feeling;
- the **last 30 days'** opportunities, completions and completion rate;
- **when it is next due**, if it is not due on that date.

You can narrow it to one habit by name (“what's my streak on sleep?”), and
archived habits are excluded unless asked for. Rest days and unscheduled days
are reported as exactly that — they are never counted as misses, which is the
same rule the habits page and the day score use.

The list is capped so the answer stays small enough for a modest local model;
past the cap the assistant is told the list was cut and to ask by name.

### Changes it can propose

Create a task, complete a task, create a reminder, add an inbox note,
**complete an inbox note**, record a transaction, add a planner block,
**log a habit** (one day, one habit: done, skipped or missed, with an optional
value), delete a task, delete a reminder.

Each proposal is previewed as one plain sentence and executed — only after your
confirmation — by calling the same server action the app's own buttons call, so
everything those actions enforce (ownership, validation, recomputed summaries,
UI refresh) applies unchanged.

The proposal schemas are deliberately **narrower** than the app's own forms:
the assistant may only send the fields the preview sentence describes, and
anything else is refused outright. A task it creates is always a plain one-off
task (no repeat, no reminder, no parent, no tags); a planner block is always a
single day (never a recurring series); a habit log carries no notes, because
the preview sentence could not quote them. This is what makes "what you confirm
is what runs" true rather than merely intended — a change the preview cannot
describe is not a change the assistant can make.

## What it cannot do

- Execute anything without your explicit confirmation, in any mode.
- Read or touch another account's data — every tool call runs as you, with
  the same ownership checks as the rest of the app.
- Reach any service other than the Ollama server you configured. The browser
  can't either: the app's Content-Security-Policy only allows same-origin
  requests, so all model traffic flows through the app server.
- Modify health data, backups, imports, budgets, accounts or documents — those
  are read-only to the assistant in this version.
- Restore backups, undo imports, or delete anything other than a single task
  or reminder you confirmed.

### Deliberately left out

These were considered and not built. Each is one schema, one preview sentence
and one dispatch arm away, if real use asks for it:

- **Creating or editing habits.** A habit carries an effective-dated schedule,
  and an edit has to choose whether it rewrites history — a decision the
  dialog asks about explicitly and a preview sentence cannot honestly carry.
- **Excusing a habit day.** A different server action from logging one, and
  one proposal kind maps to exactly one action here by design.
- **Marking a bill paid.** It does two things at once — advances the due date
  *and* writes a payment into the ledger — so a single confirmed sentence
  would be describing two changes, one of them financial.
- **Rescheduling a task.** There is no narrow "change the due date" action;
  going through the full save would let fields the preview never mentioned
  ride along, which is exactly the trap the narrow schemas close.
- **Health, budget, account and document writes**, and anything touching
  backups or imports. The read surface covers them; the write surface would
  not be worth the blast radius.

## Confirmations

- Every proposal shows **exactly** what will run — the preview sentence is
  generated from the validated payload, not from the model's own words.
- **Normal** actions (create task, complete task, add or complete an inbox
  note, log a habit) execute on one Confirm click — they are the everyday
  ticks, and each is undone by clicking the same control in the app.
- **Sensitive** actions (finance records, reminders, planner changes) and
  **destructive** actions (any delete) open a second dialog that restates the
  action; deletes are styled and worded as deletions.
- Proposals expire after an hour undecided, can be cancelled with one click,
  and can never execute twice — a double click is refused by the same
  claim that makes single execution atomic.

## Audit log

The **Recent assistant activity** panel shows the append-only audit trail:

- each exchange — a truncated first line of your request, which tools ran,
  the model, the duration, and whether it succeeded;
- each decided proposal — confirmed, cancelled or failed, with the outcome;
- each explicit connection test.

What it deliberately does **not** contain: transcripts, tool payloads or
model prose. Summaries are app-authored and bounded, enough to answer "what
did the assistant do and when" without copying your data into a log.
Conversations themselves are not persisted at all — closing the page ends
them.

## Privacy model

- Your data goes to **one place**: the Ollama server whose URL you typed —
  hardware you control. The privacy of the assistant equals the privacy of
  that machine.
- The server-side client only ever requests `/api/version`, `/api/tags` and
  `/api/chat` on that base URL; URLs are validated (http/https only, no
  credentials, cloud-metadata addresses refused), and error messages never
  echo the URL.
- Context is assembled minimally: bounded history, pruned tool results, no
  full-table dumps. A question about tasks sends task summaries, not your
  ledger.
- Assistant tables (proposals, audit log) are excluded from backups by
  design, like the app's other operational records; your Ollama URL and model
  choice live on your account row and stay out of exported backups' data
  tables.
- The suite pins all of this: tests assert the client makes zero requests
  when unconfigured, only ever calls the configured host, and that the
  assistant's server directory names no cloud AI host anywhere.

## Performance notes

- Answers stream token by token, so even a modest model feels alive.
- The model gets at most 4 tool rounds and 5 tool calls per round; tool
  results are truncated past 8 KB. If it needs more, it must ask a narrower
  question — by design.
- The connection test uses a short timeout (5 s) so Settings never hangs;
  generation gets a long one (120 s). On hosted deployments the chat route is
  additionally bounded by the platform's 60 s function ceiling — self-hosted
  deployments have no such cap.
- Model quality/speed is entirely your choice of Ollama model; the app adds
  one database round per tool call, all indexed and bounded.
