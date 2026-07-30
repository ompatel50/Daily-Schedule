import { expect, test } from "@playwright/test";

import { SIGNED_OUT } from "./auth";

test.use({ storageState: SIGNED_OUT });

test.describe("signed-out visitor", () => {
  test("/ redirects to the sign-in page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);
  });

  test("/settings redirects to the sign-in page with a callback", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/signin\?callbackUrl=.*settings/);
  });

  test("the sign-in page has no app nav and states there is no registration", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByText("Personal OS", { exact: true })).toBeVisible();
    // The private password form — and nothing suggesting an identity provider.
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/Google/)).toHaveCount(0);
    // None of the app chrome may leak to a signed-out visitor.
    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.locator("nav")).toHaveCount(0);
    await expect(page.getByText(/No public registration/)).toBeVisible();
  });

  test("/setup is closed once a credential account exists", async ({ page }) => {
    // The e2e database is seeded with password accounts, so the one-time
    // owner setup must refuse to exist and land on /signin instead.
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByText("Owner setup")).toHaveCount(0);
  });
});
