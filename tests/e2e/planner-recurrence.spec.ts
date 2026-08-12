import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The planner's overlap semantics and recurring-series scopes, verified
 * against the production build through the real UI:
 *
 *  * an adjacent morning produces no warnings anywhere; a genuine overlap
 *    names the right block and disappears when it is resolved;
 *  * a bounded Mon/Wed/Fri series respects its inclusive end date;
 *  * "this occurrence only" edits survive regeneration and touch nothing
 *    else; "this and all future" splits the series and inherits the end
 *    date; deletions of both scopes stick;
 *  * the same flows work in a phone viewport through the bottom sheet.
 *
 * Uses alice (the mutating-flows account). Every run works on its own quiet
 * far-future days (salted from the clock) so failed runs and parallel spec
 * files cannot contaminate each other, and cleans up through the app's own
 * delete flows. Console/page errors fail the test.
 */

test.use({ storageState: STORAGE.alice });

// --- run-unique far-future days ---------------------------------------------

/** Days since epoch for a YYYY-MM-DD key, all in UTC. */
const BASE = Date.UTC(2027, 2, 1); // 2027-03-01
const DAY_MS = 86_400_000;

function dayKey(offset: number): string {
  return new Date(BASE + offset * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

function addDays(key: string, amount: number): string {
  const at = new Date(`${key}T12:00:00Z`).getTime();
  return new Date(at + amount * DAY_MS).toISOString().slice(0, 10);
}

/** "Tuesday, May 4" / "May 4" — matching the app's formatDay output. */
function longDay(key: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));
}

function shortDay(key: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));
}

/** A run-unique quiet day inside a ~2-year far-future window. */
const RUN_OFFSET = (Date.now() % 600) + 30;

// --- helpers ------------------------------------------------------------------

/**
 * Fail the test on any console or page error. The one filtered source is
 * Vercel Analytics' script probe: the production bundle requests
 * /_vercel/insights/script.js, which only exists on Vercel's platform — a
 * plain `npm start` 404s it by design.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.location().url.includes("/_vercel/insights/")) return;
    if (message.text().includes("/_vercel/insights/")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function createItem(
  page: Page,
  fields: { title: string; date: string; start: string; end: string },
) {
  await page.getByRole("button", { name: "New item" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(fields.title);
  await dialog.getByLabel("Date", { exact: true }).fill(fields.date);
  await dialog.getByLabel("Start").fill(fields.start);
  await dialog.getByLabel("End", { exact: true }).fill(fields.end);
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Rows whose TITLE is exactly this text. A plain `hasText` filter would also
 * match a *different* row whose conflict badge says "Overlaps <title>" —
 * exactly the rows these tests create on purpose.
 */
function rows(page: Page, title: string) {
  return page.locator("div.group").filter({ has: page.getByText(title, { exact: true }) });
}

/** Open the row menu of the block with this title and pick a menu item. */
async function rowAction(page: Page, title: string, action: string) {
  const row = rows(page, title).first();
  await row.hover();
  await row.getByRole("button", { name: "Item actions" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

test.describe("overlap warnings", () => {
  test("an adjacent morning shows no warnings; a genuine overlap names the block", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const salt = String(Date.now()).slice(-5);
    const wake = `Wake Up ${salt}`;
    const legs = `Leg Mobility ${salt}`;
    const ready = `Get Ready ${salt}`;
    const breakfast = `Breakfast ${salt}`;
    const overlapper = `Overlapper ${salt}`;

    // Walk forward to a genuinely empty day, so residue from an interrupted
    // earlier run can never contribute a phantom pair to the counts below.
    let day = dayKey(RUN_OFFSET);
    for (let hop = 0; hop < 14; hop += 1) {
      await page.goto(`/planner?date=${day}`);
      await expect(page.getByRole("tab", { name: "Day" })).toBeVisible();
      if (await page.getByText("No items for this day").isVisible().catch(() => false)) break;
      day = addDays(day, 1);
    }
    await createItem(page, { title: wake, date: day, start: "08:00", end: "09:00" });
    await createItem(page, { title: legs, date: day, start: "09:00", end: "10:00" });
    await createItem(page, { title: ready, date: day, start: "10:00", end: "10:45" });
    await createItem(page, { title: breakfast, date: day, start: "10:45", end: "11:30" });

    // All four render…
    await expect(rows(page, breakfast)).toHaveCount(1);
    // …with no banner, no pair count, no per-row badges, no timeline styling.
    await expect(page.getByText(/overlapping pair/)).toHaveCount(0);
    await expect(page.getByText(/Overlaps /)).toHaveCount(0);
    await expect(page.locator('[title^="Overlaps"]')).toHaveCount(0);

    // Now a genuine double booking: 9:30–10:30 crosses two blocks.
    await createItem(page, { title: overlapper, date: day, start: "09:30", end: "10:30" });
    await expect(page.getByText(/2 overlapping pairs of blocks/)).toBeVisible();
    await expect(rows(page, legs).getByText(`Overlaps ${overlapper}`)).toBeVisible();

    // Resolving it clears every warning again.
    await rowAction(page, overlapper, "Delete");
    await expect(page.getByText(/overlapping pair/)).toHaveCount(0);
    await expect(page.getByText(/Overlaps /)).toHaveCount(0);

    for (const title of [wake, legs, ready, breakfast]) {
      await rowAction(page, title, "Delete");
      await expect(rows(page, title)).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});

test.describe("recurring series scopes (desktop)", () => {
  test("bounded creation, occurrence override, series split, scoped deletion", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = trackErrors(page);
    const title = `Test Class ${String(Date.now()).slice(-5)}`;

    // A semester-style series on a run-unique fortnight: Mon/Wed/Fri
    // 10:00–10:50, from a Monday anchor through the Friday eleven days later
    // (the INCLUSIVE end date) — exactly six occurrences.
    let anchor = dayKey(RUN_OFFSET + 7);
    while (weekdayOf(anchor) !== 1) anchor = addDays(anchor, 1);
    const until = addDays(anchor, 11);
    const days = [0, 2, 4, 7, 9, 11].map((offset) => addDays(anchor, offset));

    // --- create the bounded series ---------------------------------------
    await page.goto(`/planner?date=${anchor}`);
    await page.getByRole("button", { name: "New item" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Date", { exact: true }).fill(anchor);
    await dialog.getByLabel("Start").fill("10:00");
    await dialog.getByLabel("End", { exact: true }).fill("10:50");
    await dialog.getByLabel("Repeats").click();
    await page.getByRole("option", { name: "Weekly", exact: true }).click();
    for (const dayButton of ["Mo", "We", "Fr"]) {
      await dialog.getByRole("button", { name: dayButton, exact: true }).click();
    }
    await dialog.getByLabel("Ends").click();
    await page.getByRole("option", { name: "On date" }).click();
    await dialog.getByLabel("End date").fill(until);
    await expect(
      dialog.getByText(`Every Mon, Wed, Fri · ${shortDay(anchor)} – ${shortDay(until)}`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Add item" }).click();
    await expect(dialog).toBeHidden();

    // Occurrences: on pattern days only, end date included, nothing outside.
    await expect(rows(page, title)).toHaveCount(1);
    for (const [day, present] of [
      [addDays(anchor, -3), false], // the Friday before the start date
      [addDays(anchor, 1), false], // a Tuesday
      [days[1], true], // the first Wednesday
      [until, true], // the inclusive end date itself
      [addDays(until, 3), false], // the Monday after the end date
    ] as const) {
      await page.goto(`/planner?date=${day}`);
      await expect(rows(page, title)).toHaveCount(present ? 1 : 0);
    }

    // --- edit ONE occurrence (the first Wednesday) -------------------------
    await page.goto(`/planner?date=${days[1]}`);
    await rowAction(page, title, "Edit");
    const edit = page.getByRole("dialog");
    await edit.getByLabel("Start").fill("11:00");
    await edit.getByLabel("End", { exact: true }).fill("12:00");
    await edit.getByRole("button", { name: /Save/ }).click();
    const chooser = page.getByRole("dialog", { name: "Save recurring item" });
    // The selected occurrence's day is named, in words.
    await expect(chooser.getByText(longDay(days[1]), { exact: true })).toBeVisible();
    await chooser.getByRole("button", { name: /This occurrence only/ }).click();
    await expect(chooser).toBeHidden();

    // The edited day changed; regeneration (every planner open) keeps it.
    await page.goto(`/planner?date=${days[1]}`);
    await expect(rows(page, title).getByText("11:00 AM – 12:00 PM")).toBeVisible();
    await expect(rows(page, title)).toHaveCount(1);
    // Neighbours kept the series time.
    for (const day of [days[0], days[2]]) {
      await page.goto(`/planner?date=${day}`);
      await expect(rows(page, title).getByText("10:00 AM – 10:50 AM")).toBeVisible();
    }

    // --- edit THIS AND ALL FUTURE (the second Monday) ----------------------
    await page.goto(`/planner?date=${days[3]}`);
    await rowAction(page, title, "Edit");
    const splitDialog = page.getByRole("dialog");
    // The recurrence controls are pre-filled from the series — the end date
    // is already there, and we do NOT touch it.
    await expect(splitDialog.getByLabel("End date")).toHaveValue(until);
    await splitDialog.getByLabel("Start").fill("13:00");
    await splitDialog.getByLabel("End", { exact: true }).fill("14:00");
    await splitDialog.getByRole("button", { name: /Save/ }).click();
    await page
      .getByRole("dialog", { name: "Save recurring item" })
      .getByRole("button", { name: /This and all future occurrences/ })
      .click();

    // History unchanged…
    await page.goto(`/planner?date=${days[2]}`);
    await expect(rows(page, title).getByText("10:00 AM – 10:50 AM")).toBeVisible();
    // …future re-timed…
    for (const day of [days[3], days[4], days[5]]) {
      await page.goto(`/planner?date=${day}`);
      await expect(rows(page, title).getByText("1:00 PM – 2:00 PM")).toBeVisible();
      await expect(rows(page, title)).toHaveCount(1);
    }
    // …and the INHERITED end date still bounds the series.
    await page.goto(`/planner?date=${addDays(until, 3)}`);
    await expect(rows(page, title)).toHaveCount(0);

    // --- delete ONE occurrence (the second Wednesday) ----------------------
    await page.goto(`/planner?date=${days[4]}`);
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: /Delete this occurrence/ })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    // A fresh planner open re-runs generation; the day stays deleted.
    await page.goto(`/planner?date=${days[4]}`);
    await expect(rows(page, title)).toHaveCount(0);
    await page.goto(`/planner?date=${days[5]}`);
    await expect(rows(page, title)).toHaveCount(1);

    // --- delete THIS AND FUTURE (the last Friday) ---------------------------
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: /Delete this and all future occurrences/ })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    // Earlier history remains.
    await page.goto(`/planner?date=${days[3]}`);
    await expect(rows(page, title)).toHaveCount(1);

    // --- cleanup: remove both series entirely ------------------------------
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: /Delete the entire series/ })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    await page.goto(`/planner?date=${anchor}`);
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: /Delete the entire series/ })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    for (const day of [days[1], days[2]]) {
      await page.goto(`/planner?date=${day}`);
      await expect(rows(page, title)).toHaveCount(0);
    }

    expect(errors).toEqual([]);
  });
});

test.describe("recurring scopes on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the scope chooser is a touch-friendly bottom sheet", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = trackErrors(page);
    const title = `Phone series ${String(Date.now()).slice(-5)}`;
    const anchor = dayKey(RUN_OFFSET + 21);
    const second = addDays(anchor, 1);
    const third = addDays(anchor, 2);

    await page.goto(`/planner?date=${anchor}`);

    // A short daily series.
    await page.getByRole("button", { name: "New item" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Date", { exact: true }).fill(anchor);
    await dialog.getByLabel("Start").fill("09:00");
    await dialog.getByLabel("End", { exact: true }).fill("09:30");
    await dialog.getByLabel("Repeats").click();
    await page.getByRole("option", { name: "Daily" }).click();
    await dialog.getByLabel("Ends").click();
    await page.getByRole("option", { name: "On date" }).click();
    await dialog.getByLabel("End date").fill(addDays(anchor, 3));
    await dialog.getByRole("button", { name: "Add item" }).click();
    await expect(dialog).toBeHidden();

    // Edit one occurrence: the chooser opens as a sheet with big targets.
    await page.goto(`/planner?date=${second}`);
    await rowAction(page, title, "Edit");
    const edit = page.getByRole("dialog");
    await edit.getByLabel("Start").fill("10:00");
    await edit.getByLabel("End", { exact: true }).fill("10:30");
    await edit.getByRole("button", { name: /Save/ }).click();

    const sheet = page.getByRole("dialog", { name: "Save recurring item" });
    await expect(sheet.getByText(longDay(second), { exact: true })).toBeVisible();
    const option = sheet.getByRole("button", { name: /This occurrence only/ });
    const box = await option.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(44); // a real touch target
    await option.click();
    await expect(sheet).toBeHidden();
    await expect(rows(page, title).getByText("10:00 AM – 10:30 AM")).toBeVisible();

    // Neighbour unchanged.
    await page.goto(`/planner?date=${third}`);
    await expect(rows(page, title).getByText("9:00 AM – 9:30 AM")).toBeVisible();

    // No horizontal overflow with the sheet flow behind us.
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement!;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // Delete this occurrence through the sheet; it stays deleted on reload.
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: /Delete this occurrence/ })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    await page.goto(`/planner?date=${third}`);
    await expect(rows(page, title)).toHaveCount(0);

    // Then the whole series.
    await page.goto(`/planner?date=${anchor}`);
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: /Delete the entire series/ })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    await page.goto(`/planner?date=${second}`);
    await expect(rows(page, title)).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
