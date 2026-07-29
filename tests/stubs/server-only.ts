/**
 * A no-op stand-in for the `server-only` package.
 *
 * That package deliberately throws when it is resolved outside a React Server
 * Component, which is exactly the guard we want in the app — it is what stops a
 * module holding the USDA API key from ever being bundled for the browser.
 * Vitest resolves the same browser entry, so a plain unit test of a server
 * module would trip the guard rather than run.
 *
 * Aliasing it here keeps the protection where it matters (the Next.js build)
 * while letting the provider modules be tested directly. Nothing else changes:
 * the real package exports nothing either.
 */
export {};
