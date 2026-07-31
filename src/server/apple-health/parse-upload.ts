import "server-only";

import { buildApplePlan, buildImportPlan } from "@/lib/logic/health-import/rollup";
import { parseHealthCsv } from "@/lib/logic/health-import/csv";
import type { ImportPlan } from "@/lib/logic/health-import/types";

import { AppleImportError, parseAppleHealthArchive } from "./parse-archive";
import { detectUploadType, readCsvFile } from "./read-text";

/**
 * "A file on disk" → "a plan the preview can be built from".
 *
 * Extracted from the upload route so the staged path and the tests exercise
 * exactly the same code: a preview generated from reassembled parts must be
 * byte-for-byte the preview the old one-shot upload produced, and the only way
 * to be sure of that is for there to be one function.
 *
 * The file type is decided from the **bytes on disk** — never from the name the
 * browser sent, and never from a content type it claimed.
 */

export interface ParsedUpload {
  fileType: "zip" | "xml" | "csv";
  plan: ImportPlan;
  xmlBytes: number;
  ignoredFiles: string[];
  errors: string[];
}

export async function parseUploadedFile(path: string, fileName: string): Promise<ParsedUpload> {
  const fileType = await detectUploadType(path, fileName);
  if (!fileType) {
    throw new AppleImportError(
      "Unrecognised file. Supported: an Apple Health export.zip, an export.xml, or a CSV.",
    );
  }

  if (fileType === "csv") {
    const text = await readCsvFile(path);
    return {
      fileType,
      plan: buildImportPlan(parseHealthCsv(text)),
      xmlBytes: 0,
      ignoredFiles: [],
      errors: [],
    };
  }

  const parsed = await parseAppleHealthArchive(path, fileType);
  return {
    fileType,
    plan: buildApplePlan(parsed),
    xmlBytes: parsed.xmlBytes,
    ignoredFiles: parsed.ignoredFiles,
    errors: parsed.errors,
  };
}
