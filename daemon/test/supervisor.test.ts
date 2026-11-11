import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {createServiceSupervisor} from "../src/supervisor.ts"

function fixture() {
  const processes = new Map<number, string>()
  let nextPid = 900
  let clock = 1_000
  const calls: Array<{pid: number; signal: NodeJS.Signals | 0}> = []
  const supervisor = createServiceSupervisor({
    stateDirectory: "",
    spawn() {
      const pid = nextPid++
      processes.set(pid, `identity-${pid}`)
      return {pid}
    },
    async inspect(pid) {
      return processes.get(pid) ?? null
    },
    kill(pid, signal) {
      calls.push({pid, signal})
      const target = Math.abs(pid)
      if (signal === 0) {
        if (!processes.has(target)) throw new Error("gone")
        return
      }
      processes.delete(target)
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  })
  return {supervisor, processes, calls, setClock: (value: number) => { clock = value }}
}

test("start is idempotent and stop removes only the owned process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-supervisor-"))
  const f = {processes: new Map<number, string>()}
  const supervisor = createServiceSupervisor({
    stateDirectory: directory,
    spawn: () => {
      const pid = 901
      f.processes.set(pid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      return {pid}
    },
    inspect: async (pid) => f.processes.get(pid) ?? null,
    kill: (pid, signal) => {
      if (signal === 0) {
        if (!f.processes.has(Math.abs(pid))) throw new Error("gone")
        return
      }
      f.processes.delete(Math.abs(pid))
    },
    now: () => 1_000,
    sleep: async () => {},
  })
  try {
    const first = await supervisor.start({name: "alpha", command: "/bin/true", args: []})
    assert.deepEqual(first, {state: "running", pid: 901, reused: false})
    const second = await supervisor.start({name: "alpha", command: "/bin/true", args: []})
    assert.deepEqual(second, {state: "running", pid: 901, reused: true})
    assert.deepEqual(await supervisor.status("alpha"), {state: "running", pid: 901})
    assert.deepEqual(await supervisor.stop("alpha"), {state: "stopped", pid: 901})
    assert.deepEqual(await supervisor.status("alpha"), {state: "absent"})
    assert.deepEqual(await supervisor.stop("alpha"), {state: "absent"})
    assert.deepEqual((await supervisor.recover()).removed, [])
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})

test("a reused pid is not treated as the owned service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-supervisor-"))
  const processes = new Map<number, string>([[910, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]])
  const supervisor = createServiceSupervisor({
    stateDirectory: directory,
    spawn: () => {
      processes.set(911, "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
      return {pid: 911}
    },
    inspect: async (pid) => processes.get(pid) ?? null,
    kill: (pid, signal) => {
      if (signal !== 0) processes.delete(Math.abs(pid))
    },
    now: () => 1_000,
    sleep: async () => {},
  })
  try {
    // First owner publishes a record, then the process is gone.
    assert.equal((await supervisor.start({name: "beta", command: "/bin/true", args: []})).state, "running")
    const record = JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, "services", "beta.json"), "utf8"))
    processes.delete(record.pid)
    // Simulate the OS reusing the pid with a different process instance.
    processes.set(record.pid, "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd")
    await assert.rejects(supervisor.start({name: "beta", command: "/bin/true", args: []}), /service_owner_changed/)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
