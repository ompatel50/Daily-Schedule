/**
 * The health import's hard limits, in one place.
 *
 * They live outside the route handlers because Next.js only permits a fixed set
 * of exports from a route module — and outside `parse-archive.ts` because the
 * upload caps are checked before any parser is reached. Tests assert against
 * these constants rather than repeating the numbers.
 */

/**
 * Staged bytes, self-hosted. A decade of Apple Watch data compresses to a few
 * hundred megabytes, so this is generous by an order of magnitude while still
 * being a number the staging area can be held to.
 *
 * This is the app's *own* ceiling. A hosting platform's scratch space binds
 * first — see `resolveUploadLimit`, which is what the routes actually enforce
 * and what the UI actually advertises.
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
 *
 * This used to be the ceiling on an entire Apple Health export, which made the
 * hosted importer useless: a real export is a hundred times larger, and every
 * attempt died as `413 FUNCTION_PAYLOAD_TOO_LARGE` at the edge, before any of
 * this app's code ran. It now bounds only **one part** of a staged upload —
 * see `UPLOAD_PART_BYTES` — so the size of the file and the size of a request
 * are no longer the same number.
 */
export const VERCEL_REQUEST_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);

/**
 * One slice of a staged upload.
 *
 * Deliberately below `VERCEL_REQUEST_BODY_BYTES` with room to spare: the
 * platform's cap counts the whole request, and a part travels with headers and
 * a query string alongside it. Half a megabyte of headroom costs one extra
 * request per 8 parts and removes any chance of the failure this whole design
 * exists to prevent.
 *
 * `tests/deploy-config.test.ts` asserts the relationship, because a part size
 * raised above the platform cap would fail *only* in production.
 */
export const UPLOAD_PART_BYTES = 4 * 1024 * 1024;

/**
 * Parts one upload may consist of. Structural, not advisory: a part's index is
 * refused outside `[0, totalParts)` and `(sessionId, seq)` is unique, so this
 * caps what a client can store however it behaves.
 */
export const MAX_UPLOAD_PARTS = Math.ceil(MAX_UPLOAD_BYTES / UPLOAD_PART_BYTES);

/**
 * Scratch space a Vercel function gets. The staged parts are reassembled into
 * `/tmp` inside the single invocation that parses them, so this — not the
 * request body cap — is the real hosted ceiling on an archive.
 */
export const VERCEL_TMP_BYTES = 500 * 1024 * 1024;

/**
 * What a hosted deployment stages by default.
 *
 * Two things bind, and this is under both:
 *
 *  * the function's `/tmp` budget above, which the reassembled archive occupies
 *    for the length of one parse;
 *  * the free database tier the deployment guide recommends (Neon's is 0.5 GB),
 *    which holds the parts for the minutes between "upload started" and
 *    "preview ready".
 *
 * It is ~57× the old effective limit and covers the overwhelming majority of
 * real Apple Health exports. `HEALTH_MAX_UPLOAD_MB` raises it for a deployment
 * whose database and plan can take more.
 */
export const VERCEL_STAGED_UPLOAD_BYTES = 256 * 1024 * 1024;

export interface UploadLimit {
  /** Bytes the staged upload will accept, in total. */
  bytes: number;
  /** Why this is the number — used to phrase the refusal and the UI hint. */
  reason: "app" | "platform" | "configured";
  /** True when a platform ceiling, not this app, is the binding constraint. */
  platformBound: boolean;
}

/**
 * The upload cap that is actually true for this deployment.
 *
 * Three inputs, most specific first:
 *
 *  1. `HEALTH_MAX_UPLOAD_MB` — an explicit override, for a self-hoster behind a
 *     proxy with its own `client_max_body_size`, or a hosted deployment whose
 *     database can hold more than the conservative default. Never allowed to
 *     exceed this app's own ceiling.
 *  2. Running on Vercel (`VERCEL=1`) — the platform's scratch and free-tier
 *     database bound what can be staged, so advertising 2 GB would be a promise
 *     the deployment cannot keep. The user gets a truthful number *before*
 *     uploading rather than a failure after waiting.
 *  3. Otherwise the app's own ceiling.
 *
 * Deliberately does **not** remove functionality: nothing here shrinks what a
 * self-hosted deployment accepts, and every export importable before is
 * importable now — including, on a hosted deployment, the ones that were not.
 */
export function resolveUploadLimit(env: NodeJS.ProcessEnv = process.env): UploadLimit {
  const platformBound = isVercel(env);
  const ceiling = platformBound ? VERCEL_STAGED_UPLOAD_BYTES : MAX_UPLOAD_BYTES;

  const override = Number(env.HEALTH_MAX_UPLOAD_MB ?? "");
  if (Number.isFinite(override) && override > 0) {
    // An override may raise a platform default (the operator knows their plan
    // and their database) but never the app's own ceiling, which bounds the
    // scratch file and the staging table.
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
 * One sentence for the import page: how the file travels, and what this
 * deployment will accept.
 *
 * The "how" is not decoration. The old note had to warn that a hosting platform
 * would refuse anything over 4.5 MB, which is the single most confusing thing
 * an Apple Health user can be told. Saying the file goes up in parts is what
 * makes the new number believable.
 */
export function uploadLimitNote(limit: UploadLimit = resolveUploadLimit()): string {
  const size = formatLimit(limit.bytes);
  const part = formatLimit(UPLOAD_PART_BYTES);
  if (limit.platformBound) {
    return (
      `Large exports are uploaded in ${part} parts, so the hosting platform's per-request limit ` +
      `never applies. This deployment stages archives up to ${size}; a self-hosted instance goes ` +
      `to ${formatLimit(MAX_UPLOAD_BYTES)}.`
    );
  }
  return `Uploaded in ${part} parts, so no single request is ever large. Files up to ${size}.`;
}

/**
 * The refusal, phrased so the user can act on it. When a hosting platform is
 * the binding constraint it says so — otherwise "larger than the 256 MB limit"
 * reads as an arbitrary decision this app made, and the user has no way to know
 * that self-hosting or one environment variable lifts it.
 */
export function tooLargeMessage(limit: UploadLimit = resolveUploadLimit()): string {
  const size = formatLimit(limit.bytes);
  return limit.platformBound
    ? `That file is larger than the ${size} this deployment can stage. The hosting platform bounds ` +
        `the scratch space an import is reassembled in; raise HEALTH_MAX_UPLOAD_MB if your plan and ` +
        `database allow it, or self-host, where the limit is ${formatLimit(MAX_UPLOAD_BYTES)}.`
    : `That file is larger than the ${size} upload limit.`;
}
