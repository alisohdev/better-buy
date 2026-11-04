import { DurableRepository } from "../src/durable/repository";
import { runDurableScan } from "../src/durable/runner";
import { ScanEngineControl } from "../src/durable/types";
import { materializeProducts } from "../src/saved-products";
import { loadVpsConfig } from "./config";
import { createWorkerEnv } from "./environment";
import { createPersistentSteps, SqliteScanEngine } from "./scan-engine";
import { SqliteD1Database } from "./sqlite-d1";

type Outcome =
  | { kind: "complete" }
  | { kind: "suspended"; wakeAt: string }
  | { kind: "cancelled" }
  | { kind: "failed"; code: string };

function send(message: Record<string, unknown>) {
  if (process.send) process.send(message);
}

async function main(scanId: string) {
  const config = loadVpsConfig();
  const database = new SqliteD1Database(config.databasePath);
  const env = createWorkerEnv(config, database);
  const engine = env.SCAN_ENGINE as SqliteScanEngine;
  const steps = createPersistentSteps(
    database.native,
    scanId,
    engine,
    (event, name) =>
      send({ kind: event === "start" ? "step-start" : "step-finish", name })
  );
  let outcome: Outcome;
  try {
    await runDurableScan(
      { scanId, contractVersion: 1 },
      {
        repository: new DurableRepository(env.DB, env.BOX_KEY),
        steps,
        sharedOkalaOffersEnabled: env.OKALA_SHARED_OFFERS_ENABLED === "true",
        materialize: (userId, currentScanId) =>
          materializeProducts(env.DB, userId, currentScanId),
      }
    );
    outcome = { kind: "complete" };
  } catch (error) {
    if (error instanceof ScanEngineControl) {
      outcome =
        error.kind === "cancelled"
          ? { kind: "cancelled" }
          : error.wakeAt
            ? { kind: "suspended", wakeAt: error.wakeAt }
            : { kind: "failed", code: "ENGINE_CONTROL_INVALID" };
    } else {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "ENGINE_TERMINAL";
      outcome = { kind: "failed", code };
    }
  } finally {
    database.close();
  }
  if (!process.send) return;
  process.send({ kind: "outcome", outcome }, () => process.disconnect());
}

process.on("disconnect", () => process.exit(1));
const scanId = process.argv[2];
if (!scanId) throw new Error("Scan child requires a scan id");
void main(scanId);
