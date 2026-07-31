import type { SleepStage } from "@/lib/logic/health";

/**
 * The HealthKit vocabulary, in one place.
 *
 * Everything the Apple importer knows about Apple's identifiers lives here:
 * which `HKQuantityTypeIdentifier` becomes which Personal OS metric, which
 * category values are sleep stages, which activity types are workouts. The
 * parser itself contains no identifier strings, so adding support for a new
 * Apple type is a one-line edit here plus a metric in `src/lib/enums.ts`.
 *
 * Identifiers not listed are *counted and skipped*, never fatal: an export
 * full of audiograms, headphone-audio levels and environmental sound still
 * imports its steps. That is deliberate — Apple adds new types every release
 * and an importer that fails on an unknown one would rot within a year.
 */

/** `HKQuantityTypeIdentifier…` / `HKCategoryTypeIdentifier…` → metric type. */
export const APPLE_TYPE_MAP: Record<string, string> = {
  // --- activity ---------------------------------------------------------------
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance_km",
  HKQuantityTypeIdentifierDistanceCycling: "distance_cycling_km",
  HKQuantityTypeIdentifierDistanceSwimming: "distance_swimming_km",
  HKQuantityTypeIdentifierFlightsClimbed: "flights_climbed",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_calories",
  HKQuantityTypeIdentifierBasalEnergyBurned: "resting_calories",
  HKQuantityTypeIdentifierAppleExerciseTime: "exercise_minutes",

  // --- body -------------------------------------------------------------------
  HKQuantityTypeIdentifierBodyMass: "body_weight",
  HKQuantityTypeIdentifierHeight: "height_cm",
  HKQuantityTypeIdentifierBodyMassIndex: "bmi",
  HKQuantityTypeIdentifierBodyFatPercentage: "body_fat",
  HKQuantityTypeIdentifierLeanBodyMass: "lean_body_mass",
  HKQuantityTypeIdentifierWaistCircumference: "waist_cm",

  // --- heart ------------------------------------------------------------------
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_hr",
  HKQuantityTypeIdentifierWalkingHeartRateAverage: "walking_hr",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv",
  HKQuantityTypeIdentifierVO2Max: "vo2_max",

  // --- respiratory ------------------------------------------------------------
  HKQuantityTypeIdentifierRespiratoryRate: "respiratory_rate",
  HKQuantityTypeIdentifierOxygenSaturation: "blood_oxygen",
  HKQuantityTypeIdentifierPeakExpiratoryFlowRate: "peak_flow",
  HKQuantityTypeIdentifierForcedVitalCapacity: "forced_vital_capacity",
  HKQuantityTypeIdentifierForcedExpiratoryVolume1: "fev1",

  // --- nutrition --------------------------------------------------------------
  HKQuantityTypeIdentifierDietaryEnergyConsumed: "dietary_calories",
  HKQuantityTypeIdentifierDietaryWater: "hydration_ml",
  HKQuantityTypeIdentifierDietaryProtein: "protein_g",
  HKQuantityTypeIdentifierDietaryFatTotal: "fat_g",
  HKQuantityTypeIdentifierDietaryFatSaturated: "saturated_fat_g",
  HKQuantityTypeIdentifierDietaryCarbohydrates: "carbs_g",
  HKQuantityTypeIdentifierDietaryFiber: "fiber_g",
  HKQuantityTypeIdentifierDietarySugar: "sugar_g",
  HKQuantityTypeIdentifierDietaryCholesterol: "cholesterol_mg",
  HKQuantityTypeIdentifierDietarySodium: "sodium_mg",
  HKQuantityTypeIdentifierDietaryPotassium: "potassium_mg",
  HKQuantityTypeIdentifierDietaryCalcium: "calcium_mg",
  HKQuantityTypeIdentifierDietaryIron: "iron_mg",
  HKQuantityTypeIdentifierDietaryMagnesium: "magnesium_mg",
  HKQuantityTypeIdentifierDietaryZinc: "zinc_mg",
  HKQuantityTypeIdentifierDietaryCaffeine: "caffeine_mg",
  HKQuantityTypeIdentifierDietaryVitaminA: "vitamin_a_mcg",
  HKQuantityTypeIdentifierDietaryVitaminC: "vitamin_c_mg",
  HKQuantityTypeIdentifierDietaryVitaminD: "vitamin_d_mcg",
  HKQuantityTypeIdentifierDietaryVitaminE: "vitamin_e_mg",
  HKQuantityTypeIdentifierDietaryVitaminB6: "vitamin_b6_mg",
  HKQuantityTypeIdentifierDietaryVitaminB12: "vitamin_b12_mcg",
  HKQuantityTypeIdentifierDietaryFolate: "folate_mcg",

  // --- vitals -----------------------------------------------------------------
  HKQuantityTypeIdentifierBloodGlucose: "blood_glucose",
  // Basal body temperature is deliberately absent: it is a different
  // measurement taken under different conditions, and folding it in with
  // ordinary body temperature would report a number the export never claimed.
  HKQuantityTypeIdentifierBodyTemperature: "body_temperature",

  // --- category types that carry a duration or a count ------------------------
  HKCategoryTypeIdentifierSleepAnalysis: "sleep_hours",
  HKCategoryTypeIdentifierMindfulSession: "mindful_minutes",
  HKCategoryTypeIdentifierAppleStandHour: "stand_hours",
};

/**
 * Blood pressure is exported as two separate records that only mean something
 * together, so they are paired by instant rather than mapped like the rest.
 */
export const APPLE_SYSTOLIC = "HKQuantityTypeIdentifierBloodPressureSystolic";
export const APPLE_DIASTOLIC = "HKQuantityTypeIdentifierBloodPressureDiastolic";

/**
 * Category types whose value is a *duration*, derived from the record's own
 * start and end rather than from a `value` attribute.
 */
export const DURATION_CATEGORY_TYPES: Record<string, { unit: string }> = {
  HKCategoryTypeIdentifierMindfulSession: { unit: "min" },
};

/** HealthKit sleep values → our stages. Older exports say just "Asleep". */
export const APPLE_SLEEP_MAP: Record<string, SleepStage> = {
  HKCategoryValueSleepAnalysisInBed: "in_bed",
  HKCategoryValueSleepAnalysisAsleep: "asleep",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAwake: "awake",
};

/** HKWorkoutActivityType → Personal OS workout type. Unlisted → custom. */
export const APPLE_WORKOUT_MAP: Record<string, string> = {
  HKWorkoutActivityTypeRunning: "running",
  HKWorkoutActivityTypeWalking: "walking",
  HKWorkoutActivityTypeHiking: "walking",
  HKWorkoutActivityTypeCycling: "cycling",
  HKWorkoutActivityTypeSwimming: "swimming",
  HKWorkoutActivityTypeYoga: "yoga",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "strength",
  HKWorkoutActivityTypeFunctionalStrengthTraining: "strength",
  HKWorkoutActivityTypeCoreTraining: "strength",
  HKWorkoutActivityTypeHighIntensityIntervalTraining: "hiit",
  HKWorkoutActivityTypeFlexibility: "mobility",
  HKWorkoutActivityTypeCooldown: "mobility",
  HKWorkoutActivityTypeElliptical: "cardio",
  HKWorkoutActivityTypeRowing: "cardio",
  HKWorkoutActivityTypeStairClimbing: "cardio",
  HKWorkoutActivityTypeJumpRope: "cardio",
  HKWorkoutActivityTypeMixedCardio: "cardio",
  HKWorkoutActivityTypePilates: "mobility",
  HKWorkoutActivityTypeDance: "cardio",
  HKWorkoutActivityTypeSoccer: "sport",
  HKWorkoutActivityTypeBasketball: "sport",
  HKWorkoutActivityTypeTennis: "sport",
  HKWorkoutActivityTypeGolf: "sport",
  HKWorkoutActivityTypeMartialArts: "sport",
};

/** `<WorkoutStatistics type>` identifiers the workout importer reads. */
export const WORKOUT_DISTANCE_STATS = new Set([
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierDistanceCycling",
  "HKQuantityTypeIdentifierDistanceSwimming",
]);
export const WORKOUT_ENERGY_STAT = "HKQuantityTypeIdentifierActiveEnergyBurned";
export const WORKOUT_HEART_RATE_STAT = "HKQuantityTypeIdentifierHeartRate";

/**
 * `<ActivitySummary>` attributes → metric type. Apple writes one of these per
 * day with the ring totals already computed, which is both cheaper and more
 * faithful than re-deriving stand hours from thousands of category records.
 */
export const ACTIVITY_SUMMARY_FIELDS: Array<{
  attribute: string;
  unitAttribute?: string;
  type: string;
  fallbackUnit: string;
}> = [
  {
    attribute: "activeEnergyBurned",
    unitAttribute: "activeEnergyBurnedUnit",
    type: "active_calories",
    fallbackUnit: "kcal",
  },
  { attribute: "appleExerciseTime", type: "exercise_minutes", fallbackUnit: "min" },
  { attribute: "appleStandHours", type: "stand_hours", fallbackUnit: "count" },
];

/** Turn `HKWorkoutActivityTypeTraditionalStrengthTraining` into a readable name. */
export function workoutDisplayName(activityType: string): string {
  const label = activityType.replace(/^HKWorkoutActivityType/, "") || "Workout";
  return label.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Turn `HKQuantityTypeIdentifierStepCount` into something a human can read. */
export function appleTypeDisplayName(identifier: string): string {
  const label = identifier
    .replace(/^HK(Quantity|Category|Correlation|Characteristic|Clinical)TypeIdentifier/, "")
    .replace(/^HKDataType/, "");
  return label ? label.replace(/([a-z])([A-Z])/g, "$1 $2") : identifier;
}
