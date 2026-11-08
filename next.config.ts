import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // pdf-parse (PDF text extraction, used by /api/parse) relies on pdfjs-dist
  // which dynamically imports its worker file at runtime — bundling it breaks
  // the fake-worker path, so keep both external to the server bundle.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
