import {chmodSync} from "node:fs"
import {mkdir} from "node:fs/promises"
import {createRequire} from "node:module"
import {join, resolve} from "node:path"

import {DaemonError} from "./errors.ts"

const require = createRequire(import.meta.url)
const {DatabaseSync} = require("node:sqlite") as {
  DatabaseSync: new (file: string) => {
    exec(sql: string): void
    close(): void
  }
}

export type DaemonLock = {release: () => Promise<void>}

/**
 * Crash-safe exclusive ownership. A file with a PID is not enough: after
 * SIGKILL or power loss the PID is gone, but the lock file remains. SQLite's
 * exclusive transaction is held by the open connection and released by the OS
 * when the process dies, so the next daemon can recover without deleting a
 * live owner's lock.
 */
export async function acquireDaemonLock(stateDirectory: string): Promise<DaemonLock> {
  const directory = resolve(stateDirectory)
  await mkdir(directory, {recursive: true, mode: 0o700})
  const file = join(directory, "daemon.lock.sqlite")
  const db = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
    db.exec("PRAGMA busy_timeout = 0")
    db.exec("BEGIN EXCLUSIVE")
  } catch (error: any) {
    try {
      db.close()
    } catch {
      /* the original lock failure is the useful one */
    }
    if (/SQLITE_BUSY|database is locked/i.test(String(error?.message ?? "")) || error?.errcode === 5) throw new DaemonError("daemon_already_running", 409)
    throw new DaemonError("daemon_lock_unavailable", 503)
  }
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      try {
        db.exec("COMMIT")
      } catch {
        /* crash recovery rolls back instead */
      } finally {
        db.close()
      }
    },
  }
}
