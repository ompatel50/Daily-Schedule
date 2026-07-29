import { describe, expect, it } from "vitest";

import {
  DAY_LIST_CAPABILITIES,
  EXECUTION_CAPABILITIES,
  PLANNING_CAPABILITIES,
  RESPONSIBILITIES,
  RESPONSIBILITY_LABELS,
  SURFACES,
  SURFACE_ROLES,
  claimantsOf,
  dayListCapabilities,
  handoffFor,
  ownsResponsibility,
  responsibilityOwner,
  surfaceHref,
} from "@/lib/logic/surfaces";
import { NAV_ITEMS } from "@/lib/navigation";

/**
 * Phase 8 is a separation of responsibilities, so the thing worth testing is the
 * separation itself: that no job is claimed twice, that no job is orphaned, and
 * that the planning affordances live on exactly one surface. A regression here
 * is exactly the failure mode the phase exists to prevent — two screens quietly
 * growing back into copies of each other.
 */

describe("responsibility ownership", () => {
  it("gives every responsibility exactly one owner", () => {
    for (const responsibility of RESPONSIBILITIES) {
      expect(claimantsOf(responsibility), `owners of ${responsibility}`).toHaveLength(1);
    }
  });

  it("leaves no responsibility unclaimed", () => {
    for (const responsibility of RESPONSIBILITIES) {
      expect(responsibilityOwner(responsibility)).not.toBeNull();
    }
  });

  it("declares nothing outside the known responsibility list", () => {
    for (const surface of SURFACES) {
      for (const responsibility of SURFACE_ROLES[surface].owns) {
        expect(RESPONSIBILITIES).toContain(responsibility);
      }
    }
  });

  it("keeps the surfaces' owned sets disjoint", () => {
    const seen = new Set<string>();
    for (const surface of SURFACES) {
      for (const responsibility of SURFACE_ROLES[surface].owns) {
        expect(seen.has(responsibility), `${responsibility} claimed twice`).toBe(false);
        seen.add(responsibility);
      }
    }
    expect(seen.size).toBe(RESPONSIBILITIES.length);
  });

  it("puts execution on Today and structure on the Planner", () => {
    expect(ownsResponsibility("today", "day_execution")).toBe(true);
    expect(ownsResponsibility("today", "day_logging")).toBe(true);

    expect(ownsResponsibility("planner", "schedule_structure")).toBe(true);
    expect(ownsResponsibility("planner", "recurrence")).toBe(true);
    expect(ownsResponsibility("planner", "routines")).toBe(true);
    expect(ownsResponsibility("planner", "conflicts")).toBe(true);
    expect(ownsResponsibility("planner", "time_blocking")).toBe(true);
    expect(ownsResponsibility("planner", "multi_day_views")).toBe(true);
  });

  it("keeps the dashboard out of both — it summarises and routes, it does not do", () => {
    const dashboard = SURFACE_ROLES.dashboard.owns;
    expect(dashboard).not.toContain("day_execution");
    expect(dashboard).not.toContain("day_logging");
    expect(dashboard).not.toContain("schedule_structure");
    expect(dashboard).toEqual(["day_summary", "cross_domain_routing", "trend_overview"]);
  });

  it("labels every responsibility", () => {
    for (const responsibility of RESPONSIBILITIES) {
      expect(RESPONSIBILITY_LABELS[responsibility]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("day-list capabilities", () => {
  it("gives the planning affordances to the planner only", () => {
    for (const capability of PLANNING_CAPABILITIES) {
      expect(DAY_LIST_CAPABILITIES.planner[capability], `planner.${capability}`).toBe(true);
      expect(DAY_LIST_CAPABILITIES.today[capability], `today.${capability}`).toBe(false);
    }
  });

  it("keeps every execution affordance on Today", () => {
    for (const capability of EXECUTION_CAPABILITIES) {
      expect(DAY_LIST_CAPABILITIES.today[capability], `today.${capability}`).toBe(true);
    }
  });

  it("does not strip completion from the planner — planning a past day still ticks", () => {
    expect(DAY_LIST_CAPABILITIES.planner.completeItems).toBe(true);
  });

  it("covers every capability in exactly one of the two lists", () => {
    const keys = Object.keys(DAY_LIST_CAPABILITIES.today).sort();
    const declared = [...PLANNING_CAPABILITIES, ...EXECUTION_CAPABILITIES].sort();
    expect(declared).toEqual(keys);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("resolves by surface", () => {
    expect(dayListCapabilities("today")).toBe(DAY_LIST_CAPABILITIES.today);
    expect(dayListCapabilities("planner")).toBe(DAY_LIST_CAPABILITIES.planner);
  });
});

describe("hand-offs", () => {
  it("carries the date to the surface that owns the job", () => {
    expect(surfaceHref("today", "2026-08-02")).toBe("/today?date=2026-08-02");
    expect(surfaceHref("planner", "2026-08-02")).toBe("/planner?date=2026-08-02");
  });

  it("omits the date when there is none", () => {
    expect(surfaceHref("today")).toBe("/today");
    expect(surfaceHref("planner", null)).toBe("/planner");
  });

  it("never dates the dashboard, which is only ever about now", () => {
    expect(surfaceHref("dashboard", "2026-08-02")).toBe("/");
  });

  it("routes structural work to the planner and execution to Today", () => {
    expect(handoffFor("schedule_structure", "2026-08-02")).toMatchObject({
      surface: "planner",
      label: "Planner",
      href: "/planner?date=2026-08-02",
    });
    expect(handoffFor("recurrence")).toMatchObject({ surface: "planner", href: "/planner" });
    expect(handoffFor("time_blocking")).toMatchObject({ surface: "planner" });
    expect(handoffFor("day_execution", "2026-08-02")).toMatchObject({
      surface: "today",
      label: "Today",
      href: "/today?date=2026-08-02",
    });
  });
});

describe("navigation copy", () => {
  it("describes each surface with the purpose declared in the ownership table", () => {
    for (const surface of SURFACES) {
      const role = SURFACE_ROLES[surface];
      const item = NAV_ITEMS.find((navItem) => navItem.href === role.href);
      expect(item, `nav entry for ${role.href}`).toBeDefined();
      expect(item?.description).toBe(role.purpose);
    }
  });
});
