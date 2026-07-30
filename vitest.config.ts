import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      // `server-only` throws by design outside a Server Component, which is
      // the guard that keeps secrets out of the browser bundle. Tests import
      // those modules directly, so it is stubbed here only.
      { find: "server-only", replacement: path.resolve(__dirname, "./tests/stubs/server-only.ts") },
      // `next/cache` revalidation helpers throw outside a Next request scope;
      // tests exercising server actions only care about the database work.
      { find: "next/cache", replacement: path.resolve(__dirname, "./tests/stubs/next-cache.ts") },
      // Auth.js is stubbed with a controllable session so tests never perform
      // real authentication. Provider entries must precede the bare package
      // name — string finds match specifier prefixes.
      {
        find: "next-auth/providers/credentials",
        replacement: path.resolve(__dirname, "./tests/stubs/next-auth-provider.ts"),
      },
      { find: "next-auth", replacement: path.resolve(__dirname, "./tests/stubs/next-auth.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Database-backed tests run separately: npm run test:integration.
    exclude: ["tests/integration/**", "**/node_modules/**"],
  },
});
