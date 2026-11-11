import type {SqliteDatabase} from "./sqlite.ts"
import {DaemonError} from "./errors.ts"

export const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','running','completed','failed','cancelled','uncertain')),
  priority INTEGER NOT NULL DEFAULT 0,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  delivery_id TEXT
);

CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, priority DESC, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active
  ON tasks(owner_id, install_id)
  WHERE status IN ('queued','leased','running');

CREATE TABLE IF NOT EXISTS outbox (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  owner_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivering','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
);

CREATE INDEX IF NOT EXISTS events_task ON events(task_id, sequence);

CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pid INTEGER,
  state TEXT NOT NULL CHECK (state IN ('starting','ready','busy','draining','stopped')),
  capacity INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_state (
  worker_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function migrate(db: SqliteDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {value?: string} | undefined
  const current = row?.value ? Number(row.value) : 0
  if (!Number.isInteger(current) || current < 0) throw new DaemonError("schema_invalid", 500)
  if (current > SCHEMA_VERSION) throw new DaemonError("schema_newer", 503)
  if (current === SCHEMA_VERSION) return
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(SCHEMA)
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION))
    db.exec("COMMIT")
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      /* keep the original failure */
    }
    throw error
  }
}
