/**
 * The server-side health import, against real PostgreSQL.
 *
 * The whole path: parse an archive → stage → preview → confirm → re-import →
 * undo, plus the ownership rules that must hold at every step. All data is
 * synthetic; nothing here talks to a network.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { buildApplePlan, buildImportPlan } from "@/lib/logic/health-import/rollup";
import { parseHealthCsv } from "@/lib/logic/health-import/csv";
import { parseAppleHealthArchive } from "@/server/apple-health/parse-archive";
import {
  IMPORT_FORMAT_VERSION,
  confirmHealthImport,
  getImportDashboard,
  getStagedPreview,
  listImportBatches,
  previewBatchRemoval,
  removeImportBatch,
  stageImport,
} from "@/server/health-import";
import { getHealthIntegrityReport } from "@/server/health-integrity";
import {
  cancelHealthImportAction,
  confirmHealthImportAction,
  getHealthImportPreviewAction,
  previewBatchRemovalAction,
  removeImportBatchAction,
} from "@/server/actions/health-import";
import { actAs, resetDatabase, twoUsers } from "./helpers";
import { APPLE_EXPORT_XML_RICH, ECG_CSV, ROUTE_GPX, VALID_CSV } from "../fixtures/apple-health";

import type { User } from "./helpers";

let alice: User;
let bob: User;
let directory: string;
let counter = 0;

// --- a hand-built archive, so the suite needs no external zipper -------------

function buildZip(members: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const raw = Buffer.from(member.content, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

async function writeArchive(xml = APPLE_EXPORT_XML_RICH): Promise<string> {
  const path = join(directory, `export-${counter++}.zip`);
  await writeFile(
    path,
    buildZip([
      { name: "apple_health_export/export.xml", content: xml },
      { name: "apple_health_export/electrocardiograms/ecg_2026-03-14.csv", content: ECG_CSV },
      {
        name: "apple_health_export/workout-routes/route_2026-03-14_6.00pm.gpx",
        content: ROUTE_GPX,
      },
    ]),
  );
  return path;
}

/** Parse an archive and stage it for `user`, exactly as the route handler does. */
async function stageArchive(user: User, xml = APPLE_EXPORT_XML_RICH) {
  const parsed = await parseAppleHealthArchive(await writeArchive(xml), "zip");
  const result = await stageImport(user.id, {
    kind: "apple_health",
    fileType: "zip",
    fileName: "export.zip",
    fileSize: 4096,
    plan: buildApplePlan(parsed),
    parseMs: 12,
    xmlBytes: parsed.xmlBytes,
    ignoredFiles: parsed.ignoredFiles,
    errors: parsed.errors,
  });
  if (!result.ok) throw new Error(`staging failed: ${result.error}`);
  return result.preview;
}

async function stageCsv(user: User, csv = VALID_CSV) {
  const result = await stageImport(user.id, {
    kind: "csv",
    fileType: "csv",
    fileName: "health.csv",
    fileSize: csv.length,
    plan: buildImportPlan(parseHealthCsv(csv)),
    parseMs: 3,
    xmlBytes: 0,
    ignoredFiles: [],
    errors: [],
  });
  if (!result.ok) throw new Error(`staging failed: ${result.error}`);
  return result.preview;
}

const allCategories = (preview: { categories: Array<{ key: string }> }) =>
  preview.categories.map((category) => category.key);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-os-health-import-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

// ---------------------------------------------------------------------------

describe("staging", () => {
  it("writes nothing to the health tables", async () => {
    const preview = await stageArchive(alice);
    expect(preview.categories.length).toBeGreaterThan(10);
    expect(await prisma.healthMetric.count()).toBe(0);
    expect(await prisma.healthRecord.count()).toBe(0);
    expect(await prisma.workout.count()).toBe(0);
    expect(await prisma.healthImportBatch.count()).toBe(0);
    // The rows are staged, not stored as health data.
    expect(await prisma.healthImportChunk.count()).toBeGreaterThan(0);
  });

  it("reports the parse cost and the archive's ignored members", async () => {
    const preview = await stageArchive(alice);
    expect(preview.xmlBytes).toBeGreaterThan(0);
    expect(preview.parseMs).toBeGreaterThanOrEqual(0);
    expect(preview.examined).toBeGreaterThan(30);
  });

  it("refuses an export with nothing importable in it", async () => {
    // A bare archive: no ECG, no route, and an export.xml with no records.
    const path = join(directory, `empty-${counter++}.zip`);
    await writeFile(
      path,
      buildZip([
        {
          name: "apple_health_export/export.xml",
          content: '<?xml version="1.0"?><HealthData locale="en_GB"></HealthData>',
        },
      ]),
    );
    const parsed = await parseAppleHealthArchive(path, "zip");
    const result = await stageImport(alice.id, {
      kind: "apple_health",
      fileType: "zip",
      fileName: "empty.zip",
      fileSize: 100,
      plan: buildApplePlan(parsed),
      parseMs: 1,
      xmlBytes: parsed.xmlBytes,
      ignoredFiles: [],
      errors: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Nothing importable/);
  });

  it("caps how many imports one account can hold unconfirmed", async () => {
    await stageArchive(alice);
    await stageArchive(alice);
    await stageArchive(alice);
    const parsed = await parseAppleHealthArchive(await writeArchive(), "zip");
    const fourth = await stageImport(alice.id, {
      kind: "apple_health",
      fileType: "zip",
      fileName: "export.zip",
      fileSize: 4096,
      plan: buildApplePlan(parsed),
      parseMs: 1,
      xmlBytes: parsed.xmlBytes,
      ignoredFiles: [],
      errors: [],
    });
    expect(fourth.ok).toBe(false);
  });

  it("keeps only the base name of the uploaded file", async () => {
    const parsed = await parseAppleHealthArchive(await writeArchive(), "zip");
    const result = await stageImport(alice.id, {
      kind: "apple_health",
      fileType: "zip",
      fileName: "/Users/someone/Desktop/export.zip",
      fileSize: 4096,
      plan: buildApplePlan(parsed),
      parseMs: 1,
      xmlBytes: parsed.xmlBytes,
      ignoredFiles: [],
      errors: [],
    });
    expect(result.ok && result.preview.fileName).toBe("export.zip");
  });
});

describe("confirming", () => {
  it("writes the chosen categories and nothing else", async () => {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, ["steps", "flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const types = await prisma.healthMetric.findMany({ distinct: ["type"], select: { type: true } });
    expect(types.map((row) => row.type).sort()).toEqual(["flights_climbed"]);
    expect(await prisma.workout.count()).toBe(0);
    expect(await prisma.healthRecord.count()).toBe(0);
  });

  it("writes metrics, workouts and records together when all are chosen", async () => {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.outcome.imported).toBeGreaterThan(20);
    expect(result.outcome.workoutsImported).toBe(1);
    expect(result.outcome.recordsImported).toBeGreaterThanOrEqual(3);
    expect(await prisma.healthMetric.count({ where: { userId: alice.id } })).toBe(
      result.outcome.imported,
    );

    const batch = await prisma.healthImportBatch.findFirstOrThrow({ where: { userId: alice.id } });
    expect(batch.status).toBe("completed");
    expect(batch.startedAt).toBeTruthy();
    expect(batch.finishedAt).toBeTruthy();
    expect(batch.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number(batch.xmlBytes)).toBeGreaterThan(0);
  });

  it("stores blood pressure with its diastolic in the column aggregation reads", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, ["blood_pressure"]);
    const row = await prisma.healthMetric.findFirstOrThrow({
      where: { userId: alice.id, type: "blood_pressure" },
    });
    expect(row.value).toBe(118);
    expect(row.secondaryValue).toBe(76);
  });

  it("deletes the staged session once the import is written", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    expect(await prisma.healthImportSession.count()).toBe(0);
    expect(await prisma.healthImportChunk.count()).toBe(0);
  });

  it("refuses a confirmation that selects no category at all", async () => {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, []);
    expect(result.ok).toBe(false);
    expect(await prisma.healthMetric.count()).toBe(0);
  });

  it("imports a CSV through the same pipeline", async () => {
    const preview = await stageCsv(alice);
    const result = await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    expect(result.ok).toBe(true);
    const rows = await prisma.healthMetric.findMany({ where: { userId: alice.id } });
    expect(rows.length).toBe(5);
    // A CSV can never claim to be a device measurement.
    expect(rows.every((row) => row.source !== "apple_health")).toBe(true);
  });
});

describe("duplicates and re-import", () => {
  it("re-importing the same export writes nothing new", async () => {
    const first = await stageArchive(alice);
    const firstResult = await confirmHealthImport(alice.id, first.token, allCategories(first));
    expect(firstResult.ok).toBe(true);
    const afterFirst = await prisma.healthMetric.count({ where: { userId: alice.id } });

    const second = await stageArchive(alice);
    // The preview says so before anything is written.
    const totals = second.categories.reduce(
      (sum, category) => sum + category.newRows,
      0,
    );
    expect(totals).toBe(0);

    const secondResult = await confirmHealthImport(alice.id, second.token, allCategories(second));
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    expect(secondResult.outcome.imported).toBe(0);
    expect(secondResult.outcome.duplicates).toBeGreaterThan(0);
    expect(await prisma.healthMetric.count({ where: { userId: alice.id } })).toBe(afterFirst);
    expect(await prisma.workout.count({ where: { userId: alice.id } })).toBe(1);
    expect(await prisma.healthRecord.count({ where: { userId: alice.id } })).toBe(
      firstResult.ok ? firstResult.outcome.recordsImported : 0,
    );
  });

  it("a later, fuller export updates the day rather than duplicating it", async () => {
    const first = await stageArchive(alice);
    await confirmHealthImport(alice.id, first.token, ["flights_climbed"]);
    const before = await prisma.healthMetric.findFirstOrThrow({
      where: { userId: alice.id, type: "flights_climbed" },
    });
    expect(before.value).toBe(11);

    // The same day, with one more flight recorded after the first export.
    const fuller = APPLE_EXPORT_XML_RICH.replace(
      "</HealthData>",
      '  <Record type="HKQuantityTypeIdentifierFlightsClimbed" sourceName="Phone" unit="count" startDate="2026-03-14 20:00:00 -0400" endDate="2026-03-14 20:01:00 -0400" value="5"/>\n</HealthData>',
    );
    const second = await stageArchive(alice, fuller);
    const result = await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.updated).toBe(1);
    expect(result.outcome.imported).toBe(0);

    const rows = await prisma.healthMetric.findMany({
      where: { userId: alice.id, type: "flights_climbed" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(16);
    // The refreshed row now belongs to the NEWER batch, so undoing the older
    // one can no longer reach it.
    expect(rows[0].batchId).not.toBe(before.batchId);
  });

  it("skips an imported workout that duplicates one the user logged themselves", async () => {
    await prisma.workout.create({
      data: {
        userId: alice.id,
        date: "2026-03-14",
        time: "18:05",
        name: "Evening run",
        type: "running",
        durationMin: 33,
        status: "completed",
        source: "manual",
      },
    });
    const preview = await stageArchive(alice);
    const workouts = preview.categories.find((category) => category.key === "workouts");
    expect(workouts?.unchangedRows).toBe(1);

    // Selecting a category whose every row is already present is a safe
    // re-import, not an error: it succeeds and records a zero-write batch.
    const result = await confirmHealthImport(alice.id, preview.token, ["workouts"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.workoutsImported).toBe(0);
    expect(result.outcome.workoutsSkipped).toBe(1);
    // The user's own record is untouched.
    const kept = await prisma.workout.findFirstOrThrow({ where: { userId: alice.id } });
    expect(kept.name).toBe("Evening run");
  });
});

describe("ownership", () => {
  it("another account cannot preview, confirm or cancel a staged import", async () => {
    const preview = await stageArchive(alice);

    actAs(bob);
    expect((await getHealthImportPreviewAction(preview.token)).ok).toBe(false);
    expect((await confirmHealthImportAction({ token: preview.token, categories: ["steps"] })).ok).toBe(
      false,
    );
    await cancelHealthImportAction(preview.token);
    // Cancelling as Bob is a no-op, so Alice's session survives.
    actAs(alice);
    expect(await getStagedPreview(alice.id, preview.token)).toBeTruthy();
    expect(await prisma.healthImportSession.count()).toBe(1);
  });

  it("another account cannot preview or undo an import batch", async () => {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, ["steps", "flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const batchId = result.outcome.batchId;

    actAs(bob);
    expect((await previewBatchRemovalAction(batchId)).ok).toBe(false);
    expect((await removeImportBatchAction(batchId)).ok).toBe(false);
    expect(await previewBatchRemoval(bob.id, batchId)).toBeNull();
    expect((await removeImportBatch(bob.id, batchId)).ok).toBe(false);

    // Alice's rows are all still there.
    expect(await prisma.healthMetric.count({ where: { userId: alice.id } })).toBeGreaterThan(0);
  });

  it("an import only ever writes rows owned by the importing account", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    expect(await prisma.healthMetric.count({ where: { userId: bob.id } })).toBe(0);
    expect(await prisma.healthRecord.count({ where: { userId: bob.id } })).toBe(0);
    expect(await prisma.workout.count({ where: { userId: bob.id } })).toBe(0);
  });

  it("two accounts importing the same export do not collide", async () => {
    const aliceStaged = await stageArchive(alice);
    await confirmHealthImport(alice.id, aliceStaged.token, allCategories(aliceStaged));

    actAs(bob);
    const bobStaged = await stageArchive(bob);
    const result = await confirmHealthImport(bob.id, bobStaged.token, allCategories(bobStaged));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bob's import is entirely new to Bob, however much Alice already has.
    expect(result.outcome.imported).toBeGreaterThan(20);
    expect(result.outcome.duplicates).toBe(0);
  });

  it("an expired session cannot be confirmed", async () => {
    const preview = await stageArchive(alice);
    await prisma.healthImportSession.update({
      where: { id: preview.token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const result = await confirmHealthImport(alice.id, preview.token, ["steps"]);
    expect(result.ok).toBe(false);
    expect(await prisma.healthMetric.count()).toBe(0);
  });
});

describe("undo", () => {
  async function importEverything() {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    if (!result.ok) throw new Error(result.error);
    return result.outcome;
  }

  it("previews exactly what it would delete before deleting anything", async () => {
    const outcome = await importEverything();
    const preview = await previewBatchRemoval(alice.id, outcome.batchId);
    expect(preview?.metricCount).toBe(outcome.imported);
    expect(preview?.workoutCount).toBe(1);
    expect(preview?.recordCount).toBe(outcome.recordsImported);
    expect(preview?.categories.length).toBeGreaterThan(5);
    // A preview writes nothing.
    expect(await prisma.healthMetric.count({ where: { userId: alice.id } })).toBe(outcome.imported);
  });

  it("removes the batch's rows and leaves manual entries alone", async () => {
    await prisma.healthMetric.create({
      data: {
        userId: alice.id,
        date: "2026-03-14",
        type: "steps",
        value: 4242,
        unit: "",
        source: "manual",
        fingerprint: "manual|steps|2026-03-14",
      },
    });
    const outcome = await importEverything();

    const result = await removeImportBatch(alice.id, outcome.batchId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.removedMetrics).toBe(outcome.imported);
    expect(result.report.removedWorkouts).toBe(1);

    const left = await prisma.healthMetric.findMany({ where: { userId: alice.id } });
    expect(left).toHaveLength(1);
    expect(left[0].source).toBe("manual");
    expect(left[0].value).toBe(4242);
  });

  it("keeps a row the user edited after the import", async () => {
    const outcome = await importEverything();
    const row = await prisma.healthMetric.findFirstOrThrow({
      where: { userId: alice.id, batchId: outcome.batchId, type: "flights_climbed" },
    });
    // A later write to the row — what an edit looks like from the undo's side.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await prisma.healthMetric.update({ where: { id: row.id }, data: { value: 9999 } });

    const preview = await previewBatchRemoval(alice.id, outcome.batchId);
    expect(preview?.keptEdited).toBe(1);

    const result = await removeImportBatch(alice.id, outcome.batchId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.keptCount).toBe(1);

    const kept = await prisma.healthMetric.findUnique({ where: { id: row.id } });
    expect(kept?.value).toBe(9999);
  });

  it("keeps an imported workout the user has since built on", async () => {
    const outcome = await importEverything();
    const workout = await prisma.workout.findFirstOrThrow({
      where: { userId: alice.id, importBatchId: outcome.batchId },
    });
    await prisma.workoutSet.create({
      data: { workoutId: workout.id, exercise: "Intervals", setNumber: 1, completed: true },
    });

    const preview = await previewBatchRemoval(alice.id, outcome.batchId);
    expect(preview?.workoutCount).toBe(0);
    expect(preview?.keptLinked).toBe(1);

    const result = await removeImportBatch(alice.id, outcome.batchId);
    expect(result.ok && result.report.removedWorkouts).toBe(0);
    expect(await prisma.workout.count({ where: { userId: alice.id } })).toBe(1);
  });

  it("is idempotent: a second undo does nothing", async () => {
    const outcome = await importEverything();
    expect((await removeImportBatch(alice.id, outcome.batchId)).ok).toBe(true);
    const second = await removeImportBatch(alice.id, outcome.batchId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already been undone/);
    expect(await previewBatchRemoval(alice.id, outcome.batchId)).toBeNull();
  });

  it("never touches another import's rows", async () => {
    const firstOutcome = await importEverything();
    // A second, disjoint import: different days entirely.
    const otherDays = APPLE_EXPORT_XML_RICH.replace(/2026-03-1(4|5)/g, (match) =>
      match.replace("2026-03-1", "2026-05-1"),
    );
    const second = await stageArchive(alice, otherDays);
    const secondResult = await confirmHealthImport(alice.id, second.token, allCategories(second));
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;

    await removeImportBatch(alice.id, firstOutcome.batchId);
    const left = await prisma.healthMetric.findMany({ where: { userId: alice.id } });
    expect(left.length).toBe(secondResult.outcome.imported);
    expect(left.every((row) => row.batchId === secondResult.outcome.batchId)).toBe(true);
  });

  it("records the undo in the history", async () => {
    const outcome = await importEverything();
    await removeImportBatch(alice.id, outcome.batchId);
    const [batch] = await listImportBatches(alice.id);
    expect(batch.status).toBe("removed");
    expect(batch.undoneAt).toBeTruthy();
    expect(batch.undoneCount).toBeGreaterThan(0);
  });
});

describe("history", () => {
  it("lists batches newest first with their counts and notes", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    const csvPreview = await stageCsv(alice);
    await confirmHealthImport(alice.id, csvPreview.token, allCategories(csvPreview));

    const batches = await listImportBatches(alice.id);
    expect(batches).toHaveLength(2);
    expect(batches[0].source).toBe("csv");
    expect(batches[1].source).toBe("apple_health");
    expect(batches[1].categoriesList.length).toBeGreaterThan(5);
    expect(Array.isArray(batches[1].warningsList)).toBe(true);
    expect(Array.isArray(batches[1].errorsList)).toBe(true);
    // BigInt never crosses the server boundary.
    expect(typeof batches[1].xmlBytes).toBe("number");
  });

  it("shows only this account's imports", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, ["steps"]);
    expect(await listImportBatches(bob.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Smart merge, the import dashboard, and the integrity checks.
// ---------------------------------------------------------------------------

/** The same day's flights, one flight fuller than the committed fixture. */
const FULLER_FLIGHTS = APPLE_EXPORT_XML_RICH.replace(
  "</HealthData>",
  '  <Record type="HKQuantityTypeIdentifierFlightsClimbed" sourceName="Phone" unit="count" startDate="2026-03-14 20:00:00 -0400" endDate="2026-03-14 20:01:00 -0400" value="5"/>\n</HealthData>',
);

describe("smart merge", () => {
  /** Import flights once and hand back the single row it wrote. */
  async function importFlights(user: User = alice) {
    const preview = await stageArchive(user);
    const result = await confirmHealthImport(user.id, preview.token, ["flights_climbed"]);
    if (!result.ok) throw new Error(result.error);
    const row = await prisma.healthMetric.findFirstOrThrow({
      where: { userId: user.id, type: "flights_climbed" },
    });
    return { row, outcome: result.outcome };
  }

  /** Edit a stored reading the way the user would — after the import finished. */
  async function editRow(id: string, value: number) {
    // Comfortably past the one-second grace, so this is unambiguously an edit
    // and not the import's own write landing late.
    await prisma.healthMetric.update({
      where: { id },
      data: { value, updatedAt: new Date(Date.now() + 60_000) },
    });
  }

  it("does not write over a reading the user edited after importing it", async () => {
    const { row } = await importFlights();
    expect(row.value).toBe(11);
    await editRow(row.id, 9);

    const second = await stageArchive(alice, FULLER_FLIGHTS);
    // The preview promises it before anything is written.
    const flights = second.categories.find((category) => category.key === "flights_climbed");
    expect(flights?.protectedRows).toBe(1);
    expect(flights?.updatedRows).toBe(0);
    expect(second.warnings.join(" ")).toContain("left exactly as");

    const result = await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.protectedRows).toBe(1);
    expect(result.outcome.updated).toBe(0);
    expect(result.outcome.imported).toBe(0);

    // The correction survived, unchanged, and still belongs to the old batch.
    const after = await prisma.healthMetric.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.value).toBe(9);
    expect(after.batchId).toBe(row.batchId);
  });

  it("still merges a reading the import itself owns and nobody has touched", async () => {
    const { row } = await importFlights();
    const second = await stageArchive(alice, FULLER_FLIGHTS);
    const flights = second.categories.find((category) => category.key === "flights_climbed");
    expect(flights?.updatedRows).toBe(1);
    expect(flights?.protectedRows).toBe(0);

    const result = await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.updated).toBe(1);
    expect(result.outcome.protectedRows).toBe(0);
    const after = await prisma.healthMetric.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.value).toBe(16);
  });

  it("re-reads ownership at confirm time, not from the stale preview", async () => {
    const { row } = await importFlights();
    // Staged while the row was still the import's…
    const second = await stageArchive(alice, FULLER_FLIGHTS);
    expect(
      second.categories.find((category) => category.key === "flights_climbed")?.updatedRows,
    ).toBe(1);

    // …then edited before the user got round to confirming.
    await editRow(row.id, 3);

    const result = await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.protectedRows).toBe(1);
    expect(result.outcome.updated).toBe(0);
    expect((await prisma.healthMetric.findUniqueOrThrow({ where: { id: row.id } })).value).toBe(3);
  });

  it("records what it protected on the batch, and stamps the pipeline version", async () => {
    const { row } = await importFlights();
    await editRow(row.id, 9);
    const second = await stageArchive(alice, FULLER_FLIGHTS);
    await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);

    const [latest] = await listImportBatches(alice.id, 1);
    expect(latest.protectedRows).toBe(1);
    expect(latest.formatVersion).toBe(IMPORT_FORMAT_VERSION);
  });

  it("protects a row whose batch belongs to another account", async () => {
    // Constructed rather than imported: it is the shape a hand-edited database
    // or a partially-restored backup produces, and the rule must hold for it.
    const { row: bobRow } = await importFlights(bob);
    const { row: aliceRow } = await importFlights(alice);
    await prisma.healthMetric.update({
      where: { id: aliceRow.id },
      data: { batchId: bobRow.batchId },
    });

    const second = await stageArchive(alice, FULLER_FLIGHTS);
    const result = await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.protectedRows).toBe(1);
    expect(
      (await prisma.healthMetric.findUniqueOrThrow({ where: { id: aliceRow.id } })).value,
    ).toBe(11);
  });

  it("leaves a protected row undoable by the batch that actually wrote it", async () => {
    // The two rules share a boundary instant, so a row protected from
    // re-import must still be classified as edited — and therefore kept — by
    // undo. The contradiction to avoid is a row neither rule will touch being
    // silently removed by the other.
    const { row } = await importFlights();
    await editRow(row.id, 9);
    const second = await stageArchive(alice, FULLER_FLIGHTS);
    await confirmHealthImport(alice.id, second.token, ["flights_climbed"]);

    const removal = await removeImportBatch(alice.id, row.batchId as string);
    expect(removal.ok).toBe(true);
    if (!removal.ok) return;
    expect(removal.report.keptCount).toBe(1);
    expect(
      await prisma.healthMetric.findUnique({ where: { id: row.id } }),
    ).not.toBeNull();
  });
});

describe("the import dashboard", () => {
  it("is empty and honest for an account that has never imported", async () => {
    const dashboard = await getImportDashboard(alice.id, "2026-03-20");
    expect(dashboard.batches).toEqual([]);
    expect(dashboard.totals.runs).toBe(0);
    expect(dashboard.lastSuccessful).toBeNull();
    expect(dashboard.recency).toBe("never");
    expect(dashboard.pending).toBe(0);
    expect(dashboard.truncated).toBe(false);
  });

  it("totals every run, not only the ones on the page", async () => {
    const first = await stageArchive(alice);
    await confirmHealthImport(alice.id, first.token, ["steps", "flights_climbed"]);
    const second = await stageCsv(alice);
    await confirmHealthImport(alice.id, second.token, allCategories(second));

    const dashboard = await getImportDashboard(alice.id, "2026-03-20", 1);
    expect(dashboard.batches).toHaveLength(1);
    expect(dashboard.truncated).toBe(true);
    expect(dashboard.totals.runs).toBe(2);
    expect(dashboard.totals.completed).toBe(2);
    // The sum spans both batches even though only one was listed.
    expect(dashboard.totals.readingsWritten).toBeGreaterThan(dashboard.batches[0].imported);
  });

  it("counts an undone import separately and stops offering it as the last success", async () => {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, ["steps"]);
    if (!result.ok) return;
    await removeImportBatch(alice.id, result.outcome.batchId);

    const dashboard = await getImportDashboard(alice.id, "2026-03-20");
    expect(dashboard.totals.runs).toBe(1);
    expect(dashboard.totals.undone).toBe(1);
    expect(dashboard.totals.completed).toBe(0);
    expect(dashboard.lastSuccessful).toBeNull();
    expect(dashboard.recency).toBe("never");
  });

  it("surfaces a staged import that has not been confirmed", async () => {
    await stageArchive(alice);
    const dashboard = await getImportDashboard(alice.id, "2026-03-20");
    expect(dashboard.pending).toBe(1);
    // Staging writes no batch, so the history is still empty.
    expect(dashboard.totals.runs).toBe(0);
  });

  it("dates recency against the user's today, not the host clock", async () => {
    const preview = await stageArchive(alice);
    const result = await confirmHealthImport(alice.id, preview.token, ["steps"]);
    if (!result.ok) return;
    await prisma.healthImportBatch.update({
      where: { id: result.outcome.batchId },
      data: {
        createdAt: new Date("2026-03-01T09:00:00.000Z"),
        finishedAt: new Date("2026-03-01T09:00:00.000Z"),
      },
    });

    expect((await getImportDashboard(alice.id, "2026-03-01")).recency).toBe("today");
    expect((await getImportDashboard(alice.id, "2026-03-05")).recency).toBe("week");
    expect((await getImportDashboard(alice.id, "2026-03-20")).recency).toBe("month");
    expect((await getImportDashboard(alice.id, "2026-06-20")).recency).toBe("stale");
    expect((await getImportDashboard(alice.id, "2026-03-05")).lastSuccessful?.daysAgo).toBe(4);
  });

  it("shows one account nothing about another's imports", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, ["steps"]);
    await stageArchive(alice);

    const bobsView = await getImportDashboard(bob.id, "2026-03-20");
    expect(bobsView.batches).toEqual([]);
    expect(bobsView.totals.runs).toBe(0);
    expect(bobsView.totals.readingsWritten).toBe(0);
    expect(bobsView.pending).toBe(0);
    expect(bobsView.lastSuccessful).toBeNull();
  });
});

describe("integrity checks", () => {
  it("reports a clean account as clean", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, allCategories(preview));
    const report = await getHealthIntegrityReport(alice.id, "2026-03-20");
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("catches a unit no aggregation can read back", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, ["lean_body_mass", "steps"]);
    const mangled = await prisma.healthMetric.updateMany({
      where: { userId: alice.id, type: "lean_body_mass" },
      data: { unit: "stones-and-a-bit" },
    });
    expect(mangled.count).toBeGreaterThan(0);

    const report = await getHealthIntegrityReport(alice.id, "2026-03-20");
    const finding = report.findings.find((entry) => entry.code === "unreadable_unit");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("stones-and-a-bit");
    expect(finding?.detail).toContain("Lean body mass");
    expect(report.clean).toBe(false);
  });

  it("catches a future-dated reading and an unknown metric", async () => {
    const preview = await stageArchive(alice);
    await confirmHealthImport(alice.id, preview.token, ["steps"]);
    await prisma.healthMetric.create({
      data: {
        userId: alice.id,
        date: "2099-01-01",
        type: "steps",
        value: 1000,
        unit: "",
        source: "manual",
        fingerprint: "manual|steps|2099-01-01",
      },
    });
    await prisma.healthMetric.create({
      data: {
        userId: alice.id,
        date: "2026-03-14",
        type: "hk_something_new",
        value: 1,
        unit: "",
        source: "apple_health",
        fingerprint: "ah|hk_something_new|2026-03-14|Watch",
      },
    });

    const report = await getHealthIntegrityReport(alice.id, "2026-03-20");
    expect(report.findings.map((finding) => finding.code)).toContain("future_dated");
    expect(report.findings.map((finding) => finding.code)).toContain("unknown_metric_type");
  });

  it("never sees another account's rows", async () => {
    const preview = await stageArchive(bob);
    await confirmHealthImport(bob.id, preview.token, ["lean_body_mass"]);
    const mangled = await prisma.healthMetric.updateMany({
      where: { userId: bob.id, type: "lean_body_mass" },
      data: { unit: "not-a-unit", date: "2099-01-01" },
    });
    expect(mangled.count).toBeGreaterThan(0);

    // Bob's account is a mess; Alice's is untouched by it.
    expect((await getHealthIntegrityReport(bob.id, "2026-03-20")).clean).toBe(false);
    expect((await getHealthIntegrityReport(alice.id, "2026-03-20")).clean).toBe(true);
  });
});
