import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * Deliberately does NOT force a real server error: crashing routes on the
 * shared server would be destructive, and the (app) error.tsx boundary is a
 * plain client component whose rendering is covered at unit level. What this
 * asserts is the adjacent guarantee — an unknown route is a clean 404 page,
 * and the app shell comes back intact on the next navigation.
 */
test("a bogus route 404s cleanly and the shell survives", async ({ page }) => {
  const response = await page.goto("/this-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("This page could not be found")).toBeVisible();

  await page.goto("/");
  await expect(page.locator("aside")).toBeVisible();
  await expect(page.locator("header h1")).toHaveText("Dashboard");
});
