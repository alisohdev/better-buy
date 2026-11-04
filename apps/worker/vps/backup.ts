import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { databasePath } from "./config";
import { SqliteD1Database } from "./sqlite-d1";

const source = resolve(databasePath());
const backupDirectory = resolve(
  process.env.VPS_BACKUP_DIR ??
    fileURLToPath(new URL("../../../.data/vps-backups", import.meta.url))
);
const retentionDays = Number.parseInt(
  process.env.VPS_BACKUP_RETENTION_DAYS ?? "14",
  10
);
if (
  !Number.isInteger(retentionDays) ||
  retentionDays < 1 ||
  retentionDays > 365
)
  throw new Error("VPS_BACKUP_RETENTION_DAYS must be between 1 and 365");

mkdirSync(backupDirectory, { recursive: true });
const now = new Date();
const stamp = now
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");
const destination = join(backupDirectory, `better-buy-${stamp}.sqlite`);
const temporaryDestination = `${destination}.tmp`;
if (source === resolve(destination))
  throw new Error("Backup destination must differ from the live database");

const database = new SqliteD1Database(source);
try {
  const quotedPath = temporaryDestination.replace(/'/g, "''");
  database.native.exec(`VACUUM INTO '${quotedPath}'`);
  renameSync(temporaryDestination, destination);
} catch (error) {
  rmSync(temporaryDestination, { force: true });
  throw error;
} finally {
  database.close();
}

const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
for (const name of readdirSync(backupDirectory)) {
  if (!/^better-buy-\d{8}T\d{6}Z\.sqlite$/.test(name)) continue;
  const path = join(backupDirectory, name);
  if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
}
console.info("VPS SQLite backup completed", { destination });
