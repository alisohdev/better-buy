import { databasePath } from "./config";
import { applyMigrations } from "./migrations";
import { SqliteD1Database } from "./sqlite-d1";

const database = new SqliteD1Database(databasePath());
try {
  applyMigrations(database.native);
  console.info("VPS SQLite migrations are current", {
    databasePath: database.path,
  });
} finally {
  database.close();
}
