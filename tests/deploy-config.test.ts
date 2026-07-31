import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_FUNCTION_SECONDS,
  MAX_UPLOAD_BYTES,
  VERCEL_REQUEST_BODY_BYTES,
  formatLimit,
  resolveUploadLimit,
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

  it("the health upload route asks for exactly the ceiling, no more", () => {
    // It has to be a literal (Next.js refuses to build otherwise), so this is
    // the assertion that keeps the literal and the constant in step.
    const source = readFileSync(join(APP_DIR, "api", "health", "import", "route.ts"), "utf8");
    expect(source).toContain(`export const maxDuration = ${MAX_FUNCTION_SECONDS};`);
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

  it("on Vercel it drops to the platform's request-body cap", () => {
    const limit = resolveUploadLimit(env({ VERCEL: "1" }));
    expect(limit.bytes).toBe(VERCEL_REQUEST_BODY_BYTES);
    expect(limit.platformBound).toBe(true);
    // The note must name the platform as the reason, and point somewhere.
    expect(uploadLimitNote(limit)).toMatch(/hosting platform/);
    expect(uploadLimitNote(limit)).toMatch(/self-hosted/);
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
