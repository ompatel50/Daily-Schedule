import { expect, test } from "@playwright/test";

import { SIGNED_OUT } from "./auth";

test.use({ storageState: SIGNED_OUT });

/**
 * The whole public self-serve journey in one browser, in order: sign up,
 * save the recovery codes, land signed in on the dashboard, sign out,
 * sign back in, then reset the password with a recovery code and prove the
 * old password is dead and the code is burned.
 *
 * A unique email per run keeps re-runs from colliding with the unique
 * constraint; the account it creates is empty and never touches the seeded
 * accounts the rest of the suite uses.
 */
const EMAIL = `signup-journey-${Date.now()}@e2e.local`;
const PASSWORD = "a-sturdy-first-passphrase";
const NEW_PASSWORD = "an-even-better-passphrase";

test.describe.serial("public sign-up journey", () => {
  let recoveryCodes: string[] = [];

  test("a fresh visitor signs up, saves recovery codes and lands on the dashboard", async ({
    page,
  }) => {
    await page.goto("/signup");
    await page.locator("#signup-email").fill(EMAIL);
    await page.locator("#signup-name").fill("Journey");
    await page.locator("#signup-password").fill(PASSWORD);
    await page.locator("#signup-confirm").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    // The one-time recovery-code screen. Codes render as list items.
    await expect(page.getByText("Save your recovery codes")).toBeVisible();
    recoveryCodes = await page.locator("ul li").allTextContents();
    expect(recoveryCodes.length).toBe(8);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    }

    await page.getByRole("link", { name: /open Personal OS/ }).click();
    await expect(page).toHaveURL("/");
    // Signed in: the app chrome is present and it is the fresh, empty account.
    await expect(page.locator("nav").first()).toBeVisible();
  });

  test("sign out ends the session; the same password signs back in", async ({ page }) => {
    // Sign in through the real form (this test owns its own context).
    await page.goto("/signin");
    await page.locator("#email").fill(EMAIL);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/");

    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    // A server round trip: sign out, then a render of /signin. The suite runs
    // two workers, so this can coincide with the import spec's large write
    // transaction in the other one; the default 10 s expect timeout is not
    // always enough for that, and the flow itself is not racy (20 stress
    // repeats in isolation are clean). What is asserted is unchanged.
    await expect(page).toHaveURL(/\/signin/, { timeout: 30_000 });

    // The session really ended: the app is fenced again.
    await page.goto("/today");
    await expect(page).toHaveURL(/\/signin/);
  });

  test("a recovery code resets the password once — old password dead, code burned", async ({
    page,
  }) => {
    const code = recoveryCodes[0];

    await page.goto("/forgot-password");
    await page.locator("#reset-email").fill(EMAIL);
    await page.locator("#reset-code").fill(code);
    await page.locator("#reset-password").fill(NEW_PASSWORD);
    await page.locator("#reset-confirm").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByText("Password reset", { exact: true })).toBeVisible();

    // The old password is dead…
    await page.goto("/signin");
    await page.locator("#email").fill(EMAIL);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").first()).toContainText(/didn't sign you in/);

    // …the new one works…
    await page.locator("#email").fill(EMAIL);
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/");

    // …and the burned code never works twice.
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/signin/, { timeout: 30_000 });

    await page.goto("/forgot-password");
    await page.locator("#reset-email").fill(EMAIL);
    await page.locator("#reset-code").fill(code);
    await page.locator("#reset-password").fill("a-third-passphrase-here");
    await page.locator("#reset-confirm").fill("a-third-passphrase-here");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByRole("alert").first()).toContainText(/wasn't accepted/);
  });

  test("a duplicate email cannot sign up again", async ({ page }) => {
    await page.goto("/signup");
    await page.locator("#signup-email").fill(EMAIL);
    await page.locator("#signup-password").fill("another-password-entirely");
    await page.locator("#signup-confirm").fill("another-password-entirely");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert").first()).toContainText(/already exists/);
  });
});
