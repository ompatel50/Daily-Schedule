/**
 * The onboarding checklist — pure state handling for `User.onboardingState`.
 *
 * The checklist is optional and dismissible; steps are ticked by the user, not
 * inferred, because "has a meal row" cannot distinguish demo data from a real
 * first log. State is a small JSON blob on the user; parsing is defensive so a
 * hand-edited or pre-upgrade value can never crash a page.
 */

export interface OnboardingStep {
  id: string;
  label: string;
  detail: string;
  href: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "plan_day",
    label: "Plan a day",
    detail: "Block out tomorrow in the planner — times, categories, a routine if you have one.",
    href: "/planner",
  },
  {
    id: "add_habit",
    label: "Add a habit",
    detail: "Pick one thing worth repeating and give it a real schedule.",
    href: "/habits",
  },
  {
    id: "set_goals",
    label: "Set your goals",
    detail: "Targets for nutrition, training or health — scheduled on the days they apply.",
    href: "/settings",
  },
  {
    id: "log_meal",
    label: "Log a meal",
    detail: "Search the food table or add a custom food; totals and the day score follow.",
    href: "/nutrition",
  },
  {
    id: "log_workout",
    label: "Train once",
    detail: "Start a live session from a template, or log a finished workout.",
    href: "/workouts",
  },
  {
    id: "health_data",
    label: "Bring in health data",
    detail: "Log a metric by hand, or import an Apple Health export / CSV — locally.",
    href: "/health",
  },
  {
    id: "backup",
    label: "Take a backup",
    detail: "Export the JSON once so you know the restore path works.",
    href: "/settings",
  },
];

export interface OnboardingState {
  dismissed: boolean;
  done: string[];
}

const KNOWN_IDS = new Set(ONBOARDING_STEPS.map((step) => step.id));

/** Never throws; unknown shapes and unknown step ids degrade to defaults. */
export function parseOnboardingState(raw: unknown): OnboardingState {
  const empty: OnboardingState = { dismissed: false, done: [] };
  if (typeof raw !== "string" || raw.trim() === "") return empty;
  try {
    const parsed = JSON.parse(raw) as { dismissed?: unknown; done?: unknown };
    return {
      dismissed: parsed.dismissed === true,
      done: Array.isArray(parsed.done)
        ? [...new Set(parsed.done.filter((id): id is string => typeof id === "string" && KNOWN_IDS.has(id)))]
        : [],
    };
  } catch {
    return empty;
  }
}

export function serializeOnboardingState(state: OnboardingState): string {
  return JSON.stringify({ dismissed: state.dismissed, done: state.done });
}

export function toggleStep(state: OnboardingState, stepId: string, done: boolean): OnboardingState {
  if (!KNOWN_IDS.has(stepId)) return state;
  const set = new Set(state.done);
  if (done) set.add(stepId);
  else set.delete(stepId);
  return { ...state, done: [...set] };
}

export function dismissChecklist(state: OnboardingState): OnboardingState {
  return { ...state, dismissed: true };
}

export function restoreChecklist(state: OnboardingState): OnboardingState {
  return { ...state, dismissed: false };
}

export function checklistProgress(state: OnboardingState): { done: number; total: number } {
  return { done: state.done.length, total: ONBOARDING_STEPS.length };
}
