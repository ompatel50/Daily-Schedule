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
- “Summarize my finances this month.”
- “Find overdue bills and tasks.”
- “Summarize my sleep and heart trends.”
- “Show me the most important things that happened this week.”
- “Create a reminder to renew my passport.” *(draft/confirm modes)*
- “Add this bill to my finances.” *(draft/confirm modes)*

Under the hood the model never touches the database. It calls a fixed,
server-side set of tools — search, day/week summaries, the needs-attention
digest, tasks, inbox, finance, bills, budgets, reminders, health trends,
documents, the planner, import history, and backup row-counts — each of which
wraps an existing, ownership-checked, bounded read model. The one non-read
tool stages a **proposal**; it cannot execute anything.

Changes the assistant can propose: create a task, complete a task, create a
reminder, add an inbox note, record a transaction, add a planner block, delete
a task, delete a reminder. Each proposal is validated with the exact same
schema the app's own forms use, previewed as one plain sentence, and executed
— only after your confirmation — by calling the same server action the app's
own buttons call. Everything those actions enforce (ownership, validation,
recomputed summaries, UI refresh) applies unchanged.

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

## Confirmations

- Every proposal shows **exactly** what will run — the preview sentence is
  generated from the validated payload, not from the model's own words.
- **Normal** actions (create task, add inbox note, complete task) execute on
  one Confirm click.
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
