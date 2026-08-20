import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.alice });

/**
 * The barcode flow a headless browser can prove deterministically: a custom
 * food saved WITH its barcode resolves through the scanner's manual entry —
 * locally, no camera, no provider network — straight into the log dialog.
 * The provider fallback chain (OFF → USDA) and the unknown-code offer are
 * pinned by tests/food-lookup.test.ts and tests/integration/barcode.test.ts;
 * live camera decoding cannot run headless by design (the camera only starts
 * from a user click).
 */

test("a custom food's barcode resolves through manual entry into the log dialog", async ({
  page,
}) => {
  // Unique digits per run so reruns never collide (99 + 12 digits = 14).
  const code = `99${String(Date.now() % 1_000_000_000_000).padStart(12, "0")}`;
  const name = `E2E scanned bar ${Date.now().toString(36)}`;

  await page.goto("/nutrition");

  // Create the custom food with its barcode.
  await page.getByRole("button", { name: "Custom food" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Calories").fill("123");
  await dialog.getByLabel("Barcode (optional)").fill(code);
  await dialog.getByRole("button", { name: /Add food|Save/ }).click();
  await expect(page.getByText(`${name} added to your food list`).first()).toBeVisible();

  // Scan it — manual entry, same lookup as the camera path.
  await page.getByRole("button", { name: "Scan barcode" }).click();
  const scanner = page.getByRole("dialog");
  await scanner.getByLabel("Barcode", { exact: true }).fill(code);
  await scanner.getByRole("button", { name: "Look up" }).click();

  // The scanner closes and the log dialog opens on the resolved food.
  await expect(page.getByRole("dialog").getByText(name).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Log to/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("scanning degrades gracefully with no camera: manual entry stays first-class", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await page.getByRole("button", { name: "Scan barcode" }).click();
  const scanner = page.getByRole("dialog");

  // Headless Chromium has no camera device; whichever support message shows,
  // manual entry must be present and enabled — scanning never gates logging.
  await expect(scanner.getByLabel("Barcode", { exact: true })).toBeEnabled();
  await expect(scanner.getByRole("button", { name: "Look up" })).toBeVisible();
  await page.keyboard.press("Escape");
});
