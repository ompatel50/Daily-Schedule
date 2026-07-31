import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Content Security Policy.
 *
 * Everything the app needs is same-origin: self-hosted fonts (next/font),
 * same-origin server actions, webpack-built workers, no third-party scripts
 * and no analytics. `'unsafe-inline'` remains for scripts and styles because
 * Next.js hydration and Tailwind/styled-jsx inject inline code; a nonce-based
 * policy would require per-request middleware rewriting and is documented as
 * a possible hardening step. `blob:` covers chart rendering; `data:` covers
 * inline SVG/image data URIs. `worker-src` stays permitted because Next's own
 * build may emit workers, even though the health import no longer uses one —
 * health exports are parsed on the server (see docs/health-import-privacy.md).
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera stays available same-origin for the barcode scanner; everything
  // else this app never uses is denied outright.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  },
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  reactStrictMode: true,
  // Pin the workspace root to this project. Without it, a stray lockfile in
  // a parent directory (observed on the user's machine) makes Next guess the
  // workspace root, which mis-scopes file tracing and prints a warning on
  // every dev start.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // ESLint runs as its own CI step (npm run lint); builds don't repeat it.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // The largest server-action payload is a full JSON backup on import.
    // Health exports deliberately do NOT travel through an action: an action
    // buffers its whole body in memory, so they are streamed to the route
    // handler at /api/health/import instead. (Serverless platforms may impose
    // a lower hard cap per request — Vercel's is ~4.5 MB — which bounds
    // importable backup size there; the health upload route is unaffected.)
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
