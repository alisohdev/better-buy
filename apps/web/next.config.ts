import type { NextConfig } from "next";
import path from "node:path";
const nextConfig: NextConfig = {
  ...(process.env.BETTER_BUY_TEST_BUILD === "1" &&
  !process.env.CLOUDFLARE_WORKER
    ? {
        distDir: ".next-e2e",
        typescript: { tsconfigPath: "tsconfig.playwright.json" },
      }
    : {}),
  ...(process.env.CLOUDFLARE_WORKER
    ? {
        output: "export",
        // Allow release builds while Wrangler dev is watching the usual output.
        distDir: process.env.BETTER_BUY_EXPORT_DIR || "out",
      }
    : {}),
  ...(process.env.NODE_ENV === "development"
    ? {
        async rewrites() {
          const apiOrigin =
            process.env.DEV_API_ORIGIN || "http://127.0.0.1:8787";
          return [
            { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
          ];
        },
      }
    : {}),
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};
export default nextConfig;
