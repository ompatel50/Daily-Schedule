/**
 * File-type detection for health imports. Pure and browser-safe — this runs
 * in the Web Worker against the bytes of the file the user picked, which
 * never leave their device.
 */
export type HealthFileType = "xml" | "zip" | "csv";

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

export function detectHealthFileType(fileName: string, bytes: Uint8Array): HealthFileType | null {
  const ext = extensionOf(fileName);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  if (ext === ".xml") return "xml";
  if (ext === ".csv") return "csv";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (head.trimStart().startsWith("<?xml") || head.includes("<HealthData")) return "xml";
  if (ext === "" || ext === ".txt") return "csv";
  return null;
}
