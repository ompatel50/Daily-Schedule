/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app is a single-user local tool; keep the dev experience noise-free.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Server Actions receive small JSON payloads (import/restore is the biggest).
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
