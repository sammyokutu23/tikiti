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
  serverExternalPackages: ["pdf-lib", "qrcode", "nodemailer", "bcryptjs", "pg"],
  images: {
    // Event images are served pre-sized (Unsplash params / uploaded files).
    unoptimized: true,
  },
  experimental: {
    serverActions: { bodySizeLimit: "6mb" }, // 5 MB cover images + multipart overhead
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
