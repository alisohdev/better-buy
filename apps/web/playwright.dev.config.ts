import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

const port = process.env.PLAYWRIGHT_DEV_PORT ?? "3000";
export default defineConfig({
  ...config,
  testIgnore: [],
  testMatch: ["**/wishlist-dev.spec.ts", "**/wishlist-live.spec.ts"],
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `pnpm exec next dev -H 127.0.0.1 -p ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
