import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The two follow-up planner fixes, verified against the production build
 * through the real UI:
 *
 *  * same-start ordering — a 9:00 AM point item sorts before 9:00–9:30
 *    before 9:00–10:00, in the day list AND the timeline, at desktop and
 *    phone widths;
 *  * cross-midnight blocks — 11:45 PM → 12:15 AM is accepted, announces
 *    "ends next day" before saving, stores the real next-day end, groups
 *    under the start's operational day, treats a 12:15 AM follower as
 *    adjacent, and repeats correctly as a recurring series.
 *
 * Uses alice (the mutating-flows account), run-unique far-future days, and
 * cleans up through the app's own delete flows. Console/page errors fail the
 * test.
 */

test.use({ storageState: STORAGE.alice });

// --- run-unique far-future days (same scheme as planner-recurrence) ---------

const BASE = Date.UTC(2027, 7, 2); // 2027-08-02 — a different window than the sibling specs
const DAY_MS = 86_400_000;

function dayKey(offset: number): string {
  return new Date(BASE + offset * DAY_MS).toISOString().slice(0, 10);
}

function addDays(key: string, amount: number): string {
  const at = new Date(`${key}T12:00:00Z`).getTime();
  return new Date(at + amount * DAY_MS).toISOString().slice(0, 10);
}

/** "Aug 3" — matching the app's formatDay(…, "MMM d") output. */
function shortDay(key: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));
}

/** "Tue, Aug 3" — matching the app's default formatDay ("EEE, MMM d"). */
function weekdayShortDay(key: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));
}

const RUN_OFFSET = (Date.now() % 500) + 20;

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

function rows(page: Page, title: string) {
  return page.locator("div.group").filter({ has: page.getByText(title, { exact: true }) });
}

async function rowAction(page: Page, title: string, action: string) {
  const row = rows(page, title).first();
  await row.hover();
  await row.getByRole("button", { name: "Item actions" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

/** Walk forward to a genuinely empty day, immune to residue from failed runs. */
async function emptyDay(page: Page, from: string): Promise<string> {
  let day = from;
  for (let hop = 0; hop < 14; hop += 1) {
    await page.goto(`/planner?date=${day}`);
    await expect(page.getByRole("tab", { name: "Day" })).toBeVisible();
    if (await page.getByText("No items for this day").isVisible().catch(() => false)) break;
    day = addDays(day, 1);
  }
  return day;
}

/**
 * Titles in the day list's VISUAL order (top to bottom). Matching by each
 * row's own exact-title element, never by substring — a different row's
 * "Overlaps <title>" badge must not count as the title.
 */
async function listOrder(page: Page, titles: string[]): Promise<string[]> {
  const entries: Array<{ title: string; y: number }> = [];
  for (const title of titles) {
    const box = await rows(page, title).first().boundingBox();
    if (box) entries.push({ title, y: box.y });
  }
  return entries.sort((a, b) => a.y - b.y).map((entry) => entry.title);
}

/**
 * Titles in the timeline's visual order: top to bottom, then left to right —
 * same-start blocks sit side by side, ordered by their assigned columns.
 * A block's text STARTS with its title (the sr-only conflict suffix follows),
 * which is what keeps "Overlaps X" from matching as X.
 */
async function timelineOrder(page: Page, titles: string[]): Promise<string[]> {
  const blocks = await page.locator("div.absolute.inset-y-0 button").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { text: node.textContent ?? "", top: rect.top, left: rect.left };
    }),
  );
  return blocks
    .map((block) => ({
      ...block,
      title: titles.find((title) => block.text.startsWith(title)) ?? null,
    }))
    .filter((block): block is typeof block & { title: string } => block.title !== null)
    .sort((a, b) => (a.top !== b.top ? a.top - b.top : a.left - b.left))
    .map((block) => block.title);
}

// ---------------------------------------------------------------------------

test.describe("same-start ordering (desktop)", () => {
  test("Wake Up 9:00 before Mobility 9:00–9:30 before Cardio 9:00–10:00, list and timeline agreeing", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const salt = String(Date.now()).slice(-5);
    const wake = `Wake Up ${salt}`;
    const cardio = `Cardio ${salt}`;
    const mobility = `Mobility ${salt}`;

    const day = await emptyDay(page, dayKey(RUN_OFFSET));

    // The reported repro order: the longer block created FIRST.
    await createItem(page, { title: cardio, date: day, start: "09:00", end: "10:00" });
    // A point item: equal start and end.
    await createItem(page, { title: wake, date: day, start: "09:00", end: "09:00" });

    await expect(rows(page, wake)).toHaveCount(1);
    expect(await listOrder(page, [cardio, wake])).toEqual([wake, cardio]);

    await createItem(page, { title: mobility, date: day, start: "09:00", end: "09:30" });
    await expect(rows(page, mobility)).toHaveCount(1);

    const expected = [wake, mobility, cardio];
    expect(await listOrder(page, [cardio, wake, mobility])).toEqual(expected);
    expect(await timelineOrder(page, [cardio, wake, mobility])).toEqual(expected);

    for (const title of expected) {
      await rowAction(page, title, "Delete");
      await expect(rows(page, title)).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});

test.describe("cross-midnight blocks (desktop)", () => {
  test("11:45 PM → 12:15 AM: accepted, announced, stored next-day, adjacent follower stays quiet", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const salt = String(Date.now()).slice(-5);
    const night = `Night Mobility ${salt}`;
    const follower = `Early Reading ${salt}`;

    const day = await emptyDay(page, dayKey(RUN_OFFSET + 40));

    // The form announces the resolved meaning BEFORE saving.
    await page.getByRole("button", { name: "New item" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(night);
    await dialog.getByLabel("Date", { exact: true }).fill(day);
    await dialog.getByLabel("Start").fill("23:45");
    await dialog.getByLabel("End", { exact: true }).fill("00:15");
    await expect(
      dialog.getByText(`Ends next day — ${weekdayShortDay(addDays(day, 1))} · 30m`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Add item" }).click();
    await expect(dialog).toBeHidden();

    // Saved without any "End time must be after the start time" refusal; the
    // row shows the real range and the explicit next-day marker.
    const row = rows(page, night).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("11:45 PM – 12:15 AM")).toBeVisible();
    await expect(row.getByText(`ends ${shortDay(addDays(day, 1))}`)).toBeVisible();

    // Grouped under the start's operational day only.
    await page.goto(`/planner?date=${addDays(day, 1)}`);
    await expect(rows(page, night)).toHaveCount(0);
    await page.goto(`/planner?date=${day}`);
    await expect(rows(page, night)).toHaveCount(1);

    // A 12:15 AM follower on the SAME operational day is adjacent, not a
    // conflict — and it sorts after the evening block.
    await createItem(page, { title: follower, date: day, start: "00:15", end: "01:00" });
    await expect(rows(page, follower)).toHaveCount(1);
    await expect(page.getByText(/overlapping pair/)).toHaveCount(0);
    await expect(page.getByText(/Overlaps /)).toHaveCount(0);
    expect(await listOrder(page, [follower, night])).toEqual([night, follower]);

    await rowAction(page, follower, "Delete");
    await rowAction(page, night, "Delete");
    await expect(rows(page, night)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a recurring 11:45 PM series repeats the cross-midnight span on each start date", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const salt = String(Date.now()).slice(-5);
    const title = `Nightly Reset ${salt}`;

    const day = await emptyDay(page, dayKey(RUN_OFFSET + 80));
    const until = addDays(day, 2);

    await page.getByRole("button", { name: "New item" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Date", { exact: true }).fill(day);
    await dialog.getByLabel("Start").fill("23:45");
    await dialog.getByLabel("End", { exact: true }).fill("00:15");
    await dialog.getByLabel("Repeats").click();
    await page.getByRole("option", { name: "Daily", exact: true }).click();
    await dialog.getByLabel("Ends").click();
    await page.getByRole("option", { name: "On date" }).click();
    await dialog.getByLabel("End date").fill(until);
    await dialog.getByRole("button", { name: "Add item" }).click();
    await expect(dialog).toBeHidden();

    // Three operational days, each with the same wrapped 30-minute block —
    // recurrence is driven by the START date, never the end date.
    for (const occurrence of [day, addDays(day, 1), until]) {
      await page.goto(`/planner?date=${occurrence}`);
      await expect(rows(page, title)).toHaveCount(1);
      await expect(rows(page, title).getByText("11:45 PM – 12:15 AM")).toBeVisible();
    }
    await page.goto(`/planner?date=${addDays(until, 1)}`);
    await expect(rows(page, title)).toHaveCount(0);

    await page.goto(`/planner?date=${day}`);
    await rowAction(page, title, "Delete…");
    await page
      .getByRole("dialog", { name: "Delete recurring item" })
      .getByRole("button", { name: "Delete the entire series" })
      .click();
    await expect(rows(page, title)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("ordering and the next-day hint hold on a phone", async ({ page }) => {
    const errors = trackErrors(page);
    const salt = String(Date.now()).slice(-5);
    const wake = `Wake Up ${salt}`;
    const cardio = `Cardio ${salt}`;
    const night = `Night Cap ${salt}`;

    const day = await emptyDay(page, dayKey(RUN_OFFSET + 120));

    await createItem(page, { title: cardio, date: day, start: "09:00", end: "10:00" });
    await createItem(page, { title: wake, date: day, start: "09:00", end: "09:00" });
    expect(await listOrder(page, [cardio, wake])).toEqual([wake, cardio]);

    // The compact next-day hint fits the phone dialog without growing it.
    await page.getByRole("button", { name: "New item" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(night);
    await dialog.getByLabel("Date", { exact: true }).fill(day);
    await dialog.getByLabel("Start").fill("23:45");
    await dialog.getByLabel("End", { exact: true }).fill("00:15");
    await expect(
      dialog.getByText(`Ends next day — ${weekdayShortDay(addDays(day, 1))} · 30m`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Add item" }).click();
    await expect(dialog).toBeHidden();

    const row = rows(page, night).first();
    await expect(row.getByText("11:45 PM – 12:15 AM")).toBeVisible();
    await expect(row.getByText(`ends ${shortDay(addDays(day, 1))}`)).toBeVisible();

    // No horizontal overflow crept in with the new row marker.
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement!;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    for (const title of [night, wake, cardio]) {
      await rowAction(page, title, "Delete");
      await expect(rows(page, title)).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});
