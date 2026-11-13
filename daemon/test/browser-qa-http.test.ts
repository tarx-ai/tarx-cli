import test from "node:test"
import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {join} from "node:path"
import {tmpdir} from "node:os"
import {randomBytes} from "node:crypto"
import {createDaemonStore} from "../src/store.ts"
import {createDaemonServer} from "../src/http.ts"

const TOKEN = "a".repeat(64)
const identity = {ownerId: "owner_fixture", installId: "install_fixture"}
const requestId = () => `bqa_${randomBytes(8).toString("hex")}`
const receipt = (id: string) => ({
  kind: "browser_qa", request_id: id, channel_id: "internal-qa", agent_id: "channel-agent:internal-qa",
  url: "https://www.tarx.com/", navigation: "completed", composer_visible: true, composer_usable: true,
  independent_verified: true, dom_actions: 1, native_actions: 0, model_calls: 0, billing_truth: "not_a_charge",
})

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "tarx-browser-qa-"))
  const store = createDaemonStore({file: join(dir, "daemon.sqlite")})
  const server = createDaemonServer({store, port: 0, token: TOKEN, identity})
  const address = await server.listen()
  t.after(async () => { await server.close(); store.close(); await rm(dir, {recursive: true, force: true}) })
  const call = async (path: string, body: object) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", headers: {authorization: `Bearer ${TOKEN}`, "content-type": "application/json"}, body: JSON.stringify(body),
    })
    return {status: response.status, body: await response.json() as any}
  }
  return {dir, store, server, call}
}

test("a typed browser QA task is claimed, persisted before delivery, and delivered once", async (t) => {
  const f = await fixture(t)
  const id = requestId()
  const submitted = await f.call("/v1/browser-qa/submit", {request_id: id, channel_id: "internal-qa", agent_id: "channel-agent:internal-qa", goal: "Open the public TARX browser and verify the composer."})
  assert.equal(submitted.status, 201)
  const claimed = await f.call("/v1/browser-qa/claim", {worker_id: "browser-worker-1"})
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.task.kind, "browser_qa")
  assert.equal(claimed.body.task.request.request_id, id)
  const fence = claimed.body.task.fencing_token
  const completed = await f.call("/v1/browser-qa/complete", {task_id: claimed.body.task.task_id, worker_id: "browser-worker-1", fencing_token: fence, receipt: receipt(id)})
  assert.equal(completed.status, 200)
  assert.equal(completed.body.status, "completed")
  assert.match(completed.body.idempotency_key, /^browser-qa:/)
  const task = f.store.getTask(claimed.body.task.task_id)
  assert.equal(task?.status, "completed")
  assert.equal((task?.result as any)?.kind, "browser_qa")
  const duplicate = await f.call("/v1/browser-qa/complete", {task_id: claimed.body.task.task_id, worker_id: "browser-worker-1", fencing_token: fence, receipt: receipt(id)})
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.deduplicated, true)
  assert.equal(duplicate.body.delivery_id, completed.body.delivery_id)
  const deliveries = await f.call("/v1/browser-qa/deliveries/claim", {worker_id: "delivery-worker"})
  assert.equal(deliveries.status, 200)
  assert.equal(deliveries.body.deliveries.length, 1)
  assert.equal(deliveries.body.deliveries[0].task_id, claimed.body.task.task_id)
  assert.equal(deliveries.body.deliveries[0].payload.receipt.kind, "browser_qa")
  assert.equal(deliveries.body.deliveries[0].payload.receipt.composer_visible, true)
  assert.equal(deliveries.body.deliveries[0].idempotency_key, completed.body.idempotency_key)
  const ack = await f.call("/v1/browser-qa/deliveries/ack", {delivery_id: deliveries.body.deliveries[0].delivery_id, worker_id: "delivery-worker"})
  assert.equal(ack.status, 200)
  assert.equal(ack.body.status, "delivered")
  assert.equal(f.store.stats().outbox.delivered, 1)
})

test("an invalid receipt is refused and does not complete the task", async (t) => {
  const f = await fixture(t)
  const id = requestId()
  await f.call("/v1/browser-qa/submit", {request_id: id, channel_id: "internal-qa", agent_id: "channel-agent:internal-qa", goal: "Open the public TARX browser and verify the composer."})
  const claimed = await f.call("/v1/browser-qa/claim", {worker_id: "browser-worker-1"})
  const bad = await f.call("/v1/browser-qa/complete", {task_id: claimed.body.task.task_id, worker_id: "browser-worker-1", fencing_token: claimed.body.task.fencing_token, receipt: {...receipt(id), composer_visible: false}})
  assert.equal(bad.status, 400)
  assert.equal(f.store.getTask(claimed.body.task.task_id)?.status, "running")
})

test("Stop settles cancelled with one cancellation delivery and no replay", async (t) => {
  const f = await fixture(t)
  const id = requestId()
  await f.call("/v1/browser-qa/submit", {request_id: id, channel_id: "internal-qa", agent_id: "channel-agent:internal-qa", goal: "Open the public TARX browser and verify the composer."})
  const claimed = await f.call("/v1/browser-qa/claim", {worker_id: "browser-worker-1"})
  const cancelled = await f.call("/v1/browser-qa/cancel", {task_id: claimed.body.task.task_id, worker_id: "browser-worker-1", fencing_token: claimed.body.task.fencing_token})
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.status, "cancelled")
  const task = f.store.getTask(claimed.body.task.task_id)
  assert.equal(task?.status, "cancelled")
  assert.equal(task?.delivery_id, cancelled.body.delivery_id)
  assert.equal(f.store.claimDeliveries("delivery-worker", 1, 30_000).length, 1)
})

test("an expired in-flight browser QA lease is uncertain and never replayed after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tarx-browser-qa-restart-"))
  const file = join(dir, "daemon.sqlite")
  let store = createDaemonStore({file})
  const id = requestId()
  const task = store.submitTask({ownerId: identity.ownerId, installId: identity.installId, channelId: "internal-qa", agentId: "channel-agent:internal-qa", kind: "browser_qa", request: {request_id: id, channel_id: "internal-qa", agent_id: "channel-agent:internal-qa", goal: "fixed", url: "https://www.tarx.com/"}})
  const claimed = store.claimTask("browser-worker-1", 5_000, "browser_qa")
  assert.equal(claimed?.task_id, task.task_id)
  store.close()
  store = createDaemonStore({file})
  t.after(async () => { store.close(); await rm(dir, {recursive: true, force: true}) })
  const recovered = store.recoverExpired(Date.now() + 10_000)
  assert.equal(recovered.count, 1)
  assert.equal(store.getTask(task.task_id)?.status, "uncertain")
  assert.equal(store.claimTask("browser-worker-2", 5_000, "browser_qa"), null)
})
