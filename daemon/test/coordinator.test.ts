import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {createCoordinator} from "../src/coordinator.ts"
import {createDaemonStore, type DeliveryInput, type TaskRecord} from "../src/store.ts"

const OWNER = "tvs_" + "e".repeat(32)
const INSTALL = "install_" + "f".repeat(48)
const CHANNEL = "channel-agent:coordinator"
const AGENT = "coordinator-agent"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-coordinator-"))
  const clock = {value: 1_000_000}
  const store = createDaemonStore({file: join(directory, "daemon.sqlite"), now: () => clock.value, maxDeliveryAttempts: 3})
  const submitted = store.submitTask({ownerId: OWNER, installId: INSTALL, channelId: CHANNEL, agentId: AGENT, kind: "computer_use", request: {goal: "coordinated"}})
  return {directory, clock, store, submitted}
}

function delivery(): DeliveryInput {
  return {kind: "result", payload: {status: "completed", request_id: "coordinated"}}
}

test("one tick claims, executes, completes and delivers exactly once", async () => {
  const f = await fixture()
  const delivered: string[] = []
  const coordinator = createCoordinator({
    store: f.store,
    workerId: "worker-coordinator",
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    executor: {
      async execute(task: TaskRecord) {
        assert.equal(task.task_id, f.submitted.task_id)
        return {result: {ok: true}, delivery: delivery()}
      },
    },
    delivery: {
      async deliver(row) {
        delivered.push(row.delivery_id)
      },
    },
  })
  try {
    const result = await coordinator.tick()
    assert.equal(result.task, f.submitted.task_id)
    assert.equal(result.delivered, 1)
    assert.equal(f.store.getTask(f.submitted.task_id)?.status, "completed")
    assert.equal(f.store.listDeliveries().length, 1)
    assert.equal(f.store.listDeliveries()[0]?.status, "delivered")
    assert.deepEqual(delivered, [f.store.listDeliveries()[0]?.delivery_id])
    assert.equal((await coordinator.tick()).task, null)
  } finally {
    await coordinator.stop()
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("an uncertain execution is retained without an outbox and without replay", async () => {
  const f = await fixture()
  const coordinator = createCoordinator({
    store: f.store,
    workerId: "worker-uncertain",
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    executor: {
      async execute() {
        const error: any = new Error("dispatch lost")
        error.uncertain = true
        throw error
      },
    },
    delivery: {async deliver() {}},
  })
  try {
    await coordinator.tick()
    assert.equal(f.store.getTask(f.submitted.task_id)?.status, "uncertain")
    assert.equal(f.store.listDeliveries().length, 0)
    assert.equal((await coordinator.tick()).task, null)
    assert.equal(f.store.claimTask("worker-other", 10_000), null)
  } finally {
    await coordinator.stop()
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("a failed delivery retries with the same idempotency key and backoff", async () => {
  const f = await fixture()
  let attempts = 0
  const coordinator = createCoordinator({
    store: f.store,
    workerId: "worker-delivery",
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    executor: {async execute() { return {result: {ok: true}, delivery: delivery()} }},
    delivery: {
      async deliver() {
        attempts += 1
        if (attempts === 1) {
          const error: any = new Error("channel down")
          error.code = "channel_unavailable"
          throw error
        }
      },
    },
  })
  try {
    await coordinator.tick()
    const first = f.store.listDeliveries()[0]
    assert.equal(first?.status, "pending")
    assert.equal(first?.attempts, 1)
    assert.ok((first?.next_attempt_at ?? 0) > f.clock.value)
    f.clock.value = first!.next_attempt_at
    await coordinator.tick()
    const second = f.store.listDeliveries()[0]
    assert.equal(second?.status, "delivered")
    assert.equal(second?.attempts, 2)
    assert.equal(second?.idempotency_key, first?.idempotency_key)
  } finally {
    await coordinator.stop()
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("a long task that heartbeats keeps its fence and completes", async () => {
  const f = await fixture()
  const coordinator = createCoordinator({
    store: f.store,
    workerId: "worker-heartbeat",
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    executor: {
      async execute(_task, context) {
        f.clock.value += 5_000
        await context.heartbeat()
        return {result: {ok: true}, delivery: delivery()}
      },
    },
    delivery: {async deliver() {}},
  })
  try {
    await coordinator.tick()
    const task = f.store.getTask(f.submitted.task_id)
    assert.equal(task?.status, "completed")
    assert.equal(task?.fencing_token, 1)
  } finally {
    await coordinator.stop()
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})
