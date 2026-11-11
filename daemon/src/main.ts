import {randomBytes} from "node:crypto"
import {lstat, open, readFile} from "node:fs/promises"
import {join, resolve} from "node:path"

import {syncComputerReceipts} from "./adapters/computer-receipts.ts"
import {createCoordinator, type DeliveryAdapter, type TaskExecutor} from "./coordinator.ts"
import {DaemonError, asDaemonError} from "./errors.ts"
import {createDaemonServer} from "./http.ts"
import {acquireDaemonLock} from "./lock.ts"
import {createDaemonStore, type DaemonStore} from "./store.ts"

async function daemonToken(stateDirectory: string): Promise<string> {
  const file = join(stateDirectory, "daemon.token")
  const read = async () => {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size < 1 || info.size > 128) throw new DaemonError("daemon_token_unsafe", 503)
    const token = (await readFile(file, "utf8")).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new DaemonError("daemon_token_invalid", 503)
    return token
  }
  try {
    return await read()
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }
  const token = randomBytes(32).toString("hex")
  try {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(token)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return token
  } catch (error: any) {
    if (error?.code === "EEXIST") return read()
    throw error
  }
}

export type DaemonOptions = {
  stateDirectory: string
  port?: number
  once?: boolean
  check?: boolean
  recoveryIntervalMs?: number
  now?: () => number
  executor?: TaskExecutor
  delivery?: DeliveryAdapter
  workerId?: string
  leaseMs?: number
  heartbeatMs?: number
  receiptLedger?: string
}

export async function runDaemon(options: DaemonOptions): Promise<Record<string, unknown>> {
  const stateDirectory = resolve(options.stateDirectory)
  if (!stateDirectory.startsWith("/") && !/^[A-Za-z]:\\/.test(stateDirectory)) throw new DaemonError("invalid_state_directory", 400)
  const now = options.now ?? Date.now
  const intervalMs = options.recoveryIntervalMs ?? 1_000
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new DaemonError("invalid_recovery_interval", 400)
  if (Boolean(options.executor) !== Boolean(options.delivery)) throw new DaemonError("coordinator_incomplete", 400)
  const lock = await acquireDaemonLock(stateDirectory)
  let store: DaemonStore | undefined
  let server: ReturnType<typeof createDaemonServer> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let coordinator: ReturnType<typeof createCoordinator> | undefined
  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    await coordinator?.stop().catch(() => {})
    await server?.close().catch(() => {})
    store?.close()
    await lock.release()
  }
  try {
    store = createDaemonStore({file: join(stateDirectory, "daemon.sqlite"), now})
    const recovered = store.recoverExpired(now())
    store.recoverExpiredDeliveries(now())
    store.expireWorkers(now())
    const receipts = options.receiptLedger ? await syncComputerReceipts({ledgerFile: options.receiptLedger, store}) : null
    if (options.executor && options.delivery) {
      coordinator = createCoordinator({
        store,
        executor: options.executor,
        delivery: options.delivery,
        workerId: options.workerId ?? `daemon-${process.pid}`,
        leaseMs: options.leaseMs,
        heartbeatMs: options.heartbeatMs,
      })
    }
    if (options.once) {
      if (coordinator) await coordinator.tick()
      const stats = store.stats()
      const coordinatorStats = coordinator?.stats()
      await shutdown()
      return {ok: true, check: false, recovered, receipts, stats, coordinator: coordinatorStats ?? null}
    }
    if (options.check) {
      const stats = store.stats()
      await shutdown()
      return {ok: true, check: true, recovered, receipts, stats, coordinator: null}
    }
    const token = await daemonToken(stateDirectory)
    server = createDaemonServer({store, port: options.port, now, token})
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
    coordinator?.start()
    const stop = () => {
      void shutdown().finally(() => process.exit(0))
    }
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    return {ok: true, listening: address, state_directory: stateDirectory, recovered, receipts, coordinator: coordinator?.stats() ?? null}
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
    else if (arg === "--receipt-ledger") options.receiptLedger = argv[++i] ?? ""
    else if (arg === "--help") {
      console.log(JSON.stringify({usage: "tarxd --state-dir DIR [--port PORT] [--receipt-ledger FILE] [--once|--check]", commands: ["run", "check"]}))
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
