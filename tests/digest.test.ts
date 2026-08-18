import { describe, expect, it } from "vitest";

import { buildDailyDigest, digestKey } from "@/lib/logic/digest";
import { DELIVERY_WINDOW_MS, type ReminderOccurrence } from "@/lib/logic/reminders";

/**
 * The daily digest builder — the pure half of the once-a-day cron's one
 * useful push. Selection (wall-clock always in, instants only when they
 * belong to the coming day), line shapes (agenda times for timed kinds, the
 * occurrence's own phrasing for due items and alerts), ordering, the line
 * cap, and the empty-day null.
 */

const NOW = Date.parse("2026-08-18T14:00:00Z");
const TZ = "America/New_York"; // UTC-4 in August — 14:00Z is 10:00 local.

function occurrence(over: Partial<ReminderOccurrence>): ReminderOccurrence {
  return {
    key: over.key ?? `habit:h1:2026-08-18`,
    kind: "habit",
    title: "Stretch",
    message: null,
    fireAt: "2026-08-18T07:30:00",
    reminderId: null,
    ...over,
  };
}

describe("buildDailyDigest", () => {
  it("an empty feed is silence, not an empty notification", () => {
    expect(buildDailyDigest([], { timezone: TZ, nowMs: NOW })).toBeNull();
  });

  it("timed kinds read as an agenda; due items carry their own phrasing", () => {
    const digest = buildDailyDigest(
      [
        occurrence({ key: "habit:h1:2026-08-18", title: "Stretch", fireAt: "2026-08-18T07:30:00" }),
        occurrence({
          key: "bill:b1:2026-08-18",
          kind: "bill",
          title: "Rent",
          message: "Bill due today · $1,200.00",
          fireAt: "2026-08-18T09:00:00",
        }),
      ],
      { timezone: TZ, nowMs: NOW },
    );
    expect(digest).not.toBeNull();
    expect(digest!.title).toBe("Your day ahead: 2 reminders");
    expect(digest!.body).toContain("07:30 Stretch");
    expect(digest!.body).toContain("Rent — Bill due today · $1,200.00");
    // No meaningless 9:00 stamp on the bill line.
    expect(digest!.body).not.toContain("09:00");
  });

  it("agenda lines come first in clock order, due items after", () => {
    const digest = buildDailyDigest(
      [
        occurrence({
          key: "task:t1:2026-08-18",
          kind: "task",
          title: "File taxes",
          message: "Task due today",
          fireAt: "2026-08-18T09:00:00",
        }),
        occurrence({ key: "habit:h2:2026-08-18", title: "Journal", fireAt: "2026-08-18T21:00:00" }),
        occurrence({ key: "habit:h1:2026-08-18", title: "Stretch", fireAt: "2026-08-18T07:30:00" }),
      ],
      { timezone: TZ, nowMs: NOW },
    );
    const lines = digest!.body.split("\n");
    expect(lines[0]).toBe("07:30 Stretch");
    expect(lines[1]).toBe("21:00 Journal");
    expect(lines[2]).toBe("File taxes — Task due today");
  });

  it("a small-hours occurrence dated tomorrow still belongs to the day", () => {
    // Operational-day shifting stamps a 1:00 AM reminder with the NEXT
    // calendar date; the feed only ever contains the coming operational day,
    // so every wall-clock occurrence is included as-is.
    const digest = buildDailyDigest(
      [occurrence({ title: "Wind down", fireAt: "2026-08-19T01:00:00" })],
      { timezone: TZ, nowMs: NOW },
    );
    expect(digest!.body).toBe("01:00 Wind down");
  });

  it("classic instants are windowed to the coming day and shown on the user's clock", () => {
    const digest = buildDailyDigest(
      [
        // 18:30Z = 14:30 in New York — later today: in, with the local time.
        occurrence({
          key: "reminder:r1:2026-08-18T18:30:00.000Z",
          kind: "reminder",
          title: "Call the bank",
          fireAt: "2026-08-18T18:30:00.000Z",
        }),
        // Still inside the late window: in.
        occurrence({
          key: "reminder:r2:...",
          kind: "reminder",
          title: "Just missed",
          fireAt: new Date(NOW - DELIVERY_WINDOW_MS / 2).toISOString(),
        }),
        // Next week: out — the feed carries future classics; the digest must not.
        occurrence({
          key: "reminder:r3:...",
          kind: "reminder",
          title: "Renew passport",
          fireAt: "2026-08-25T18:30:00.000Z",
        }),
        // Long past: out.
        occurrence({
          key: "reminder:r4:...",
          kind: "reminder",
          title: "Yesterday's",
          fireAt: new Date(NOW - 2 * DELIVERY_WINDOW_MS).toISOString(),
        }),
      ],
      { timezone: TZ, nowMs: NOW },
    );
    expect(digest!.count).toBe(2);
    expect(digest!.body).toContain("14:30 Call the bank");
    expect(digest!.body).toContain("Just missed");
    expect(digest!.body).not.toContain("Renew passport");
    expect(digest!.body).not.toContain("Yesterday's");
  });

  it("caps the body and counts the fold honestly", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      occurrence({
        key: `habit:h${index}:2026-08-18`,
        title: `Habit ${index}`,
        fireAt: `2026-08-18T0${index}:00:00`,
      }),
    );
    const digest = buildDailyDigest(many, { timezone: TZ, nowMs: NOW });
    expect(digest!.count).toBe(9);
    const lines = digest!.body.split("\n");
    expect(lines).toHaveLength(7); // 6 entries + the fold line
    expect(lines[6]).toBe("…and 3 more");
    expect(digest!.title).toBe("Your day ahead: 9 reminders");
  });

  it("clips a runaway line instead of shipping a novel", () => {
    const digest = buildDailyDigest(
      [occurrence({ title: "A".repeat(300) })],
      { timezone: TZ, nowMs: NOW },
    );
    const line = digest!.body.split("\n")[0];
    expect(line.length).toBeLessThanOrEqual(90);
    expect(line.endsWith("…")).toBe(true);
  });

  it("one reminder gets the singular title", () => {
    const digest = buildDailyDigest([occurrence({})], { timezone: TZ, nowMs: NOW });
    expect(digest!.title).toBe("Your day ahead: 1 reminder");
  });

  it("a broken timezone degrades to a timeless line, never a throw", () => {
    const digest = buildDailyDigest(
      [
        occurrence({
          kind: "reminder",
          title: "Call the bank",
          fireAt: "2026-08-18T18:30:00.000Z",
        }),
      ],
      { timezone: "Not/AZone", nowMs: NOW },
    );
    expect(digest!.body).toBe("Call the bank");
  });
});

describe("digestKey", () => {
  it("is the operational day under a stable prefix", () => {
    expect(digestKey("2026-08-18")).toBe("digest:2026-08-18");
  });
});
