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
