import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

const port = process.env.PLAYWRIGHT_DEV_PORT ?? "3000";
export default defineConfig({
  ...config,
  testIgnore: [],
  testMatch: ["**/wishlist-dev.spec.ts", "**/wishlist-live.spec.ts"],
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `pnpm --filter @better-buy/shared build && pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
