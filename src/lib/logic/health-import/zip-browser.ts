/**
 * Minimal ZIP extraction for Apple Health `export.zip` — the browser build.
 *
 * The archive layout Apple produces is plain: a handful of entries, stored or
 * deflated, no encryption, no zip64 in practice. This is the same ~80 lines
 * of directory-walking as the original Node implementation, written against
 * `DataView`/`Uint8Array` and `DecompressionStream("deflate-raw")` so it runs
 * inside a Web Worker. The archive is read on the user's device and the
 * extracted XML never leaves it — only normalised rows do, after preview.
 *
 * (Node 18+ has DecompressionStream too, which is what lets the unit tests
 * exercise this exact code.)
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

function findEocd(view: DataView): number {
  // EOCD is at the end, possibly preceded by a comment up to 64 KiB long.
  const floor = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd === -1) throw new Error("Not a ZIP archive (no end-of-directory record).");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function extractEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (view.getUint32(at, true) !== LOCAL_SIGNATURE) {
    throw new Error("Corrupt ZIP: local header not where the directory said.");
  }
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const dataStart = at + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

export function listZipEntries(bytes: Uint8Array): string[] {
  return readEntries(bytes).map((entry) => entry.name);
}

/**
 * Pull `export.xml` out of an Apple Health export archive.
 * Throws with a user-readable message when the archive isn't one.
 */
export async function extractAppleHealthXml(bytes: Uint8Array): Promise<string> {
  const entries = readEntries(bytes);
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
  return new TextDecoder().decode(await extractEntry(bytes, entry));
}
