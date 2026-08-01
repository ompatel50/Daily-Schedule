import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatOllama,
  getOllamaStatus,
  listOllamaModels,
  normalizeOllamaBaseUrl,
  pingOllama,
  streamOllamaChat,
} from "@/server/ai/ollama";
import { classifyThrown } from "@/server/ai/types";

/**
 * The Ollama client against mocked responses. Nothing here touches a live
 * server — a suite that needs Ollama running is a suite that fails for
 * reasons unrelated to the code. The wire itself is asserted: every request
 * goes to the configured host and nowhere else, carries no cookies and no
 * referrer, and no failure message ever echoes the URL. That is the
 * "Ollama-only, no cloud" guarantee as tests rather than as a promise.
 */

const BASE = "http://localhost:11434";

interface Captured {
  url: string;
  method: string;
  body: unknown;
  init: RequestInit | undefined;
}

let captured: Captured[] = [];

function jsonResponse(handler: (url: string, body: unknown) => { status?: number; json?: unknown }) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    captured.push({ url, method: init?.method ?? "GET", body, init });
    const response = handler(url, body);
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => response.json ?? {},
    } as unknown as Response;
  });
}

function ndjsonResponse(lines: unknown[]) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      init,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        controller.close();
      },
    });
    return { ok: true, status: 200, body: stream, headers: { get: () => null } } as unknown as Response;
  });
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Base-URL validation
// ---------------------------------------------------------------------------

describe("normalizeOllamaBaseUrl", () => {
  it("accepts localhost and LAN addresses — that is the designed use", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434")).toEqual({
      ok: true,
      url: "http://localhost:11434",
    });
    expect(normalizeOllamaBaseUrl("http://192.168.1.20:11434").ok).toBe(true);
    expect(normalizeOllamaBaseUrl("http://10.0.0.5:11434").ok).toBe(true);
    expect(normalizeOllamaBaseUrl("https://ollama.my-home.example").ok).toBe(true);
  });

  it("strips trailing slashes and surrounding whitespace", () => {
    expect(normalizeOllamaBaseUrl("  http://localhost:11434//  ")).toEqual({
      ok: true,
      url: "http://localhost:11434",
    });
  });

  it("refuses anything that is not plain http(s)", () => {
    expect(normalizeOllamaBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("ftp://host").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("not a url").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("").ok).toBe(false);
  });

  it("refuses embedded credentials, query strings and fragments", () => {
    expect(normalizeOllamaBaseUrl("http://user:pass@localhost:11434").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("http://localhost:11434?x=1").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("http://localhost:11434#frag").ok).toBe(false);
  });

  it("refuses cloud metadata endpoints on every platform", () => {
    expect(normalizeOllamaBaseUrl("http://169.254.169.254").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("http://169.254.170.2:80").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("http://metadata.google.internal").ok).toBe(false);
    expect(normalizeOllamaBaseUrl("http://metadata").ok).toBe(false);
  });

  it("refuses an unreasonably long URL", () => {
    expect(normalizeOllamaBaseUrl(`http://${"a".repeat(300)}.example`).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status: ping + models
// ---------------------------------------------------------------------------

describe("pingOllama / listOllamaModels / getOllamaStatus", () => {
  it("reads the version and the model list from the configured host only", async () => {
    vi.stubGlobal(
      "fetch",
      jsonResponse((url) =>
        url.endsWith("/api/version")
          ? { json: { version: "0.5.1" } }
          : {
              json: {
                models: [
                  { name: "zeta", size: 100, details: { parameter_size: "8.0B" } },
                  { name: "alpha", size: 200 },
                  { junk: true },
                ],
              },
            },
      ),
    );

    const status = await getOllamaStatus(BASE);
    expect(status).toEqual({
      ok: true,
      data: {
        version: "0.5.1",
        models: [
          { name: "alpha", size: 200, parameterSize: null },
          { name: "zeta", size: 100, parameterSize: "8.0B" },
        ],
      },
    });

    for (const request of captured) {
      expect(request.url.startsWith(`${BASE}/`)).toBe(true);
      expect(request.init?.cache).toBe("no-store");
      expect(request.init?.referrerPolicy).toBe("no-referrer");
      expect(request.init?.credentials).toBeUndefined();
    }
  });

  it("makes no request at all for an invalid base URL", async () => {
    const fetchMock = jsonResponse(() => ({ json: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pingOllama("http://user:pass@localhost:11434");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("phrases a dead server as unavailable, without echoing the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await pingOllama(BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("unavailable");
      expect(result.failure.message).not.toContain("11434");
      expect(result.failure.message).not.toContain("http");
    }
  });

  it("maps an abort to timeout, distinctly from an outage", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(classifyThrown(abort).reason).toBe("timeout");
    expect(classifyThrown(new TypeError("fetch failed")).reason).toBe("unavailable");
  });

  it("survives a malformed model list", async () => {
    vi.stubGlobal("fetch", jsonResponse(() => ({ json: { models: "nope" } })));
    const result = await listOllamaModels(BASE);
    expect(result).toEqual({ ok: true, data: [] });
  });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

describe("chatOllama", () => {
  it("POSTs the conversation non-streaming and returns the reply", async () => {
    vi.stubGlobal(
      "fetch",
      jsonResponse(() => ({
        json: { message: { role: "assistant", content: "Hello there" } },
      })),
    );
    const result = await chatOllama({
      baseUrl: BASE,
      model: "llama3.1",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.message.content).toBe("Hello there");

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`${BASE}/api/chat`);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].body).toMatchObject({
      model: "llama3.1",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("passes Ollama's own phrased error through, bounded and URL-free", async () => {
    vi.stubGlobal(
      "fetch",
      jsonResponse(() => ({ status: 404, json: { error: 'model "nope" not found' } })),
    );
    const result = await chatOllama({
      baseUrl: BASE,
      model: "nope",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("bad_response");
      expect(result.failure.message).toBe('Ollama: model "nope" not found');
    }
  });

  it("refuses an upstream error phrase that carries a URL", async () => {
    vi.stubGlobal(
      "fetch",
      jsonResponse(() => ({ status: 500, json: { error: "see http://internal/debug" } })),
    );
    const result = await chatOllama({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toBe("The Ollama server returned an error (HTTP 500).");
    }
  });

  it("treats a reply with no readable message as bad_response", async () => {
    vi.stubGlobal("fetch", jsonResponse(() => ({ json: { message: {} } })));
    const result = await chatOllama({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("bad_response");
  });
});

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

describe("streamOllamaChat", () => {
  it("delivers tokens in order and resolves with the full text", async () => {
    vi.stubGlobal(
      "fetch",
      ndjsonResponse([
        { message: { role: "assistant", content: "Hel" } },
        { message: { role: "assistant", content: "lo" } },
        { message: { role: "assistant", content: "" }, done: true },
      ]),
    );
    const tokens: string[] = [];
    const result = await streamOllamaChat({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onToken: (token) => {
        tokens.push(token);
      },
    });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ ok: true, data: { content: "Hello", toolCalls: [] } });
    expect(captured[0].body).toMatchObject({ stream: true });
  });

  it("collects tool calls the model streams", async () => {
    vi.stubGlobal(
      "fetch",
      ndjsonResponse([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "search_records", arguments: { query: "rent" } } }],
          },
        },
        { done: true },
      ]),
    );
    const result = await streamOllamaChat({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "find rent" }],
      onToken: () => {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.toolCalls).toHaveLength(1);
      expect(result.data.toolCalls[0].function.name).toBe("search_records");
    }
  });

  it("surfaces a mid-stream error as bad_response", async () => {
    vi.stubGlobal(
      "fetch",
      ndjsonResponse([{ message: { role: "assistant", content: "ok so" } }, { error: "boom" }]),
    );
    const result = await streamOllamaChat({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("bad_response");
  });

  it("skips malformed NDJSON lines rather than dying on them", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("not json\n"));
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ message: { content: "fine" } })}\n`),
            );
            controller.close();
          },
        });
        return { ok: true, status: 200, body: stream, headers: { get: () => null } } as unknown as Response;
      }),
    );
    const result = await streamOllamaChat({
      baseUrl: BASE,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.content).toBe("fine");
  });
});

// ---------------------------------------------------------------------------
// No cloud, structurally
// ---------------------------------------------------------------------------

describe("the Ollama-only guarantee, as structure", () => {
  const aiDir = join(process.cwd(), "src", "server", "ai");
  const sources = readdirSync(aiDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(aiDir, name), "utf8") }));

  it("reads the whole assistant server directory", () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      "audit.ts",
      "engine.ts",
      "ollama.ts",
      "proposals.ts",
      "tools.ts",
      "types.ts",
    ]);
  });

  it("never imports a raw network module — global fetch only", () => {
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(/node:https?|node:net|XMLHttpRequest|axios/);
    }
  });

  it("names no AI cloud provider host anywhere", () => {
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(
        /openai|anthropic|openrouter|mistral\.ai|googleapis|azure|bedrock|api\.groq/i,
      );
    }
  });

  it("mentions no API key — there is nothing to configure but a URL and a model", () => {
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(/api[_-]?key/i);
    }
  });
});
