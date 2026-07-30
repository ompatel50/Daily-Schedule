import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * globals.css collapses every transition/animation to 0.01ms under
 * prefers-reduced-motion (spinners excepted, so "busy" stays visible). The
 * computed values come back in seconds — 0.01ms is 0.00001s — so anything
 * under 50ms counts as collapsed here.
 */
test("reduced motion collapses transitions and the page still renders", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByText("What's next", { exact: true })).toBeVisible();

  const durations = await page.evaluate(() => {
    // A sidebar link (transition-colors) and <main> (animate-fade-in) are
    // always present on the dashboard.
    const link = document.querySelector("aside nav a")!;
    const main = document.querySelector("main")!;
    return {
      transition: parseFloat(getComputedStyle(link).transitionDuration),
      animation: parseFloat(getComputedStyle(main).animationDuration),
    };
  });
  expect(durations.transition).toBeLessThan(0.05);
  expect(durations.animation).toBeLessThan(0.05);
});
