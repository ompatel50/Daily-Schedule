# The Health module

Everything the Health section does, what an Apple Health export actually gives it, and the
rules it holds to. If you only want the privacy answer, read
[`health-import-privacy.md`](health-import-privacy.md) instead — this page is the reference.

## Contents

- [The section](#the-section)
- [Supported Apple Health data](#supported-apple-health-data)
- [What is deliberately not imported](#what-is-deliberately-not-imported)
- [The import, step by step](#the-import-step-by-step)
- [Duplicate rules](#duplicate-rules)
- [Merge rules](#merge-rules--what-a-re-import-does-to-a-reading-it-has-seen-before)
- [Undo rules](#undo-rules)
- [The import dashboard, and what history means](#the-import-dashboard-and-what-history-means)
- [Data integrity checks](#data-integrity-checks)
- [Performance expectations](#performance-expectations)
- [The privacy model](#the-privacy-model)
- [Backup](#backup)
- [Extending it](#extending-it)

---

## The section

| Route | What it is for |
| --- | --- |
| `/health` | Overview: today's headline numbers, one card per area, last night's sleep, recent workouts, latest trends, records, manual entry, last import |
| `/health/activity` | Steps, distances, flights, calories, exercise minutes, stand hours |
| `/health/sleep` | Every night in the range with its stages, plus the sleep chart |
| `/health/heart` | Heart rate, resting and walking rate, HRV, VO₂ max |
| `/health/body` | Weight, height, BMI, body fat, lean mass, waist |
| `/health/nutrition` | Energy, macros, vitamins and minerals **as imported** — kept separate from meals you log in `/nutrition` |
| `/health/workouts` | Every workout in range, from the export and from the training log, labelled by source |
| `/health/vitals` | Blood pressure, glucose, temperature, respiratory metrics, and the non-numeric health records |
| `/health/trends` | The ten trends worth watching over months |
| `/health/import` | Import an export; how to produce one; what happens to it |
| `/health/imports` | Every import this account has run, and the undo |

Every page takes a range — `?range=7d | 30d | 90d | 1y | all` — resolved server-side. "All
time" asks the database for your earliest health day rather than guessing a start, and is capped
at ten years so a single stray row dated 1970 cannot turn a chart into 20,000 points.

Nutrition is on two pages on purpose. `/nutrition` is what you logged in this app; the Health
page is what your export said. They are different records of the same days, and merging them
would double-count every meal.

---

## Supported Apple Health data

Each HealthKit identifier below maps to one Personal OS metric. The mapping lives in one file,
[`src/lib/logic/health-import/apple-types.ts`](../src/lib/logic/health-import/apple-types.ts).

### Activity

| HealthKit identifier | Metric |
| --- | --- |
| `HKQuantityTypeIdentifierStepCount` | Steps |
| `HKQuantityTypeIdentifierDistanceWalkingRunning` | Walking + running distance |
| `HKQuantityTypeIdentifierDistanceCycling` | Cycling distance |
| `HKQuantityTypeIdentifierDistanceSwimming` | Swimming distance |
| `HKQuantityTypeIdentifierFlightsClimbed` | Flights climbed |
| `HKQuantityTypeIdentifierActiveEnergyBurned` | Active calories |
| `HKQuantityTypeIdentifierBasalEnergyBurned` | Resting calories |
| `HKQuantityTypeIdentifierAppleExerciseTime` | Exercise minutes |
| `HKCategoryTypeIdentifierAppleStandHour` | Stand hours (only hours recorded as *stood*) |
| `<ActivitySummary>` | Active calories, exercise minutes and stand hours as Apple's own daily ring totals |

`<ActivitySummary>` rows are attributed to a source called **Activity summary** rather than to a
device, so they form their own source group and can never be summed with the watch's per-sample
records for the same day. The aggregation takes the fullest group, which is normally the ring
total.

### Body

| HealthKit identifier | Metric |
| --- | --- |
| `HKQuantityTypeIdentifierBodyMass` | Body weight |
| `HKQuantityTypeIdentifierHeight` | Height |
| `HKQuantityTypeIdentifierBodyMassIndex` | BMI |
| `HKQuantityTypeIdentifierBodyFatPercentage` | Body fat |
| `HKQuantityTypeIdentifierLeanBodyMass` | Lean body mass |
| `HKQuantityTypeIdentifierWaistCircumference` | Waist circumference |

### Heart

| HealthKit identifier | Metric |
| --- | --- |
| `HKQuantityTypeIdentifierHeartRate` | Heart rate (day average, min–max preserved) |
| `HKQuantityTypeIdentifierRestingHeartRate` | Resting heart rate |
| `HKQuantityTypeIdentifierWalkingHeartRateAverage` | Walking heart rate |
| `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | HRV |
| `HKQuantityTypeIdentifierVO2Max` | VO₂ max |

### Sleep

`HKCategoryTypeIdentifierSleepAnalysis`, with the stage taken from the record's value:
`InBed`, `Asleep`, `AsleepUnspecified`, `AsleepCore`, `AsleepDeep`, `AsleepREM`, `Awake`.

Stage intervals are union-merged per night per device, so overlapping records can never
double-count. **Time asleep is the sum of the asleep-ish stages only** — awake and in-bed are
shown but never added to it, which is what stops "8h in bed and 7h asleep" reading as fifteen
hours. A night that crosses midnight belongs to the day it *ends* on: the morning you woke up.

### Respiratory

`RespiratoryRate`, `OxygenSaturation`, `PeakExpiratoryFlowRate`, `ForcedVitalCapacity`,
`ForcedExpiratoryVolume1`.

### Nutrition

`DietaryEnergyConsumed`, `DietaryWater`, `DietaryProtein`, `DietaryFatTotal`,
`DietaryFatSaturated`, `DietaryCarbohydrates`, `DietaryFiber`, `DietarySugar`,
`DietaryCholesterol`, `DietarySodium`, `DietaryPotassium`, `DietaryCalcium`, `DietaryIron`,
`DietaryMagnesium`, `DietaryZinc`, `DietaryCaffeine`, `DietaryVitaminA`, `DietaryVitaminC`,
`DietaryVitaminD`, `DietaryVitaminE`, `DietaryVitaminB6`, `DietaryVitaminB12`, `DietaryFolate`.

### Vitals

| HealthKit identifier | Metric |
| --- | --- |
| `HKQuantityTypeIdentifierBloodPressureSystolic` + `…Diastolic` | Blood pressure, paired into one reading |
| `HKQuantityTypeIdentifierBloodGlucose` | Blood glucose |
| `HKQuantityTypeIdentifierBodyTemperature` | Body temperature |

Blood pressure is exported as two separate records that only mean something together. They are
paired by their shared start instant; a systolic whose diastolic never arrives is **dropped and
counted**, not reported as half a reading.

### Mindfulness

`HKCategoryTypeIdentifierMindfulSession` → mindful minutes, derived from the session's own start
and end (the record carries no value).

### Workouts

`<Workout>` elements import as real workout records: type, name, date and time, duration,
distance, calories, and average heart rate from `<WorkoutStatistics>`. Distance and energy are
read from the open tag (older exports) *and* from `<WorkoutStatistics>` children (newer ones),
preferring the tag.

`HKWorkoutActivityType…` maps to the app's own workout types (running, walking, cycling,
swimming, yoga, strength, hiit, mobility, cardio, sport); anything unlisted becomes `custom`
with a readable name derived from the identifier, so no workout is ever lost to an unmapped
activity.

### Non-numeric records

Read from the archive's member files and from `<ClinicalRecord>` elements:

| Kind | Source | What is stored |
| --- | --- | --- |
| ECG | `electrocardiograms/*.csv` | Classification, average heart rate, symptoms, device, recorded date |
| Medication | `<ClinicalRecord type="Medication…">` | Display name, provider, received date |
| Clinical record | `<ClinicalRecord>` (all other types) | Display name, provider, type, received date |
| Workout route | `workout-routes/*.gpx`, `<WorkoutRoute>` | Point count, total distance, time span |

### Units

Every unit an export uses converts to the metric's canonical unit: mass (kg/lb/g/st), length
(cm/m/in/ft), distance (km/mi/m/yd), volume (ml/l/fl oz), energy (kcal/kJ), duration (h/min/s),
mass prefixes for nutrition (g/mg/µg), rates (count/min), pressure (mmHg), glucose
(mg/dL, mmol/L), flow (L/min) and VO₂ (mL/kg·min). Temperature is the one **affine** conversion —
°F is `(v − 32) × 5/9`, not a multiplier — and is handled explicitly. Percentages HealthKit
writes as 0–1 fractions (body fat, blood oxygen) are scaled to 0–100.

---

## What is deliberately not imported

* **ECG voltage traces.** A 30-second trace is thousands of samples this app cannot draw and
  should not hold. Only the summary is read; the scan stops at the header's blank line.
* **GPS coordinates.** A route is summarised into a point count and a distance *while streaming*
  and the coordinates are discarded. The app can say "a 10.2 km route was recorded"; it cannot
  say where you ran.
* **Raw clinical documents.** `clinical-records/*.json` holds FHIR payloads — diagnoses, lab
  values, notes. Only the index entry in `export.xml` is read; the payloads are never opened.
* **`export_cda.xml`.** A clinical-document duplicate of data already read.
* **Basal body temperature.** A different measurement under different conditions; folding it in
  with ordinary body temperature would report a number the export never claimed.
* **Unmapped record types** — audiograms, headphone audio exposure, vision prescriptions, and
  whatever Apple adds next. Counted, listed in the preview, and skipped.

Nothing in this list fails an import. The preview tells you what was skipped and why.

---

## The import, step by step

```
choose a file
   ↓  streamed to a scratch path on the server (never held in memory)
parse            server-side; ZIP directory read, export.xml streamed through the scanner
   ↓
validate         malformed archive / XML / entity declarations refused here
   ↓
duplicate check  against what this account already has
   ↓
preview          counts, categories, date span, new vs refreshed vs already-present
   ↓             NOTHING has been written to your health tables
choose + confirm one transaction, recorded as a batch
   ↓
summary          new, refreshed, already present, workouts, records, days recalculated
   ↓
history          /health/imports — every run, with its timings and notes
```

The uploaded file is deleted as soon as the parse finishes, on every path including failure. The
staged rows live in the account's own import-session rows, are deleted on confirm or cancel, and
expire after two hours if abandoned.

### Failures, and what they cost you

| Input | Result |
| --- | --- |
| Not a ZIP, or a damaged directory | Refused, nothing written |
| ZIP with no `export.xml` | Refused, with instructions for producing one |
| `export.xml` with no `<HealthData>` | Refused |
| Malformed XML (tags that do not nest, truncated file) | Refused, nothing written |
| XML declaring an entity, or an external DTD | Refused outright — see [privacy](#the-privacy-model) |
| Encrypted or bombed archive member | Refused at its byte budget |
| Empty but well-formed export | "Nothing importable was found" — not an error state |
| One damaged ECG or route file | That file is reported and skipped; the rest imports |
| Unsupported record types | Counted, listed, skipped |
| A record with a bad value or date | Counted as invalid, listed in the warnings, skipped |

---

## Duplicate rules

Every row carries a **fingerprint** derived from its content, unique per account. Importing the
same export twice reproduces the same fingerprints, so the second import writes nothing;
importing a *later* export reproduces the fingerprints of the days it shares and adds new ones
for the days it does not. Nothing about the identity depends on when the file was made or what
it was called, which is what makes incremental import work without the app tracking "what did I
import last time".

| Row kind | Fingerprint |
| --- | --- |
| Rolled-up metrics (steps, calories, heart rate, nutrition — anything summed or averaged over a day) | `ah\|type\|date\|device` |
| Sleep | `ah\|sleep_hours\|stage\|date\|device` |
| Point readings (weight, blood pressure, VO₂ max, glucose…) | `ah\|type\|instant\|value\|device` |
| Health records (ECG, medication, clinical, route) | `ahr\|kind\|identifier` |
| Workouts | `ah:<start instant>:<activity type>` |
| CSV rows with an `externalId` | `x\|source\|externalId` |
| CSV rows without one | the whole row |
| Manual entries | `manual\|type\|date` |

Three consequences worth stating:

1. **The device is part of the key.** A phone and a watch that both counted the same walk are two
   independent measurements; collapsing them would throw one away. Keeping them separate is what
   lets the aggregation take the fullest source instead of adding them up.
2. **A fuller day updates in place.** The value is not part of a rolled-up row's identity, so a
   later export that contains the rest of a day *refreshes* that row — and moves it to the newer
   batch, so undoing the older import can no longer reach it.
3. **A manual entry can never collide with an import.** `manual|steps|2026-03-14` is not a shape
   any import fingerprint can produce.

**Workouts** get a second check. An imported workout whose day, start time and duration are close
to a workout you logged by hand is treated as a probable duplicate: it is **skipped and
reported**, never merged and never allowed to overwrite your own record.

---

## Merge rules — what a re-import does to a reading it has seen before

A fingerprint is a stable *identity*, not a claim of ownership. An import may refresh a row it
wrote itself; it may not write over one that has become yours. The decision is made per row, by
`src/lib/logic/health-import/merge.ts`, and the same code produces both the preview and the
write — so the preview is a promise, not an estimate.

| The stored row | What the import does |
| --- | --- |
| Does not exist | **Added** |
| Already holds the same value | **Skipped** — counted as "already present" |
| Was entered by hand, or carries no import batch at all | **Kept as yours** — nothing written |
| Was written by an import, but you have edited it since | **Kept as yours** — nothing written |
| Was written by an import and nobody has touched it | **Merged** — the file's fuller value wins |

"Edited since" uses the batch's own `finishedAt` as the boundary, with a one-second grace so an
import cannot classify its own writes as edits. That is *the same boundary undo uses*, and
deliberately so: if the two rules disagreed, a row could be protected from re-import and yet
removed by undo, or the reverse.

Two properties follow, and both are asserted by tests:

* **Ownership is re-read at confirm time**, never carried over from the preview. A staged import
  can sit for up to two hours; a row you edit in that window is protected on the strength of what
  is true when the write happens.
* **Ambiguity means hands off.** A row whose batch id does not resolve to one of *your* batches —
  a partially restored backup, a hand-edited database — is protected rather than merged. Refusing
  to write is recoverable; overwriting is not.

Every protected row is **reported**, in the preview's warnings, on the import's result screen and
on the batch in `/health/imports`. A skip you are not told about is indistinguishable from data
loss.

The conservatism is intentional for this first version. There is no field-level merge, no
"prefer the higher value", and no prompt asking you to resolve a conflict row by row.

---

## Undo rules

Every import is a batch, and `/health/imports` can undo any of them. An undo removes the
import's own work and nothing else.

| Row | Decision |
| --- | --- |
| Untouched since the import wrote it | **Removed** |
| Changed after the import finished | **Kept** — you corrected it, so it is yours now |
| Now depended on by something else (an imported workout you added sets to, or scheduled a planner block from) | **Kept** — deleting it would take that work with it |

The preview shows all three counts before you commit. Beyond that:

* Deletes are keyed on **both** the batch id and your user id, so there is no path from an undo
  to another account's data or to data that run did not write.
* A row a later import refreshed already moved to that later batch, so it is out of reach.
* Manual entries were never given a batch id at all.
* The batch is stamped `undoneAt`; a second undo is a no-op rather than a way to reach rows a
  later import wrote onto the same fingerprints.
* Every affected day's derived numbers — day scores, calendar, insights, goals — are recomputed
  afterwards through the same path every other write uses.

---

## The import dashboard, and what history means

`/health/imports` is where the state of every import lives. Four tiles across the top, then the
history itself.

| Tile | What it means |
| --- | --- |
| **Last import** | How long ago the most recent *successful* import ran, against your own today. An undone import does not count as a success. |
| **Imports run** | Every run this account has ever made, split into active / undone / failed. |
| **Readings written** | New readings across every import, plus how many were merged into existing days. |
| **Kept as yours** | Readings a re-import deliberately left alone (see the merge rules above). |

These are **aggregates over every batch**, not sums of the rows on the page — an account with
hundreds of imports would otherwise be shown a figure that silently meant "of the most recent
hundred". The list itself is capped at 100 and says so when it is.

Each row in the history carries: the file name, its status, its source (Apple Health or CSV), when
it ran, how big the file was, how long the write took, the span of days it covered, and the full
counts — new, merged, already present, kept as yours, workouts, records, invalid, unsupported.
The categories it wrote are listed as badges, and any parser notes are one click away. Once there
are three or more, a search box and status filters appear; both filter the list already on the
page rather than asking the server per keystroke.

A staged import that has not been confirmed is called out at the top of the page: nothing has been
written, and it expires on its own after two hours.

**Version awareness.** Every batch records `formatVersion` — which version of the importer wrote
it. Version 1 is the original pipeline, which replaced any matching reading regardless of who had
touched it; version 2 is the current one, with the merge rules above. A batch from version 1 says
so in the history, because its "0 kept as yours" is a fact about the importer of the day rather
than a promise about your data. The stamp also gives a future change something to migrate *from*
instead of having to infer an old batch's semantics from its dates.

---

## Data integrity checks

The same page runs a handful of read-only checks over what your imports have left behind. They
exist because the quiet failures are the ones nobody notices: a unit the metric cannot express
stores fine and then reads as nothing forever; a reading dated in the future sits outside every
range the pages offer.

| Check | Severity | What it means |
| --- | --- | --- |
| Readings under a metric this app has no rules for | Problem | Kept, but never shown or counted anywhere. Usually from a backup written by a different version. |
| A unit the metric cannot convert | Problem | Every chart and average silently skips those rows, so the numbers you see are computed without them. |
| A value outside any plausible range for its metric | Problem | Almost always a unit mix-up upstream. One wrong row skews the average and the chart's scale for its whole range. |
| Readings dated after today | Problem | A device whose clock or timezone was wrong. Stored, never shown. |
| Readings with no deduplication key | Note | They display normally, but a future import cannot recognise them as already present. |
| Readings that outlived an undone import | Note | The intended behaviour for a row you had edited or built on — they are yours now. |
| Failed imports | Note | Rolled back whole, so nothing they read was written. |

**Everything is an aggregate.** Six queries, answered from the database's own counters and the
existing indexes; not one materialises a row. That is why the panel costs the same for 400
readings and 4,000,000. The trade is that a min/max says a metric *holds* an impossible reading
without saying how many, so the implausible-value check counts **metrics**, not rows, rather than
claim a number it did not measure.

Nothing is written and nothing is repaired: the app never silently rewrites a stored reading on
the strength of a heuristic. The findings tell you which metric's page to open.

The bounds are deliberately absurd rather than clinical — a resting heart rate of 34 bpm is a
well-trained athlete and must not be flagged; 4,000 bpm is a parse error. A committed test holds
the rules to an ordinary, healthy range for every bounded metric, because a check that flags real
data is worse than no check at all: you learn to ignore the panel.

---

## Performance expectations

An Apple Health export is one flat XML file of every individual sensor reading a decade of
watches produced. A ten-year export is routinely several gigabytes once unzipped.

**The design.** The rollup happens *during* the scan. Each record is folded straight into an
accumulator keyed by (metric, day, source app); the accumulators are all that is ever held. So
memory is proportional to **distinct days × metrics × devices**, not to the number of samples —
a decade of data is a few hundred thousand small objects whether the file is 200 MB or 8 GB.

| Concern | How it is bounded |
| --- | --- |
| Upload size | 2 GB, checked against `Content-Length` *and* against what actually arrives |
| Decompressed XML | 6 GB, enforced as the stream is produced — a zip bomb fails the import instead of the host |
| One XML element | 256 KB |
| The prologue / DTD | 64 KB |
| XML nesting depth | 64 |
| Attributes per element | 256 |
| Distinct accumulators | 500,000 |
| Individual point readings | 250,000 |
| Workouts / records | 100,000 each |
| ECG and route files read | 5,000 each |
| One member file | 32 MB |
| A CSV import | 64 MB |

Hitting a cap is reported, never silent: the import says what it kept and tells you to import
again to continue.

**On a hosting platform, the platform's own limits bind first**, and the app now says so rather
than promising a size it cannot accept.

* **Execution time.** The upload route asks for `maxDuration = 60`, the highest value every
  Vercel plan accepts. It has to be a literal — Next.js statically analyses route segment config
  and refuses to build otherwise — so `tests/deploy-config.test.ts` holds every route in the app
  to `MAX_FUNCTION_SECONDS`. A value above the plan's ceiling fails the *whole deployment* rather
  than being clamped, which is the worst possible place to find out.
* **Request body.** Vercel rejects a body above ~4.5 MB before the function runs, with a platform
  413 the app never sees and cannot phrase. So when `VERCEL` is set, the importer advertises and
  enforces *that* number instead of its own 2 GB: the import page states the real limit up front,
  and a refusal explains that the platform is the constraint and self-hosting lifts it.
* **Overriding it.** Set `HEALTH_MAX_UPLOAD_MB` when you know better than the defaults — a
  reverse proxy with its own `client_max_body_size`, or a plan whose body cap is higher. It can
  never raise the app's own 2 GB ceiling, which bounds memory and disk.

A self-hosted deployment (`npm start` behind your own proxy) has neither platform limit, which
remains the answer for an export large enough to hit them.

**Measured.** A synthetic export of 60,000 records across 400 days parses in well under a second
and produces 400 rows — one per day per device — with heap growth in the low tens of megabytes.
That case is a committed test (`tests/health-archive.test.ts`), so the property is checked on
every run rather than asserted here.

**Writes** are batched (500 rows per statement) inside one transaction, so a confirm is a
handful of round trips rather than one per row. **Reads** are bounded by an explicit day window
and metric list, and every table the module queries is indexed on `(userId, type, date)`,
`(userId, date)` and `(batchId)`.

**Duplicate detection** uses one bounded range scan for an Apple import — every Apple
fingerprint embeds the row's own date, so a single query finds every possible collision however
many rows the plan has — and per-fingerprint lookups for CSV, where the row count is small and a
row's date may have changed since last time.

---

## The privacy model

* **Owner-scoped by construction.** Every health row carries a `userId`; every query in the
  module is scoped by it; every server action resolves the user from the session and never
  accepts a user id. Database-backed tests assert another account can neither preview, confirm,
  cancel, nor undo your import.
* **The upload is transient.** Streamed to a scratch path, parsed, deleted in a `finally` — on
  every path, including a parse failure.
* **Nothing sensitive is copied.** See [what is not imported](#what-is-deliberately-not-imported).
* **No network calls.** A committed test walks the health modules and asserts they contain no
  `fetch`, no socket import, no HTTP client.
* **Nothing health-shaped in the logs.** Record contents are never logged; errors are logged
  under a short reference id with the message only.
* **The parser is hostile-input hardened.** It resolves no entities, so XXE and billion-laughs
  have nothing to work with; an entity declaration or an external DTD is a hard refusal rather
  than a silent misreading. Archive paths are never used as paths, and a traversal-shaped name
  is refused outright.

---

## Backup

Health data is in the backup file from format **v7**: `healthMetrics`, `healthRecords` and
`healthImportBatches`, restored in that order so a record keeps its batch link. **v8** adds the
two columns this phase introduced — `protectedRows` and `formatVersion` — to the batch rows; it
adds no tables.

A v1–v7 file restores into a v8 app unchanged. The missing tables simply have no rows, and the
new columns take their defaults — a v7 batch arrives with `protectedRows = 0` and
`formatVersion = 1`, which is *exactly true of it*: the importer that wrote it was version 1 and
protected nothing, because protecting was not a thing it did. A v8 file taken to an older build
is refused rather than silently restored without those columns, which is what the version bump
buys. See [`backup-and-recovery.md`](backup-and-recovery.md).

---

## Extending it

Adding a metric is three edits and no migration, because `HealthMetric` is generic (date + type
+ value + unit):

1. `src/lib/enums.ts` — add the key to `HEALTH_METRIC_TYPES` and a `HEALTH_METRIC_META` entry
   (label, unit, direction, group).
2. `src/lib/logic/health.ts` — add a `HEALTH_METRIC_RULES` entry saying how days aggregate and
   which unit family it converts through.
3. `src/lib/logic/health-import/apple-types.ts` — map the HealthKit identifier onto it.

A committed test asserts every declared type has both a meta entry and a rule, and that every
rule's canonical unit is one its family can actually convert — so a half-finished addition fails
the suite rather than silently storing values nothing can read.
