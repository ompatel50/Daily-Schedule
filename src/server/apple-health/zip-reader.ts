import "server-only";

import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

/**
 * A read-only, streaming ZIP reader for Apple Health's `export.zip` — the
 * server-side half of the import.
 *
 * It never loads an archive into memory. The central directory is read from
 * the tail of the file with positional reads, and a member is decompressed
 * as a Node stream so `export.xml` — routinely hundreds of megabytes, and
 * multiple gigabytes for a decade of Apple Watch data — flows through the
 * XML scanner in constant memory.
 *
 * Deliberately narrow, because a general ZIP implementation is a liability:
 *
 *  * only the stored (0) and deflate (8) methods, which is all Apple writes;
 *  * encrypted entries are refused rather than half-read;
 *  * **path traversal cannot happen** — nothing here writes files. Entry
 *    names are only ever compared and displayed, and are rejected outright
 *    when absolute or containing `..`, so a malicious name cannot even be
 *    *shown* as if it were a real path;
 *  * **zip bombs are bounded** — every extraction takes a hard byte budget
 *    and aborts the stream the moment output exceeds it, so a 100 KB archive
 *    that claims to expand to 100 GB stops at the budget instead of filling
 *    the disk or the heap;
 *  * ZIP64 sizes and offsets are read, so a >4 GiB export is not silently
 *    truncated to its low 32 bits.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
/** The EOCD may be followed by a comment of up to 64 KiB. */
const EOCD_SEARCH_WINDOW = 65_557;
/** A sane ceiling on entries: Apple writes a few thousand at most. */
const MAX_ENTRIES = 200_000;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Bit 0 of the general-purpose flags. */
  encrypted: boolean;
}

export class ZipArchive {
  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
    readonly entries: ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const handle = await open(path, "r");
    try {
      const entries = await readCentralDirectory(handle);
      return new ZipArchive(handle, path, entries);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {});
  }

  find(predicate: (entry: ZipEntry) => boolean): ZipEntry | undefined {
    return this.entries.find(predicate);
  }

  /**
   * A stream of one member's bytes, decompressed. `maxBytes` is a hard budget:
   * the stream errors once more than that has been produced, which is what
   * makes a decompression bomb a failed import rather than an outage.
   */
  async openEntry(entry: ZipEntry, maxBytes: number): Promise<Readable> {
    if (entry.encrypted) {
      throw new ZipError(`"${entry.name}" is encrypted — this importer cannot read it.`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`"${entry.name}" uses an unsupported compression method.`);
    }

    // The local header repeats the name and extra fields, and its lengths are
    // the authoritative ones for where the data starts.
    const header = Buffer.alloc(30);
    const { bytesRead } = await this.handle.read(header, 0, 30, entry.localHeaderOffset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError("Corrupt archive: a local file header is not where the directory said.");
    }
    const dataStart =
      entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);

    const raw = createReadStream(this.path, {
      start: dataStart,
      end: dataStart + entry.compressedSize - 1,
      // 1 MiB reads: large enough that a multi-gigabyte member is not a
      // syscall storm, small enough to stay off the large-object heap.
      highWaterMark: 1024 * 1024,
    });

    const body = entry.method === 0 ? raw : raw.pipe(createInflateRaw());
    if (entry.method === 8) {
      // Piping loses the source's errors; forward them so a truncated archive
      // rejects instead of ending quietly with a short read.
      raw.on("error", (error) => body.destroy(error));
    }
    return budgeted(body, maxBytes, entry.name);
  }
}

/** Wrap a stream so it fails fast once it has produced more than the budget. */
function budgeted(stream: Readable, maxBytes: number, name: string): Readable {
  let produced = 0;
  stream.on("data", (chunk: Buffer | string) => {
    produced += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (produced > maxBytes) {
      stream.destroy(
        new ZipError(
          `"${name}" expands to more than the ${Math.round(maxBytes / (1024 * 1024))} MB this ` +
            "importer will read. Nothing was imported.",
        ),
      );
    }
  });
  return stream;
}

async function readCentralDirectory(handle: FileHandle): Promise<ZipEntry[]> {
  const { size } = await handle.stat();
  if (size < EOCD_MIN_SIZE) throw new ZipError("That file is too small to be a ZIP archive.");

  const tailLength = Math.min(size, EOCD_SEARCH_WINDOW);
  const tail = Buffer.alloc(tailLength);
  await handle.read(tail, 0, tailLength, size - tailLength);

  let eocd = -1;
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw new ZipError(
      "That is not a ZIP archive — it has no end-of-central-directory record.",
    );
  }

  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record the locator points at.
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = findZip64Locator(tail, eocd);
    if (locator === null) throw new ZipError("This ZIP64 archive is missing its locator record.");
    const record = Buffer.alloc(56);
    await handle.read(record, 0, 56, locator);
    if (record.readUInt32LE(0) !== EOCD64_SIGNATURE) {
      throw new ZipError("This ZIP64 archive's end-of-directory record is damaged.");
    }
    entryCount = readUInt64(record, 32);
    directorySize = readUInt64(record, 40);
    directoryOffset = readUInt64(record, 48);
  }

  if (entryCount > MAX_ENTRIES) {
    throw new ZipError("That archive contains an implausible number of files.");
  }
  if (directoryOffset + directorySize > size) {
    throw new ZipError("Corrupt archive: the central directory runs past the end of the file.");
  }

  const directory = Buffer.alloc(directorySize);
  await handle.read(directory, 0, directorySize, directoryOffset);

  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directory.length) break;
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;

    const flags = directory.readUInt16LE(cursor + 8);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const name = directory
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString(flags & 0x800 ? "utf8" : "latin1");

    let compressedSize = directory.readUInt32LE(cursor + 20);
    let uncompressedSize = directory.readUInt32LE(cursor + 24);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const zip64 = readZip64Extra(extra, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      });
      uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
      compressedSize = zip64.compressedSize ?? compressedSize;
      localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset;
    }

    // Names are never used as paths — nothing here writes to disk — but a
    // traversal-shaped name is still a signal the archive is not what it
    // claims, and refusing it keeps such a string out of the UI entirely.
    if (name.startsWith("/") || name.includes("..") || /^[A-Za-z]:[\\/]/.test(name)) {
      throw new ZipError("That archive contains an unsafe file path and was not read.");
    }

    entries.push({
      name,
      method: directory.readUInt16LE(cursor + 10),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findZip64Locator(tail: Buffer, eocd: number): number | null {
  for (let offset = eocd - 20; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD64_LOCATOR_SIGNATURE) {
      return readUInt64(tail, offset + 8);
    }
  }
  return null;
}

function readZip64Extra(
  extra: Buffer,
  want: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    if (headerId === 0x0001) {
      const field = extra.subarray(cursor + 4, cursor + 4 + size);
      const result: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
      let at = 0;
      if (want.uncompressed && at + 8 <= field.length) {
        result.uncompressedSize = readUInt64(field, at);
        at += 8;
      }
      if (want.compressed && at + 8 <= field.length) {
        result.compressedSize = readUInt64(field, at);
        at += 8;
      }
      if (want.offset && at + 8 <= field.length) {
        result.localHeaderOffset = readUInt64(field, at);
      }
      return result;
    }
    cursor += 4 + size;
  }
  return {};
}

/**
 * ZIP64 fields are 64-bit. Node's `readBigUInt64LE` is exact but a BigInt is
 * awkward to thread through offsets, so this converts and refuses anything
 * above `Number.MAX_SAFE_INTEGER` — an archive that large is not an Apple
 * Health export and would silently lose precision.
 */
function readUInt64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError("That archive declares an implausibly large size.");
  }
  return Number(value);
}
