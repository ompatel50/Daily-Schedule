import { NextResponse, type NextRequest } from "next/server";

import { isAssistantMode, requestPreviewOf, type AssistantMode } from "@/lib/logic/assistant";
import { scheduleSettingsFor } from "@/server/schedule";
import { assistantChatSchema } from "@/lib/validation";
import { writeAuditEntry } from "@/server/ai/audit";
import { runAssistantExchange, type EngineEvent } from "@/server/ai/engine";
import { getCurrentUser } from "@/server/auth/current-user";
import { logRedactedError } from "@/server/safe-error";

/**
 * The assistant exchange endpoint: one user message in, newline-delimited
 * JSON events out (status, tokens, tool activity, proposals, done/error).
 *
 * A route handler rather than a server action because the answer streams —
 * a modest local model producing a paragraph can take a while, and the user
 * should watch it arrive. Everything model-related happens server-side
 * against the user's own Ollama server; the browser only ever talks to this
 * same-origin route (the app's CSP forbids anything else).
 *
 * Auth is the first statement, and the user, their settings and their mode
 * are resolved HERE, from the session and the database row — never from the
 * request body. The model cannot choose who it acts as or how much it may do.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel-only ceiling (Hobby allows at most 60; self-hosted has no limit).
// Held to tests/deploy-config.test.ts like every other route.
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const parsed = assistantChatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const baseUrl = user.assistantBaseUrl;
  const model = user.assistantModel;
  if (!baseUrl || !model) {
    return NextResponse.json(
      {
        ok: false,
        error: "The assistant is not set up. Add your Ollama server and pick a model in Settings.",
      },
      { status: 409 },
    );
  }
  const mode: AssistantMode = isAssistantMode(user.assistantMode) ? user.assistantMode : "readonly";
  const settings = scheduleSettingsFor(user);
  const { message, history } = parsed.data;
  const started = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: EngineEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const result = await runAssistantExchange({
          user,
          settings,
          mode,
          baseUrl,
          model,
          message,
          history,
          signal: request.signal,
          emit,
        });

        await writeAuditEntry({
          userId: user.id,
          kind: "chat",
          status: result.status === "ok" ? "ok" : "error",
          summary:
            result.status === "ok"
              ? `Answered${result.toolCalls.length ? ` using ${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? "" : "s"}` : ""}${result.proposals.length ? `, proposed ${result.proposals.length} action${result.proposals.length === 1 ? "" : "s"}` : ""}`
              : (result.error ?? "The exchange failed."),
          requestPreview: requestPreviewOf(message),
          toolCalls: result.toolCalls,
          model,
          durationMs: result.durationMs,
        });
      } catch (error) {
        const reference = logRedactedError("assistant-chat", error);
        emit({
          type: "error",
          message: `The assistant hit an unexpected problem (reference ${reference}).`,
        });
        await writeAuditEntry({
          userId: user.id,
          kind: "chat",
          status: "error",
          summary: `Exchange crashed (reference ${reference})`,
          requestPreview: requestPreviewOf(message),
          model,
          durationMs: Date.now() - started,
        }).catch(() => {});
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
