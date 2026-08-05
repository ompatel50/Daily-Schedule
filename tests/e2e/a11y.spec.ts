import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

// Plain path, not require.resolve: Playwright's spec transform runs these
// files in an ESM scope where `require` does not exist.
const AXE_SOURCE = readFileSync(
  path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

interface AxeViolation {
  id: string;
  impact: string;
  help: string;
  nodes: Array<{ target: string[] }>;
}

/**
 * Automated accessibility floor: no serious/critical axe violations on the
 * app's main surfaces, at phone width, plus the drawer and palette open
 * states. axe is injected from node_modules (CSP allows inline script), so
 * no network access is needed.
 */
test.use({ storageState: STORAGE.you, viewport: { width: 390, height: 844 } });

async function auditPage(page: import("@playwright/test").Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const results = (await page.evaluate(() =>
    (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<unknown> } }).axe.run(
      document,
      { resultTypes: ["violations"] },
    ),
  )) as { violations: AxeViolation[] };
  return results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

function describeViolations(violations: AxeViolation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} @ ${violation.nodes
          .map((node) => node.target.join(" "))
          .slice(0, 3)
          .join(" | ")}`,
    )
    .join("\n");
}

for (const route of ["/", "/today", "/planner", "/habits", "/settings", "/assistant"]) {
  test(`${route} has no serious axe violations at phone width`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator("main h1, main h2").first()).toBeVisible();
    await page.waitForLoadState("networkidle");

    const violations = await auditPage(page);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
}

test("the open navigation drawer has no serious axe violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();

  const violations = await auditPage(page);
  expect(violations, describeViolations(violations)).toEqual([]);
});

test("the open command palette has no serious axe violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Command palette" }).click();
  await expect(page.getByRole("dialog").first()).toBeVisible();

  const violations = await auditPage(page);
  expect(violations, describeViolations(violations)).toEqual([]);
});
