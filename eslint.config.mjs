import path from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";

/**
 * ESLint 9 flat config. `next lint` is deprecated in Next 15, so the `lint`
 * script runs eslint directly; the Next.js rule sets (core-web-vitals +
 * TypeScript) still come from eslint-config-next via the compat bridge.
 *
 * Narrow, documented exceptions only — a rule is never disabled repo-wide to
 * get a green run.
 */
const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "tests/e2e/.output/**",
      "tests/e2e/.auth/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // The codebase deliberately prefixes intentionally-unused values with _
      // (e.g. destructuring to drop fields before persisting).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // The service worker is plain JS running in a worker scope.
    files: ["public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", clients: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default config;
