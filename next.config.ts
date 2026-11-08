import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Heavy Node-native parsing libs used by /api/parse must stay external to
  // the server bundle — otherwise Turbopack/webpack applies the `browser`
  // field resolution and ships browser-only shims that crash at runtime:
  //   • pdf-parse v2 inlines pdfjs-dist; bundling breaks its worker path.
  //   • mammoth ships a `browser` field that remaps ./lib/unzip.js to a
  //     browser build which only accepts `options.arrayBuffer` (NOT
  //     `options.buffer`), so extractRawText({ buffer }) rejects with
  //     "Could not find file in options" in production standalone builds.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth"],
};

export default nextConfig;
