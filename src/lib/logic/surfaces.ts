/**
 * Who owns what, across the three day-oriented surfaces.
 *
 * Dashboard, Today and Planner all talk about the same day, so they will always
 * mention some of the same facts — a summary that refused to name a number
 * would be useless. What actually confuses people is duplicated *depth* and
 * duplicated *interaction*: two screens that both let you restructure the day,
 * two editable lists you have to keep in sync in your head, two stat grids
 * showing the same four numbers with no reason to prefer either.
 *
 * This module is the single declaration of which surface owns which job. The
 * pages, the sidebar, the command palette and the day list all read it, so the
 * separation cannot drift out of agreement with the copy that describes it —
 * and `tests/surfaces.test.ts` fails the moment two surfaces claim the same
 * responsibility.
 */

export const SURFACES = ["dashboard", "today", "planner"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * The jobs the three surfaces divide between them. Each one belongs to exactly
 * one surface; there is no "shared" owner, because "shared" is how the previous
 * layout ended up with two editable copies of the same day.
 */
export const RESPONSIBILITIES = [
  "day_summary",
  "cross_domain_routing",
  "trend_overview",
  "day_execution",
  "day_logging",
  "schedule_structure",
  "recurrence",
  "routines",
  "conflicts",
  "time_blocking",
  "multi_day_views",
] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];

export const RESPONSIBILITY_LABELS: Record<Responsibility, string> = {
  day_summary: "the day at a glance",
  cross_domain_routing: "getting to the right screen",
  trend_overview: "recent trends",
  day_execution: "working through today",
  day_logging: "logging what actually happened",
  schedule_structure: "building and shaping the schedule",
  recurrence: "repeating items and series",
  routines: "saved routines",
  conflicts: "overlapping time blocks",
  time_blocking: "laying the day out on a time axis",
  multi_day_views: "the week and the month",
};

export interface SurfaceRole {
  surface: Surface;
  href: string;
  label: string;
  /** One line. The sidebar, the command palette and the page header share it. */
  purpose: string;
  owns: readonly Responsibility[];
}

export const SURFACE_ROLES: Record<Surface, SurfaceRole> = {
  dashboard: {
    surface: "dashboard",
    href: "/",
    label: "Dashboard",
    purpose: "A read-only summary of today, and the way in to everything else",
    owns: ["day_summary", "cross_domain_routing", "trend_overview"],
  },
  today: {
    surface: "today",
    href: "/today",
    label: "Today",
    purpose: "Work through today — tick things off and log what happened",
    owns: ["day_execution", "day_logging"],
  },
  planner: {
    surface: "planner",
    href: "/planner",
    label: "Planner",
    purpose: "Shape schedules, routines, recurrence and time blocks",
    owns: [
      "schedule_structure",
      "recurrence",
      "routines",
      "conflicts",
      "time_blocking",
      "multi_day_views",
    ],
  },
};

const OWNER_BY_RESPONSIBILITY = ((): Map<Responsibility, Surface> => {
  const map = new Map<Responsibility, Surface>();
  for (const surface of SURFACES) {
    // Deliberately does not overwrite: if two surfaces ever claim the same job
    // the first wins here and the test suite reports the clash, rather than the
    // map silently agreeing with whichever entry was declared last.
    for (const responsibility of SURFACE_ROLES[surface].owns) {
      if (!map.has(responsibility)) map.set(responsibility, surface);
    }
  }
  return map;
})();

/** Which surface a job belongs to. `null` only if a job is declared nowhere. */
export function responsibilityOwner(responsibility: Responsibility): Surface | null {
  return OWNER_BY_RESPONSIBILITY.get(responsibility) ?? null;
}

export function ownsResponsibility(surface: Surface, responsibility: Responsibility): boolean {
  return responsibilityOwner(responsibility) === surface;
}

/** Every surface that claims `responsibility`. More than one is a bug. */
export function claimantsOf(responsibility: Responsibility): Surface[] {
  return SURFACES.filter((surface) => SURFACE_ROLES[surface].owns.includes(responsibility));
}

// ---------------------------------------------------------------------------
// The day list
// ---------------------------------------------------------------------------

/** The two surfaces that render an editable list of a single day's items. */
export type DayListSurface = Extract<Surface, "today" | "planner">;

export interface DayListCapabilities {
  /** Tick an item done, skip it, push it to tomorrow. */
  completeItems: boolean;
  /** One-line capture. Available anywhere, because capture must never be a trip. */
  quickAdd: boolean;
  /** Drag the untimed backlog into the order you want to work it. */
  reorderBacklog: boolean;
  /** Move a past day's unfinished work forward. */
  rollover: boolean;
  /** The full new-item dialog: times, category, priority, recurrence. */
  createItems: boolean;
  /** Overlap warnings on the row. */
  conflictWarnings: boolean;
  /** "This and future" / "whole series" scopes on edit and delete. */
  seriesActions: boolean;
}

/**
 * One editable day list, two postures.
 *
 * Both surfaces render the *same* `DaySchedule` component against the same
 * server actions — the split is which affordances that component offers, not a
 * second implementation. Today can finish work; the Planner can restructure it.
 */
export const DAY_LIST_CAPABILITIES: Record<DayListSurface, DayListCapabilities> = {
  today: {
    completeItems: true,
    quickAdd: true,
    reorderBacklog: true,
    rollover: true,
    createItems: false,
    conflictWarnings: false,
    seriesActions: false,
  },
  planner: {
    completeItems: true,
    quickAdd: true,
    reorderBacklog: true,
    rollover: true,
    createItems: true,
    conflictWarnings: true,
    seriesActions: true,
  },
};

/**
 * Affordances that belong to whoever owns `schedule_structure`. Never true on
 * two surfaces at once — that is the duplication Phase 8 exists to remove.
 */
export const PLANNING_CAPABILITIES = [
  "createItems",
  "conflictWarnings",
  "seriesActions",
] as const satisfies ReadonlyArray<keyof DayListCapabilities>;

/** Affordances Today must keep, or it stops being the place you finish a day. */
export const EXECUTION_CAPABILITIES = [
  "completeItems",
  "quickAdd",
  "reorderBacklog",
  "rollover",
] as const satisfies ReadonlyArray<keyof DayListCapabilities>;

export function dayListCapabilities(surface: DayListSurface): DayListCapabilities {
  return DAY_LIST_CAPABILITIES[surface];
}

// ---------------------------------------------------------------------------
// Hand-offs
// ---------------------------------------------------------------------------

/**
 * A link to a surface for a given date.
 *
 * The dashboard never edits and Today never restructures, so both need to send
 * the user somewhere — and the date has to travel with them, or "plan this day"
 * silently means "plan today".
 */
export function surfaceHref(surface: Surface, date?: string | null): string {
  const role = SURFACE_ROLES[surface];
  // The dashboard is always about the current day; a `?date=` there would
  // promise a time machine that does not exist.
  if (surface === "dashboard" || !date) return role.href;
  return `${role.href}?date=${date}`;
}

export interface Handoff {
  responsibility: Responsibility;
  surface: Surface;
  label: string;
  href: string;
}

/**
 * "You want X? X lives over there." Resolved from the ownership table so the
 * link and the wording cannot disagree with who actually owns the job.
 */
export function handoffFor(responsibility: Responsibility, date?: string | null): Handoff | null {
  const surface = responsibilityOwner(responsibility);
  if (!surface) return null;
  return {
    responsibility,
    surface,
    label: SURFACE_ROLES[surface].label,
    href: surfaceHref(surface, date),
  };
}
