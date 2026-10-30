import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from '../config.ts';

export type Row = Record<string, any>;
type Params = SQLInputValue[] | [Record<string, SQLInputValue>];

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
    db = new DatabaseSync(config.dbFile);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

export function all<T = Row>(sql: string, ...params: Params): T[] {
  return getDb().prepare(sql).all(...(params as SQLInputValue[])) as T[];
}

export function get<T = Row>(sql: string, ...params: Params): T | undefined {
  return getDb().prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
}

export function run(sql: string, ...params: Params) {
  const r = getDb().prepare(sql).run(...(params as SQLInputValue[]));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

let txDepth = 0;
/** Runs fn inside a write transaction (BEGIN IMMEDIATE takes the write lock up-front, serialising conflicting writers). */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  if (txDepth > 0) return fn();
  d.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrate(log = false) {
  const d = getDb();
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    tx(() => {
      d.exec(sql);
      run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', f, new Date().toISOString());
    });
    if (log) console.log(`applied migration ${f}`);
  }
}
