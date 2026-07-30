import { expect, test } from "@playwright/test";

import { SIGNED_OUT, signInWithPassword } from "./auth";

test.use({ storageState: SIGNED_OUT });

/**
 * Every kind of failed sign-in — unknown account, wrong password — must
 * produce the IDENTICAL generic refusal: same message, same page, no app
 * chrome, no hint whether the email exists. That uniformity is the
 * enumeration resistance the sign-in page promises.
 */
const GENERIC_REFUSAL = "Those details didn't sign you in.";

async function attempt(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/signin");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // (Filtered because Next's route announcer is a second, empty role=alert.)
  await expect(page.getByRole("alert").filter({ hasText: GENERIC_REFUSAL })).toBeVisible();
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.locator("aside")).toHaveCount(0);
}

test("an unknown email is refused with the generic error", async ({ page }) => {
  await attempt(page, "mallory@evil.example", "any-password-at-all");
});

test("a real account with the wrong password gets the identical refusal", async ({ page }) => {
  await attempt(page, "you@local", "wrong-password-entirely");
});

test("the right password still signs in after a failed attempt", async ({ page }) => {
  // One wrong try must not lock the account (the threshold is 5): the real
  // password immediately afterwards works.
  await attempt(page, "alice@example.com", "wrong-password-entirely");
  await signInWithPassword(page, "alice@example.com");
  await expect(page).toHaveURL("/");
});
