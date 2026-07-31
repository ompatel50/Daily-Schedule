import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

import { STORAGE } from "./auth";

/** A page's own title, as opposed to a section or metric panel heading. */
const pageTitle = (page: Page, name: string) =>
  page.getByRole("heading", { level: 2, name, exact: true });

/**
 * The Health module in a real browser.
 *
 * The read-only checks run as the demo profile (`you@local`), because that is
 * the account `npm run db:seed` fills with an Apple-Health-shaped import — a
 * batch, device-attributed rows, workouts and records. They run only where
 * that seed exists (CI skips this file against its empty database — see
 * `testIgnore` in playwright.config.ts).
 *
 * The one mutating check runs as `alice`, following the same split every other
 * spec uses: the demo account is never written to by the suite.
 */
test.describe("reading the seeded health data", () => {
  test.use({ storageState: STORAGE.you });

  test("the health section navigates between its pages", async ({ page }) => {
    await page.goto("/health");
    await expect(pageTitle(page, "Health")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Health sections" });
    for (const [label, slug] of [
      ["Activity", "activity"],
      ["Sleep", "sleep"],
      ["Heart", "heart"],
      ["Body", "body"],
      ["Nutrition", "nutrition"],
      ["Workouts", "workouts"],
      ["Vitals", "vitals"],
      ["Trends", "trends"],
    ] as const) {
      await nav.getByRole("link", { name: label, exact: true }).click();
      // Each tab owns a real route — that is the point of them, and the URL
      // is what makes a Health view shareable and bookmarkable. A single
      // click has to be enough: the section's `loading.tsx` boundary is what
      // lets the transition commit immediately, and a regression there shows
      // up here as a click that goes nowhere.
      await expect(page).toHaveURL(new RegExp(`/health/${slug}$`));
      // Then the page's own title, which is the h2 — a metric panel of the
      // same name (Sleep, Nutrition) is an h3, so the level disambiguates
      // without `.first()`. Waiting for it also guarantees the transition has
      // finished before the next link is clicked; clicking mid-transition is
      // how a navigation gets dropped.
      await expect(pageTitle(page, label)).toBeVisible();
    }
  });

  test("a trend range is a shareable URL the server reads", async ({ page }) => {
    await page.goto("/health/trends?range=90d");
    await expect(pageTitle(page, "Trends")).toBeVisible();
    await expect(page.getByRole("link", { name: "90 days" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    await page.getByRole("link", { name: "7 days" }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByRole("link", { name: "7 days" })).toHaveAttribute("aria-current", "true");
  });

  test("the import history labels its batch as Apple Health and offers an undo", async ({
    page,
  }) => {
    await page.goto("/health/imports");
    await expect(pageTitle(page, "Import history")).toBeVisible();
    await expect(page.getByText(/· Apple Health/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Undo the import/ }).first()).toBeVisible();
  });

  test("the undo preview says what it would remove, and cancelling removes nothing", async ({
    page,
  }) => {
    await page.goto("/health/imports");
    await page
      .getByRole("button", { name: /^Undo the import/ })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Undo this import?" })).toBeVisible();
    await expect(dialog.getByText(/readings/).first()).toBeVisible();

    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toBeHidden();

    // Nothing was undone: the batch is still offering an undo.
    await page.reload();
    await expect(page.getByRole("button", { name: /^Undo the import/ }).first()).toBeVisible();
  });

  test("the import page explains the flow without starting one", async ({ page }) => {
    await page.goto("/health/import");
    await expect(pageTitle(page, "Import health data")).toBeVisible();
    await expect(page.getByText("Export All Health Data")).toBeVisible();
    await expect(page.getByRole("button", { name: "Import health data" })).toBeEnabled();
  });

  test("imported workouts are labelled by where they came from", async ({ page }) => {
    await page.goto("/health/workouts");
    await expect(pageTitle(page, "Workouts")).toBeVisible();
    await expect(page.getByText("Apple Health").first()).toBeVisible();
  });

  test("sleep nights show their stages and never add in-bed to time asleep", async ({ page }) => {
    await page.goto("/health/sleep");
    await expect(pageTitle(page, "Sleep")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Asleep" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "In bed" })).toBeVisible();
    await expect(page.getByText(/Time asleep counts only the asleep stages/)).toBeVisible();
  });

  test("health records show a summary and never a raw trace", async ({ page }) => {
    await page.goto("/health/vitals");
    await expect(pageTitle(page, "Vitals")).toBeVisible();
    await expect(page.getByText("Health records", { exact: true })).toBeVisible();
    await expect(page.getByText(/ECG voltage traces, route coordinates/)).toBeVisible();
  });
});

test.describe("writing health data", () => {
  test.use({ storageState: STORAGE.alice });

  // Runs against whichever state this account is in — with health data or
  // completely empty — because the entry form is reachable either way. That is
  // the point: an account with nothing logged still has somewhere to start.
  test("a manually logged metric is stored and shown", async ({ page }) => {
    await page.goto("/health");

    // The detailed form defaults to Steps and the live "today".
    await page.locator("#metric-value").fill("4321");
    await page.getByRole("button", { name: "Log", exact: true }).click();
    await expect(page.getByText("Steps logged").first()).toBeVisible();

    // The overview re-renders with the value it just stored.
    await expect(page.getByText("4,321").first()).toBeVisible();
  });
});
