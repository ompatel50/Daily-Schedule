import { test as setup } from "@playwright/test";

import { STORAGE, signInWithPassword } from "./auth";

// One real password sign-in per account, persisted as storage state. Every
// spec in the chromium project starts already authenticated from these files.

setup("sign in as you@local", async ({ page }) => {
  await signInWithPassword(page, "you@local");
  await page.context().storageState({ path: STORAGE.you });
});

setup("sign in as alice@example.com", async ({ page }) => {
  await signInWithPassword(page, "alice@example.com");
  await page.context().storageState({ path: STORAGE.alice });
});
