import { api } from "../src/index";
import { loadVpsConfig } from "./config";
import { createWorkerEnv } from "./environment";
import { SqliteD1Database } from "./sqlite-d1";

const config = loadVpsConfig();
const database = new SqliteD1Database(config.databasePath);
const env = createWorkerEnv(config, database);
const server = Bun.serve({
  fetch: (request) => api.fetch(request, env),
  hostname: config.host,
  port: config.port,
  development: false,
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await server.stop();
  } catch (error) {
    console.error("HTTP server shutdown failed", { error });
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.info("VPS HTTP server listening", {
  host: config.host,
  port: config.port,
  storage: "bun:sqlite",
});
