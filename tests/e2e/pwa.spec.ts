import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Installability surface: manifest, icons, meta and the service worker's
 * privacy posture. These fetch public files, so no storage state is needed —
 * except the meta checks, which read an authenticated page.
 */
test.describe("PWA files", () => {
  test("the manifest is valid and standalone", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    const manifest = await response.json();

    expect(manifest.name).toBe("Personal OS");
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.id).toBe("/");
    expect(manifest.theme_color).toMatch(/^#/);
    expect(manifest.background_color).toMatch(/^#/);

    const sizes = (manifest.icons as Array<{ sizes: string; purpose?: string }>).map(
      (icon) => icon.sizes,
    );
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(
      (manifest.icons as Array<{ purpose?: string }>).some((icon) => icon.purpose === "maskable"),
    ).toBe(true);
  });

  test("icons and the apple touch icon are served", async ({ request }) => {
    for (const path of [
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/apple-touch-icon.png",
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toContain("image/png");
    }
  });

  test("the service worker is served and never caches private routes", async ({ request }) => {
    const response = await request.get("/sw.js");
    expect(response.status()).toBe(200);
    const body = await response.text();

    // The cacheable set is the static allowlist and nothing else.
    expect(body).toContain("/_next/static/");
    expect(body).not.toMatch(/caches?\.[a-z]+\([^)]*\/api\//i);
    // The fetch handler must bail on non-GET and non-allowlisted URLs.
    expect(body).toContain('request.method !== "GET"');
    expect(body).toContain("isCacheableStatic");
  });
});

test.describe("PWA meta", () => {
  test.use({ storageState: STORAGE.you, viewport: { width: 390, height: 844 } });

  test("viewport covers the safe areas and apple meta is present", async ({ page }) => {
    await page.goto("/");
    const viewport = await page
      .locator('meta[name="viewport"]')
      .first()
      .getAttribute("content");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("width=device-width");

    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]').first()).toHaveAttribute(
      "content",
      "yes",
    );
    await expect(page.locator('link[rel="apple-touch-icon"]').first()).toHaveAttribute(
      "href",
      /apple-touch-icon/,
    );
    await expect(page.locator('link[rel="manifest"]').first()).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
  });
});
