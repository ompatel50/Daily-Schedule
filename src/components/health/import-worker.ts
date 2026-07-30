/**
 * The health-import parser, off the main thread.
 *
 * Everything heavy — unzipping the Apple Health archive, scanning the XML,
 * strict-parsing the CSV, rolling samples up into normalised day rows —
 * happens here, inside a Web Worker on the user's device. The raw file never
 * leaves the machine; only the normalised rows the user previews and
 * confirms are uploaded, in bounded chunks, by the wizard.
 */
import { detectHealthFileType } from "@/lib/logic/health-import/detect";
import { extractAppleHealthXml } from "@/lib/logic/health-import/zip-browser";
import { parseAppleHealthXml } from "@/lib/logic/health-import/apple-xml";
import { parseHealthCsv } from "@/lib/logic/health-import/csv";
import { buildImportPlan } from "@/lib/logic/health-import/rollup";
import type { ImportPlan } from "@/lib/logic/health-import/types";

export interface ParseRequest {
  buffer: ArrayBuffer;
  fileName: string;
}

export type ParseResponse =
  | { ok: true; fileType: "xml" | "zip" | "csv"; plan: ImportPlan; parseMs: number }
  | { ok: false; error: string };

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const started = Date.now();
  try {
    const { buffer, fileName } = event.data;
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0) {
      self.postMessage({ ok: false, error: "The file is empty." } satisfies ParseResponse);
      return;
    }

    const fileType = detectHealthFileType(fileName, bytes);
    if (!fileType) {
      self.postMessage({
        ok: false,
        error: "Unrecognised file type. Supported: Apple Health export.zip, export.xml, or a CSV.",
      } satisfies ParseResponse);
      return;
    }

    let plan: ImportPlan;
    if (fileType === "csv") {
      plan = buildImportPlan(parseHealthCsv(new TextDecoder().decode(bytes)));
    } else {
      const xml =
        fileType === "zip" ? await extractAppleHealthXml(bytes) : new TextDecoder().decode(bytes);
      plan = buildImportPlan(parseAppleHealthXml(xml));
    }

    if (plan.errors.length > 0) {
      self.postMessage({ ok: false, error: plan.errors.join(" ") } satisfies ParseResponse);
      return;
    }

    self.postMessage({
      ok: true,
      fileType,
      plan,
      parseMs: Date.now() - started,
    } satisfies ParseResponse);
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "The file could not be parsed.",
    } satisfies ParseResponse);
  }
};
