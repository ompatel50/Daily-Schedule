import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.alice });

/**
 * Unified quick-capture, end to end: the `n` shortcut and the persistent
 * topbar button open ONE dialog that classifies what you type, shows the
 * parsed fields editable, and routes the confirmed capture to the right
 * module. Grammar and routing details are pinned by tests/capture.test.ts and
 * tests/integration/capture.test.ts; what only a browser proves is the
 * dialog loop — live classification, the editable preview, the commit, and
 * the record landing on its surface.
 */

test("desktop: `n` opens capture; a todo routes to Tasks with its parsed fields", async ({
  page,
}) => {
  const title = `E2E capture task ${Date.now()}`;
  await page.goto("/");
  await page.keyboard.press("n");

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Capture" })).toBeVisible();

  await dialog.getByLabel("Capture anything").fill(`todo ${title} friday !high`);
  // Live classification labels it a Task and shows the parsed fields.
  await expect(dialog.getByText("Task", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(title);
  await expect(dialog.getByLabel("Priority")).toContainText("high");

  await dialog.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByText("Task created").first()).toBeVisible();
  await expect(dialog).toBeHidden();

  // The task is real, on its own surface. Titles are unique per run, so no
  // cleanup is needed for idempotence.
  await page.goto("/tasks");
  await expect(page.getByText(title).first()).toBeVisible();
});

test("planner text keeps its historical behaviour inside capture", async ({ page }) => {
  const title = `E2E capture block ${Date.now()}`;
  await page.goto("/");
  await page.keyboard.press("n");

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Capture anything").fill(`${title} 9-10am tomorrow`);
  await expect(dialog.getByText("Planner", { exact: true }).first()).toBeVisible();
  // Parsed fields are editable — the times landed in the Start/End inputs.
  await expect(dialog.getByLabel("Start")).toHaveValue("09:00");
  await expect(dialog.getByLabel("End")).toHaveValue("10:00");

  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByText("Added to your planner").first()).toBeVisible();
});

test("a near-miss routes to Inbox and the raw text survives", async ({ page }) => {
  // The suffix must stay non-numeric — a bare number would legitimately read
  // as an expense amount.
  const note = `spent a lovely evening run-${Date.now().toString(36)}x`;
  await page.goto("/");
  await page.keyboard.press("n");

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Capture anything").fill(note);
  await expect(dialog.getByText("Inbox", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(note);

  await dialog.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.getByText("Captured to your inbox").first()).toBeVisible();

  await page.goto("/inbox");
  await expect(page.getByText(note).first()).toBeVisible();

  // Clean up the inbox item.
  await page.getByRole("button", { name: `Actions for ${note}` }).click();
  await page.getByRole("menuitem", { name: /Delete/ }).click();
});

test("mobile: the persistent topbar button opens the same capture dialog", async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: STORAGE.alice,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Capture" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Capture anything")).toBeVisible();
  await context.close();
});
