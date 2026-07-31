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

  test("the new life-admin surfaces are behind the same wall", async ({ page }) => {
    for (const route of ["/finance", "/tasks", "/inbox"]) {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`/signin\\?callbackUrl=.*${route.slice(1)}`));
    }
  });

  test("the sign-in page has no app nav and links to sign-up and password recovery", async ({
    page,
  }) => {
    await page.goto("/signin");
    await expect(page.getByText("Personal OS", { exact: true })).toBeVisible();
    // The password form — and nothing suggesting an identity provider.
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/Google/)).toHaveCount(0);
    // None of the app chrome may leak to a signed-out visitor.
    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.locator("nav")).toHaveCount(0);
    // Public self-serve: both doors are on the front page.
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup",
    );
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  test("/signup and /forgot-password are reachable signed out", async ({ page }) => {
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/signup/);
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();

    await page.goto("/forgot-password");
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.getByRole("button", { name: "Reset password" })).toBeVisible();
  });

  test("the retired /setup page is just another protected path now", async ({ page }) => {
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByText("Owner setup")).toHaveCount(0);
  });
});
