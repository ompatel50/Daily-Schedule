import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    // Health exports never travel through an action any more — they are
    // parsed in the browser and only bounded (<1 MB) chunks of normalised
    // rows are uploaded. (Serverless platforms may impose a lower hard cap
    // per request — Vercel's is ~4.5 MB — which bounds importable backup
    // size there; chunks are unaffected.)
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
