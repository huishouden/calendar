import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The few D1 calls the Worker makes, on an in-memory SQLite with the repo's migrations. */
class Statement {
  constructor(
    private readonly db: Database,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }
  async first<T>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...(this.params as never[])) as T) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...(this.params as never[])) as T[] };
  }
  async run() {
    this.db.query(this.sql).run(...(this.params as never[]));
    return { success: true };
  }
  runSync() {
    this.db.query(this.sql).run(...(this.params as never[]));
  }
}

export function memoryD1(): D1Database {
  const db = new Database(':memory:');
  const dir = join(import.meta.dir, '..', '..', 'migrations');
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      db.transaction(() => statements.forEach((s) => s.runSync()))();
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

export function memoryKV(): KVNamespace & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  } as unknown as KVNamespace & { map: Map<string, string> };
}
