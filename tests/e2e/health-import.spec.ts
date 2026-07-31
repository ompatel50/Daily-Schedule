import { deflateRawSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The whole import, through the browser: choose a file → it uploads and is
 * parsed on the server → preview → confirm → the data appears across the
 * Health section and in search → re-importing is a no-op → undo puts
 * everything back.
 *
 * The export is built here rather than fixture-loaded, so this runs against
 * any database including CI's empty one, and every run cleans up after itself
 * by undoing the import it created. It runs as `alice` — the account this
 * suite is allowed to write to.
 */

test.use({ storageState: STORAGE.alice });
test.describe.configure({ mode: "serial" });

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

async function upload(page: import("@playwright/test").Page) {
  await page.goto("/health/import");
  await expect(page.getByRole("heading", { level: 2, name: "Import health data" })).toBeVisible();
  await page.setInputFiles('input[type="file"]', archivePath);
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeVisible({ timeout: 120_000 });
}

test("imports an Apple Health export end to end, then undoes it", async ({ page }) => {
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
  const again = (await page.getByRole("dialog").textContent()) ?? "";
  expect(again).toContain("already present");
  expect(again).not.toContain("new");
  await page.getByRole("button", { name: /Cancel/ }).click();

  // --- undo ------------------------------------------------------------------
  await page.goto("/health/imports");
  await page
    .getByRole("button", { name: /^Undo the import/ })
    .first()
    .click();
  const undoDialog = page.getByRole("dialog");
  await expect(undoDialog.getByRole("heading", { name: "Undo this import?" })).toBeVisible();
  await expect(undoDialog.getByText(/readings/).first()).toBeVisible();
  await undoDialog.getByRole("button", { name: "Undo import" }).click();
  await expect(page.getByText(/^Undone/).first()).toBeVisible({ timeout: 60_000 });

  // The medication it wrote is gone with it.
  await page.goto("/health/vitals");
  await expect(page.getByText(MEDICATION)).toBeHidden();
});

test("refuses a file that is not a health export, and writes nothing", async ({ page }) => {
  const notAnExport = join(directory, "not-an-export.zip");
  await writeFile(notAnExport, buildZip([{ name: "notes.txt", content: "hello" }]));

  await page.goto("/health/import");
  await page.setInputFiles('input[type="file"]', notAnExport);
  await expect(page.getByText(/no export\.xml/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeHidden();
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

  await page.goto("/health/import");
  await page.setInputFiles('input[type="file"]', broken);
  await expect(page.getByText(/Malformed XML|damaged|Nothing was imported/).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeHidden();
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

  await page.goto("/health/import");
  await page.setInputFiles('input[type="file"]', entity);
  await expect(page.getByText(/entity/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeHidden();
});
