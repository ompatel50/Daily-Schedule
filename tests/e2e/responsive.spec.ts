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

/**
 * Broader sweep for the phone widths: the ready signal is the page <h1> in
 * the topbar (always present inside the shell), so every major route can be
 * measured without knowing its content.
 */
const ROUTES = [
  "/",
  "/today",
  "/planner",
  "/planner?view=week",
  "/planner?view=month",
  "/tasks",
  "/inbox",
  "/finance",
  "/nutrition",
  "/workouts",
  "/habits",
  "/health",
  "/calendar",
  "/insights",
  "/assistant",
  "/settings",
];

async function measureOverflow(page: import("@playwright/test").Page): Promise<number> {
  // Charts animate to their measured width on mount, and under full parallel
  // load that window stretches; a mid-animation measurement reads a
  // transiently wide document. Poll briefly: a real overflow never resolves,
  // a mount animation does.
  return page.evaluate(async () => {
    const measure = () => {
      const root = document.scrollingElement!;
      return root.scrollWidth - root.clientWidth;
    };
    let overflow = measure();
    for (let attempt = 0; attempt < 8 && overflow > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      overflow = measure();
    }
    return overflow;
  });
}

for (const width of [900, 1280]) {
  for (const { path, ready } of PAGES) {
    test(`${path} at ${width}px has no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();

      const overflow = await measureOverflow(page);
      expect(overflow, "document must not scroll horizontally").toBeLessThanOrEqual(0);
    });
  }
}

// The iPhone sizes the redesign targets: SE (320), classic (375), 14/15 (390),
// Pro Max (430). Every major route must fit; 320 is the honest floor.
for (const width of [320, 390]) {
  for (const route of ROUTES) {
    test(`${route} at ${width}px has no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(route);
      await expect(page.locator("main h1, main h2").first()).toBeVisible();
      // Let client components (charts, boards) hydrate before measuring.
      await page.waitForLoadState("networkidle");

      const overflow = await measureOverflow(page);
      expect(overflow, "document must not scroll horizontally").toBeLessThanOrEqual(0);
    });
  }
}

for (const width of [375, 430]) {
  for (const route of ["/", "/today", "/planner", "/assistant"]) {
    test(`${route} at ${width}px has no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(route);
      await expect(page.locator("main h1, main h2").first()).toBeVisible();
      await page.waitForLoadState("networkidle");

      const overflow = await measureOverflow(page);
      expect(overflow, "document must not scroll horizontally").toBeLessThanOrEqual(0);
    });
  }
}

test("the drawer trigger appears only below the sidebar breakpoint", async ({ page }) => {
  // Sidebar shows from lg (1024px): narrow windows get the drawer instead.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.locator("aside")).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  await expect(page.locator("aside")).toBeVisible();
});

test("tablet portrait keeps the drawer and no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/today");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  const overflow = await measureOverflow(page);
  expect(overflow).toBeLessThanOrEqual(0);
});
