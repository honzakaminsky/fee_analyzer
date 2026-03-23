/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 14.2+ top-level
  serverExternalPackages: ["pdf-parse"],
  experimental: {
    // Zpětná kompatibilita
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

export default nextConfig;
