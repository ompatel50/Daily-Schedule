import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

// Each page's ready signal — asserting overflow before the content streams in
// would measure a half-empty document.
const PAGES: Array<{ path: string; ready: string }> = [
  { path: "/", ready: "What's next" },
  { path: "/today", ready: "Your day" },
  { path: "/planner", ready: "New item" },
];

for (const width of [900, 1280]) {
  for (const { path, ready } of PAGES) {
    test(`${path} at ${width}px has no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();

      const overflow = await page.evaluate(() => {
        const root = document.scrollingElement!;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow, "document must not scroll horizontally").toBeLessThanOrEqual(0);
    });
  }
}

test("the compact menu button appears only below the sidebar breakpoint", async ({ page }) => {
  // Sidebar shows from lg (1024px): narrow windows get the topbar menu instead.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
  await expect(page.locator("aside")).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
  await expect(page.locator("aside")).toBeVisible();
});
