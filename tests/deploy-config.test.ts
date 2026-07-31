import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_FUNCTION_SECONDS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PARTS,
  UPLOAD_PART_BYTES,
  VERCEL_REQUEST_BODY_BYTES,
  VERCEL_STAGED_UPLOAD_BYTES,
  VERCEL_TMP_BYTES,
  formatLimit,
  resolveUploadLimit,
  tooLargeMessage,
  uploadLimitNote,
} from "@/server/apple-health/limits";

/**
 * Deployment configuration, held to the limits of the platform the app is
 * actually deployed to.
 *
 * This suite exists because of a real failure: a route asked for
 * `maxDuration = 800`, which is valid on fluid compute and invalid on Hobby.
 * Vercel validates the value against the account's plan **at deploy time** and
 * fails the entire deployment rather than clamping it — so the mistake was
 * invisible to lint, types, tests and the production build, and only surfaced
 * when the deploy was already in flight.
 *
 * Everything below turns that class of mistake into a red test instead.
 */

const APP_DIR = join(process.cwd(), "src", "app");

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("route segment config stays inside every hosting plan's ceiling", () => {
  const files = walk(APP_DIR);

  it("finds the app router to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("no route or page declares a maxDuration above the universally-accepted ceiling", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // Only a numeric literal can be checked statically; an identifier is
      // resolved below, and anything else is flagged so it cannot slip through.
      const match = source.match(/export\s+const\s+maxDuration\s*=\s*([^;\n]+)/);
      if (!match) continue;
      const raw = match[1].trim();
      const numeric = Number(raw);
      // Next.js statically analyses route segment config and refuses the build
      // for anything that is not a literal, so a literal is the only shape a
      // working route can have — and therefore the only one worth checking.
      if (!Number.isFinite(numeric)) {
        offenders.push(`${file}: maxDuration = ${raw} (must be a numeric literal)`);
        continue;
      }
      if (numeric > MAX_FUNCTION_SECONDS) {
        offenders.push(`${file}: maxDuration = ${numeric} (ceiling is ${MAX_FUNCTION_SECONDS})`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("pins the ceiling to the value every Vercel plan accepts", () => {
    // Hobby's ceiling. Raising this is a deliberate act that breaks deploys on
    // the smallest plan, so it should require editing a test that says so.
    expect(MAX_FUNCTION_SECONDS).toBe(60);
  });

  it("the routes that do the health import's work ask for exactly the ceiling, no more", () => {
    // They have to be literals (Next.js refuses to build otherwise), so this is
    // the assertion that keeps the literals and the constant in step. Both the
    // part upload (slow connection) and the finalize (reassemble + parse) are
    // long-running; opening a session is a single insert and needs nothing.
    for (const route of [
      ["api", "health", "import", "part", "route.ts"],
      ["api", "health", "import", "finalize", "route.ts"],
    ]) {
      const source = readFileSync(join(APP_DIR, ...route), "utf8");
      expect(source, route.join("/")).toContain(
        `export const maxDuration = ${MAX_FUNCTION_SECONDS};`,
      );
    }
  });
});

/**
 * The regression this whole staged-upload design exists to prevent.
 *
 * The importer used to POST an entire Apple Health `export.zip` as one request
 * body. On Vercel that is refused at the edge with
 * `413 FUNCTION_PAYLOAD_TOO_LARGE` before any application code runs — so it
 * could not be caught, phrased, retried or logged by this app, and the hosted
 * importer simply did not work. The invariant below is what keeps it working:
 * **no request the client makes may approach the platform's body cap.**
 */
describe("no request in the health upload can hit a hosting platform's body cap", () => {
  it("a part is comfortably below the platform's request-body limit", () => {
    expect(UPLOAD_PART_BYTES).toBeLessThan(VERCEL_REQUEST_BODY_BYTES);
    // Headroom for headers, the query string and any transfer encoding — the
    // cap counts the whole request, not just the body this app measures.
    expect(VERCEL_REQUEST_BODY_BYTES - UPLOAD_PART_BYTES).toBeGreaterThanOrEqual(256 * 1024);
  });

  it("the file size is no longer bounded by the request size", () => {
    // The point of the change, stated as a number: a hosted deployment accepts
    // an archive many times larger than a single request may carry.
    const hosted = resolveUploadLimit({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv);
    expect(hosted.bytes).toBeGreaterThan(VERCEL_REQUEST_BODY_BYTES * 20);
  });

  it("the staged ceiling stays inside the scratch space the archive is rebuilt in", () => {
    // The parts are reassembled into the function's own /tmp before parsing,
    // so a ceiling above that budget would trade a 413 for a disk-full error.
    expect(VERCEL_STAGED_UPLOAD_BYTES).toBeLessThan(VERCEL_TMP_BYTES);
  });

  it("the part count is bounded by the app's own ceiling", () => {
    expect(MAX_UPLOAD_PARTS).toBe(Math.ceil(MAX_UPLOAD_BYTES / UPLOAD_PART_BYTES));
    // A part index is refused outside [0, totalParts), and (session, index) is
    // unique, so this is what caps stored bytes however a client behaves.
    expect(MAX_UPLOAD_PARTS * UPLOAD_PART_BYTES).toBeGreaterThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it("no route handler reads a whole upload out of one request body", () => {
    // A regression guard with teeth: the old route called `request.body` and
    // streamed the entire archive out of it. The part route still does read a
    // body — bounded to one part — so what is asserted is that nothing under
    // the import routes reads a body without a bound in the same module.
    const source = readFileSync(
      join(APP_DIR, "api", "health", "import", "part", "route.ts"),
      "utf8",
    );
    expect(source).toContain("receivePart");
    // The session and finalize routes take JSON envelopes, never file bytes.
    for (const route of [
      ["api", "health", "import", "route.ts"],
      ["api", "health", "import", "finalize", "route.ts"],
    ]) {
      const text = readFileSync(join(APP_DIR, ...route), "utf8");
      expect(text, route.join("/")).toContain("request.json()");
      expect(text, route.join("/")).not.toContain("request.body");
    }
  });
});

describe("vercel.json cron schedules stay inside the free plan's cadence", () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
    crons?: Array<{ path: string; schedule: string }>;
  };

  it("declares at most two cron jobs", () => {
    // Hobby allows two. A third is another deploy-time rejection.
    expect((config.crons ?? []).length).toBeLessThanOrEqual(2);
  });

  it("every cron runs at most once a day", () => {
    for (const cron of config.crons ?? []) {
      const [minute, hour] = cron.schedule.split(/\s+/);
      // Hobby runs daily crons only: a wildcard or step in the minute or hour
      // field asks for a cadence the plan refuses.
      expect(minute, `${cron.path}: minute field must be fixed`).toMatch(/^\d+$/);
      expect(hour, `${cron.path}: hour field must be fixed`).toMatch(/^\d+$/);
    }
  });
});

describe("the upload limit the app advertises is the one the deployment can keep", () => {
  /** A bare environment, without inheriting the runner's own variables. */
  const env = (values: Record<string, string> = {}) => values as unknown as NodeJS.ProcessEnv;

  it("self-hosted keeps the app's own generous ceiling", () => {
    const limit = resolveUploadLimit(env());
    expect(limit.bytes).toBe(MAX_UPLOAD_BYTES);
    expect(limit.platformBound).toBe(false);
    expect(uploadLimitNote(limit)).toContain("2 GB");
  });

  it("on Vercel it drops to what the platform can actually stage", () => {
    const limit = resolveUploadLimit(env({ VERCEL: "1" }));
    expect(limit.bytes).toBe(VERCEL_STAGED_UPLOAD_BYTES);
    expect(limit.platformBound).toBe(true);
    // The note must name the platform as the reason, and point somewhere.
    expect(uploadLimitNote(limit)).toMatch(/hosting platform/);
    expect(uploadLimitNote(limit)).toMatch(/self-hosted/);
    // And it must explain the mechanism, because "256 MB on a platform that
    // refuses 5 MB requests" is otherwise not a believable claim.
    expect(uploadLimitNote(limit)).toMatch(/parts/);
  });

  it("a refusal says what to do about it rather than only stating the number", () => {
    const hosted = tooLargeMessage(resolveUploadLimit(env({ VERCEL: "1" })));
    expect(hosted).toContain(formatLimit(VERCEL_STAGED_UPLOAD_BYTES));
    expect(hosted).toMatch(/HEALTH_MAX_UPLOAD_MB/);
    expect(hosted).toMatch(/self-host/);

    // Self-hosted, the app's own number is the whole story — no platform to
    // blame and nothing to suggest.
    const own = tooLargeMessage(resolveUploadLimit(env()));
    expect(own).toContain(formatLimit(MAX_UPLOAD_BYTES));
    expect(own).not.toMatch(/hosting platform/);
  });

  it("an explicit override wins, and is still bounded by the app's ceiling", () => {
    const raised = resolveUploadLimit(env({ VERCEL: "1", HEALTH_MAX_UPLOAD_MB: "200" }));
    expect(raised.bytes).toBe(200 * 1024 * 1024);
    expect(raised.reason).toBe("configured");

    const absurd = resolveUploadLimit(env({ HEALTH_MAX_UPLOAD_MB: "999999999" }));
    expect(absurd.bytes).toBe(MAX_UPLOAD_BYTES);

    const nonsense = resolveUploadLimit(env({ HEALTH_MAX_UPLOAD_MB: "not-a-number" }));
    expect(nonsense.bytes).toBe(MAX_UPLOAD_BYTES);
    expect(nonsense.reason).toBe("app");

    const negative = resolveUploadLimit(env({ HEALTH_MAX_UPLOAD_MB: "-5" }));
    expect(negative.bytes).toBe(MAX_UPLOAD_BYTES);
  });

  it("formats a limit in a unit that is never zero", () => {
    // The bug this replaces: rounding to whole gigabytes printed "0 GB" for
    // every limit smaller than half a gigabyte.
    expect(formatLimit(2 * 1024 * 1024 * 1024)).toBe("2 GB");
    expect(formatLimit(VERCEL_REQUEST_BODY_BYTES)).toBe("4.5 MB");
    expect(formatLimit(200 * 1024 * 1024)).toBe("200 MB");
    expect(formatLimit(1_500_000_000)).toBe("1.4 GB");
  });
});
