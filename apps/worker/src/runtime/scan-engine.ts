import type { DurableEnv, ScanEngine } from "../durable/types";
import { createCloudflareScanEngine } from "./cloudflare-scan-engine";

export function scanEngineFor(
  env: Pick<DurableEnv, "SCAN_ENGINE" | "SCAN_WORKFLOW">
): ScanEngine | undefined {
  if (env.SCAN_ENGINE) return env.SCAN_ENGINE;
  return env.SCAN_WORKFLOW
    ? createCloudflareScanEngine(env.SCAN_WORKFLOW)
    : undefined;
}
