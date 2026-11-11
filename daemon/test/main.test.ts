import assert from "node:assert/strict"
import {mkdtemp, rm, stat} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {runDaemon} from "../src/main.ts"
import {createDaemonStore} from "../src/store.ts"

test("once and check acquire, recover, close and release the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-main-"))
  try {
    const first = await runDaemon({stateDirectory: directory, once: true, now: () => 1_000})
    assert.equal(first.ok, true)
    assert.equal((first.stats as any).schema, 1)
    const second = await runDaemon({stateDirectory: directory, check: true, now: () => 2_000})
    assert.equal(second.ok, true)
    assert.equal(second.check, true)
    const file = await stat(join(directory, "daemon.sqlite"))
    assert.equal(file.mode & 0o777, 0o600)
    await assert.rejects(stat(join(directory, ".daemon.lock")), {code: "ENOENT"})
    assert.equal((await stat(join(directory, "daemon.lock.sqlite"))).mode & 0o777, 0o600)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})


test("the launcher runs one coordinator tick with an injected executor and delivery adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-main-coordinator-"))
  const clock = {value: 1_000_000}
  try {
    const seed = createDaemonStore({file: join(directory, "daemon.sqlite"), now: () => clock.value})
    seed.submitTask({ownerId: "tvs_" + "a".repeat(32), installId: "install_" + "b".repeat(48), channelId: "channel-agent:main", agentId: "main-agent", kind: "computer_use", request: {goal: "launcher proof"}})
    seed.close()

    const delivered: string[] = []
    const result = await runDaemon({
      stateDirectory: directory,
      once: true,
      now: () => clock.value,
      workerId: "main-coordinator",
      leaseMs: 10_000,
      heartbeatMs: 1_000,
      executor: {async execute() { return {result: {ok: true}, delivery: {kind: "result", payload: {ok: true}}} }},
      delivery: {async deliver(row) { delivered.push(row.delivery_id) }},
    })
    assert.equal(result.ok, true)
    assert.equal((result.coordinator as any).tasks_completed, 1)
    assert.equal((result.stats as any).tasks.completed, 1)
    assert.equal((result.stats as any).outbox.delivered, 1)
    assert.equal(delivered.length, 1)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})

test("a launcher adapter is all-or-nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-main-incomplete-"))
  try {
    await assert.rejects(runDaemon({stateDirectory: directory, once: true, executor: {async execute() { return {result: {}, delivery: {kind: "result", payload: {}}} }}}), /coordinator_incomplete/)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
