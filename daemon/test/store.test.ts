import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {DaemonError} from "../src/errors.ts"
import {createDaemonStore, type DaemonStore, type TaskInput} from "../src/store.ts"

const OWNER = "tvs_" + "a".repeat(32)
const INSTALL = "install_" + "b".repeat(48)
const CHANNEL = "channel-agent:review"
const AGENT = "review-agent"

function task(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    ownerId: OWNER,
    installId: INSTALL,
    channelId: CHANNEL,
    agentId: AGENT,
    kind: "computer_use",
    request: {goal: "open the approved window"},
    ...overrides,
  }
}

async function fixture(maxDeliveryAttempts = 3): Promise<{store: DaemonStore; directory: string; clock: {value: number}}> {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-"))
  const clock = {value: 1_000_000}
  const store = createDaemonStore({file: join(directory, "daemon.sqlite"), now: () => clock.value, maxDeliveryAttempts})
  return {store, directory, clock}
}

test("one active task per owner/install, and the public task id is idempotent", async () => {
  const f = await fixture()
  try {
    const first = f.store.submitTask(task())
    assert.equal(first.status, "queued")
    assert.equal(f.store.submitTask(task({taskId: first.task_id})).task_id, first.task_id)
    assert.throws(() => f.store.submitTask(task()), (error) => error instanceof DaemonError && error.code === "task_owner_busy")
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("claim gives one worker a fence; a stale worker cannot complete or heartbeat", async () => {
  const f = await fixture()
  try {
    const submitted = f.store.submitTask(task())
    const claimed = f.store.claimTask("worker-a", 10_000)
    assert.equal(claimed?.task_id, submitted.task_id)
    assert.equal(claimed?.status, "running")
    assert.equal(claimed?.fencing_token, 1)
    assert.equal(f.store.claimTask("worker-b", 10_000), null)
    assert.throws(() => f.store.heartbeatTask(submitted.task_id, "worker-b", 1, 10_000), (error) => error instanceof DaemonError && error.code === "stale_fence")
    assert.throws(() => f.store.completeTask({
      taskId: submitted.task_id,
      workerId: "worker-b",
      fencingToken: 1,
      result: {ok: true},
      delivery: {kind: "result", payload: {ok: true}},
    }), (error) => error instanceof DaemonError && error.code === "stale_fence")
    assert.equal(f.store.getTask(submitted.task_id)?.status, "running")
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("completion and outbox are one transaction; retry is idempotent", async () => {
  const f = await fixture()
  try {
    const submitted = f.store.submitTask(task())
    f.store.claimTask("worker-a", 10_000)
    const completed = f.store.completeTask({
      taskId: submitted.task_id,
      workerId: "worker-a",
      fencingToken: 1,
      result: {ok: true, native_actions: 1},
      delivery: {kind: "result", payload: {request_id: submitted.task_id, status: "completed"}},
    })
    assert.equal(completed.task.status, "completed")
    assert.equal(completed.delivery.status, "pending")
    assert.equal(completed.delivery.task_id, submitted.task_id)
    assert.equal(completed.delivery.kind, "result")

    const again = f.store.completeTask({
      taskId: submitted.task_id,
      workerId: "worker-a",
      fencingToken: 1,
      result: {ok: true},
      delivery: {kind: "result", payload: {different: true}},
    })
    assert.equal(again.deduplicated, true)
    assert.equal(again.delivery.delivery_id, completed.delivery.delivery_id)
    assert.equal(f.store.listDeliveries().length, 1)

    const claimed = f.store.claimDeliveries("delivery-a", 10, 5_000)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.attempts, 1)
    const delivered = f.store.ackDelivery(completed.delivery.delivery_id, "delivery-a")
    assert.equal(delivered.status, "delivered")
    assert.equal(f.store.claimDeliveries("delivery-b", 10, 5_000).length, 0)
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("delivery retries with backoff and becomes dead after the bounded attempts", async () => {
  const f = await fixture(2)
  try {
    const submitted = f.store.submitTask(task())
    f.store.claimTask("worker-a", 10_000)
    const completed = f.store.completeTask({
      taskId: submitted.task_id,
      workerId: "worker-a",
      fencingToken: 1,
      result: {ok: true},
      delivery: {kind: "result", payload: {ok: true}},
    })
    const id = completed.delivery.delivery_id
    const first = f.store.claimDeliveries("delivery-a", 1, 5_000)[0]
    assert.equal(first?.attempts, 1)
    const retry = f.store.failDelivery(id, "delivery-a", "channel_unavailable")
    assert.equal(retry.status, "pending")
    assert.ok(retry.next_attempt_at > f.clock.value)
    f.clock.value = retry.next_attempt_at
    const second = f.store.claimDeliveries("delivery-b", 1, 5_000)[0]
    assert.equal(second?.attempts, 2)
    const dead = f.store.failDelivery(id, "delivery-b", "channel_unavailable")
    assert.equal(dead.status, "dead")
    assert.equal(f.store.claimDeliveries("delivery-c", 1, 5_000).length, 0)
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("an expired assignment becomes uncertain and is never replayed", async () => {
  const f = await fixture()
  try {
    const submitted = f.store.submitTask(task())
    const claimed = f.store.claimTask("worker-a", 10_000)
    assert.equal(claimed?.fencing_token, 1)
    f.clock.value += 10_001
    const recovered = f.store.recoverExpired()
    assert.deepEqual(recovered.task_ids, [submitted.task_id])
    assert.equal(f.store.getTask(submitted.task_id)?.status, "uncertain")
    assert.equal(f.store.claimTask("worker-b", 10_000), null)
    const next = f.store.submitTask(task({taskId: "task_after_recovery_001"}))
    assert.equal(next.status, "queued")
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("events deduplicate ids and sequences, drop private traces, and filter unchanged health", async () => {
  const f = await fixture()
  try {
    const submitted = f.store.submitTask(task())
    f.store.claimTask("worker-a", 10_000)
    const reasoning = f.store.recordEvent({eventId: "evt_reasoning_001", taskId: submitted.task_id, sequence: 0, type: "reasoning.delta", payload: {text: "private"}})
    assert.deepEqual(reasoning, {status: "filtered", reason: "private_trace"})
    assert.deepEqual(f.store.recordEvent({eventId: "evt_reasoning_001", taskId: submitted.task_id, sequence: 1, type: "reasoning.delta"}), {status: "duplicate", reason: "duplicate_id"})
    const health = f.store.recordEvent({eventId: "evt_health_001", taskId: submitted.task_id, sequence: 1, type: "health", workerId: "worker-a", payload: {ok: true}})
    assert.equal(health.status, "stored")
    assert.deepEqual(f.store.recordEvent({eventId: "evt_health_002", taskId: submitted.task_id, sequence: 2, type: "health", workerId: "worker-a", payload: {ok: true}}), {status: "filtered", reason: "unchanged_health"})
    assert.equal(f.store.recordEvent({eventId: "evt_health_003", taskId: submitted.task_id, sequence: 3, type: "health", workerId: "worker-a", payload: {ok: false}}).status, "stored")
    assert.deepEqual(f.store.recordEvent({eventId: "evt_health_004", taskId: submitted.task_id, sequence: 3, type: "health", workerId: "worker-a", payload: {ok: false}}), {status: "duplicate", reason: "duplicate_sequence"})
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("cancellation can enqueue one delivery; a failed task cannot", async () => {
  const f = await fixture()
  try {
    const one = f.store.submitTask(task())
    f.store.claimTask("worker-a", 10_000)
    const cancelled = f.store.settleTask({
      taskId: one.task_id,
      workerId: "worker-a",
      fencingToken: 1,
      status: "cancelled",
      errorCode: "stopped",
      delivery: {kind: "cancelled", payload: {status: "cancelled"}},
    })
    assert.equal(cancelled.task.status, "cancelled")
    assert.equal(cancelled.delivery?.kind, "cancelled")
    assert.equal(f.store.listDeliveries().length, 1)

    const two = f.store.submitTask(task({taskId: "task_failed_0001"}))
    f.store.claimTask("worker-b", 10_000)
    const failed = f.store.settleTask({taskId: two.task_id, workerId: "worker-b", fencingToken: 1, status: "failed", errorCode: "executor_failed"})
    assert.equal(failed.task.status, "failed")
    assert.equal(failed.delivery, null)
    assert.equal(f.store.listDeliveries().length, 1)
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("stats expose queue and outbox pressure without inventing work", async () => {
  const f = await fixture()
  try {
    const submitted = f.store.submitTask(task())
    const stats = f.store.stats()
    assert.equal(stats.tasks.queued, 1)
    assert.equal(stats.oldest_queued_at, f.clock.value)
    f.store.claimTask("worker-a", 10_000)
    assert.equal(f.store.stats().tasks.running, 1)
    f.store.completeTask({
      taskId: submitted.task_id,
      workerId: "worker-a",
      fencingToken: 1,
      result: {ok: true},
      delivery: {kind: "result", payload: {ok: true}},
    })
    const final = f.store.stats()
    assert.equal(final.tasks.completed, 1)
    assert.equal(final.outbox.pending, 1)
  } finally {
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})
