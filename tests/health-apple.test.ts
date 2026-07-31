import { describe, expect, it } from "vitest";

import { AppleHealthAccumulator } from "@/lib/logic/health-import/apple-stream";
import { parseEcgCsv, routeRecord, summarizeRouteGpx } from "@/lib/logic/health-import/apple-members";
import { APPLE_TYPE_MAP } from "@/lib/logic/health-import/apple-types";
import { buildApplePlan } from "@/lib/logic/health-import/rollup";
import {
  decodeXmlText,
  MAX_DEPTH,
  parseAttributes,
  XmlScanError,
  XmlScanner,
} from "@/lib/logic/health-import/xml-scanner";
import { classifyHealthUndoRow, planHealthUndo, UNDO_GRACE_MS } from "@/lib/logic/health-import/undo";
import { HEALTH_METRIC_META, HEALTH_METRIC_TYPES } from "@/lib/enums";
import { aggregateDay, HEALTH_METRIC_RULES, toCanonical } from "@/lib/logic/health";
import { APPLE_EXPORT_XML_RICH, ECG_CSV, ROUTE_GPX } from "./fixtures/apple-health";

/**
 * The Apple Health importer's own suite: the XML scanner's hardening, the
 * wider metric vocabulary, the member files an archive carries beside
 * `export.xml`, and the undo rule. The end-to-end path (upload → stage →
 * confirm → undo) is covered by the database-backed integration tests.
 */

function parse(xml: string, chunkSize = 0) {
  const accumulator = new AppleHealthAccumulator();
  if (chunkSize > 0) {
    for (let at = 0; at < xml.length; at += chunkSize) {
      accumulator.write(xml.slice(at, at + chunkSize));
    }
  } else {
    accumulator.write(xml);
  }
  accumulator.end();
  return buildApplePlan(accumulator.result());
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

describe("XML scanner — structure", () => {
  it("emits start, end and attributes for nested elements", () => {
    const events: string[] = [];
    const scanner = new XmlScanner({
      onStart: (event) =>
        events.push(`+${event.name}@${event.depth}${event.selfClosing ? "/" : ""}:${JSON.stringify(event.attributes)}`),
      onEnd: (name, depth) => events.push(`-${name}@${depth}`),
    });
    scanner.write('<a x="1"><b y="2"/></a>');
    scanner.end();
    expect(events).toEqual(['+a@1:{"x":"1"}', '+b@2/:{"y":"2"}', "-a@1"]);
  });

  it("accepts single-quoted attributes and whitespace around the equals sign", () => {
    expect(parseAttributes("Record type = 'x'  unit=\"kg\"")).toEqual({ type: "x", unit: "kg" });
  });

  it("does not treat a > inside an attribute value as the end of the tag", () => {
    const seen: Record<string, string>[] = [];
    const scanner = new XmlScanner({ onStart: (event) => seen.push(event.attributes) });
    scanner.write('<Record device="&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch&gt;" value="5"/>');
    scanner.end();
    expect(seen[0].value).toBe("5");
    expect(seen[0].device).toContain("name:Apple Watch");
  });

  it("skips comments, processing instructions and CDATA", () => {
    const names: string[] = [];
    const text: string[] = [];
    const scanner = new XmlScanner({
      onStart: (event) => names.push(event.name),
      onText: (value) => text.push(value),
    });
    scanner.write('<?xml version="1.0"?><!-- a > comment --><a><![CDATA[raw <not> markup]]></a>');
    scanner.end();
    expect(names).toEqual(["a"]);
    expect(text).toEqual(["raw <not> markup"]);
  });

  it("refuses a document whose tags do not nest", () => {
    expect(() => parse("<HealthData><Record></Workout></HealthData>")).toThrow(XmlScanError);
    expect(() => parse("<HealthData></Record>")).toThrow(XmlScanError);
  });

  it("refuses a document that ends inside a tag", () => {
    const scanner = new XmlScanner({});
    scanner.write("<HealthData><Record type=");
    expect(() => scanner.end()).toThrow(/truncated or damaged/);
  });

  it("refuses nesting beyond the depth limit", () => {
    const deep = "<a>".repeat(MAX_DEPTH + 5);
    expect(() => parse(deep)).toThrow(/nests too deeply/);
  });
});

describe("XML scanner — hostile input", () => {
  it("skips the internal DTD subset every real Apple export carries", () => {
    const plan = parse(APPLE_EXPORT_XML_RICH);
    expect(plan.rows.length).toBeGreaterThan(10);
  });

  it("refuses an entity declaration rather than silently ignoring it", () => {
    const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE HealthData [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<HealthData><Record type="x" value="&lol3;"/></HealthData>`;
    expect(() => parse(billionLaughs)).toThrow(/never resolves entity declarations/);
  });

  it("refuses an external DTD rather than fetching it", () => {
    expect(() => parse('<!DOCTYPE HealthData SYSTEM "file:///etc/passwd"><HealthData/>')).toThrow(
      /never fetches anything/,
    );
    expect(() =>
      parse('<!DOCTYPE HealthData PUBLIC "-//x//EN" "http://evil.example/x.dtd"><HealthData/>'),
    ).toThrow(/never fetches anything/);
  });

  it("never expands an unknown entity — it stays literal text", () => {
    const seen: Record<string, string>[] = [];
    const scanner = new XmlScanner({ onStart: (event) => seen.push(event.attributes) });
    scanner.write('<a v="&xxe; &amp; &#65; &#x42;"/>');
    scanner.end();
    expect(seen[0].v).toBe("&xxe; & A B");
  });

  it("decodes only the five predefined entities and numeric references", () => {
    expect(decodeXmlText("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
    expect(decodeXmlText("&#9731;")).toBe("☃");
    // Lone surrogates would break JSON serialisation downstream.
    expect(decodeXmlText("&#xD800;")).toBe("&#xD800;");
    expect(decodeXmlText("&nbsp;")).toBe("&nbsp;");
  });

  it("refuses one implausibly large element instead of buffering it", () => {
    const scanner = new XmlScanner({});
    expect(() => {
      scanner.write("<HealthData>");
      for (let index = 0; index < 40; index += 1) scanner.write(`<Record x="${"a".repeat(20_000)}"`);
    }).toThrow(/implausibly large/);
  });

  it("refuses an element with an implausible number of attributes", () => {
    const attributes = Array.from({ length: 400 }, (_, index) => `a${index}="1"`).join(" ");
    expect(() => parse(`<HealthData><Record ${attributes}/></HealthData>`)).toThrow(
      /implausible number of attributes/,
    );
  });
});

// ---------------------------------------------------------------------------
// The wider vocabulary
// ---------------------------------------------------------------------------

describe("the wider Apple vocabulary", () => {
  const plan = parse(APPLE_EXPORT_XML_RICH);
  const row = (type: string, app?: string) =>
    plan.rows.find((entry) => entry.type === type && (app === undefined || entry.sourceApp === app));

  it("every mapped HealthKit identifier points at a metric this app knows", () => {
    for (const [identifier, type] of Object.entries(APPLE_TYPE_MAP)) {
      expect(HEALTH_METRIC_RULES[type], `${identifier} → ${type}`).toBeTruthy();
      expect((HEALTH_METRIC_TYPES as readonly string[]).includes(type), type).toBe(true);
    }
  });

  it("sums activity metrics per day per device", () => {
    expect(row("flights_climbed")?.value).toBe(11); // 4 + 7
    expect(row("flights_climbed")?.sampleCount).toBe(2);
  });

  it("converts every unit family the export uses", () => {
    expect(row("distance_cycling_km")?.value).toBeCloseTo(18.4, 3);
    expect(row("distance_swimming_km")?.value).toBeCloseTo(1.4, 3); // metres → km
    expect(row("height_cm")?.value).toBeCloseTo(178, 3);
    expect(row("waist_cm")?.value).toBeCloseTo(83.82, 2); // inches → cm
    expect(row("lean_body_mass")?.value).toBeCloseTo(65.86, 1); // lb → kg
    expect(row("vo2_max")?.value).toBeCloseTo(44.2, 3);
    expect(row("peak_flow")?.value).toBeCloseTo(520, 3);
    expect(row("blood_glucose")?.value).toBeCloseTo(94, 3);
  });

  it("converts Fahrenheit through the affine rule, not a factor", () => {
    expect(row("body_temperature")?.value).toBeCloseTo(37, 2);
    expect(toCanonical("body_temperature", 32, "degF")).toBeCloseTo(0, 6);
    expect(toCanonical("body_temperature", 37, "degC")).toBeCloseTo(37, 6);
  });

  it("scales fractional percentages to 0–100", () => {
    expect(row("blood_oxygen")?.value).toBeCloseTo(97, 3);
  });

  it("totals nutrition per day and keeps each nutrient distinct", () => {
    expect(row("dietary_calories")?.value).toBe(1960); // 820 + 1140
    expect(row("protein_g")?.value).toBe(42);
    expect(row("saturated_fat_g")?.value).toBeCloseTo(9.5, 3);
    expect(row("sodium_mg")?.value).toBe(1450);
    expect(row("vitamin_d_mcg")?.value).toBeCloseTo(12.5, 3);
    expect(row("iron_mg")?.value).toBeCloseTo(8.4, 3);
  });

  it("derives mindful minutes from the session's own length", () => {
    expect(row("mindful_minutes")?.value).toBe(12);
  });

  it("counts only the hours actually stood", () => {
    const watch = plan.rows.find(
      (entry) => entry.type === "stand_hours" && entry.sourceApp === "Watch",
    );
    expect(watch?.value).toBe(2); // two Stood, one Idle
  });

  it("reads the ring totals from ActivitySummary as their own source", () => {
    const summary = plan.rows.filter((entry) => entry.sourceApp === "Activity summary");
    expect(summary.find((entry) => entry.type === "active_calories")?.value).toBe(512);
    expect(summary.find((entry) => entry.type === "exercise_minutes")?.value).toBe(46);
    expect(summary.find((entry) => entry.type === "stand_hours")?.value).toBe(12);
  });

  it("never adds a ring summary to the same day's per-sample records", () => {
    // Two source groups for stand hours: the watch's own records (2) and the
    // ring summary (12). The aggregation takes the fullest, never the sum.
    const day = plan.rows.filter((entry) => entry.type === "stand_hours");
    expect(day).toHaveLength(2);
    const aggregated = aggregateDay("stand_hours", day as never);
    expect(aggregated?.value).toBe(12);
  });

  it("pairs blood pressure into one reading with a diastolic", () => {
    const pressure = plan.rows.filter((entry) => entry.type === "blood_pressure");
    expect(pressure).toHaveLength(1);
    expect(pressure[0].value).toBe(118);
    expect(pressure[0].secondaryValue).toBe(76);
    expect(pressure[0].date).toBe("2026-03-14");
  });

  it("drops a half-recorded blood pressure and says so", () => {
    // 2026-03-15 has a systolic with no diastolic.
    expect(plan.invalid).toBeGreaterThanOrEqual(1);
    expect(plan.warnings.some((warning) => /blood-pressure/.test(warning))).toBe(true);
  });

  it("reads a workout's average heart rate from its statistics", () => {
    expect(plan.workouts[0].avgHeartRate).toBe(151);
    expect(plan.workouts[0].distanceKm).toBeCloseTo(6.4, 3);
  });

  it("records a route's presence without reading a coordinate from the XML", () => {
    const route = plan.records.find((entry) => entry.kind === "workout_route");
    expect(route).toBeTruthy();
    expect(route?.value).toBeCloseTo(6.4, 3);
    expect(JSON.stringify(route?.detail)).not.toMatch(/lat|lon/);
  });

  it("separates medications from other clinical records", () => {
    const medication = plan.records.find((entry) => entry.kind === "medication");
    const clinical = plan.records.find((entry) => entry.kind === "clinical");
    expect(medication?.title).toBe("Metformin 500 mg");
    expect(clinical?.title).toBe("Influenza vaccine");
    // The FHIR payload itself is never read, only the index entry.
    expect(JSON.stringify(plan.records)).not.toContain("resourceFilePath");
  });

  it("counts an audiogram as unsupported rather than failing", () => {
    expect(plan.errors).toHaveLength(0);
    expect(plan.rows.length).toBeGreaterThan(20);
  });

  it("gives every metric a category the UI can group by", () => {
    for (const category of plan.categories) {
      if (category.key === "workouts" || category.key === "records") continue;
      expect(HEALTH_METRIC_META[category.key as never], category.key).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Member files
// ---------------------------------------------------------------------------

describe("ECG files", () => {
  it("reads the header summary and never a voltage sample", () => {
    const record = parseEcgCsv(ECG_CSV, "ecg_2026-03-14.csv");
    expect(record?.kind).toBe("ecg");
    expect(record?.title).toBe("Sinus Rhythm");
    expect(record?.date).toBe("2026-03-14");
    expect(record?.value).toBe(64);
    expect(record?.unit).toBe("bpm");
    expect(record?.fingerprint).toBe("ahr|ecg|ecg_2026-03-14.csv");
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain("-12.3");
    expect(serialised).not.toContain("88.0");
  });

  it("skips an ECG whose header it cannot date rather than guessing", () => {
    expect(parseEcgCsv("Name,Test\nClassification,Sinus Rhythm\n\n1.0", "x.csv")).toBeNull();
    expect(parseEcgCsv("", "x.csv")).toBeNull();
  });
});

describe("workout routes", () => {
  it("summarises a route without keeping a coordinate", () => {
    const summary = summarizeRouteGpx(ROUTE_GPX);
    expect(summary?.points).toBe(3);
    expect(summary?.distanceKm).toBeGreaterThan(2);
    expect(summary?.startAt).toBe("2026-03-14T22:00:00.000Z");
    expect(summary?.endAt).toBe("2026-03-14T22:16:00.000Z");

    const record = routeRecord(summary!, "route_2026-03-14_6.00pm.gpx");
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain("51.5");
    expect(serialised).not.toContain("-0.1278");
    expect(record?.date).toBe("2026-03-14");
  });

  it("ignores a GPX with no track points", () => {
    expect(summarizeRouteGpx("<gpx><trk><trkseg/></trk></gpx>")).toBeNull();
  });

  it("ignores out-of-range coordinates instead of computing nonsense", () => {
    const summary = summarizeRouteGpx(
      '<gpx><trkpt lat="999" lon="999"/><trkpt lat="51.5" lon="-0.1"/></gpx>',
    );
    expect(summary?.points).toBe(1);
    expect(summary?.distanceKm).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe("import undo classification", () => {
  const finished = new Date("2026-03-16T10:00:00Z");

  it("removes a row nothing has touched since the import", () => {
    expect(
      classifyHealthUndoRow({ id: "a", updatedAt: finished, linked: false }, finished),
    ).toBe("remove");
  });

  it("does not mistake the import's own writes for edits", () => {
    const justAfter = new Date(finished.getTime() + UNDO_GRACE_MS - 1);
    expect(classifyHealthUndoRow({ id: "a", updatedAt: justAfter, linked: false }, finished)).toBe(
      "remove",
    );
  });

  it("keeps a row edited after the import finished", () => {
    const later = new Date(finished.getTime() + 60_000);
    expect(classifyHealthUndoRow({ id: "a", updatedAt: later, linked: false }, finished)).toBe(
      "keep_edited",
    );
  });

  it("keeps a row something else now depends on, however old it is", () => {
    expect(classifyHealthUndoRow({ id: "a", updatedAt: finished, linked: true }, finished)).toBe(
      "keep_linked",
    );
  });

  it("splits a batch into what undo removes and what it keeps", () => {
    const plan = planHealthUndo(
      [
        { id: "untouched", updatedAt: finished, linked: false },
        { id: "edited", updatedAt: new Date(finished.getTime() + 90_000), linked: false },
        { id: "linked", updatedAt: finished, linked: true },
      ],
      finished,
    );
    expect(plan.removeIds).toEqual(["untouched"]);
    expect(plan.keptEdited).toBe(1);
    expect(plan.keptLinked).toBe(1);
    expect(plan.keptCount).toBe(2);
  });

  it("removes nothing from an empty batch", () => {
    const plan = planHealthUndo([], finished);
    expect(plan.removeCount).toBe(0);
    expect(plan.keptCount).toBe(0);
  });
});
