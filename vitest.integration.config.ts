import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration tests: real PostgreSQL (the disposable personal_os_test
 * database — never dev, never production), real server actions, stubbed
 * session. Run with `npm run test:integration`, which resets the test
 * database and applies the committed migrations first.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: path.resolve(__dirname, "./tests/stubs/server-only.ts") },
      { find: "next/cache", replacement: path.resolve(__dirname, "./tests/stubs/next-cache.ts") },
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
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    // One database — files must not race each other.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
