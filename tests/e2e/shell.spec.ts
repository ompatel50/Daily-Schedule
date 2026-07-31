import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

// Labels from src/lib/navigation.ts. The links' accessible names carry the
// `g <key>` shortcut hint as a suffix, hence the prefix regexes below.
const PRIMARY_NAV = [
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
  "Settings",
];

test("sidebar and topbar render with every primary nav link", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("aside")).toBeVisible();
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("header h1")).toHaveText("Dashboard");

  const nav = page.locator("aside nav");
  for (const label of PRIMARY_NAV) {
    await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
  }
});

test("account menu shows the email; sign-out returns to /signin", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("menu")).toContainText("you@local");

  // JWT sessions: this only clears the cookie in this test's own context, so
  // the storage state the other specs reuse stays valid.
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  // A server round trip: sign out, then a render of /signin. The suite runs
  // two workers, so this can coincide with the import spec's large write
  // transaction in the other one; the default 10 s expect timeout is not
  // always enough for that, and the flow itself is not racy (20 stress
  // repeats in isolation are clean). What is asserted is unchanged.
  await expect(page).toHaveURL(/\/signin/, { timeout: 30_000 });
  await expect(page.locator("aside")).toHaveCount(0);
});
