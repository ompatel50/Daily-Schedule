import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppleImportError, parseAppleHealthArchive } from "@/server/apple-health/parse-archive";
import { ZipArchive, ZipError } from "@/server/apple-health/zip-reader";
import { detectUploadType } from "@/server/apple-health/read-text";
import { APPLE_EXPORT_XML, APPLE_EXPORT_XML_RICH, ECG_CSV, ROUTE_GPX } from "./fixtures/apple-health";

/**
 * The server-side archive path: the ZIP reader, the member files, and the
 * failures the importer has to survive without losing the rest of an export.
 *
 * Archives are built by hand rather than shelled out to `zip`, so the suite
 * runs anywhere and can produce the malformed cases a real zipper refuses to
 * write — a truncated directory, an encrypted entry, a bomb.
 */

interface Member {
  name: string;
  content: string | Buffer;
  store?: boolean;
  encrypted?: boolean;
}

function buildZip(members: Member[], options: { corruptDirectory?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const raw = Buffer.isBuffer(member.content) ? member.content : Buffer.from(member.content, "utf8");
    const data = member.store ? raw : deflateRawSync(raw);
    const method = member.store ? 0 : 8;
    const flags = member.encrypted ? 0x1 : 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(options.corruptDirectory ? 0xffff0 : offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }

  const centralStart = offset;
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

let directory: string;
let counter = 0;

async function fileWith(content: Buffer | string): Promise<string> {
  const path = join(directory, `case-${counter++}`);
  await writeFile(path, content);
  return path;
}

async function zipFile(members: Member[], options?: { corruptDirectory?: boolean }): Promise<string> {
  return fileWith(buildZip(members, options));
}

/** The full Apple layout: export.xml plus the member files beside it. */
function appleLayout(xml = APPLE_EXPORT_XML_RICH): Member[] {
  return [
    { name: "apple_health_export/export_cda.xml", content: "<ClinicalDocument/>" },
    { name: "apple_health_export/export.xml", content: xml },
    { name: "apple_health_export/clinical-records/Medication-1.json", content: '{"resourceType":"Medication"}' },
    { name: "apple_health_export/electrocardiograms/ecg_2026-03-14.csv", content: ECG_CSV },
    { name: "apple_health_export/workout-routes/route_2026-03-14_6.00pm.gpx", content: ROUTE_GPX },
  ];
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-os-archive-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("ZIP reader", () => {
  it("lists deflated and stored entries from the central directory", async () => {
    const archive = await ZipArchive.open(await zipFile(appleLayout()));
    expect(archive.entries.map((entry) => entry.name)).toContain("apple_health_export/export.xml");
    await archive.close();
  });

  it("refuses a file that is not a ZIP at all", async () => {
    await expect(ZipArchive.open(await fileWith("plain text, no directory"))).rejects.toBeInstanceOf(
      ZipError,
    );
  });

  it("refuses an empty file", async () => {
    await expect(ZipArchive.open(await fileWith(""))).rejects.toThrow(/too small/);
  });

  it("refuses an archive whose directory points nowhere", async () => {
    const archive = await ZipArchive.open(
      await zipFile([{ name: "export.xml", content: "<HealthData/>" }], { corruptDirectory: true }),
    );
    const entry = archive.entries[0];
    await expect(archive.openEntry(entry, 1024)).rejects.toThrow(/local file header/);
    await archive.close();
  });

  it("refuses an encrypted entry rather than reading noise", async () => {
    const archive = await ZipArchive.open(
      await zipFile([{ name: "export.xml", content: "<HealthData/>", encrypted: true }]),
    );
    await expect(archive.openEntry(archive.entries[0], 1024)).rejects.toThrow(/encrypted/);
    await archive.close();
  });

  it("refuses a path that tries to escape the archive", async () => {
    await expect(
      ZipArchive.open(await zipFile([{ name: "../../etc/passwd", content: "x" }])),
    ).rejects.toThrow(/unsafe file path/);
    await expect(
      ZipArchive.open(await zipFile([{ name: "/etc/passwd", content: "x" }])),
    ).rejects.toThrow(/unsafe file path/);
  });

  it("stops a decompression bomb at its byte budget", async () => {
    // 8 MB of zeroes compresses to a few kilobytes.
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
    const archive = await ZipArchive.open(await zipFile([{ name: "export.xml", content: bomb }]));
    const stream = await archive.openEntry(archive.entries[0], 64 * 1024);
    await expect(
      (async () => {
        for await (const _chunk of stream) void _chunk;
      })(),
    ).rejects.toThrow(/expands to more than/);
    await archive.close();
  });
});

describe("archive parsing", () => {
  it("reads export.xml plus the ECG and route member files", async () => {
    const result = await parseAppleHealthArchive(await zipFile(appleLayout()), "zip");
    expect(result.rows.length).toBeGreaterThan(20);
    expect(result.xmlBytes).toBeGreaterThan(1000);
    expect(result.records.some((record) => record.kind === "ecg")).toBe(true);
    expect(result.records.some((record) => record.kind === "workout_route")).toBe(true);
    expect(result.records.some((record) => record.kind === "medication")).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("says which member files it deliberately did not read", async () => {
    const result = await parseAppleHealthArchive(await zipFile(appleLayout()), "zip");
    expect(result.ignoredFiles.join(" ")).toMatch(/clinical document duplicate/);
    expect(result.ignoredFiles.join(" ")).toMatch(/FHIR/);
  });

  it("prefers apple_health_export/export.xml over a stray export.xml", async () => {
    const result = await parseAppleHealthArchive(
      await zipFile([
        { name: "other/export.xml", content: "<HealthData></HealthData>" },
        { name: "apple_health_export/export.xml", content: APPLE_EXPORT_XML },
      ]),
      "zip",
    );
    expect(result.workouts).toHaveLength(2);
  });

  it("explains itself when the archive is not a health export", async () => {
    await expect(
      parseAppleHealthArchive(await zipFile([{ name: "notes.txt", content: "hello" }]), "zip"),
    ).rejects.toThrow(/no export\.xml/);
  });

  it("refuses an export.xml with no HealthData element", async () => {
    await expect(
      parseAppleHealthArchive(
        await zipFile([{ name: "apple_health_export/export.xml", content: "<html><body/></html>" }]),
        "zip",
      ),
    ).rejects.toThrow(/not an Apple Health export/);
  });

  it("turns malformed XML into a readable failure, not a crash", async () => {
    await expect(
      parseAppleHealthArchive(
        await zipFile([
          { name: "apple_health_export/export.xml", content: "<HealthData><Record></Workout>" },
        ]),
        "zip",
      ),
    ).rejects.toBeInstanceOf(AppleImportError);
  });

  it("refuses an entity-declaring export from inside an archive", async () => {
    await expect(
      parseAppleHealthArchive(
        await zipFile([
          {
            name: "apple_health_export/export.xml",
            content: '<!DOCTYPE HealthData [<!ENTITY x "y">]><HealthData/>',
          },
        ]),
        "zip",
      ),
    ).rejects.toThrow(/entity/);
  });

  it("keeps the whole import when one member file is damaged", async () => {
    const members = appleLayout();
    members.push({
      name: "apple_health_export/electrocardiograms/ecg_broken.csv",
      content: "this is not an ECG header at all",
    });
    const result = await parseAppleHealthArchive(await zipFile(members), "zip");
    expect(result.rows.length).toBeGreaterThan(20);
    expect(result.errors.join(" ")).toMatch(/ecg_broken\.csv/);
    // The good ECG still came through.
    expect(result.records.filter((record) => record.kind === "ecg")).toHaveLength(1);
  });

  it("reads a bare export.xml too", async () => {
    const result = await parseAppleHealthArchive(await fileWith(APPLE_EXPORT_XML), "xml");
    expect(result.workouts).toHaveLength(2);
    expect(result.ignoredFiles).toHaveLength(0);
  });

  it("handles an empty export without inventing records", async () => {
    const result = await parseAppleHealthArchive(
      await zipFile([
        {
          name: "apple_health_export/export.xml",
          content: '<?xml version="1.0"?><HealthData locale="en_GB"></HealthData>',
        },
      ]),
      "zip",
    );
    expect(result.rows).toHaveLength(0);
    expect(result.workouts).toHaveLength(0);
    expect(result.records).toHaveLength(0);
    expect(result.examined).toBe(0);
  });

  it("reads a large export in bounded memory and a sane time", async () => {
    // 60,000 records across 400 days — the shape of a multi-year export,
    // small enough to run in CI. The accumulators must stay proportional to
    // the days, not to the records.
    const lines: string[] = ['<?xml version="1.0"?>', '<HealthData locale="en_GB">'];
    for (let day = 0; day < 400; day += 1) {
      const date = new Date(Date.UTC(2024, 0, 1 + day)).toISOString().slice(0, 10);
      for (let sample = 0; sample < 150; sample += 1) {
        const hour = String(sample % 24).padStart(2, "0");
        const minute = String(sample % 60).padStart(2, "0");
        lines.push(
          `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" ` +
            `startDate="${date} ${hour}:${minute}:00 -0400" endDate="${date} ${hour}:${minute}:30 -0400" value="17"/>`,
        );
      }
    }
    lines.push("</HealthData>");
    const path = await zipFile([
      { name: "apple_health_export/export.xml", content: lines.join("\n") },
    ]);

    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const result = await parseAppleHealthArchive(path, "zip");
    const elapsed = Date.now() - started;
    const grew = process.memoryUsage().heapUsed - before;

    expect(result.examined).toBe(60_000);
    // One row per day per device, not one per sample — that is the whole point.
    expect(result.rows).toHaveLength(400);
    expect(result.rows[0].value).toBe(150 * 17);
    expect(elapsed).toBeLessThan(30_000);
    // 60,000 records folded into 400 rows must not cost tens of megabytes.
    expect(grew).toBeLessThan(120 * 1024 * 1024);
  }, 60_000);
});

describe("upload type detection", () => {
  it("decides from the bytes, not the name", async () => {
    const zip = await zipFile([{ name: "apple_health_export/export.xml", content: "<HealthData/>" }]);
    expect(await detectUploadType(zip, "totally-a.csv")).toBe("zip");
    expect(await detectUploadType(await fileWith(APPLE_EXPORT_XML), "renamed.txt")).toBe("xml");
    expect(await detectUploadType(await fileWith("metricType,value,date\n"), "data.csv")).toBe("csv");
    expect(await detectUploadType(await fileWith("random bytes"), "mystery.bin")).toBeNull();
  });
});
