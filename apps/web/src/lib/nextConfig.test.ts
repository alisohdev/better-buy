import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("keeps development assets separate from production and browser-test builds", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const development = (await import("../../next.config")).default;
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  const production = (await import("../../next.config")).default;
  expect(development.distDir).toBe(".next-dev");
  expect(production.distDir).toBe(".next");
  expect(development.distDir).not.toBe(production.distDir);
  expect(production.output).toBe("export");
});
