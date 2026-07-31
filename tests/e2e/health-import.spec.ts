import { deflateRawSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The whole import, through the browser: choose a file → it uploads and is
 * parsed on the server → preview → confirm → the data appears across the
 * Health section and in search → re-importing is a no-op → undo puts
 * everything back.
 *
 * The export is built here rather than fixture-loaded, so this runs against
 * any database including CI's empty one, and every run cleans up after itself
 * by undoing the import it created.
 *
 * It runs as `importer` — an account no other spec touches. Spec files run in
 * parallel across workers, and this one writes a month of readings, rebuilds
 * every affected day, and then undoes all of it; sharing an account with the
 * manual-entry check made the two race for the same rows.
 */

test.use({ storageState: STORAGE.importer });
test.describe.configure({ mode: "serial" });
// Uploading, parsing and writing a 30-day export, then undoing it, is more
// than the suite's default 30 s allows on a cold CI runner.
test.setTimeout(180_000);

/**
 * Console errors are a failure, not a warning — collected per test and asserted
 * at the end of each one.
 *
 * The single exclusion is Vercel's analytics script, which 404s whenever the
 * app runs anywhere other than the Vercel platform. That is a property of the
 * environment, not of this app, and every other console error is real.
 */
const IGNORED_CONSOLE = [/_vercel\/insights/];

function watchConsole(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A failed resource load reports a generic "Failed to load resource: 404"
    // and puts the URL in the location instead, so both have to be considered:
    // matching on the text alone can neither exclude the known-noisy request
    // nor tell a reader which request failed.
    const where = message.location()?.url ?? "";
    const entry = where ? `${message.text()} (${where})` : message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(entry))) return;
    errors.push(entry);
  });
  page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));
  return () => errors;
}

/** A minimal ZIP writer: deflate each member, then a central directory. */
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

/**
 * Thirty days of a plausible export, dated relative to today so it lands
 * inside the ranges the Health pages default to. Deliberately distinctive
 * source names, so the assertions cannot pass on somebody else's data.
 */
const MEDICATION = "Atorvastatin 20 mg (browser test)";

function buildExportXml(): string {
  const days: string[] = [];
  for (let back = 30; back >= 1; back -= 1) {
    days.push(new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10));
  }

  const records = days.flatMap((day, index) => [
    `  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="E2E Watch" unit="count" startDate="${day} 08:00:00 -0400" endDate="${day} 08:10:00 -0400" value="${4000 + index * 37}"/>`,
    `  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="E2E Watch" unit="count" startDate="${day} 18:00:00 -0400" endDate="${day} 18:10:00 -0400" value="${1200 + index * 11}"/>`,
    `  <Record type="HKQuantityTypeIdentifierFlightsClimbed" sourceName="E2E Phone" unit="count" startDate="${day} 09:00:00 -0400" endDate="${day} 09:01:00 -0400" value="${3 + (index % 9)}"/>`,
    `  <Record type="HKQuantityTypeIdentifierVO2Max" sourceName="E2E Watch" unit="mL/min·kg" startDate="${day} 09:00:00 -0400" endDate="${day} 09:00:00 -0400" value="${(40 + index * 0.05).toFixed(1)}"/>`,
    `  <Record type="HKQuantityTypeIdentifierDietaryProtein" sourceName="E2E Food" unit="g" startDate="${day} 12:00:00 -0400" endDate="${day} 12:00:00 -0400" value="${90 + (index % 40)}"/>`,
    `  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="E2E Watch" startDate="${day} 00:30:00 -0400" endDate="${day} 04:00:00 -0400" value="HKCategoryValueSleepAnalysisAsleepCore"/>`,
    `  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="E2E Watch" startDate="${day} 04:00:00 -0400" endDate="${day} 05:20:00 -0400" value="HKCategoryValueSleepAnalysisAsleepREM"/>`,
    // An unsupported type, to prove it is counted and skipped rather than fatal.
    `  <Record type="HKQuantityTypeIdentifierEnvironmentalAudioExposure" sourceName="E2E Watch" unit="dBASPL" startDate="${day} 10:00:00 -0400" endDate="${day} 10:01:00 -0400" value="66"/>`,
    `  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="E2E Cuff" startDate="${day} 07:30:00 -0400" endDate="${day} 07:30:00 -0400">
   <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="E2E Cuff" unit="mmHg" startDate="${day} 07:30:00 -0400" endDate="${day} 07:30:00 -0400" value="${112 + (index % 12)}"/>
   <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" sourceName="E2E Cuff" unit="mmHg" startDate="${day} 07:30:00 -0400" endDate="${day} 07:30:00 -0400" value="${70 + (index % 9)}"/>
  </Correlation>`,
  ]);

  const workouts = days
    .filter((_, index) => index % 6 === 0)
    .map(
      (day) => `  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="34.5" durationUnit="min" sourceName="E2E Watch" startDate="${day} 18:00:00 -0400" endDate="${day} 18:34:30 -0400">
   <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="6.4" unit="km"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="455" unit="kcal"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="151" minimum="118" maximum="176" unit="count/min"/>
  </Workout>`,
    );

  // The DOCTYPE is the one a real export carries — an internal subset the
  // scanner must skip rather than refuse.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 12 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord)*)>
<!ATTLIST HealthData locale CDATA #REQUIRED>
]>
<HealthData locale="en_GB">
 <ExportDate value="${days[days.length - 1]} 09:00:00 -0400"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>
${records.join("\n")}
${workouts.join("\n")}
 <ClinicalRecord type="Medication" identifier="e2e-med-1" sourceName="E2E Clinic" fhirVersion="4.0.1" receivedDate="${days[0]} 10:00:00 -0500" resourceFilePath="/clinical-records/Medication-1.json" displayName="${MEDICATION}"/>
</HealthData>`;
}

let directory: string;
let archivePath: string;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-os-e2e-health-"));
  archivePath = join(directory, "export.zip");
  await writeFile(
    archivePath,
    buildZip([
      { name: "apple_health_export/export.xml", content: buildExportXml() },
      { name: "apple_health_export/export_cda.xml", content: "<ClinicalDocument/>" },
      {
        name: "apple_health_export/electrocardiograms/ecg_e2e.csv",
        content: [
          "Name,E2E Person",
          "Date of Birth,1990-01-01",
          `Recorded Date,${new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)} 09:15:00 -0400`,
          "Classification,Sinus Rhythm",
          "Symptoms,None",
          "Device,Apple Watch",
          "Average Heart Rate,64 bpm",
          "",
          "-12.3",
          "40.1",
        ].join("\n"),
      },
    ]),
  );
});

test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function upload(page: Page) {
  await page.goto("/health/import");
  await expect(page.getByRole("heading", { level: 2, name: "Import health data" })).toBeVisible();
  await page.setInputFiles('input[type="file"]', archivePath);
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeVisible({ timeout: 120_000 });
}

/**
 * Upload a file the importer must refuse, and assert the refusal.
 *
 * The assertion is on the **response**, not on the toast. A refusal for a tiny
 * file is near-instant and the toast auto-dismisses a few seconds later, so
 * asserting on the toast is a race that a slow runner loses — and it was
 * losing it. Waiting for the response is set up *before* the upload starts, so
 * it cannot be missed, and it checks the thing that actually matters: the
 * server refused, said why in a readable way, and no preview opened.
 */
async function expectRefusal(page: Page, file: string, reason: RegExp) {
  await page.goto("/health/import");
  await expect(page.getByRole("heading", { level: 2, name: "Import health data" })).toBeVisible();
  // Both waits are armed BEFORE the upload starts, which is the whole point:
  // a refusal for a tiny file is near-instant, so anything set up afterwards
  // is racing an outcome that has already happened.
  const responded = page.waitForResponse((response) =>
    response.url().includes("/api/health/import"),
  );
  const toasted = page.waitForSelector("[data-sonner-toast]", { state: "attached" });

  await page.setInputFiles('input[type="file"]', file);

  const response = await responded;
  expect(response.status(), "a refused import must not answer 2xx").toBeGreaterThanOrEqual(400);

  // The response body is deliberately not re-read here — the page has already
  // consumed it, and Chromium evicts a consumed body from the inspector cache.
  // What the user is told is the thing worth asserting anyway.
  const toast = await toasted;
  expect(await toast.textContent(), "the refusal must say why").toMatch(reason);

  // Nothing was staged, so the preview never opens.
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeHidden();
}

test("imports an Apple Health export end to end, then undoes it", async ({ page }) => {
  const consoleErrors = watchConsole(page);

  // --- preview ---------------------------------------------------------------
  await upload(page);
  const dialog = page.getByRole("dialog");
  const previewText = (await dialog.textContent()) ?? "";
  for (const category of [
    "Steps",
    "Flights climbed",
    "VO₂ max",
    "Protein",
    "Sleep",
    "Blood pressure",
    "Workouts",
    "Health records",
  ]) {
    expect(previewText, `preview is missing the ${category} category`).toContain(category);
  }
  // Unsupported types are reported, not fatal.
  expect(previewText).toContain("unsupported types were skipped");

  // --- confirm ---------------------------------------------------------------
  await dialog.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Done" }).click();

  // --- the data is where it should be ---------------------------------------
  await page.goto("/health/activity");
  await expect(page.getByTestId("metric-steps")).toContainText("days with data");
  await page.goto("/health/vitals");
  await expect(page.getByTestId("metric-blood_pressure")).toContainText("mmHg");
  await expect(page.getByText(MEDICATION)).toBeVisible();
  await page.goto("/health/sleep");
  await expect(page.getByRole("columnheader", { name: "Asleep" })).toBeVisible();
  await page.goto("/health/workouts");
  await expect(page.getByText("Apple Health").first()).toBeVisible();

  // --- re-importing the same file writes nothing -----------------------------
  await upload(page);
  const previewDialog = page.getByRole("dialog");
  // Wait for a badge to exist before reading the dialog's text: `textContent`
  // is a single snapshot, so taking it the instant the heading appears can
  // catch the dialog before its category list has rendered.
  await expect(previewDialog.getByText(/already present/).first()).toBeVisible();
  const again = (await previewDialog.textContent()) ?? "";
  // No "<n> new" and no "<n> merged": every row the second file carries is one
  // the first already wrote, unchanged. Matched as the badges' own shapes
  // rather than the bare words, which could legitimately appear in a warning.
  expect(again).not.toMatch(/\d+ new/);
  expect(again).not.toMatch(/\d+ merged/);
  await page.getByRole("button", { name: /Cancel/ }).click();
  await expect(previewDialog).toBeHidden();

  // --- undo ------------------------------------------------------------------
  await page.goto("/health/imports");
  const undoButton = page.getByRole("button", { name: /^Undo the import/ }).first();
  await expect(undoButton).toBeVisible();
  await undoButton.click();

  const undoDialog = page.getByRole("dialog");
  await expect(undoDialog.getByRole("heading", { name: "Undo this import?" })).toBeVisible();
  await expect(undoDialog.getByText(/readings/).first()).toBeVisible();
  await undoDialog.getByRole("button", { name: "Undo import" }).click();

  // Asserted on DURABLE state, never on the toast. The success toast dismisses
  // itself after a few seconds, so on a slow runner the assertion can arrive
  // after the thing it is looking for has already gone — which is the exact
  // race that made the refusal cases flaky. The batch row's own "Undone …"
  // line and the disappearance of its undo button survive indefinitely, and
  // they are what actually proves the undo happened.
  await expect(undoDialog).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId("import-batch").first()).toContainText(/Undone/, {
    timeout: 120_000,
  });
  await expect(page.getByRole("button", { name: /^Undo the import/ })).toHaveCount(0);

  // The medication it wrote is gone with it.
  await page.goto("/health/vitals");
  await expect(page.getByText(MEDICATION)).toBeHidden();

  expect(consoleErrors(), "the import round trip must log no console errors").toEqual([]);
});

test("the import dashboard reports the run, and the integrity checks pass", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/health/imports");
  await expect(page.getByRole("heading", { level: 2, name: "Import history" })).toBeVisible();

  // The dashboard tiles, which are aggregates over every batch rather than
  // sums of the visible page.
  for (const tile of ["Last import", "Imports run", "Readings written", "Kept as yours"]) {
    await expect(page.getByText(tile, { exact: true })).toBeVisible();
  }

  // The integrity panel always renders a verdict. What is asserted is the
  // absence of the two findings THIS importer could have caused — a metric it
  // has no rules for, or a unit no aggregation can read back. Asserting "every
  // check passed" instead would make the test depend on whatever else the
  // account happens to hold, which is not what it is here to measure.
  await expect(page.getByText("Data integrity")).toBeVisible();
  await expect(page.getByText(/unrecognised metric/)).toHaveCount(0);
  await expect(page.getByText(/cannot be read back/)).toHaveCount(0);

  expect(consoleErrors(), "the import dashboard must log no console errors").toEqual([]);
});

test("refuses a file that is not a health export, and writes nothing", async ({ page }) => {
  const notAnExport = join(directory, "not-an-export.zip");
  await writeFile(notAnExport, buildZip([{ name: "notes.txt", content: "hello" }]));
  await expectRefusal(page, notAnExport, /no export\.xml/);
});

test("refuses malformed XML with a readable message", async ({ page }) => {
  const broken = join(directory, "broken.zip");
  await writeFile(
    broken,
    buildZip([
      {
        name: "apple_health_export/export.xml",
        content: '<?xml version="1.0"?><HealthData><Record type="x"></Workout>',
      },
    ]),
  );

  await expectRefusal(page, broken, /Malformed XML|damaged/);
});

test("refuses an export that declares an XML entity", async ({ page }) => {
  const entity = join(directory, "entity.zip");
  await writeFile(
    entity,
    buildZip([
      {
        name: "apple_health_export/export.xml",
        content:
          '<?xml version="1.0"?><!DOCTYPE HealthData [<!ENTITY lol "haha">]><HealthData><Record type="x" value="&lol;"/></HealthData>',
      },
    ]),
  );

  await expectRefusal(page, entity, /entity/);
});
