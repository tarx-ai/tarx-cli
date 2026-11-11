import {mkdir, open, unlink, writeFile} from "node:fs/promises"
import {join, resolve} from "node:path"

import {DaemonError, asDaemonError} from "./errors.ts"
import {createDaemonServer} from "./http.ts"
import {createDaemonStore, type DaemonStore} from "./store.ts"

const LOCK = ".daemon.lock"

async function acquire(stateDirectory: string): Promise<{release: () => Promise<void>}> {
  await mkdir(stateDirectory, {recursive: true, mode: 0o700})
  const file = join(stateDirectory, LOCK)
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(String(process.pid))
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(file).catch(() => {})
    throw error
  }
  await handle.close()
  return {
    async release() {
      try {
        await unlink(file)
      } catch {
        /* another owner cannot remove it; leave the directory as found */
      }
    },
  }
}

export type DaemonOptions = {
  stateDirectory: string
  port?: number
  once?: boolean
  check?: boolean
  recoveryIntervalMs?: number
  now?: () => number
}

export async function runDaemon(options: DaemonOptions): Promise<Record<string, unknown>> {
  const stateDirectory = resolve(options.stateDirectory)
  if (!stateDirectory.startsWith("/") && !/^[A-Za-z]:\\/.test(stateDirectory)) throw new DaemonError("invalid_state_directory", 400)
  const now = options.now ?? Date.now
  const intervalMs = options.recoveryIntervalMs ?? 1_000
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new DaemonError("invalid_recovery_interval", 400)
  const lock = await acquire(stateDirectory)
  let store: DaemonStore | undefined
  let server: ReturnType<typeof createDaemonServer> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    await server?.close().catch(() => {})
    store?.close()
    await lock.release()
  }
  try {
    store = createDaemonStore({file: join(stateDirectory, "daemon.sqlite"), now})
    const recovered = store.recoverExpired(now())
    store.recoverExpiredDeliveries(now())
    store.expireWorkers(now())
    const stats = store.stats()
    if (options.check || options.once) {
      await shutdown()
      return {ok: true, check: Boolean(options.check), recovered, stats}
    }
    server = createDaemonServer({store, port: options.port, now})
    const address = await server.listen()
    timer = setInterval(() => {
      try {
        store!.recoverExpired(now())
        store!.recoverExpiredDeliveries(now())
        store!.expireWorkers(now())
      } catch {
        /* health/readiness expose the persistent failure; the loop stays alive */
      }
    }, intervalMs)
    timer.unref?.()
    const stop = () => {
      void shutdown().finally(() => process.exit(0))
    }
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    return {ok: true, listening: address, state_directory: stateDirectory, recovered}
  } catch (error) {
    await shutdown()
    throw error
  }
}

function parse(argv: string[]): DaemonOptions {
  const options: DaemonOptions = {stateDirectory: join(process.env.HOME ?? process.cwd(), ".tarx", "state", "daemon")}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--once") options.once = true
    else if (arg === "--check") options.check = true
    else if (arg === "--state-dir") options.stateDirectory = argv[++i] ?? ""
    else if (arg === "--port") options.port = Number(argv[++i])
    else if (arg === "--interval") options.recoveryIntervalMs = Number(argv[++i])
    else if (arg === "--help") {
      console.log(JSON.stringify({usage: "tarxd --state-dir DIR [--port PORT] [--once|--check]", commands: ["run", "check"]}))
      process.exit(0)
    } else throw new DaemonError("invalid_arguments", 400)
  }
  if (!options.stateDirectory) throw new DaemonError("invalid_state_directory", 400)
  return options
}

const entry = process.argv[1] ?? ""
if (entry.endsWith("main.ts") || entry.endsWith("tarxd")) {
  runDaemon(parse(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result))
      if (!result.ok) process.exitCode = 1
    })
    .catch((error) => {
      const failure = asDaemonError(error)
      console.error(JSON.stringify({ok: false, error: failure.code}))
      process.exitCode = 1
    })
}
