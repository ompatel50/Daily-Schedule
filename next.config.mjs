/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app is a single-user local tool; keep the dev experience noise-free.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Server Actions receive JSON payloads and file uploads. The ceiling exists
    // for the Apple Health import — a multi-year export.zip is large, and it is
    // parsed locally and discarded rather than stored.
    serverActions: { bodySizeLimit: "400mb" },
  },
};

export default nextConfig;
