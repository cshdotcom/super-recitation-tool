import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 不再使用 serverExternalPackages —— 把 pdf-parse / mammoth 全部打包进
  // server bundle，使 standalone 输出真正自包含，不依赖 nft 追踪外部包。
  // 之前 externalize 导致 nft 漏复制 mammoth 依赖树 → 生产 /api/parse 500。
  // 服务端 bundle target=node 不会应用 browser 字段，mammoth 的 Node 版
  // lib/unzip.js（认 buffer）会被打包；parse 路由同时传 buffer+arrayBuffer 兜底。
  // pdf-parse v2 是单文件 CJS bundle（pdfjs 内联），打包无 worker 追踪问题。
};

export default nextConfig;
