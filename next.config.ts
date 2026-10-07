import type { NextConfig } from "next";

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "Permissions-Policy",
    value: [
      "camera=(self)",
      "microphone=(self)",
      "display-capture=(self)",
      "fullscreen=(self)",
      "payment=(self)",
      "autoplay=(self)",
      "clipboard-read=(self)",
      "clipboard-write=(self)",
      "geolocation=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "usb=()",
    ].join(", "),
  },
  {
    // Enforced CSP. Keep sources broad enough for current AI, camera/WebRTC, payments, Vercel assets, and blob media.
    key: "Content-Security-Policy",
    value: [
      "default-src 'self' https: data: blob:",
      "base-uri 'self'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "connect-src 'self' https: wss: blob:",
      "media-src 'self' data: blob: https:",
      "worker-src 'self' blob:",
      "frame-src 'self' https:",
      "form-action 'self' https:",
      "frame-ancestors 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
