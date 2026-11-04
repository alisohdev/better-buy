import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

type RunMetadata = {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
};

export type LocalD1Result<T> = {
  success: true;
  results: T[];
  meta: RunMetadata & Record<string, unknown>;
};

export class SqlitePreparedStatement {
  constructor(
    private readonly database: Database,
    readonly sql: string,
    private readonly bindings: readonly unknown[] = []
  ) {}

  bind(...values: unknown[]) {
    return new SqlitePreparedStatement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database
      .prepare(this.sql)
      .get(...(this.bindings as never[])) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? (row[column] ?? null) : row) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<LocalD1Result<T>> {
    return this.execute<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<LocalD1Result<T>> {
    return this.execute<T>();
  }

  async raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.database.prepare(this.sql);
    const rows = statement.values(...(this.bindings as never[])) as unknown[][];
    if (!options?.columnNames) return rows as T[];
    return [statement.columnNames, ...rows] as [string[], ...T[]];
  }

  execute<T = Record<string, unknown>>(): LocalD1Result<T> {
    const statement = this.database.prepare(this.sql);
    const startedAt = performance.now();
    let results: unknown[] = [];
    if (statement.reader) {
      results = statement.all(...(this.bindings as never[])) as unknown[];
    } else {
      statement.run(...(this.bindings as never[]));
    }
    const duration = performance.now() - startedAt;
    const metadata = this.database
      .prepare(
        "SELECT changes() AS changes, last_insert_rowid() AS last_row_id"
      )
      .get() as { changes: number; last_row_id: number };
    const changes = statement.readonly ? 0 : Number(metadata.changes);
    const lastRowId = statement.readonly ? 0 : Number(metadata.last_row_id);
    return {
      success: true,
      results: results as T[],
      meta: {
        changes,
        last_row_id: lastRowId,
        duration,
        rows_read: statement.readonly ? results.length : 0,
        rows_written: changes,
        changed_db: changes > 0,
        size_after: 0,
      },
    };
  }
}

export class SqliteD1Database {
  readonly native: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.native = new Database(path);
    this.native.run("PRAGMA journal_mode = WAL");
    this.native.run("PRAGMA synchronous = FULL");
    this.native.run("PRAGMA foreign_keys = ON");
    this.native.run("PRAGMA busy_timeout = 5000");
  }

  prepare(sql: string) {
    return new SqlitePreparedStatement(this.native, sql);
  }

  async batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatement[]
  ): Promise<LocalD1Result<T>[]> {
    const transaction = this.native.transaction(() =>
      statements.map((statement) => {
        if (!(statement instanceof SqlitePreparedStatement))
          throw new TypeError("SQLite batch received a foreign statement");
        return statement.execute<T>();
      })
    );
    return transaction.immediate();
  }

  async exec(sql: string) {
    const startedAt = performance.now();
    this.native.exec(sql);
    return {
      count: sql.trim() ? 1 : 0,
      duration: performance.now() - startedAt,
    };
  }

  close() {
    this.native.close(true);
  }
}

export function asD1Database(database: SqliteD1Database): D1Database {
  return database as unknown as D1Database;
}
