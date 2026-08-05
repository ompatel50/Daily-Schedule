import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The phone navigation drawer: everything the redesign promised, verified at
 * an iPhone width. The Sheet is a Radix Dialog underneath, so most of these
 * assertions are guarding OUR wiring (close-on-navigate, destinations,
 * focus return target), not re-testing Radix.
 */
test.use({ storageState: STORAGE.you, viewport: { width: 390, height: 844 } });

const openDrawer = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  return drawer;
};

test("opens with every destination, grouped, plus account and sign out", async ({ page }) => {
  await page.goto("/");
  const drawer = await openDrawer(page);

  for (const label of [
    "Dashboard",
    "Today",
    "Planner",
    "Tasks",
    "Inbox",
    "Finance",
    "Nutrition",
    "Workouts",
    "Habits",
    "Health",
    "Calendar",
    "Insights",
    "Assistant",
    "Settings",
  ]) {
    await expect(drawer.getByRole("link", { name: label, exact: true })).toBeVisible();
  }

  for (const group of ["Plan", "Track", "Review", "App"]) {
    await expect(drawer.getByText(group, { exact: true })).toBeVisible();
  }

  await expect(drawer.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("navigating from the drawer closes it and changes route", async ({ page }) => {
  await page.goto("/");
  const drawer = await openDrawer(page);

  await drawer.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks/);
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
});

test("Escape closes the drawer and focus returns to the menu button", async ({ page }) => {
  await page.goto("/");
  await openDrawer(page);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});

test("the explicit close button closes the drawer", async ({ page }) => {
  await page.goto("/");
  const drawer = await openDrawer(page);

  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
});

test("tapping the backdrop closes the drawer", async ({ page }) => {
  await page.goto("/");
  await openDrawer(page);

  // The drawer is max-w-xs from the left; the far right edge is backdrop.
  await page.mouse.click(380, 420);
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
});

test("focus stays trapped inside the open drawer", async ({ page }) => {
  await page.goto("/");
  const drawer = await openDrawer(page);

  // Walk far enough to lap the drawer's focusable elements; focus must
  // always remain inside the dialog.
  for (let step = 0; step < 25; step += 1) {
    await page.keyboard.press("Tab");
    const inside = await drawer.evaluate((node) => node.contains(document.activeElement));
    expect(inside, `focus escaped the drawer on Tab #${step + 1}`).toBe(true);
  }
});

test("background scroll locks while the drawer is open", async ({ page }) => {
  await page.goto("/settings"); // long page — always scrollable on a phone
  await openDrawer(page);
  const overflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
  expect(overflow).toBe("hidden");
});

test("the current route is marked in the drawer", async ({ page }) => {
  await page.goto("/today");
  const drawer = await openDrawer(page);
  await expect(drawer.getByRole("link", { name: "Today", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
