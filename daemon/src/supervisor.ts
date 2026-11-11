import {createHash} from "node:crypto"
import {execFile, spawn as nodeSpawn} from "node:child_process"
import {chmod, lstat, mkdir, open, readFile, readdir, rename, unlink} from "node:fs/promises"
import {join, resolve} from "node:path"
import {promisify} from "node:util"

import {DaemonError} from "./errors.ts"

const exec = promisify(execFile)
const NAME = /^[a-z][a-z0-9_-]{0,63}$/
const MAX_RECORD = 16 * 1024

export type ServiceSpec = {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  healthUrl?: string
  startTimeoutMs?: number
}

type ServiceRecord = {name: string; pid: number; identity: string; startedAt: number}

export type SupervisorDeps = {
  stateDirectory: string
  spawn?: (command: string, args: string[], env: Record<string, string>) => {pid?: number}
  inspect?: (pid: number) => Promise<string | null>
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function defaultInspect(pid: number): Promise<string | null> {
  try {
    const {stdout} = await exec("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {timeout: 2_000, maxBuffer: 4_096})
    const text = stdout.trim()
    return text ? hash(`${pid}\n${text}`) : null
  } catch {
    return null
  }
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Owns a service by PID + process-instance identity. A record never authorizes
 * a signal for a different process that reused the PID. */
export function createServiceSupervisor(deps: SupervisorDeps) {
  const root = resolve(deps.stateDirectory)
  const spawn = deps.spawn ?? ((command, args, env) => nodeSpawn(command, args, {detached: true, stdio: "ignore", env}))
  const inspect = deps.inspect ?? defaultInspect
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  const fetcher = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepDefault
  const directory = join(root, "services")

  function pathFor(name: string): string {
    if (!NAME.test(name)) throw new DaemonError("invalid_service", 400)
    return join(directory, `${name}.json`)
  }

  async function readRecord(name: string): Promise<ServiceRecord | null> {
    const file = pathFor(name)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size < 1 || info.size > MAX_RECORD) throw new DaemonError("service_record_unsafe", 503)
      const value = JSON.parse(await readFile(file, "utf8")) as ServiceRecord
      if (value.name !== name || !Number.isInteger(value.pid) || value.pid < 2 || typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity)) throw new DaemonError("service_record_invalid", 503)
      return value
    } catch (error: any) {
      if (error?.code === "ENOENT") return null
      if (error instanceof DaemonError) throw error
      throw new DaemonError("service_record_invalid", 503)
    }
  }

  async function writeRecord(record: ServiceRecord): Promise<void> {
    await mkdir(directory, {recursive: true, mode: 0o700})
    const target = pathFor(record.name)
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, target)
      await chmod(target, 0o600)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async function removeRecord(name: string, expected: ServiceRecord): Promise<void> {
    const current = await readRecord(name)
    if (!current || current.pid !== expected.pid || current.identity !== expected.identity) throw new DaemonError("service_owner_changed", 503)
    await unlink(pathFor(name))
  }

  async function live(record: ServiceRecord): Promise<boolean> {
    try {
      kill(record.pid, 0)
    } catch {
      return false
    }
    return (await inspect(record.pid)) === record.identity
  }

  async function waitHealthy(spec: ServiceSpec, pid: number, identity: string): Promise<void> {
    const deadline = now() + (spec.startTimeoutMs ?? 15_000)
    while (now() < deadline) {
      if ((await inspect(pid)) !== identity) throw new DaemonError("service_exited", 503)
      if (!spec.healthUrl) return
      try {
        if ((await fetcher(spec.healthUrl, {signal: AbortSignal.timeout(800)})).ok) return
      } catch {
        /* keep polling */
      }
      await sleep(100)
    }
    throw new DaemonError("service_start_timeout", 503)
  }

  async function signal(record: ServiceRecord, name: NodeJS.Signals): Promise<void> {
    try {
      kill(-record.pid, name)
    } catch {
      try {
        kill(record.pid, name)
      } catch {
        /* The exit deadline decides whether Stop succeeded. */
      }
    }
  }

  async function stop(name: string): Promise<{state: "stopped" | "absent"; pid?: number}> {
    const record = await readRecord(name)
    if (!record) return {state: "absent"}
    if (!(await live(record))) {
      await removeRecord(name, record)
      return {state: "stopped", pid: record.pid}
    }
    await signal(record, "SIGTERM")
    const deadline = now() + 5_000
    while (now() < deadline) {
      if (!(await live(record))) {
        await removeRecord(name, record)
        return {state: "stopped", pid: record.pid}
      }
      await sleep(100)
    }
    await signal(record, "SIGKILL")
    await sleep(100)
    if (await live(record)) throw new DaemonError("service_stop_timeout", 503)
    await removeRecord(name, record)
    return {state: "stopped", pid: record.pid}
  }

  return {
    async start(spec: ServiceSpec): Promise<{state: "running"; pid: number; reused: boolean}> {
      if (!NAME.test(spec.name)) throw new DaemonError("invalid_service", 400)
      if (!spec.command) throw new DaemonError("invalid_service_command", 400)
      const existing = await readRecord(spec.name)
      if (existing) {
        if (await live(existing)) return {state: "running", pid: existing.pid, reused: true}
        if (await inspect(existing.pid) !== null) throw new DaemonError("service_owner_changed", 503)
        await removeRecord(spec.name, existing)
      }
      const env = {PATH: process.env.PATH ?? "", ...spec.env}
      const child = spawn(spec.command, spec.args, env)
      const pid = child.pid
      if (!pid || pid < 2) throw new DaemonError("service_spawn_failed", 503)
      const identity = await inspect(pid)
      if (!identity) {
        try {
          kill(-pid, "SIGKILL")
        } catch {
          /* best effort for an unowned spawn */
        }
        throw new DaemonError("service_identity_unavailable", 503)
      }
      const record: ServiceRecord = {name: spec.name, pid, identity, startedAt: now()}
      await writeRecord(record)
      try {
        await waitHealthy(spec, pid, identity)
        return {state: "running", pid, reused: false}
      } catch (error) {
        await stop(spec.name).catch(() => {})
        throw error
      }
    },

    stop,

    async status(name: string): Promise<{state: "running" | "stopped" | "absent"; pid?: number}> {
      const record = await readRecord(name)
      if (!record) return {state: "absent"}
      return (await live(record)) ? {state: "running", pid: record.pid} : {state: "stopped", pid: record.pid}
    },

    async recover(): Promise<{removed: string[]}> {
      await mkdir(directory, {recursive: true, mode: 0o700})
      const removed: string[] = []
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json")) continue
        const name = file.slice(0, -5)
        const record = await readRecord(name).catch(() => null)
        if (!record) continue
        if (!(await live(record))) {
          await removeRecord(name, record)
          removed.push(name)
        }
      }
      return {removed}
    },
  }
}
