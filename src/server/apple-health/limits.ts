/**
 * The health import's hard limits, in one place.
 *
 * They live outside the route handler because Next.js only permits a fixed set
 * of exports from a route module — and outside `parse-archive.ts` because the
 * upload cap is checked before any parser is reached. Tests assert against
 * these constants rather than repeating the numbers.
 */

/**
 * Uploaded bytes, self-hosted. A decade of Apple Watch data compresses to a few
 * hundred megabytes, so this is generous by an order of magnitude while still
 * being a number a single request can be held to.
 *
 * This is the app's *own* ceiling. On a hosting platform the platform's cap
 * binds first — see `resolveUploadLimit`, which is what the route actually
 * enforces and what the UI actually advertises.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Decompressed `export.xml` bytes this importer will read. */
export const MAX_XML_BYTES = 6 * 1024 * 1024 * 1024;

/** One ECG CSV / route GPX. Apple's are kilobytes; this is generous. */
export const MAX_MEMBER_BYTES = 32 * 1024 * 1024;

/** A CSV import is a hand-made file; anything larger than this is not one. */
export const MAX_CSV_BYTES = 64 * 1024 * 1024;

/** How many ECG files are read; the rest are reported as skipped. */
export const MAX_ECG_FILES = 5_000;

/** How many route files are read; the rest are reported as skipped. */
export const MAX_ROUTE_FILES = 5_000;

// --- platform limits ------------------------------------------------------------

/**
 * The highest `maxDuration` **every** Vercel plan accepts.
 *
 * Vercel validates a route's `maxDuration` against the account's plan at deploy
 * time and fails the whole deployment rather than clamping it, so a value that
 * is fine on one plan breaks the deploy on another. 60 is the Hobby ceiling and
 * therefore the only number that is safe everywhere. `tests/deploy-config.test.ts`
 * asserts no route exceeds it — the deploy failure this constant exists to
 * prevent is otherwise invisible until a push to production.
 */
export const MAX_FUNCTION_SECONDS = 60;

/**
 * Vercel rejects a request body larger than this **before** the function runs,
 * with a platform 413 the app never sees and cannot phrase. Documented as
 * 4.5 MB for Serverless Functions.
 */
export const VERCEL_REQUEST_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);

export interface UploadLimit {
  /** Bytes the route will accept. */
  bytes: number;
  /** Why this is the number — used to phrase the refusal and the UI hint. */
  reason: "app" | "platform" | "configured";
  /** True when a platform cap, not this app, is the binding constraint. */
  platformBound: boolean;
}

/**
 * The upload cap that is actually true for this deployment.
 *
 * Three inputs, most specific first:
 *
 *  1. `HEALTH_MAX_UPLOAD_MB` — an explicit override, for a self-hoster behind a
 *     proxy with its own `client_max_body_size`, or a Vercel account whose plan
 *     raises the body cap. Never allowed to exceed this app's own ceiling.
 *  2. Running on Vercel (`VERCEL=1`) — the platform's request-body cap binds,
 *     so advertising 2 GB would be a promise the deployment cannot keep. The
 *     user gets a truthful number *before* uploading rather than an opaque
 *     platform 413 after waiting.
 *  3. Otherwise the app's own ceiling.
 *
 * Deliberately does **not** remove functionality: nothing here shrinks what a
 * self-hosted deployment accepts, and a large export remains importable exactly
 * where it was importable before.
 */
export function resolveUploadLimit(env: NodeJS.ProcessEnv = process.env): UploadLimit {
  const platformBound = isVercel(env);
  const ceiling = platformBound ? VERCEL_REQUEST_BODY_BYTES : MAX_UPLOAD_BYTES;

  const override = Number(env.HEALTH_MAX_UPLOAD_MB ?? "");
  if (Number.isFinite(override) && override > 0) {
    // An override may raise a platform cap (the operator knows their plan) but
    // never the app's own ceiling, which bounds memory and disk use.
    const bytes = Math.min(Math.floor(override * 1024 * 1024), MAX_UPLOAD_BYTES);
    return { bytes, reason: "configured", platformBound: platformBound && bytes > ceiling };
  }

  return {
    bytes: ceiling,
    reason: platformBound ? "platform" : "app",
    platformBound,
  };
}

function isVercel(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.VERCEL ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Bytes as the shortest honest unit. The previous formatter only ever printed
 * whole gigabytes, which reads as "larger than the 0 GB upload limit" the
 * moment the effective cap is a platform-sized one.
 */
export function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * One sentence for the import page: what this deployment will accept, and —
 * when a platform is the reason it is small — what to do about it.
 */
export function uploadLimitNote(limit: UploadLimit = resolveUploadLimit()): string {
  const size = formatLimit(limit.bytes);
  if (limit.platformBound) {
    return `This deployment accepts files up to ${size} — the hosting platform caps request bodies, not the app. A larger export needs a self-hosted instance.`;
  }
  return `Files up to ${size}.`;
}
