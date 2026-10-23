import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Guest access links carry a token in the query string; never leak it cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdf-lib", "qrcode", "nodemailer", "bcryptjs", "pg", "sharp"],
  // Fonts for AI banner composition are read from disk at runtime (src/server/banners/compose.tsx).
  outputFileTracingIncludes: {
    "/organizer/**": ["./assets/fonts/**"],
    "/api/organizer/**": ["./assets/fonts/**"],
    // Approving an outside resale ticket makes the event's AI banner (src/server/resale/banner.ts).
    "/admin/**": ["./assets/fonts/**"],
  },
  images: {
    // Event images are served pre-sized (Unsplash params / uploaded files).
    unoptimized: true,
  },
  experimental: {
    serverActions: { bodySizeLimit: "5mb" }, // 4 MB cover images + multipart overhead
  },
  async redirects() {
    // "Explore events" became the Buy page (the home page); query filters are passed through.
    return [{ source: "/events", destination: "/", permanent: false }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
