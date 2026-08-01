/**
 * The assistant, end to end, against a scripted local "Ollama".
 *
 * The stub below is a real HTTP listener speaking Ollama's API shapes —
 * /api/version, /api/tags and NDJSON-streaming /api/chat — because the app's
 * model calls originate in the Next.js SERVER process, where page.route()
 * cannot reach. The spec points the assistant at the stub through the
 * settings UI itself, which is exactly how a user would, so the whole path
 * is exercised: settings → connection test → chat stream → tool round →
 * proposal card → confirm/cancel → real records → audit.
 *
 * Everything is deterministic: the stub's replies are keyed on the message
 * text, and the one task it ever proposes carries a per-run nonce so reruns
 * and parallel workers cannot collide. The spec deletes that task through
 * the assistant's own destructive flow — which is both the cleanup and the
 * test of the harder confirmation path.
 */
import { createServer, type Server } from "node:http";

import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

const STUB_PORT = 11435;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const NONCE = `e2e-${Date.now().toString(36)}`;
const TASK_TITLE = `Renew passport (assistant ${NONCE})`;
/** The habit the status/log cases read and write. Created and removed here. */
const HABIT_NAME = `Assistant habit ${NONCE}`;
/** A separate title for the read-only case, so its "nothing was created"
 *  assertion cannot be confused by a task an earlier case legitimately made
 *  (or an interrupted run left behind). */
const READONLY_TITLE = `Read-only probe (assistant ${NONCE})`;

const IGNORED_CONSOLE = [/_vercel\/insights/];

function watchConsole(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const where = message.location()?.url ?? "";
    const entry = where ? `${message.text()} (${where})` : message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(entry))) return;
    errors.push(entry);
  });
  page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));
  return () => errors;
}

// ---------------------------------------------------------------------------
// The stub Ollama server
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string;
  tool_name?: string;
  tool_calls?: unknown[];
}

function ndjson(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function textReply(...tokens: string[]): string {
  return ndjson([
    ...tokens.map((token) => ({ message: { role: "assistant", content: token } })),
    { message: { role: "assistant", content: "" }, done: true },
  ]);
}

function toolReply(name: string, args: Record<string, unknown>): string {
  return ndjson([
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name, arguments: args } }],
      },
    },
    { message: { role: "assistant", content: "" }, done: true },
  ]);
}

/** Find this run's task id inside a list_tasks tool result. */
function taskIdFrom(listTasksJson: string): string | null {
  try {
    const parsed = JSON.parse(listTasksJson) as {
      buckets?: Record<string, Array<{ id: string; title: string }>>;
    };
    for (const bucket of Object.values(parsed.buckets ?? {})) {
      const hit = bucket.find((task) => task.title.includes(NONCE));
      if (hit) return hit.id;
    }
  } catch {
    // fall through
  }
  return null;
}

interface HabitStatusEntry {
  id: string;
  name: string;
  status: string;
  streak: { current: number };
}

/** This run's habit inside a get_habit_status tool result. */
function habitFrom(statusJson: string): HabitStatusEntry | null {
  try {
    const parsed = JSON.parse(statusJson) as { habits?: HabitStatusEntry[] };
    return (parsed.habits ?? []).find((habit) => habit.name.includes(NONCE)) ?? null;
  } catch {
    return null;
  }
}

function chatResponseFor(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];

  // Continuation rounds: the engine has fed a tool result back.
  if (last?.role === "tool") {
    if (last.tool_name === "propose_action") {
      return last.content.includes('"proposed":true')
        ? textReply("I've drafted that — ", "review it below.")
        : textReply("Read-only mode is on, so I can't propose changes.");
    }
    if (last.tool_name === "list_tasks") {
      const id = taskIdFrom(last.content);
      return id
        ? toolReply("propose_action", { kind: "delete_task", payload: { id } })
        : textReply("I couldn't find that task.");
    }
    if (last.tool_name === "get_habit_status") {
      const habit = habitFrom(last.content);
      if (!habit) return textReply("I couldn't find that habit.");
      // Which branch depends on what was asked, three messages back — the
      // status question reports, the log request proposes.
      const asked = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      if (asked.includes("mark my habit")) {
        return toolReply("propose_action", {
          kind: "log_habit",
          payload: { habitId: habit.id },
        });
      }
      // Read straight out of the tool result, so a green assertion here can
      // only mean the tool really reached the database.
      return textReply(
        `Habit ${habit.name} is ${habit.status}, `,
        `streak ${habit.streak.current}.`,
      );
    }
    return textReply("Done.");
  }

  // A fresh user turn: scripted on the message text.
  const asked = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  if (asked.includes("hello assistant")) {
    return textReply("Hello! ", "Everything ", "looks fine.");
  }
  if (asked.includes("read-only probe")) {
    return toolReply("propose_action", {
      kind: "create_task",
      payload: { title: READONLY_TITLE },
    });
  }
  if (asked.includes("add a task")) {
    return toolReply("propose_action", {
      kind: "create_task",
      payload: { title: TASK_TITLE },
    });
  }
  if (asked.includes("delete the passport task")) {
    return toolReply("list_tasks", {});
  }
  if (asked.includes("how are my habits") || asked.includes("mark my habit")) {
    return toolReply("get_habit_status", {});
  }
  return textReply("OK.");
}

function startStub(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "0.0-e2e" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [{ name: "e2e-model", size: 1, details: { parameter_size: "1B" } }],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        let messages: ChatMessage[] = [];
        try {
          messages = (JSON.parse(body) as { messages: ChatMessage[] }).messages ?? [];
        } catch {
          // an empty script answers "OK."
        }
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(chatResponseFor(messages));
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ask(page: Page, message: string) {
  await page.getByTestId("assistant-input").fill(message);
  await page.getByTestId("assistant-send").click();
}

/**
 * A habit for this run, created the way a user would. The assistant has no
 * create-habit tool by design, so the fixture goes through the habits UI —
 * and `removeHabit` below takes it away again, so reruns start clean.
 */
async function createHabit(page: Page) {
  await page.goto("/habits");
  await page.getByRole("button", { name: /New habit|Create a habit/ }).first().click();
  await page.locator("#habit-name").fill(HABIT_NAME);
  await page.getByRole("button", { name: "Create habit" }).click();
  await expect(page.getByText(HABIT_NAME).first()).toBeVisible();
}

async function removeHabit(page: Page) {
  await page.goto("/habits");
  await page.getByRole("button", { name: `Edit ${HABIT_NAME}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByText(HABIT_NAME)).toHaveCount(0);
}

async function configureAssistant(page: Page, mode: "Confirm" | "Read-only") {
  await page.goto("/settings");
  const url = page.locator("#assistant-base-url");
  await url.fill(STUB_URL);
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByTestId("assistant-connection-result")).toContainText(
    "Connected — Ollama 0.0-e2e",
  );
  // The test found e2e-model and (with nothing saved yet) preselected it.
  await expect(page.locator("#assistant-model")).toContainText("e2e-model");
  await page.locator("#assistant-mode").click();
  await page.getByRole("option", { name: mode, exact: true }).click();
  await page.getByRole("button", { name: "Save assistant settings" }).click();
  // The toast is the "action completed" signal — navigating before it would
  // race the save. The durable assertion is the badge on the assistant page.
  await expect(page.getByText("Assistant settings saved")).toBeVisible();
  await page.goto("/assistant");
  await expect(page.getByTestId("assistant-mode-badge")).toContainText(mode);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

test.use({ storageState: STORAGE.alice });
test.describe.configure({ mode: "serial" });

let stub: Server;

test.beforeAll(async () => {
  stub = await startStub();
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

test("settings connect to the local server and save", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await configureAssistant(page, "Confirm");

  await expect(page.getByTestId("assistant-status")).toContainText("Ollama connected");
  await expect(page.getByTestId("assistant-status")).toContainText("e2e-model");
  expect(consoleErrors()).toEqual([]);
});

test("a read-only question streams an answer", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/assistant");
  await ask(page, "hello assistant");
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Hello! Everything looks fine.",
  );
  expect(consoleErrors()).toEqual([]);
});

test("a proposed task appears as a preview, and confirming creates it", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/assistant");
  await ask(page, "add a task to renew my passport");

  const proposal = page
    .getByTestId("assistant-proposal")
    .filter({ hasText: TASK_TITLE })
    .first();
  await expect(proposal).toBeVisible();
  await expect(page.getByTestId("assistant-transcript")).toContainText("review it below");

  await proposal.getByTestId("assistant-proposal-confirm").click();
  // The card leaves the pending list only after the server action resolves —
  // wait for that before navigating, or the check races the execution.
  await expect(proposal).toBeHidden();

  // Durable proof: the task exists where tasks live.
  await page.goto("/tasks");
  await expect(page.getByText(TASK_TITLE)).toHaveCount(1);
  expect(consoleErrors()).toEqual([]);
});

test("cancelling a proposal changes nothing", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/assistant");
  await ask(page, "add a task to renew my passport");

  const proposal = page
    .getByTestId("assistant-proposal")
    .filter({ hasText: TASK_TITLE })
    .first();
  await expect(proposal).toBeVisible();
  await proposal.getByTestId("assistant-proposal-cancel").click();
  await expect(proposal).toBeHidden();

  await page.goto("/tasks");
  await expect(page.getByText(TASK_TITLE)).toHaveCount(1);
  expect(consoleErrors()).toEqual([]);
});

test("a destructive delete demands the harder confirmation — and works", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/assistant");
  await ask(page, "delete the passport task please");

  const proposal = page
    .getByTestId("assistant-proposal")
    .filter({ hasText: "Delete task" })
    .first();
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText("Destructive");
  await expect(proposal).toContainText("permanent");

  // The first click opens the guard dialog rather than executing.
  await proposal.getByTestId("assistant-proposal-confirm").click();
  await expect(page.getByRole("dialog")).toContainText("Confirm this deletion?");
  await page.getByTestId("assistant-proposal-guard-confirm").click();
  await expect(proposal).toBeHidden();

  await page.goto("/tasks");
  await expect(page.getByText(TASK_TITLE)).toHaveCount(0);
  expect(consoleErrors()).toEqual([]);
});

test("get_habit_status answers a habit question from real data", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await createHabit(page);

  await page.goto("/assistant");
  await ask(page, "how are my habits doing?");

  const transcript = page.getByTestId("assistant-transcript");
  // The chip proves which tool ran; the sentence proves what it returned.
  await expect(transcript).toContainText("Checking your habits");
  await expect(transcript).toContainText(`Habit ${HABIT_NAME} is pending, streak 0.`);
  expect(consoleErrors()).toEqual([]);
});

test("logging a habit is previewed, confirmed, and lands on the checklist", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/assistant");
  await ask(page, "mark my habit as done today");

  const proposal = page
    .getByTestId("assistant-proposal")
    .filter({ hasText: HABIT_NAME })
    .first();
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText("Log habit");
  // An everyday tick: one click, no second dialog.
  await expect(proposal).not.toContainText("Destructive");
  await expect(proposal).not.toContainText("Sensitive");

  await proposal.getByTestId("assistant-proposal-confirm").click();
  await expect(proposal).toBeHidden();

  // Durable proof, where habits actually live.
  await page.goto("/habits");
  await expect(page.getByRole("button", { name: `${HABIT_NAME} — completed` })).toBeVisible();

  await removeHabit(page);
  expect(consoleErrors()).toEqual([]);
});

test("read-only mode refuses proposals server-side", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await configureAssistant(page, "Read-only");

  await ask(page, "read-only probe: add a task");
  await expect(page.getByTestId("assistant-transcript")).toContainText("Read-only mode is on");
  await expect(page.getByTestId("assistant-proposal")).toHaveCount(0);

  await page.goto("/tasks");
  await expect(page.getByText(READONLY_TITLE)).toHaveCount(0);
  expect(consoleErrors()).toEqual([]);
});

test("recent activity shows the audit trail", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/assistant");
  const audit = page.getByTestId("assistant-audit-list");
  await expect(audit).toContainText("add a task to renew my passport");
  await expect(audit).toContainText("Connection test succeeded");
  expect(consoleErrors()).toEqual([]);
});

test("the audit log stays readable on a phone", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/assistant");

  const request = page.getByTestId("assistant-audit-request").first();
  await expect(request).toBeVisible();

  // The regression this guards: the status badge and timestamp used to sit
  // beside the text with `shrink-0`, taking ~150px of a 390px screen and
  // leaving the request itself a few characters wide. They wrap now.
  const box = await request.boundingBox();
  expect(box, "the audit request line must be measurable").toBeTruthy();
  expect(box!.width, "the request needs most of the row, not a sliver").toBeGreaterThan(150);

  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement!;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, "the page must not scroll sideways").toBeLessThanOrEqual(0);
  expect(consoleErrors()).toEqual([]);
});

test("a dead Ollama is a calm, visible state", async ({ page }) => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  const consoleErrors = watchConsole(page);

  await page.goto("/assistant");
  await expect(page.getByTestId("assistant-status")).toContainText("Ollama offline");
  await expect(page.getByText(/Everything else in the app works normally/)).toBeVisible();
  expect(consoleErrors()).toEqual([]);

  // Restarted so afterAll's close finds a live server either way.
  stub = await startStub();
});
