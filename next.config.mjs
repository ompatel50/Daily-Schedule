import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Content-Security-Policy is NOT set here: a nonce-based `script-src`
 * needs a fresh nonce per request, which a static headers() block cannot
 * carry. The proxy (src/proxy.ts) builds and attaches it on every response
 * that renders a document. The static headers below apply everywhere,
 * including the few public files the proxy's matcher skips.
 */
const securityHeaders = [
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
  experimental: {
    // Server actions never carry a large body by design: an Apple Health
    // archive travels in bounded parts to /api/health/import/part, and a
    // large backup travels the same way to /api/backup/import/part, because
    // a serverless platform refuses a large body at the edge before any code
    // here runs (Vercel's cap is ~4.5 MB). This limit only covers the small
    // direct-import path (backups under 3 MB) with headroom to spare.
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
