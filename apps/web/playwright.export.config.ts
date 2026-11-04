import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// Validate the shipped static app without disturbing an active Next dev cache.
export default defineConfig({
  ...config,
  webServer: {
    command: "node scripts/serve-export.mjs",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3100"}`,
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
