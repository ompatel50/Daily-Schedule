import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP extraction for Apple Health `export.zip`.
 *
 * The archive layout Apple produces is plain: a handful of entries, stored or
 * deflated, no encryption, no zip64 in practice. Reading the central directory
 * with ~80 lines of buffer work keeps a whole archive library out of the
 * dependency tree — this code only ever runs on a file the user picked, on
 * their own machine, and the extracted XML never leaves it.
 */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEocd(buffer: Buffer): number {
  // EOCD is at the end, possibly preceded by a comment up to 64 KiB long.
  const floor = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error("Not a ZIP archive (no end-of-directory record).");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString("utf8", offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new Error("Corrupt ZIP: local header not where the directory said.");
  }
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

export function listZipEntries(buffer: Buffer): string[] {
  return readEntries(buffer).map((entry) => entry.name);
}

/**
 * Pull `export.xml` out of an Apple Health export archive.
 * Throws with a user-readable message when the archive isn't one.
 */
export function extractAppleHealthXml(buffer: Buffer): string {
  const entries = readEntries(buffer);
  const entry =
    entries.find((candidate) => candidate.name === "apple_health_export/export.xml") ??
    entries.find(
      (candidate) => candidate.name.endsWith("export.xml") && !candidate.name.includes("_cda"),
    );
  if (!entry) {
    throw new Error(
      "The archive has no export.xml — it doesn't look like an Apple Health export. " +
        "In the Health app: profile picture → Export All Health Data.",
    );
  }
  return extractEntry(buffer, entry).toString("utf8");
}
