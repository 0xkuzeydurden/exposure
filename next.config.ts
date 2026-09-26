import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No "X-Powered-By: Next.js" header in responses.
  poweredByHeader: false,
  // Pin the workspace root: a stray lockfile higher up the tree must not change module resolution.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
