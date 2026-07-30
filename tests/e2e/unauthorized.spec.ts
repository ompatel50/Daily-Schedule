import { expect, test } from "@playwright/test";

import { SIGNED_OUT } from "./auth";

test.use({ storageState: SIGNED_OUT });

test("a non-allowlisted email is refused with the safe error", async ({ page }) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill("mallory@evil.example");
  await page.getByRole("button", { name: "Sign in without Google" }).click();

  // The refusal stays on /signin and never reveals whether the address exists —
  // only that it is not approved. (Filtered because Next's route announcer is
  // a second, empty role=alert element.)
  await expect(
    page.getByRole("alert").filter({ hasText: "That email address isn't approved" }),
  ).toContainText("That email address isn't approved for this Personal OS.");
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.locator("#dev-email")).toBeVisible();
});
