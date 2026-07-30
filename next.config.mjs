/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
