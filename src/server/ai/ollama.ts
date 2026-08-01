import "server-only";

import {
  classifyThrown,
  failure,
  ok,
  type AiOutcome,
} from "@/server/ai/types";

/**
 * The Ollama client — the assistant's ONLY way to reach a model.
 *
 * Everything here talks to the one base URL the user configured in Settings:
 * their own Ollama server, on their own machine or their own network. There is
 * no cloud provider, no fallback endpoint, no API key, and no other host name
 * anywhere in this module — `ollamaUrl` below is the single place request URLs
 * are built, from the stored base URL and a fixed path. Tests assert both
 * structurally (no other hosts in this directory) and at runtime (a stubbed
 * fetch only ever sees the configured host).
 *
 * What travels to that server is exactly what the assistant needs to answer:
 * the conversation, the tool schemas, and tool results. It goes to hardware
 * the user controls, which is the entire privacy story — and why this module
 * must never grow a second destination.
 *
 * Every path returns an outcome union rather than throwing, in the app's
 * provider style (src/server/providers): a dead Ollama is a calm, phrased
 * state for the UI, not an exception. Error messages never echo the base URL
 * (deployment topology does not belong in toasts or logs) and never echo
 * response bodies.
 */

/** Everything the connection test and settings page need in one round. */
export interface OllamaStatus {
  version: string;
  models: OllamaModel[];
}

export interface OllamaModel {
  name: string;
  /** Size on disk in bytes, when the server reported it. */
  size: number | null;
  /** Parameter scale like "8.0B", when the server reported it. */
  parameterSize: string | null;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that requested tools. */
  tool_calls?: OllamaToolCall[];
  /** Present on tool messages: which tool produced this content. */
  tool_name?: string;
}

export interface OllamaToolCall {
  function: {
    name: string;
    /** Ollama sends parsed JSON objects, not strings. */
    arguments: Record<string, unknown>;
  };
}

/** A tool schema in the shape Ollama's /api/chat expects. */
export interface OllamaToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatResult {
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
}

/** Short — the settings page must never hang on a dead host. */
const STATUS_TIMEOUT_MS = 5_000;
/**
 * Long — a modest local model legitimately thinks for a while. The chat API
 * route's own `maxDuration` bounds the hosted worst case; self-hosted runs
 * are bounded by this alone.
 */
const CHAT_TIMEOUT_MS = 120_000;

/**
 * Base-URL validation, shared by the settings action and every request.
 *
 * The server fetches whatever host is stored here, so the URL is checked at
 * write AND use: http/https only, no embedded credentials, and never a cloud
 * metadata endpoint (the one class of internal address that is dangerous on
 * every hosting platform). Private LAN addresses are deliberately allowed —
 * "Ollama on the iMac across the room" is the designed use.
 */
export function normalizeOllamaBaseUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, error: "Enter the Ollama server URL." };
  if (trimmed.length > 200) return { ok: false, error: "That URL is too long." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That is not a valid URL. Try http://localhost:11434." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "The Ollama URL must start with http:// or https://." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "The Ollama URL must not contain credentials." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "The Ollama URL should be just the host — no query or fragment." };
  }

  const host = parsed.hostname.toLowerCase();
  // Cloud metadata endpoints — refused whatever the deployment, because a
  // request there returns platform credentials, not a model.
  const linkLocal = /^169\.254\.\d{1,3}\.\d{1,3}$/;
  const metadataHosts = new Set(["metadata.google.internal", "metadata", "fd00:ec2::254"]);
  if (linkLocal.test(host) || metadataHosts.has(host.replace(/^\[|\]$/g, ""))) {
    return { ok: false, error: "That address is not an Ollama server." };
  }

  return { ok: true, url: trimmed };
}

/**
 * THE url builder — every request URL in this module comes from here, which is
 * what makes "no other destination" a checkable property rather than a hope.
 */
function ollamaUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

interface RequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  body?: unknown;
}

async function request<T>(
  baseUrl: string,
  path: string,
  { timeoutMs, signal, body }: RequestOptions,
): Promise<AiOutcome<T>> {
  const checked = normalizeOllamaBaseUrl(baseUrl);
  if (!checked.ok) return failure("not_configured", checked.error);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(ollamaUrl(checked.url, path), {
      method: body === undefined ? "GET" : "POST",
      signal: controller.signal,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Nothing about the request context travels: no cookies, no referrer.
      cache: "no-store",
      referrerPolicy: "no-referrer",
      // A redirect is never a legitimate Ollama reply, and following one
      // would take the request to a host the user never configured — the one
      // way the validated base URL could stop being the only destination.
      redirect: "error",
    });

    if (!response.ok) {
      // Ollama phrases real causes in an { error } body — "model not found",
      // "does not support tools". Those are safe and useful; pass the
      // *phrase* through bounded, never the raw body wholesale.
      const detail = await readErrorDetail(response);
      return failure(
        response.status === 404 ? "bad_response" : "unavailable",
        detail ?? `The Ollama server returned an error (HTTP ${response.status}).`,
      );
    }

    const json = (await response.json().catch(() => null)) as T | null;
    if (json === null) {
      return failure("bad_response", "The Ollama server sent a response that could not be read.");
    }
    return ok(json);
  } catch (error) {
    return { ok: false, failure: classifyThrown(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Extract Ollama's own error phrase, bounded and stripped of anything that
 * looks like a URL — the message reaches toasts and the audit log.
 */
async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error.trim() : "";
    if (!message || message.length > 300 || /https?:\/\//i.test(message)) return null;
    return `Ollama: ${message}`;
  } catch {
    return null;
  }
}

/** GET /api/version — "is anything listening there at all?" */
export async function pingOllama(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<AiOutcome<{ version: string }>> {
  const result = await request<{ version?: unknown }>(baseUrl, "/api/version", {
    timeoutMs: STATUS_TIMEOUT_MS,
    signal,
  });
  if (!result.ok) return result;
  const version = typeof result.data.version === "string" ? result.data.version : "unknown";
  return ok({ version });
}

/** GET /api/tags — the models available to pick from. */
export async function listOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<AiOutcome<OllamaModel[]>> {
  const result = await request<{ models?: unknown }>(baseUrl, "/api/tags", {
    timeoutMs: STATUS_TIMEOUT_MS,
    signal,
  });
  if (!result.ok) return result;

  const rows = Array.isArray(result.data.models) ? result.data.models : [];
  const models: OllamaModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = (row as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    const size = (row as { size?: unknown }).size;
    const details = (row as { details?: { parameter_size?: unknown } }).details;
    models.push({
      name,
      size: typeof size === "number" && Number.isFinite(size) ? size : null,
      parameterSize:
        typeof details?.parameter_size === "string" ? details.parameter_size : null,
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return ok(models);
}

/** Version + models in one round — what the connection test shows. */
export async function getOllamaStatus(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<AiOutcome<OllamaStatus>> {
  const ping = await pingOllama(baseUrl, signal);
  if (!ping.ok) return ping;
  const models = await listOllamaModels(baseUrl, signal);
  if (!models.ok) return models;
  return ok({ version: ping.data.version, models: models.data });
}

/**
 * POST /api/chat, non-streaming — one model turn, possibly requesting tools.
 * The engine (src/server/ai/engine.ts) loops this for tool rounds and uses
 * the streaming variant for the final answer.
 */
export async function chatOllama(
  options: {
    baseUrl: string;
    model: string;
    messages: OllamaChatMessage[];
    tools?: OllamaToolSchema[];
    signal?: AbortSignal;
  },
): Promise<AiOutcome<OllamaChatResult>> {
  const result = await request<OllamaChatResult>(options.baseUrl, "/api/chat", {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: options.signal,
    body: {
      model: options.model,
      messages: options.messages,
      tools: options.tools && options.tools.length > 0 ? options.tools : undefined,
      stream: false,
    },
  });
  if (!result.ok) return result;
  if (!result.data || typeof result.data.message?.content !== "string") {
    return failure("bad_response", "The model's reply could not be read.");
  }
  return ok(result.data);
}

/**
 * POST /api/chat, streaming — the final answer, token by token.
 *
 * Calls `onToken` for each content fragment and resolves with the full text.
 * Tool calls are not expected here (the engine only streams once it wants
 * prose), but if the model requests one anyway it is surfaced so the engine
 * can run one more round rather than losing the request.
 */
export async function streamOllamaChat(
  options: {
    baseUrl: string;
    model: string;
    messages: OllamaChatMessage[];
    tools?: OllamaToolSchema[];
    signal?: AbortSignal;
    onToken: (token: string) => void | Promise<void>;
  },
): Promise<AiOutcome<{ content: string; toolCalls: OllamaToolCall[] }>> {
  const checked = normalizeOllamaBaseUrl(options.baseUrl);
  if (!checked.ok) return failure("not_configured", checked.error);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(ollamaUrl(checked.url, "/api/chat"), {
      method: "POST",
      signal: controller.signal,
      headers: { accept: "application/x-ndjson", "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        tools: options.tools && options.tools.length > 0 ? options.tools : undefined,
        stream: true,
      }),
      cache: "no-store",
      referrerPolicy: "no-referrer",
      // A redirect is never a legitimate Ollama reply, and following one
      // would take the request to a host the user never configured — the one
      // way the validated base URL could stop being the only destination.
      redirect: "error",
    });

    if (!response.ok || !response.body) {
      const detail = response.ok ? null : await readErrorDetail(response);
      return failure(
        "unavailable",
        detail ?? `The Ollama server returned an error (HTTP ${response.status}).`,
      );
    }

    let content = "";
    const toolCalls: OllamaToolCall[] = [];
    const decoder = new TextDecoder();
    let buffered = "";

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // NDJSON: one JSON object per line; a partial line stays buffered.
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let chunk: { message?: { content?: unknown; tool_calls?: unknown }; error?: unknown };
        try {
          chunk = JSON.parse(line) as typeof chunk;
        } catch {
          continue;
        }
        if (typeof chunk.error === "string") {
          return failure("bad_response", "The model reported an error mid-reply.");
        }
        const token = chunk.message?.content;
        if (typeof token === "string" && token) {
          content += token;
          await options.onToken(token);
        }
        const calls = chunk.message?.tool_calls;
        if (Array.isArray(calls)) {
          for (const call of calls) {
            const name = (call as OllamaToolCall)?.function?.name;
            if (typeof name === "string") toolCalls.push(call as OllamaToolCall);
          }
        }
      }
    }

    // A server that ends the stream without a trailing newline leaves the last
    // object in the buffer; flushing the decoder and parsing what remains means
    // the final token is never silently dropped.
    buffered += decoder.decode();
    const tail = buffered.trim();
    if (tail) {
      try {
        const chunk = JSON.parse(tail) as {
          message?: { content?: unknown; tool_calls?: unknown };
        };
        const token = chunk.message?.content;
        if (typeof token === "string" && token) {
          content += token;
          await options.onToken(token);
        }
        const calls = chunk.message?.tool_calls;
        if (Array.isArray(calls)) {
          for (const call of calls) {
            if (typeof (call as OllamaToolCall)?.function?.name === "string") {
              toolCalls.push(call as OllamaToolCall);
            }
          }
        }
      } catch {
        // An unterminated partial object is not recoverable; the rest stands.
      }
    }

    return ok({ content, toolCalls });
  } catch (error) {
    return { ok: false, failure: classifyThrown(error) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
