import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appMigrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const vpsMigrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../vps-migrations"
);

function applyDirectory(database: Database, directory: string, ledger: string) {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${ledger} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
  );
  const applied = new Set(
    (
      database.prepare(`SELECT name FROM ${ledger}`).all() as {
        name: string;
      }[]
    ).map(({ name }) => name)
  );
  const migrations = readdirSync(directory)
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(directory, name), "utf8");
    database
      .transaction(() => {
        database.exec(sql);
        database.prepare(`INSERT INTO ${ledger}(name) VALUES(?)`).run(name);
      })
      .immediate();
  }
}

export function applyMigrations(database: Database) {
  applyDirectory(database, appMigrations, "d1_migrations");
  applyDirectory(database, vpsMigrations, "vps_migrations");
}
