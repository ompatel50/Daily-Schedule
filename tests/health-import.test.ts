import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { parseAppleHealthXml, parseAppleDate, APPLE_TYPE_MAP } from "@/lib/logic/health-import/apple-xml";
import { parseCsvRows, parseHealthCsv } from "@/lib/logic/health-import/csv";
import {
  buildImportPlan,
  fingerprintFor,
  manualDailyFingerprint,
  WORKOUTS_CATEGORY,
} from "@/lib/logic/health-import/rollup";
import { isLikelyDuplicateWorkout } from "@/lib/logic/health-import/workout-dup";
import { extractAppleHealthXml, listZipEntries } from "@/lib/logic/health-import/zip-browser";
import { detectHealthFileType } from "@/lib/logic/health-import/detect";
import {
  APPLE_EXPORT_XML,
  APPLE_EXPORT_XML_OVERLAPPING,
  VALID_CSV,
} from "./fixtures/apple-health";

describe("Apple Health identifier mapping", () => {
  it("maps every supported HealthKit identifier onto a Personal OS metric", () => {
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierStepCount).toBe("steps");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierActiveEnergyBurned).toBe("active_calories");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierBasalEnergyBurned).toBe("resting_calories");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierHeartRate).toBe("heart_rate");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierRestingHeartRate).toBe("resting_hr");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierBodyMass).toBe("body_weight");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierDietaryWater).toBe("hydration_ml");
    expect(APPLE_TYPE_MAP.HKQuantityTypeIdentifierDistanceWalkingRunning).toBe("distance_km");
    expect(APPLE_TYPE_MAP.HKCategoryTypeIdentifierSleepAnalysis).toBe("sleep_hours");
  });

  it("parses Apple's timestamp format and keeps the day as written", () => {
    const parsed = parseAppleDate("2026-03-14 23:45:00 -0400");
    expect(parsed?.day).toBe("2026-03-14");
    expect(parsed?.iso).toBe("2026-03-14T23:45:00-04:00");
    expect(parseAppleDate("14/03/2026 23:45")).toBeNull();
    expect(parseAppleDate(undefined)).toBeNull();
  });
});

describe("Apple Health XML parsing", () => {
  const parsed = parseAppleHealthXml(APPLE_EXPORT_XML);

  it("refuses a file that is not a health export, with a readable error", () => {
    const result = parseAppleHealthXml("<html><body>nope</body></html>");
    expect(result.errors[0]).toContain("Apple Health export");
  });

  it("reads quantity records with sources, devices and escaped entities", () => {
    const steps = parsed.samples.filter((sample) => sample.type === "steps");
    expect(steps).toHaveLength(4);
    expect(steps[0].sourceApp).toBe("Watch");
    expect(steps[0].sourceDevice).toBe("Apple Watch");
    const weight = parsed.samples.filter((sample) => sample.type === "body_weight");
    expect(weight[0].sourceApp).toBe("Scale & Co");
  });

  it("counts unsupported record types instead of failing the import", () => {
    expect(parsed.unsupported.HKQuantityTypeIdentifierEnvironmentalAudioExposure).toBe(2);
    expect(parsed.errors).toHaveLength(0);
  });

  it("counts invalid records and keeps going", () => {
    expect(parsed.invalid).toBe(1); // the value="not-a-number" step record
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("converts body-fat fractions to percentages", () => {
    const fat = parsed.samples.find((sample) => sample.type === "body_fat");
    expect(fat?.value).toBeCloseTo(18.2, 5);
  });

  it("survives records with metadata children", () => {
    const hrv = parsed.samples.find((sample) => sample.type === "hrv");
    expect(hrv?.value).toBe(48);
  });

  it("assigns a sleep interval that crosses midnight to the day it ends", () => {
    const stages = parsed.samples.filter((sample) => sample.type === "sleep_hours");
    expect(stages.length).toBe(6);
    for (const stage of stages) expect(stage.date).toBe("2026-03-14");
    const core = stages.find((stage) => stage.subtype === "core");
    expect(core?.startAt).toBe("2026-03-13T23:15:00-04:00");
  });

  it("reads workouts from tag attributes and from WorkoutStatistics children", () => {
    expect(parsed.workouts).toHaveLength(2);
    const run = parsed.workouts[0];
    expect(run.type).toBe("running");
    expect(run.durationMin).toBe(32);
    expect(run.distanceKm).toBeCloseTo(5.1, 6);
    expect(run.caloriesBurned).toBe(342);
    expect(run.time).toBe("17:00");

    const strength = parsed.workouts[1];
    expect(strength.type).toBe("strength");
    expect(strength.name).toBe("Traditional Strength Training");
    expect(strength.caloriesBurned).toBe(285); // from the statistics child
  });
});

describe("CSV parsing", () => {
  it("splits quoted fields, escaped quotes and CRLF correctly", () => {
    const rows = parseCsvRows('a,"b,c","d""e"\r\nf,,g\n');
    expect(rows).toEqual([
      ["a", "b,c", 'd"e'],
      ["f", "", "g"],
    ]);
  });

  it("parses a valid file and keeps declared units for later conversion", () => {
    const parsed = parseHealthCsv(VALID_CSV);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.samples).toHaveLength(5);
    expect(parsed.invalid).toBe(0);
    const hydration = parsed.samples.find((sample) => sample.type === "hydration_ml");
    expect(hydration?.unit).toBe("l");
    const distance = parsed.samples.find((sample) => sample.type === "distance_km");
    expect(distance?.source).toBe("estimated");
  });

  it("requires the header columns and says which are missing", () => {
    const parsed = parseHealthCsv("value,unit\n5,\n");
    expect(parsed.errors[0]).toContain("metricType");
    expect(parsed.errors[0]).toContain("date");
  });

  it("refuses ambiguous dates rather than guessing", () => {
    const parsed = parseHealthCsv(
      "metricType,value,date\nsteps,5000,3/4/2026\nsteps,6000,2026-02-30\n",
    );
    expect(parsed.invalid).toBe(2);
    expect(parsed.warnings[0]).toContain("YYYY-MM-DD");
  });

  it("rejects non-numeric and negative values with per-row messages", () => {
    const parsed = parseHealthCsv(
      "metricType,value,date\nsteps,lots,2026-02-01\nsteps,-5,2026-02-01\n",
    );
    expect(parsed.invalid).toBe(2);
    expect(parsed.warnings[0]).toContain("Row 2");
  });

  it("rejects unsupported units for the metric", () => {
    const parsed = parseHealthCsv("metricType,value,unit,date\nbody_weight,80,ml,2026-02-01\n");
    expect(parsed.invalid).toBe(1);
    expect(parsed.warnings[0]).toContain('unit "ml"');
  });

  it("counts unknown metric types as unsupported without failing the file", () => {
    const parsed = parseHealthCsv(
      "metricType,value,date\nblood_sugar,5,2026-02-01\nsteps,4000,2026-02-01\n",
    );
    expect(parsed.unsupported.blood_sugar).toBe(1);
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.errors).toHaveLength(0);
  });

  it("rejects an end time before the start time", () => {
    const parsed = parseHealthCsv(
      "metricType,value,date,startTime,endTime\nsleep_hours,7,2026-02-02,2026-02-02T06:00:00,2026-02-01T23:00:00\n",
    );
    expect(parsed.invalid).toBe(1);
    expect(parsed.warnings[0]).toContain("before startTime");
  });

  it("refuses a CSV that claims to be a device measurement", () => {
    const parsed = parseHealthCsv(
      "metricType,value,date,source\nsteps,4000,2026-02-01,apple_health\n",
    );
    expect(parsed.invalid).toBe(1);
    expect(parsed.warnings[0]).toContain("not allowed");
  });
});

describe("rollup and fingerprints", () => {
  const plan = buildImportPlan(parseAppleHealthXml(APPLE_EXPORT_XML));

  it("folds samples into one row per day per device for cumulative metrics", () => {
    const steps = plan.rows.filter((row) => row.type === "steps");
    // Watch 03-14 (612+388), Phone 03-14 (420), Watch 03-15 (2400).
    expect(steps).toHaveLength(3);
    const watch14 = steps.find((row) => row.sourceApp === "Watch" && row.date === "2026-03-14");
    expect(watch14?.value).toBe(1000);
    expect(watch14?.sampleCount).toBe(2);
  });

  it("converts units during rollup (kJ → kcal, mi → km)", () => {
    const resting = plan.rows.find((row) => row.type === "resting_calories");
    expect(resting?.value).toBeCloseTo(400, 0);
    const distance = plan.rows.find((row) => row.type === "distance_km");
    expect(distance?.value).toBeCloseTo(1.2 + 1.609344, 3);
  });

  it("summarises heart rate with min, average and max", () => {
    const hr = plan.rows.find((row) => row.type === "heart_rate");
    expect(hr?.value).toBeCloseTo((61 + 141 + 70) / 3, 3);
    expect(hr?.minValue).toBe(61);
    expect(hr?.maxValue).toBe(141);
  });

  it("keeps individual weight readings rather than averaging a day", () => {
    const weights = plan.rows.filter((row) => row.type === "body_weight");
    expect(weights).toHaveLength(2);
    expect(new Set(weights.map((row) => row.fingerprint)).size).toBe(2);
  });

  it("unions sleep stages per day and never double-counts overlap", () => {
    const stages = plan.rows.filter((row) => row.type === "sleep_hours");
    const byStage = new Map(stages.map((row) => [row.subtype, row.value]));
    expect(byStage.get("core")).toBeCloseTo(2.25 + 3.3833, 2); // two core blocks
    expect(byStage.get("in_bed")).toBeCloseTo(7.6, 1);
    // The asleep total is derived at aggregation, not stored pre-summed.
    expect(byStage.has(null as never)).toBe(false);
  });

  it("re-importing the same file produces identical fingerprints (a no-op)", () => {
    const again = buildImportPlan(parseAppleHealthXml(APPLE_EXPORT_XML));
    expect(new Set(again.rows.map((row) => row.fingerprint))).toEqual(
      new Set(plan.rows.map((row) => row.fingerprint)),
    );
  });

  it("an overlapping later export keeps old fingerprints and adds only new days", () => {
    const later = buildImportPlan(parseAppleHealthXml(APPLE_EXPORT_XML_OVERLAPPING));
    const before = new Set(plan.rows.map((row) => row.fingerprint));
    const after = new Set(later.rows.map((row) => row.fingerprint));
    for (const fingerprint of before) expect(after.has(fingerprint)).toBe(true);
    // The fuller Watch day 03-15 keeps its identity but grows its value.
    const key = later.rows.find(
      (row) => row.type === "steps" && row.date === "2026-03-15" && row.sourceApp === "Watch",
    );
    expect(key?.value).toBe(2400 + 1600);
    expect(before.has(key!.fingerprint)).toBe(true);
    // And a genuinely new day appears.
    expect(later.rows.some((row) => row.type === "steps" && row.date === "2026-03-16")).toBe(true);
  });

  it("two legitimate records with the same value keep distinct fingerprints", () => {
    const base = {
      type: "body_weight",
      subtype: null,
      value: 80,
      unit: "kg",
      minValue: null,
      maxValue: null,
      date: "2026-03-14" as const,
      endAt: null,
      source: "apple_health",
      sourceApp: "Scale",
      sourceDevice: null,
      externalId: null,
      notes: null,
      sampleCount: 1,
    };
    const morning = fingerprintFor({ ...base, startAt: "2026-03-14T07:00:00-04:00" });
    const evening = fingerprintFor({ ...base, startAt: "2026-03-14T22:00:00-04:00" });
    expect(morning).not.toBe(evening);
  });

  it("prefers a supplied external id over row contents", () => {
    const base = {
      type: "steps",
      subtype: null,
      value: 4000,
      unit: "",
      minValue: null,
      maxValue: null,
      date: "2026-02-01" as const,
      startAt: null,
      endAt: null,
      source: "csv",
      sourceApp: "csv",
      sourceDevice: null,
      notes: null,
      sampleCount: 1,
    };
    expect(fingerprintFor({ ...base, externalId: "row-1" })).toBe("x|csv|row-1");
    // Changing the value does not change the identity when an id exists.
    expect(fingerprintFor({ ...base, externalId: "row-1", value: 9999 })).toBe("x|csv|row-1");
  });

  it("identical duplicated CSV rows collapse to one within a file", () => {
    const twice = buildImportPlan(
      parseHealthCsv("metricType,value,date\nsteps,4000,2026-02-01\nsteps,4000,2026-02-01\n"),
    );
    expect(twice.rows).toHaveLength(1);
  });

  it("the manual fingerprint is stable and namespaced", () => {
    expect(manualDailyFingerprint("steps", "2026-02-01")).toBe("manual|steps|2026-02-01");
  });

  it("summarises categories with counts and date ranges, workouts included", () => {
    const categories = new Map(plan.categories.map((category) => [category.key, category]));
    expect(categories.get("steps")?.records).toBe(4);
    expect(categories.get("steps")?.rows).toBe(3);
    expect(categories.get(WORKOUTS_CATEGORY)?.rows).toBe(2);
    expect(plan.dateFrom).toBe("2026-03-14");
    expect(plan.dateTo).toBe("2026-03-15");
  });
});

describe("workout duplicate detection", () => {
  it("flags a same-day workout with a close time and length", () => {
    expect(
      isLikelyDuplicateWorkout(
        { time: "17:05", durationMin: 30 },
        { time: "17:00", durationMin: 32 },
      ),
    ).toBe(true);
  });

  it("does not flag a clearly different workout", () => {
    expect(
      isLikelyDuplicateWorkout(
        { time: "07:00", durationMin: 30 },
        { time: "17:00", durationMin: 32 },
      ),
    ).toBe(false);
    expect(
      isLikelyDuplicateWorkout(
        { time: "17:00", durationMin: 90 },
        { time: "17:00", durationMin: 30 },
      ),
    ).toBe(false);
  });

  it("errs toward reporting when a time is missing", () => {
    expect(
      isLikelyDuplicateWorkout({ time: null, durationMin: 30 }, { time: "17:00", durationMin: 31 }),
    ).toBe(true);
  });
});

describe("ZIP extraction", () => {
  function buildZip(entries: Array<{ name: string; content: string; store?: boolean }>): Buffer {
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const raw = Buffer.from(entry.content, "utf8");
      const data = entry.store ? raw : deflateRawSync(raw);
      const method = entry.store ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      parts.push(local, name, data);

      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0);
      dir.writeUInt16LE(method, 10);
      dir.writeUInt32LE(data.length, 20);
      dir.writeUInt32LE(raw.length, 24);
      dir.writeUInt16LE(name.length, 28);
      dir.writeUInt32LE(offset, 42);
      central.push(dir, name);
      offset += 30 + name.length + data.length;
    }
    const centralStart = offset;
    const centralBuffer = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(centralStart, 16);
    return Buffer.concat([...parts, centralBuffer, eocd]);
  }

  it("extracts export.xml from a deflated Apple-layout archive", async () => {
    const zip = buildZip([
      { name: "apple_health_export/export_cda.xml", content: "<cda/>" },
      { name: "apple_health_export/export.xml", content: APPLE_EXPORT_XML },
    ]);
    expect(listZipEntries(zip)).toHaveLength(2);
    const xml = await extractAppleHealthXml(zip);
    expect(xml).toContain("<HealthData");
    expect(parseAppleHealthXml(xml).workouts).toHaveLength(2);
  });

  it("reads stored (uncompressed) entries too", async () => {
    const zip = buildZip([
      { name: "apple_health_export/export.xml", content: "<HealthData></HealthData>", store: true },
    ]);
    expect(await extractAppleHealthXml(zip)).toBe("<HealthData></HealthData>");
  });

  it("explains itself when the archive has no export.xml", async () => {
    const zip = buildZip([{ name: "notes.txt", content: "hello" }]);
    await expect(extractAppleHealthXml(zip)).rejects.toThrow(/export\.xml/);
  });

  it("rejects a non-zip buffer with a readable error", async () => {
    await expect(extractAppleHealthXml(Buffer.from("plain text"))).rejects.toThrow(/ZIP/);
  });
});

describe("file type detection", () => {
  it("detects by magic bytes first, extension second", () => {
    expect(detectHealthFileType("export.zip", Buffer.from("PKrest"))).toBe("zip");
    expect(detectHealthFileType("export.xml", Buffer.from("<?xml version=\"1.0\"?>"))).toBe("xml");
    expect(detectHealthFileType("data.csv", Buffer.from("metricType,value,date\n"))).toBe("csv");
    expect(detectHealthFileType("mystery.bin", Buffer.from("random"))).toBeNull();
    // A renamed XML file is still recognised by its content.
    expect(detectHealthFileType("export.txt", Buffer.from('<?xml version="1.0"?><HealthData>'))).toBe("xml");
  });
});
