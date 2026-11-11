import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {createDaemonStore} from "../src/store.ts"

const OWNER = "tvs_" + "c".repeat(32)
const INSTALL = "install_" + "d".repeat(48)
const CHANNEL = "channel-agent:restart"
const AGENT = "restart-agent"

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tarx-daemon-restart-"))
}

test("a completed result and its outbox survive a full daemon restart", async () => {
  const dir = await directory()
  const file = join(dir, "daemon.sqlite")
  try {
    const first = createDaemonStore({file, now: () => 1_000})
    const submitted = first.submitTask({ownerId: OWNER, installId: INSTALL, channelId: CHANNEL, agentId: AGENT, kind: "computer_use", request: {goal: "restart proof"}})
    const claimed = first.claimTask("worker-restart-a", 10_000)
    assert.equal(claimed?.fencing_token, 1)
    const completed = first.completeTask({
      taskId: submitted.task_id,
      workerId: "worker-restart-a",
      fencingToken: 1,
      result: {receipt: "saved"},
      delivery: {kind: "result", payload: {request_id: submitted.task_id, status: "completed"}},
    })
    first.close()

    const second = createDaemonStore({file, now: () => 2_000})
    try {
      const task = second.getTask(submitted.task_id)
      assert.equal(task?.status, "completed")
      assert.deepEqual(task?.result, {receipt: "saved"})
      const deliveries = second.listDeliveries({status: "pending"})
      assert.equal(deliveries.length, 1)
      assert.equal(deliveries[0]?.delivery_id, completed.delivery.delivery_id)
      assert.deepEqual(deliveries[0]?.payload, {request_id: submitted.task_id, status: "completed"})
      const claimedDelivery = second.claimDeliveries("delivery-restart-b", 1, 5_000)
      assert.equal(claimedDelivery.length, 1)
      assert.equal(second.ackDelivery(completed.delivery.delivery_id, "delivery-restart-b").status, "delivered")
      assert.equal(second.listDeliveries({status: "pending"}).length, 0)
    } finally {
      second.close()
    }
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test("an assignment interrupted by a restart is uncertain after recovery, not replayed", async () => {
  const dir = await directory()
  const file = join(dir, "daemon.sqlite")
  try {
    const first = createDaemonStore({file, now: () => 1_000})
    const submitted = first.submitTask({ownerId: OWNER, installId: INSTALL, channelId: CHANNEL, agentId: AGENT, kind: "computer_use", request: {goal: "interrupted"}})
    first.claimTask("worker-restart-c", 10_000)
    first.close()

    const second = createDaemonStore({file, now: () => 20_000})
    try {
      const recovered = second.recoverExpired()
      assert.deepEqual(recovered.task_ids, [submitted.task_id])
      assert.equal(second.getTask(submitted.task_id)?.status, "uncertain")
      assert.equal(second.claimTask("worker-restart-d", 10_000), null)
      assert.equal(second.listDeliveries().length, 0)
    } finally {
      second.close()
    }
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test("a result cannot be lost between completion and outbox: the invariant is in one transaction", async () => {
  const dir = await directory()
  const file = join(dir, "daemon.sqlite")
  try {
    const store = createDaemonStore({file, now: () => 1_000})
    try {
      const submitted = store.submitTask({ownerId: OWNER, installId: INSTALL, channelId: CHANNEL, agentId: AGENT, kind: "computer_use", request: {goal: "atomic"}})
      store.claimTask("worker-atomic", 10_000)
      store.completeTask({
        taskId: submitted.task_id,
        workerId: "worker-atomic",
        fencingToken: 1,
        result: {ok: true},
        delivery: {kind: "result", payload: {ok: true}},
      })
      const completed = store.listTasks({status: "completed"})
      const outbox = store.listDeliveries()
      assert.equal(completed.length, 1)
      assert.equal(outbox.length, 1)
      assert.equal(completed[0]?.delivery_id, outbox[0]?.delivery_id)
      assert.equal(outbox[0]?.task_id, completed[0]?.task_id)
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
