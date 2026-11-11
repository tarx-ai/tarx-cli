import {createRequire} from "node:module"
import {chmodSync, mkdirSync} from "node:fs"
import {dirname} from "node:path"

/**
 * The daemon deliberately uses Node's built-in SQLite rather than a JSON file.
 * SQLite gives one writer, WAL readers, atomic transactions and indexes without
 * adding a native dependency to a per-install daemon.
 */
export type SqliteRun = {changes: number; lastInsertRowid: number | bigint}
export type SqliteStatement = {
  run(...params: unknown[]): SqliteRun
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
export type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

const require = createRequire(import.meta.url)
const {DatabaseSync} = require("node:sqlite") as {
  DatabaseSync: new (file: string) => SqliteDatabase
}

export function openSqlite(file: string): SqliteDatabase {
  if (file !== ":memory:") mkdirSync(dirname(file), {recursive: true, mode: 0o700})
  const db = new DatabaseSync(file)
  if (file !== ":memory:") chmodSync(file, 0o600)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
  `)
  return db
}

/** Synchronous transaction. The store is the only writer; IMMEDIATE prevents a
 * second process from interleaving a read-modify-write. */
export function transaction<T>(db: SqliteDatabase, work: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = work()
    db.exec("COMMIT")
    return result
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      /* the original error remains the useful one */
    }
    throw error
  }
}
