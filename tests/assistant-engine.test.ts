import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASSISTANT_LIMITS, type AssistantStreamEvent } from "@/lib/logic/assistant";
import type { ScheduleSettings } from "@/lib/logic/schedule";
import type { CurrentUser } from "@/server/auth/current-user";

/**
 * The exchange engine's loop mechanics, with the tool registry mocked and the
 * Ollama transport running against a scripted fake server. What is under test
 * is exactly the orchestration: tool rounds, caps, result feedback, event
 * order, and the guarantee that the last round withholds tools so the model
 * must answer.
 */

const runToolMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const toolsForModeMock = vi.fn<(...args: unknown[]) => unknown>(() => [
  {
    name: "search_records",
    description: "search",
    parameters: { type: "object", properties: {} },
    validate: {},
    run: async () => ({ ok: true, result: {} }),
  },
]);

vi.mock("@/server/ai/tools", () => ({
  runTool: (...args: unknown[]) => runToolMock(...args),
  toolsForMode: (...args: unknown[]) => toolsForModeMock(...args),
  serializeToolResult: (outcome: { result: unknown }) => JSON.stringify(outcome.result),
}));

const { runAssistantExchange, internals } = await import("@/server/ai/engine");

const user = {
  id: "user-1",
  name: "Alice",
  timezone: "America/New_York",
  unitSystem: "imperial",
  weekStartsOn: 1,
} as unknown as CurrentUser;

const settings: ScheduleSettings = {
  weekStartsOn: 1,
  timezone: "America/New_York",
  today: "2026-08-01",
};

/** Script the fake Ollama: one entry per /api/chat POST, in order. */
type ChatScript = (body: {
  messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_name?: string }>;
  tools?: unknown[];
}) => unknown[];

let chatBodies: Array<{
  messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_name?: string }>;
  tools?: unknown[];
}> = [];

function scriptOllama(...scripts: ChatScript[]) {
  let call = 0;
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (typeof chatBodies)[number];
      chatBodies.push(body);
      const script = scripts[Math.min(call, scripts.length - 1)];
      call += 1;
      const lines = script(body);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream, headers: { get: () => null } } as unknown as Response;
    }),
  );
}

async function run(message = "hello") {
  const events: AssistantStreamEvent[] = [];
  const result = await runAssistantExchange({
    user,
    settings,
    mode: "confirm",
    baseUrl: "http://localhost:11434",
    model: "test-model",
    message,
    history: [],
    emit: (event) => {
      events.push(event);
    },
  });
  return { events, result };
}

beforeEach(() => {
  chatBodies = [];
  runToolMock.mockReset();
  runToolMock.mockResolvedValue({ ok: true, result: { fine: true } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a direct answer", () => {
  it("streams tokens and finishes with done", async () => {
    scriptOllama(() => [
      { message: { role: "assistant", content: "All " } },
      { message: { role: "assistant", content: "good." } },
    ]);
    const { events, result } = await run();

    expect(result.status).toBe("ok");
    expect(result.content).toBe("All good.");
    expect(result.toolCalls).toEqual([]);
    expect(events.filter((event) => event.type === "token").map((event) => (event as { text: string }).text)).toEqual([
      "All ",
      "good.",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", content: "All good." });
  });
});

describe("a tool round", () => {
  it("runs the requested tool and feeds the result back", async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { hits: [{ title: "Rent" }] } });
    scriptOllama(
      () => [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "search_records", arguments: { query: "rent" } } }],
          },
        },
      ],
      () => [{ message: { role: "assistant", content: "Found your rent bill." } }],
    );

    const { events, result } = await run("find rent");

    expect(runToolMock).toHaveBeenCalledTimes(1);
    expect(runToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "confirm", user }),
      "search_records",
      { query: "rent" },
    );
    expect(result.status).toBe("ok");
    expect(result.content).toBe("Found your rent bill.");
    expect(result.toolCalls).toEqual([{ tool: "search_records", args: { query: "rent" } }]);

    // The second request carries the assistant's tool_calls message and the
    // tool result, in that order.
    const second = chatBodies[1].messages;
    const toolMessage = second.at(-1);
    expect(toolMessage).toMatchObject({
      role: "tool",
      tool_name: "search_records",
      content: JSON.stringify({ hits: [{ title: "Rent" }] }),
    });
    expect(second.at(-2)).toMatchObject({ role: "assistant" });

    const types = events.map((event) => event.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types.indexOf("tool_start")).toBeLessThan(types.indexOf("done"));
  });

  it("emits proposals the tool layer stages", async () => {
    const proposal = { id: "p1", kind: "create_task", summary: "Create task", risk: "normal" };
    runToolMock.mockResolvedValue({ ok: true, result: { proposed: true }, proposal });
    scriptOllama(
      () => [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "propose_action", arguments: { kind: "create_task", payload: {} } } },
            ],
          },
        },
      ],
      () => [{ message: { role: "assistant", content: "Proposed it." } }],
    );

    const { events, result } = await run("add a task");
    expect(result.proposals).toEqual([proposal]);
    expect(events.some((event) => event.type === "proposal")).toBe(true);
  });

  it("honours at most the per-round cap and refuses the rest in-band", async () => {
    const calls = Array.from({ length: 7 }, (_, index) => ({
      function: { name: "search_records", arguments: { query: `q${index}` } },
    }));
    scriptOllama(
      () => [{ message: { role: "assistant", content: "", tool_calls: calls } }],
      () => [{ message: { role: "assistant", content: "done" } }],
    );

    await run("many");
    expect(runToolMock).toHaveBeenCalledTimes(ASSISTANT_LIMITS.maxToolCallsPerRound);
    const toolMessages = chatBodies[1].messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(7);
    expect(toolMessages.at(-1)?.content).toContain("was not run");
  });
});

describe("the round cap", () => {
  it("withholds tools on the last round, so the model must answer", async () => {
    scriptOllama((body) =>
      body.tools
        ? [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "search_records", arguments: {} } }],
              },
            },
          ]
        : [{ message: { role: "assistant", content: "Best effort answer." } }],
    );

    const { result } = await run("loop forever");
    expect(result.status).toBe("ok");
    expect(result.content).toBe("Best effort answer.");
    // maxToolRounds requests carried tools; the final one did not.
    expect(chatBodies).toHaveLength(ASSISTANT_LIMITS.maxToolRounds + 1);
    expect(chatBodies.at(-1)?.tools).toBeUndefined();
    expect(runToolMock).toHaveBeenCalledTimes(
      ASSISTANT_LIMITS.maxToolRounds * 1,
    );
  });
});

describe("failure", () => {
  it("phrases a dead Ollama as an error event, not an exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { events, result } = await run();
    expect(result.status).toBe("error");
    expect(result.error).toBe("Could not reach the Ollama server. Is it running?");
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("context assembly", () => {
  it("bounds the history by count and by message length", () => {
    const long = "x".repeat(ASSISTANT_LIMITS.maxHistoryChars + 500);
    const many = Array.from({ length: 30 }, (_, index) => ({
      role: "user" as const,
      content: index === 29 ? long : `m${index}`,
    }));
    const bounded = internals.boundedHistory(many);
    expect(bounded).toHaveLength(ASSISTANT_LIMITS.maxHistoryMessages);
    expect(bounded.at(-1)?.content.length).toBeLessThanOrEqual(
      ASSISTANT_LIMITS.maxHistoryChars + 1,
    );
  });

  it("tells the model the user's real today, timezone and mode", () => {
    const prompt = internals.systemPrompt(user, settings, "readonly");
    expect(prompt).toContain("2026-08-01");
    expect(prompt).toContain("America/New_York");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("non-judgemental");

    const confirm = internals.systemPrompt(user, settings, "confirm");
    expect(confirm).toContain("Never claim a change happened");
  });
});
