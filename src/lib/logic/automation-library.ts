/**
 * The starter rule library — pre-built definitions the user can add and
 * edit. Presented strictly as OPTIONAL templates: adding one stores it
 * DISABLED (the ordinary save path), and it only runs after the user has
 * reviewed it in the builder and run the mandatory dry run. Nothing here
 * self-activates.
 *
 * Each template's JSON goes through the same `parseRuleDefinition`
 * validation as a hand-built rule — a unit test parses every entry, so a
 * template can never drift out of the vocabulary.
 */

export interface StarterRule {
  key: string;
  name: string;
  /** Why someone would want it — one sentence, shown on the card. */
  blurb: string;
  /** What the user is expected to edit before enabling ("change the payee
   * text to your gym"). */
  editHint: string | null;
  trigger: string;
  conditions: string;
  actions: string;
}

export const STARTER_RULES: readonly StarterRule[] = [
  {
    key: "merchant-categorisation",
    name: "Categorise a merchant",
    blurb:
      "When a transaction from a payee you name arrives, file it under the right category automatically.",
    editHint: "Change “planet fitness” to your merchant and pick your category.",
    trigger: '{"type":"record","module":"transaction","event":"created"}',
    conditions: '{"field":"payee","op":"contains","value":"planet fitness"}',
    actions: '[{"type":"set_category","category":"health"}]',
  },
  {
    key: "recurring-transaction-linking",
    name: "Link a recurring charge to its bill",
    blurb:
      "When a recurring charge arrives, link the transaction to the matching bill so payments and dues stay reconciled.",
    editHint: "Change the payee text to the charge this should catch.",
    trigger: '{"type":"record","module":"transaction","event":"created"}',
    conditions: '{"field":"payee","op":"contains","value":"netflix"}',
    actions: '[{"type":"link_bill"}]',
  },
  {
    key: "post-workout-habit",
    name: "Log a habit after training",
    blurb: "When a workout is saved, mark a training habit done for that day.",
    editHint: "Change “Train” to the exact name of your habit.",
    trigger: '{"type":"record","module":"workout","event":"created"}',
    conditions: '{"field":"status","op":"eq","value":"completed"}',
    actions: '[{"type":"log_habit","habit":"Train"}]',
  },
  {
    key: "low-sleep-protection",
    name: "Protect a short-sleep day",
    blurb:
      "When last night's sleep was under 6 hours, put an early wind-down block on today's planner.",
    editHint: "Adjust the threshold and the block to taste.",
    trigger: '{"type":"fact","metric":"sleepHours","direction":"below","value":6}',
    conditions: '{"all":[]}',
    actions:
      '[{"type":"create_block","title":"Wind down early","category":"rest"},{"type":"notify","title":"Short night logged","message":"Sleep was under 6 h — an early wind-down block is on today\'s planner."}]',
  },
];
