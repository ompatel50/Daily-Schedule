import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * The (app) loading.tsx skeleton (aria-label "Loading") shows while a client
 * navigation streams the next route in. Racing the real server made this
 * flaky, so the test makes the window deterministic instead: the on-click RSC
 * payload for /insights is held open for ~1.5s at the network layer, long
 * enough that the skeleton must appear. Prefetches pass through untouched —
 * for a dynamic route they only carry the loading boundary, and aborting them
 * makes the router fall back to a full browser navigation, which never shows
 * loading.tsx at all.
 */
test("client-side navigation to /insights shows the loading skeleton", async ({ page }) => {
  await page.route("**/insights*", async (route) => {
    const headers = route.request().headers();
    if (headers["rsc"] && !headers["next-router-prefetch"]) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return route.continue();
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page
    .locator("aside nav")
    .getByRole("link", { name: /^Insights/ })
    .click();

  // Skeleton first, real page after the held payload lands, skeleton gone.
  await expect(page.locator('[aria-label="Loading"]')).toBeVisible();
  await expect(page.locator("main").getByRole("heading", { name: "Insights" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0);
});
