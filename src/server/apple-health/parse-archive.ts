import "server-only";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  AppleHealthAccumulator,
  type AppleParseResult,
} from "@/lib/logic/health-import/apple-stream";
import {
  ECG_DIRECTORY,
  EXPORT_XML_NAMES,
  IGNORED_MEMBER_PATTERNS,
  parseEcgCsv,
  ROUTE_DIRECTORY,
  routeRecord,
  summarizeRouteGpx,
} from "@/lib/logic/health-import/apple-members";
import { XmlScanError } from "@/lib/logic/health-import/xml-scanner";
import {
  MAX_ECG_FILES,
  MAX_MEMBER_BYTES,
  MAX_ROUTE_FILES,
  MAX_XML_BYTES,
} from "./limits";
import { ZipArchive, ZipError, type ZipEntry } from "./zip-reader";

/**
 * Server-side parsing of an Apple Health export — the whole of it, streamed.
 *
 * The uploaded archive is read from disk and never held in memory:
 * `export.xml` flows through the XML scanner a megabyte at a time and is
 * folded into accumulators as it goes (see `apple-stream.ts`), so a decade of
 * Apple Watch data — routinely several gigabytes once unzipped — is parsed in
 * memory proportional to the number of distinct days, not to the file.
 *
 * Everything is bounded, because the input is a file a stranger could have
 * crafted:
 *
 *  * `MAX_XML_BYTES` caps how much decompressed XML is read, which is what
 *    turns a zip bomb into a failed import instead of an outage;
 *  * member files (ECG CSVs, route GPX) each have their own small cap and a
 *    cap on how many are read at all;
 *  * an unreadable member file is recorded as an error and skipped — the
 *    import still succeeds, because a corrupt route should not cost you ten
 *    years of steps;
 *  * only a broken *archive* or a broken `export.xml` is fatal.
 *
 * No parsing happens anywhere but here. Nothing in this module performs a
 * network request, and no record content is ever logged.
 */

/** Text handed to the scanner per iteration. */
const READ_CHUNK = 1024 * 1024;

export interface ArchiveParseResult extends AppleParseResult {
  /** Bytes of `export.xml` actually read. */
  xmlBytes: number;
  /** Member files present that this app does not read, with the reason. */
  ignoredFiles: string[];
  /** Non-fatal problems: a member file that would not parse. */
  errors: string[];
  /** How many ECGs / routes were found beyond the caps. */
  skippedMembers: number;
}

export class AppleImportError extends Error {}

/**
 * Parse an Apple Health export from a path on disk. `fileType` decides whether
 * the path is the archive or a bare `export.xml`.
 */
export async function parseAppleHealthArchive(
  path: string,
  fileType: "zip" | "xml",
): Promise<ArchiveParseResult> {
  return fileType === "zip" ? parseZip(path) : parseBareXml(path);
}

async function parseBareXml(path: string): Promise<ArchiveParseResult> {
  const { size } = await stat(path);
  if (size > MAX_XML_BYTES) {
    throw new AppleImportError("That export.xml is larger than this importer will read.");
  }
  const accumulator = new AppleHealthAccumulator();
  const xmlBytes = await pumpXml(createReadStream(path, { highWaterMark: READ_CHUNK }), accumulator);
  return finish(accumulator, { xmlBytes, ignoredFiles: [], errors: [], skippedMembers: 0 });
}

async function parseZip(path: string): Promise<ArchiveParseResult> {
  let archive: ZipArchive;
  try {
    archive = await ZipArchive.open(path);
  } catch (error) {
    throw new AppleImportError(
      error instanceof ZipError
        ? error.message
        : "That archive could not be opened — it does not look like a ZIP file.",
    );
  }

  try {
    const exportEntry = findExportXml(archive);
    if (!exportEntry) {
      throw new AppleImportError(
        "The archive has no export.xml, so it is not an Apple Health export. " +
          "In the Health app: your profile picture → Export All Health Data.",
      );
    }

    const accumulator = new AppleHealthAccumulator();
    const errors: string[] = [];

    const stream = await archive.openEntry(exportEntry, MAX_XML_BYTES);
    const xmlBytes = await pumpXml(stream, accumulator);

    if (!accumulator.looksLikeAppleExport) {
      throw new AppleImportError(
        "That archive's export.xml has no <HealthData> element — it is not an Apple Health export.",
      );
    }

    const { ignoredFiles, skippedMembers } = await readMemberFiles(
      archive,
      accumulator,
      errors,
    );

    return finish(accumulator, { xmlBytes, ignoredFiles, errors, skippedMembers });
  } finally {
    await archive.close();
  }
}

function findExportXml(archive: ZipArchive): ZipEntry | undefined {
  for (const name of EXPORT_XML_NAMES) {
    const exact = archive.find((entry) => entry.name === name);
    if (exact) return exact;
  }
  // Some third-party re-zips nest the folder one level deeper.
  return archive.find(
    (entry) => entry.name.endsWith("/export.xml") && !entry.name.includes("_cda"),
  );
}

/**
 * Read the ECG and route member files. Each failure is recorded and skipped:
 * a damaged route must never cost the user the rest of the import.
 */
async function readMemberFiles(
  archive: ZipArchive,
  accumulator: AppleHealthAccumulator,
  errors: string[],
): Promise<{ ignoredFiles: string[]; skippedMembers: number }> {
  const ignored = new Map<string, string>();
  let skipped = 0;
  let ecgCount = 0;
  let routeCount = 0;

  for (const entry of archive.entries) {
    if (entry.name.endsWith("/")) continue;
    const base = entry.name.split("/").pop() ?? entry.name;

    if (entry.name.includes(ECG_DIRECTORY) && /\.csv$/i.test(base)) {
      if (ecgCount >= MAX_ECG_FILES) {
        skipped += 1;
        continue;
      }
      ecgCount += 1;
      const text = await readMemberText(archive, entry, errors);
      if (text === null) continue;
      const record = parseEcgCsv(text, base);
      if (record) accumulator.addRecord(record);
      else errors.push(`Could not read the ECG "${base}" — its header was not in a known format.`);
      continue;
    }

    if (entry.name.includes(ROUTE_DIRECTORY) && /\.gpx$/i.test(base)) {
      if (routeCount >= MAX_ROUTE_FILES) {
        skipped += 1;
        continue;
      }
      routeCount += 1;
      const text = await readMemberText(archive, entry, errors);
      if (text === null) continue;
      const summary = summarizeRouteGpx(text);
      const record = summary ? routeRecord(summary, base) : null;
      if (record) accumulator.addRecord(record);
      continue;
    }

    const ignoredBy = IGNORED_MEMBER_PATTERNS.find((pattern) => pattern.test.test(entry.name));
    if (ignoredBy && !ignored.has(ignoredBy.reason)) ignored.set(ignoredBy.reason, ignoredBy.reason);
  }

  if (skipped > 0) {
    accumulator.addWarning(
      `${skipped} ECG or route file${skipped === 1 ? "" : "s"} beyond the per-import limit were not read. ` +
        "Everything else in the export was.",
    );
  }

  return { ignoredFiles: [...ignored.values()], skippedMembers: skipped };
}

async function readMemberText(
  archive: ZipArchive,
  entry: ZipEntry,
  errors: string[],
): Promise<string | null> {
  if (errors.length > 40) return null; // stop accumulating once the point is made
  try {
    const stream = await archive.openEntry(entry, MAX_MEMBER_BYTES);
    return await readAll(stream);
  } catch (error) {
    const base = entry.name.split("/").pop() ?? entry.name;
    errors.push(
      `Could not read "${base}": ${error instanceof ZipError ? error.message : "the file is damaged"}.`,
    );
    return null;
  }
}

async function readAll(stream: Readable): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  for await (const chunk of stream) {
    text += decoder.write(chunk as Buffer);
  }
  return text + decoder.end();
}

/**
 * Push a byte stream through the scanner in bounded slices.
 *
 * A `StringDecoder` is what makes this safe: UTF-8 characters straddle chunk
 * boundaries constantly in a file this size, and decoding each buffer
 * independently would corrupt every one of them.
 */
async function pumpXml(stream: Readable, accumulator: AppleHealthAccumulator): Promise<number> {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      const text = decoder.write(buffer);
      if (text.length > 0) accumulator.write(text);
    }
    const tail = decoder.end();
    if (tail.length > 0) accumulator.write(tail);
    accumulator.end();
  } catch (error) {
    if (error instanceof XmlScanError) {
      throw new AppleImportError(`${error.message} Nothing was imported.`);
    }
    if (error instanceof ZipError) throw new AppleImportError(`${error.message}`);
    throw new AppleImportError(
      "That export could not be read — the file appears to be damaged. Nothing was imported.",
    );
  }
  return bytes;
}

function finish(
  accumulator: AppleHealthAccumulator,
  extra: { xmlBytes: number; ignoredFiles: string[]; errors: string[]; skippedMembers: number },
): ArchiveParseResult {
  const result = accumulator.result();
  return { ...result, ...extra };
}

/** Read a bare `export.xml` for the "does this look like an export" check. */
export function isProbablyZip(header: Buffer): boolean {
  return header.length >= 2 && header[0] === 0x50 && header[1] === 0x4b;
}
