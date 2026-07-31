/**
 * The health import's hard limits, in one place.
 *
 * They live outside the route handler because Next.js only permits a fixed set
 * of exports from a route module — and outside `parse-archive.ts` because the
 * upload cap is checked before any parser is reached. Tests assert against
 * these constants rather than repeating the numbers.
 */

/**
 * Uploaded bytes. A decade of Apple Watch data compresses to a few hundred
 * megabytes, so this is generous by an order of magnitude while still being a
 * number a single request can be held to.
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
