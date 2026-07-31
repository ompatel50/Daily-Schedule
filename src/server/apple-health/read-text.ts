import "server-only";

import { open, readFile, stat } from "node:fs/promises";

import { detectHealthFileType, type HealthFileType } from "@/lib/logic/health-import/detect";
import { MAX_CSV_BYTES } from "./limits";

/**
 * Reading a freshly uploaded file well enough to decide what it is, without
 * reading all of it.
 *
 * The type is decided from the *bytes on disk*, never from the name the client
 * sent or the content type it claimed: a `.csv` full of ZIP data is a ZIP, and
 * an `export.xml` renamed to `.txt` is still XML. Only the first few kilobytes
 * are needed for that, which matters when the alternative is loading a
 * multi-gigabyte archive to look at its first two bytes.
 */

const SNIFF_BYTES = 4096;

export async function detectUploadType(
  path: string,
  fileName: string,
): Promise<HealthFileType | null> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
    return detectHealthFileType(fileName, head.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * A CSV small enough to parse as one string. The cap is the reason this is
 * safe: an "import.csv" of two gigabytes is refused rather than buffered.
 */
export async function readCsvFile(path: string): Promise<string> {
  const { size } = await stat(path);
  if (size > MAX_CSV_BYTES) {
    throw new Error(
      `That CSV is larger than the ${Math.round(MAX_CSV_BYTES / (1024 * 1024))} MB limit for CSV imports.`,
    );
  }
  return readFile(path, "utf8");
}
