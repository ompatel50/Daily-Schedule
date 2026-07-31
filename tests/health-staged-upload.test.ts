import { beforeEach, describe, expect, it } from "vitest";

import { stageHealthFile, type UploadStage } from "@/lib/health/staged-upload";

/**
 * The browser half of the staged upload, against a fake server.
 *
 * This is the layer whose failure used to be `413 FUNCTION_PAYLOAD_TOO_LARGE`:
 * the whole archive went up as one request body, and a hosting platform refused
 * it at the edge before any application code ran. What is asserted here is the
 * property that replaced it — **no request ever carries more than one part** —
 * plus the retry, ordering, bounding and cancellation rules that make an upload
 * of a hundred parts survive a real network.
 *
 * Deterministic by construction: the fake server is a plain function, retry
 * backoff is injected as a no-op, and nothing here touches a clock, a socket or
 * a database.
 */

const PART_BYTES = 1024;

interface FakeServer {
  /** Every request the client made, in order, as (method, path). */
  calls: Array<{ method: string; url: string; bytes: number }>;
  /** Parts the server accepted, by index. */
  parts: Map<number, Uint8Array>;
  deleted: string[];
  fetch: typeof fetch;
}

interface ServerOptions {
  partBytes?: number;
  /** Return a status to fail this attempt with, or null to accept it. */
  failPart?: (seq: number, attempt: number) => number | null;
  /** Fail the finalize call with this message. */
  finalizeError?: { status: number; error: string };
  /** Refuse to open with this status/error. */
  openError?: { status: number; error: string };
  /** Answer with non-JSON (a platform rejection) for this path fragment. */
  rawRejection?: { path: string; status: number };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeServer(options: ServerOptions = {}): FakeServer {
  const partBytes = options.partBytes ?? PART_BYTES;
  const parts = new Map<number, Uint8Array>();
  const calls: FakeServer["calls"] = [];
  const deleted: string[] = [];
  const attempts = new Map<number, number>();
  let totalParts = 0;

  const call: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body;
    const bytes =
      body instanceof Blob
        ? body.size
        : typeof body === "string"
          ? new TextEncoder().encode(body).length
          : 0;
    calls.push({ method, url, bytes });

    if (options.rawRejection && url.includes(options.rawRejection.path)) {
      return new Response("<html>Request Entity Too Large</html>", {
        status: options.rawRejection.status,
        headers: { "content-type": "text/html" },
      });
    }

    if (method === "POST" && url === "/api/health/import") {
      if (options.openError) {
        return json({ ok: false, error: options.openError.error }, options.openError.status);
      }
      const parsed = JSON.parse(String(body)) as { fileSize: number; fileName: string };
      totalParts = Math.ceil(parsed.fileSize / partBytes);
      return json({ ok: true, uploadId: "up_1", partBytes, totalParts });
    }

    if (method === "DELETE" && url.startsWith("/api/health/import?")) {
      deleted.push(new URL(url, "http://localhost").searchParams.get("upload") ?? "");
      return json({ ok: true });
    }

    if (method === "PUT" && url.startsWith("/api/health/import/part")) {
      const parameters = new URL(url, "http://localhost").searchParams;
      const seq = Number(parameters.get("seq"));
      const attempt = (attempts.get(seq) ?? 0) + 1;
      attempts.set(seq, attempt);

      const failure = options.failPart?.(seq, attempt) ?? null;
      if (failure !== null) return json({ ok: false, error: `part ${seq} refused` }, failure);

      if (!(body instanceof Blob)) throw new Error("a part must be sent as raw bytes");
      parts.set(seq, new Uint8Array(await body.arrayBuffer()));
      return json({ ok: true, receivedParts: parts.size, totalParts, receivedBytes: 0 });
    }

    if (method === "POST" && url === "/api/health/import/finalize") {
      if (options.finalizeError) {
        return json({ ok: false, error: options.finalizeError.error }, options.finalizeError.status);
      }
      return json({ ok: true, preview: { token: "tok_1", fileName: "export.zip" } });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  };

  return { calls, parts, deleted, fetch: call };
}

/** A file whose every byte encodes its own offset, so order is checkable. */
function makeFile(size: number, name = "export.zip"): File {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return new File([bytes], name, { type: "application/zip" });
}

function reassemble(parts: Map<number, Uint8Array>): Uint8Array {
  const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, data]) => data);
  const total = ordered.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of ordered) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const noSleep = async () => {};

let server: FakeServer;

beforeEach(() => {
  server = fakeServer();
});

describe("a large file never travels as one request", () => {
  it("slices it into parts and sends one request each", async () => {
    const file = makeFile(PART_BYTES * 10 + 17);
    const result = await stageHealthFile(file, { fetchImpl: server.fetch, sleepImpl: noSleep });

    expect(result.ok).toBe(true);
    expect(server.parts.size).toBe(11);
    const puts = server.calls.filter((entry) => entry.method === "PUT");
    expect(puts).toHaveLength(11);
  });

  it("never puts more than one part's worth of bytes in a single request", async () => {
    const file = makeFile(PART_BYTES * 40 + 3);
    await stageHealthFile(file, { fetchImpl: server.fetch, sleepImpl: noSleep });

    // The invariant the whole design exists for. A platform's request cap is
    // enforced at the edge, so this is the only place it can be honoured.
    for (const entry of server.calls) {
      expect(entry.bytes, `${entry.method} ${entry.url}`).toBeLessThanOrEqual(PART_BYTES);
    }
  });

  it("reassembles to exactly the bytes that were chosen, in order", async () => {
    const file = makeFile(PART_BYTES * 7 + 511);
    await stageHealthFile(file, { fetchImpl: server.fetch, sleepImpl: noSleep });

    const rebuilt = reassemble(server.parts);
    const original = new Uint8Array(await file.arrayBuffer());
    expect(rebuilt.length).toBe(original.length);
    expect(Buffer.from(rebuilt).equals(Buffer.from(original))).toBe(true);
  });

  it("handles a file that fits in a single part", async () => {
    const file = makeFile(12, "readings.csv");
    const result = await stageHealthFile(file, { fetchImpl: server.fetch, sleepImpl: noSleep });

    expect(result.ok).toBe(true);
    expect(server.parts.size).toBe(1);
    expect(server.parts.get(0)?.length).toBe(12);
  });
});

describe("progress and stages", () => {
  it("reports the stages in order, ending at the preview", async () => {
    const stages: UploadStage[] = [];
    await stageHealthFile(makeFile(PART_BYTES * 3), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
      onProgress: (progress) => {
        if (stages[stages.length - 1] !== progress.stage) stages.push(progress.stage);
      },
    });

    expect(stages).toEqual(["preparing", "uploading", "parsing", "preview"]);
  });

  it("reports monotonically increasing bytes, ending at the file's size", async () => {
    const size = PART_BYTES * 6 + 100;
    const sent: number[] = [];
    await stageHealthFile(makeFile(size), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
      onProgress: (progress) => {
        if (progress.stage === "uploading") sent.push(progress.sent);
      },
    });

    expect(sent.length).toBeGreaterThan(1);
    for (let index = 1; index < sent.length; index += 1) {
      expect(sent[index]).toBeGreaterThanOrEqual(sent[index - 1]);
    }
    expect(sent[sent.length - 1]).toBe(size);
  });
});

describe("failures", () => {
  it("retries a part the server failed transiently, and still succeeds", async () => {
    // Part 2 fails twice with a 500, then works — a flaky connection, not a
    // decision. The retry is safe because (session, index) is unique server-side.
    server = fakeServer({ failPart: (seq, attempt) => (seq === 2 && attempt <= 2 ? 500 : null) });
    const result = await stageHealthFile(makeFile(PART_BYTES * 4), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(server.parts.size).toBe(4);
    expect(server.calls.filter((entry) => entry.url.includes("seq=2"))).toHaveLength(3);
  });

  it("does not retry a refusal the server meant, and reports its message", async () => {
    server = fakeServer({ failPart: (seq) => (seq === 1 ? 413 : null) });
    const result = await stageHealthFile(makeFile(PART_BYTES * 4), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("part 1 refused");
    // One attempt only: retrying a decision just delays telling the user.
    expect(server.calls.filter((entry) => entry.url.includes("seq=1"))).toHaveLength(1);
  });

  it("gives up after exhausting its attempts on a part", async () => {
    server = fakeServer({ failPart: (seq) => (seq === 0 ? 500 : null) });
    const result = await stageHealthFile(makeFile(PART_BYTES * 2), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    expect(result.ok).toBe(false);
    expect(server.calls.filter((entry) => entry.url.includes("seq=0"))).toHaveLength(4);
  });

  it("abandons the server-side session when a part finally fails", async () => {
    server = fakeServer({ failPart: (seq) => (seq === 0 ? 500 : null) });
    await stageHealthFile(makeFile(PART_BYTES * 2), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    // The staged parts are dropped now rather than left to expire.
    expect(server.deleted).toContain("up_1");
  });

  it("sends the abandon request with keepalive, so a closing tab still frees its slot", async () => {
    // Without `keepalive` the browser cancels this the instant the document
    // goes away, and the account keeps paying for an upload slot it is not
    // using — which is exactly what was observed in a browser before this.
    const options: Array<RequestInit | undefined> = [];
    const recording = fakeServer({ failPart: (seq) => (seq === 0 ? 500 : null) });
    const capture: typeof fetch = (input, init) => {
      if (init?.method === "DELETE") options.push(init);
      return recording.fetch(input, init);
    };

    await stageHealthFile(makeFile(PART_BYTES), { fetchImpl: capture, sleepImpl: noSleep });

    expect(options).toHaveLength(1);
    expect(options[0]?.keepalive).toBe(true);
  });

  it("surfaces a refusal to open the upload without sending a single part", async () => {
    server = fakeServer({ openError: { status: 413, error: "That file is larger than…" } });
    const result = await stageHealthFile(makeFile(PART_BYTES * 50), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("That file is larger than…");
    expect(server.calls.filter((entry) => entry.method === "PUT")).toHaveLength(0);
  });

  it("surfaces a parse failure from the finalize step", async () => {
    server = fakeServer({
      finalizeError: { status: 400, error: "The archive has no export.xml…" },
    });
    const result = await stageHealthFile(makeFile(PART_BYTES * 2), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("The archive has no export.xml…");
  });

  it("reads a platform rejection that is not JSON, rather than reporting nothing useful", async () => {
    // The exact shape of the bug this change fixes: a gateway answers 413 with
    // HTML. The old client called .json() unguarded and reported a generic
    // "the upload did not complete", which is what made it so hard to diagnose.
    server = fakeServer({ rawRejection: { path: "/part", status: 413 } });
    const result = await stageHealthFile(makeFile(PART_BYTES * 2), {
      fetchImpl: server.fetch,
      sleepImpl: noSleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/too large/i);
  });
});

describe("cancellation", () => {
  it("stops uploading and abandons the session", async () => {
    const controller = new AbortController();
    const slowServer = fakeServer();
    const withAbort: typeof fetch = async (input, init) => {
      // Cancel once the first part is on its way, which is when a real user
      // presses the button.
      if (String(input).includes("/part")) controller.abort();
      return slowServer.fetch(input, init);
    };

    const result = await stageHealthFile(makeFile(PART_BYTES * 20), {
      fetchImpl: withAbort,
      sleepImpl: noSleep,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.cancelled).toBe(true);
    expect(slowServer.deleted).toContain("up_1");
    // It stopped early rather than uploading all twenty parts anyway.
    expect(slowServer.calls.filter((entry) => entry.method === "PUT").length).toBeLessThan(20);
  });
});
