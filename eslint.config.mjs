import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * ESLint 9 flat config. The `lint` script runs eslint directly (`next lint`
 * was removed in Next 16); the Next.js rule sets (core-web-vitals +
 * TypeScript) come from eslint-config-next, which ships native flat configs
 * as of v16 — no eslintrc compat bridge.
 *
 * Narrow, documented exceptions only — a rule is never disabled repo-wide to
 * get a green run.
 */
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
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // The codebase deliberately prefixes intentionally-unused values with _
      // (e.g. destructuring to drop fields before persisting).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // New in eslint-plugin-react-hooks v7 (arrived with eslint-config-next
      // 16). They flag ~50 pre-existing sites — mostly the "reset dialog form
      // state when it opens" effect pattern. Rewriting those belongs to its
      // own pass, not the framework migration, so they warn instead of error
      // until that pass happens. Deliberately NOT "off": new code should see
      // them.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
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
