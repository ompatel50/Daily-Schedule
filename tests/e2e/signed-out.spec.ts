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
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    // None of the app chrome may leak to a signed-out visitor.
    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.locator("nav")).toHaveCount(0);
    await expect(
      page.getByText("No public registration. Access is limited to approved email addresses."),
    ).toBeVisible();
  });
});
