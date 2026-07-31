/**
 * Synthetic Apple Health export fragments. Entirely invented — no real person's
 * data — but shaped exactly like a real `export.xml`: same element names, same
 * attribute order Apple writes, same timestamp format, plus the quirks the
 * parser has to survive (metadata children, escaped entities, percent-as-
 * fraction body fat, unsupported record types, workout statistics children).
 */

const record = (attrs: string) => `  <Record ${attrs}/>`;

export const APPLE_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
]>
<HealthData locale="en_US">
 <ExportDate value="2026-03-16 09:00:00 -0400"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>
${record(
  'type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" sourceVersion="11.1" device="&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch, model:Watch7,1&gt;" unit="count" creationDate="2026-03-14 09:01:00 -0400" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 08:10:00 -0400" value="612"',
)}
${record(
  'type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-03-14 08:10:00 -0400" endDate="2026-03-14 08:20:00 -0400" value="388"',
)}
${record(
  'type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-03-14 08:05:00 -0400" endDate="2026-03-14 08:15:00 -0400" value="420"',
)}
${record(
  'type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-03-15 10:00:00 -0400" endDate="2026-03-15 10:30:00 -0400" value="2400"',
)}
${record(
  'type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Watch" unit="Cal" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 09:00:00 -0400" value="180.5"',
)}
${record(
  'type="HKQuantityTypeIdentifierBasalEnergyBurned" sourceName="Watch" unit="kJ" startDate="2026-03-14 00:00:00 -0400" endDate="2026-03-14 06:00:00 -0400" value="1673.6"',
)}
${record(
  'type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-14 08:01:00 -0400" endDate="2026-03-14 08:01:00 -0400" value="61"',
)}
${record(
  'type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-14 12:30:00 -0400" endDate="2026-03-14 12:30:00 -0400" value="141"',
)}
${record(
  'type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-14 20:15:00 -0400" endDate="2026-03-14 20:15:00 -0400" value="70"',
)}
${record(
  'type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-14 00:00:00 -0400" endDate="2026-03-14 23:59:00 -0400" value="55"',
)}
${record(
  'type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale &amp; Co" unit="lb" startDate="2026-03-14 07:05:00 -0400" endDate="2026-03-14 07:05:00 -0400" value="180.5"',
)}
${record(
  'type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale &amp; Co" unit="lb" startDate="2026-03-15 07:10:00 -0400" endDate="2026-03-15 07:10:00 -0400" value="180.1"',
)}
${record(
  'type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="Scale &amp; Co" unit="%" startDate="2026-03-14 07:05:00 -0400" endDate="2026-03-14 07:05:00 -0400" value="0.182"',
)}
${record(
  'type="HKQuantityTypeIdentifierDietaryWater" sourceName="WaterApp" unit="mL" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 09:00:00 -0400" value="500"',
)}
${record(
  'type="HKQuantityTypeIdentifierDietaryWater" sourceName="WaterApp" unit="mL" startDate="2026-03-14 15:00:00 -0400" endDate="2026-03-14 15:00:00 -0400" value="750"',
)}
${record(
  'type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="Watch" unit="km" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 09:00:00 -0400" value="1.2"',
)}
${record(
  'type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="Watch" unit="mi" startDate="2026-03-14 17:00:00 -0400" endDate="2026-03-14 18:00:00 -0400" value="1"',
)}
 <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" startDate="2026-03-14 06:00:00 -0400" endDate="2026-03-14 06:05:00 -0400" value="48">
  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="0"/>
 </Record>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-13 23:04:00 -0400" endDate="2026-03-14 06:40:00 -0400" value="HKCategoryValueSleepAnalysisInBed"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-13 23:15:00 -0400" endDate="2026-03-14 01:30:00 -0400" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-14 01:30:00 -0400" endDate="2026-03-14 02:20:00 -0400" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-14 02:20:00 -0400" endDate="2026-03-14 03:00:00 -0400" value="HKCategoryValueSleepAnalysisAsleepREM"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-14 03:00:00 -0400" endDate="2026-03-14 03:12:00 -0400" value="HKCategoryValueSleepAnalysisAwake"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-03-14 03:12:00 -0400" endDate="2026-03-14 06:35:00 -0400" value="HKCategoryValueSleepAnalysisAsleepCore"/>
${record(
  'type="HKQuantityTypeIdentifierEnvironmentalAudioExposure" sourceName="Watch" unit="dBASPL" startDate="2026-03-14 10:00:00 -0400" endDate="2026-03-14 10:30:00 -0400" value="63.5"',
)}
${record(
  'type="HKQuantityTypeIdentifierEnvironmentalAudioExposure" sourceName="Watch" unit="dBASPL" startDate="2026-03-14 11:00:00 -0400" endDate="2026-03-14 11:30:00 -0400" value="60.1"',
)}
${record(
  'type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 09:10:00 -0400" value="not-a-number"',
)}
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="31.5" durationUnit="min" totalDistance="5.1" totalDistanceUnit="km" totalEnergyBurned="342" totalEnergyBurnedUnit="Cal" sourceName="Watch" startDate="2026-03-14 17:00:00 -0400" endDate="2026-03-14 17:32:00 -0400">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="48" durationUnit="min" sourceName="Watch" startDate="2026-03-15 07:30:00 -0400" endDate="2026-03-15 08:18:00 -0400">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2026-03-15 07:30:00 -0400" endDate="2026-03-15 08:18:00 -0400" sum="285" unit="Cal"/>
 </Workout>
</HealthData>
`;

/** A second export taken two days later: everything above plus more of 03-15. */
export const APPLE_EXPORT_XML_OVERLAPPING = APPLE_EXPORT_XML.replace(
  "</HealthData>",
  `${record(
    'type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-03-15 14:00:00 -0400" endDate="2026-03-15 14:30:00 -0400" value="1600"',
  )}
${record(
  'type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-03-16 08:00:00 -0400" endDate="2026-03-16 08:30:00 -0400" value="900"',
)}
</HealthData>`,
);

export const VALID_CSV = `metricType,value,unit,date,startTime,endTime,subtype,source,externalId,notes
steps,8450,,2026-02-01,,,,,row-1,
hydration_ml,2.5,l,2026-02-01,,,,,,litres in
body_weight,81.2,kg,2026-02-01,2026-02-01T07:00:00,,,,row-3,morning
sleep_hours,7.4,h,2026-02-02,2026-02-01T23:00:00,2026-02-02T06:24:00,,,,
distance_km,3,mi,2026-02-02,,,,estimated,,
`;

/**
 * A real Apple export's prologue: an internal DTD subset of ELEMENT/ATTLIST
 * declarations. Every genuine `export.xml` has one, so the scanner must skip
 * it — while still refusing the ENTITY declarations that make XML parsers
 * dangerous.
 */
export const APPLE_DOCTYPE = `<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 12 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData locale CDATA #REQUIRED>
<!ELEMENT ExportDate EMPTY>
<!ATTLIST ExportDate value CDATA #REQUIRED>
<!ELEMENT Record ((MetadataEntry|HeartRateVariabilityMetadataList)*)>
<!ATTLIST Record
  type        CDATA #REQUIRED
  unit        CDATA #IMPLIED
  value       CDATA #IMPLIED
  sourceName  CDATA #REQUIRED
>
]>`;

/**
 * The wider vocabulary the Apple Health phase added: activity rings, body
 * composition, respiratory, nutrition, vitals, mindfulness, blood pressure as
 * a Correlation, an ActivitySummary, and clinical records.
 */
export const APPLE_EXPORT_XML_RICH = `<?xml version="1.0" encoding="UTF-8"?>
${APPLE_DOCTYPE}
<HealthData locale="en_GB">
 <ExportDate value="2026-03-16 09:00:00 -0400"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>
${record('type="HKQuantityTypeIdentifierFlightsClimbed" sourceName="Phone" unit="count" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 09:01:00 -0400" value="4"')}
${record('type="HKQuantityTypeIdentifierFlightsClimbed" sourceName="Phone" unit="count" startDate="2026-03-14 15:00:00 -0400" endDate="2026-03-14 15:01:00 -0400" value="7"')}
${record('type="HKQuantityTypeIdentifierAppleExerciseTime" sourceName="Watch" unit="min" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 09:20:00 -0400" value="20"')}
${record('type="HKQuantityTypeIdentifierDistanceCycling" sourceName="Watch" unit="km" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 10:00:00 -0400" value="18.4"')}
${record('type="HKQuantityTypeIdentifierDistanceSwimming" sourceName="Watch" unit="m" startDate="2026-03-14 07:00:00 -0400" endDate="2026-03-14 07:40:00 -0400" value="1400"')}
${record('type="HKQuantityTypeIdentifierHeight" sourceName="Manual" unit="cm" startDate="2026-03-14 07:00:00 -0400" endDate="2026-03-14 07:00:00 -0400" value="178"')}
${record('type="HKQuantityTypeIdentifierBodyMassIndex" sourceName="Scale" unit="count" startDate="2026-03-14 07:05:00 -0400" endDate="2026-03-14 07:05:00 -0400" value="23.4"')}
${record('type="HKQuantityTypeIdentifierLeanBodyMass" sourceName="Scale" unit="lb" startDate="2026-03-14 07:05:00 -0400" endDate="2026-03-14 07:05:00 -0400" value="145.2"')}
${record('type="HKQuantityTypeIdentifierWaistCircumference" sourceName="Manual" unit="in" startDate="2026-03-14 07:05:00 -0400" endDate="2026-03-14 07:05:00 -0400" value="33"')}
${record('type="HKQuantityTypeIdentifierWalkingHeartRateAverage" sourceName="Watch" unit="count/min" startDate="2026-03-14 00:00:00 -0400" endDate="2026-03-14 23:59:00 -0400" value="102"')}
${record('type="HKQuantityTypeIdentifierVO2Max" sourceName="Watch" unit="mL/min·kg" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 09:00:00 -0400" value="44.2"')}
${record('type="HKQuantityTypeIdentifierRespiratoryRate" sourceName="Watch" unit="count/min" startDate="2026-03-14 03:00:00 -0400" endDate="2026-03-14 03:05:00 -0400" value="14"')}
${record('type="HKQuantityTypeIdentifierOxygenSaturation" sourceName="Watch" unit="%" startDate="2026-03-14 03:10:00 -0400" endDate="2026-03-14 03:11:00 -0400" value="0.97"')}
${record('type="HKQuantityTypeIdentifierPeakExpiratoryFlowRate" sourceName="Spiro" unit="L/min" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 08:00:00 -0400" value="520"')}
${record('type="HKQuantityTypeIdentifierForcedVitalCapacity" sourceName="Spiro" unit="L" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 08:00:00 -0400" value="4.6"')}
${record('type="HKQuantityTypeIdentifierForcedExpiratoryVolume1" sourceName="Spiro" unit="L" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 08:00:00 -0400" value="3.7"')}
${record('type="HKQuantityTypeIdentifierDietaryEnergyConsumed" sourceName="Food" unit="kcal" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="820"')}
${record('type="HKQuantityTypeIdentifierDietaryEnergyConsumed" sourceName="Food" unit="kcal" startDate="2026-03-14 19:00:00 -0400" endDate="2026-03-14 19:00:00 -0400" value="1140"')}
${record('type="HKQuantityTypeIdentifierDietaryProtein" sourceName="Food" unit="g" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="42"')}
${record('type="HKQuantityTypeIdentifierDietaryFatTotal" sourceName="Food" unit="g" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="31"')}
${record('type="HKQuantityTypeIdentifierDietaryFatSaturated" sourceName="Food" unit="g" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="9.5"')}
${record('type="HKQuantityTypeIdentifierDietaryCarbohydrates" sourceName="Food" unit="g" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="88"')}
${record('type="HKQuantityTypeIdentifierDietaryFiber" sourceName="Food" unit="g" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="12"')}
${record('type="HKQuantityTypeIdentifierDietarySugar" sourceName="Food" unit="g" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="24"')}
${record('type="HKQuantityTypeIdentifierDietarySodium" sourceName="Food" unit="mg" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="1450"')}
${record('type="HKQuantityTypeIdentifierDietaryCaffeine" sourceName="Food" unit="mg" startDate="2026-03-14 08:00:00 -0400" endDate="2026-03-14 08:00:00 -0400" value="95"')}
${record('type="HKQuantityTypeIdentifierDietaryVitaminC" sourceName="Food" unit="mg" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="65"')}
${record('type="HKQuantityTypeIdentifierDietaryVitaminD" sourceName="Food" unit="mcg" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="12.5"')}
${record('type="HKQuantityTypeIdentifierDietaryCalcium" sourceName="Food" unit="mg" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="640"')}
${record('type="HKQuantityTypeIdentifierDietaryIron" sourceName="Food" unit="mg" startDate="2026-03-14 12:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="8.4"')}
${record('type="HKQuantityTypeIdentifierBloodGlucose" sourceName="Meter" unit="mg/dL" startDate="2026-03-14 07:15:00 -0400" endDate="2026-03-14 07:15:00 -0400" value="94"')}
${record('type="HKQuantityTypeIdentifierBodyTemperature" sourceName="Thermo" unit="degF" startDate="2026-03-14 07:20:00 -0400" endDate="2026-03-14 07:20:00 -0400" value="98.6"')}
${record('type="HKCategoryTypeIdentifierMindfulSession" sourceName="Mindfulness" startDate="2026-03-14 20:00:00 -0400" endDate="2026-03-14 20:12:00 -0400" value="HKCategoryValueNotApplicable"')}
${record('type="HKCategoryTypeIdentifierAppleStandHour" sourceName="Watch" startDate="2026-03-14 09:00:00 -0400" endDate="2026-03-14 10:00:00 -0400" value="HKCategoryValueAppleStandHourStood"')}
${record('type="HKCategoryTypeIdentifierAppleStandHour" sourceName="Watch" startDate="2026-03-14 10:00:00 -0400" endDate="2026-03-14 11:00:00 -0400" value="HKCategoryValueAppleStandHourStood"')}
${record('type="HKCategoryTypeIdentifierAppleStandHour" sourceName="Watch" startDate="2026-03-14 11:00:00 -0400" endDate="2026-03-14 12:00:00 -0400" value="HKCategoryValueAppleStandHourIdle"')}
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Cuff" startDate="2026-03-14 07:30:00 -0400" endDate="2026-03-14 07:30:00 -0400">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Cuff" unit="mmHg" startDate="2026-03-14 07:30:00 -0400" endDate="2026-03-14 07:30:00 -0400" value="118"/>
  <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" sourceName="Cuff" unit="mmHg" startDate="2026-03-14 07:30:00 -0400" endDate="2026-03-14 07:30:00 -0400" value="76"/>
 </Correlation>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Cuff" startDate="2026-03-15 07:30:00 -0400" endDate="2026-03-15 07:30:00 -0400">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Cuff" unit="mmHg" startDate="2026-03-15 07:30:00 -0400" endDate="2026-03-15 07:30:00 -0400" value="121"/>
 </Correlation>
 <ActivitySummary dateComponents="2026-03-14" activeEnergyBurned="512" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="kcal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="46" appleExerciseTimeGoal="30" appleStandHours="12" appleStandHoursGoal="12"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32.5" durationUnit="min" sourceName="Watch" startDate="2026-03-14 18:00:00 -0400" endDate="2026-03-14 18:32:30 -0400">
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="6.4" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="455" unit="kcal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="151" minimum="118" maximum="176" unit="count/min"/>
  <WorkoutRoute sourceName="Watch" startDate="2026-03-14 18:00:00 -0400" endDate="2026-03-14 18:32:30 -0400">
   <FileReference path="/workout-routes/route_2026-03-14_6.00pm.gpx"/>
  </WorkoutRoute>
 </Workout>
 <ClinicalRecord type="Medication" identifier="med-1" sourceName="Riverside Clinic" fhirVersion="4.0.1" receivedDate="2026-02-01 10:00:00 -0500" resourceFilePath="/clinical-records/Medication-1.json" displayName="Metformin 500 mg"/>
 <ClinicalRecord type="Immunization" identifier="imm-1" sourceName="Riverside Clinic" fhirVersion="4.0.1" receivedDate="2026-02-02 10:00:00 -0500" resourceFilePath="/clinical-records/Immunization-1.json" displayName="Influenza vaccine"/>
 <Audiogram type="HKAudiogramTypeIdentifier" startDate="2026-01-01 10:00:00 -0500" endDate="2026-01-01 10:05:00 -0500"/>
</HealthData>`;

/** One ECG, as Apple writes them: a header block, a blank line, then voltages. */
export const ECG_CSV = [
  "Name,Test Person",
  "Date of Birth,1990-01-01",
  "Recorded Date,2026-03-14 09:15:00 -0400",
  "Classification,Sinus Rhythm",
  "Symptoms,None",
  "Software Version,10.1",
  "Device,Apple Watch",
  "Sample Rate,512 Hertz",
  "Lead,Lead I",
  "Unit,µV",
  "Average Heart Rate,64 bpm",
  "",
  "-12.3",
  "40.1",
  "88.0",
].join("\n");

/** One workout route, as Apple writes them. */
export const ROUTE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Apple Health Export"><trk><name>Route</name><trkseg>
<trkpt lat="51.5074" lon="-0.1278"><ele>10.1</ele><time>2026-03-14T22:00:00Z</time></trkpt>
<trkpt lat="51.5174" lon="-0.1278"><ele>10.4</ele><time>2026-03-14T22:08:00Z</time></trkpt>
<trkpt lat="51.5274" lon="-0.1278"><ele>10.9</ele><time>2026-03-14T22:16:00Z</time></trkpt>
</trkseg></trk></gpx>`;
