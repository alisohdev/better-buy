import type { NextConfig } from "next";
import path from "node:path";
const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  output: "export",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};
export default nextConfig;
