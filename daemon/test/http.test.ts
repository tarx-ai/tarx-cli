import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {createDaemonServer} from "../src/http.ts"
import {createDaemonStore} from "../src/store.ts"

const TOKEN = "a".repeat(64)

test("loopback health, readiness and metrics expose pressure without task payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-http-"))
  const store = createDaemonStore({file: join(directory, "daemon.sqlite")})
  const server = createDaemonServer({store, port: 0})
  const address = await server.listen()
  try {
    const base = `http://${address.host}:${address.port}`
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    const healthBody = await health.json() as Record<string, any>
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.tasks.queued, 0)
    assert.equal(JSON.stringify(healthBody).includes("goal"), false)

    const ready = await fetch(`${base}/readyz`)
    assert.equal(ready.status, 200)
    assert.deepEqual(await ready.json(), {ready: true, database: "ok"})

    const metrics = await fetch(`${base}/metrics`)
    assert.equal(metrics.status, 200)
    const text = await metrics.text()
    assert.match(text, /tarx_daemon_tasks\{status="queued"\} 0/)
    assert.match(text, /tarx_daemon_outbox\{status="pending"\} 0/)
    assert.match(text, /tarx_daemon_uptime_seconds/)

    assert.equal((await fetch(`${base}/nope`)).status, 404)
    assert.equal((await fetch(`${base}/healthz`, {method: "POST"})).status, 405)
  } finally {
    await server.close()
    store.close()
    await rm(directory, {recursive: true, force: true})
  }
})


test("the Electron host acknowledges a receipt outbox row with the install token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-http-ack-"))
  const store = createDaemonStore({file: join(directory, "daemon.sqlite")})
  store.importCompletedTask({
    taskId: "saved_request_001",
    ownerId: "tvs_" + "a".repeat(32),
    installId: "install_" + "b".repeat(48),
    channelId: "review",
    agentId: "channel-agent:review",
    kind: "computer_use",
    request: {request_id: "saved_request_001"},
    result: {ok: true},
    delivery: {kind: "result", payload: {request_id: "saved_request_001"}},
  })
  const server = createDaemonServer({store, port: 0, token: TOKEN})
  const address = await server.listen()
  try {
    const base = `http://${address.host}:${address.port}`
    const body = JSON.stringify({request_id: "saved_request_001", channel_id: "review", agent_id: "channel-agent:review"})
    const unauthorized = await fetch(`${base}/v1/receipts/ack`, {method: "POST", headers: {"content-type": "application/json"}, body})
    assert.equal(unauthorized.status, 401)
    const wrongChannel = await fetch(`${base}/v1/receipts/ack`, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${TOKEN}`}, body: JSON.stringify({request_id: "saved_request_001", channel_id: "other", agent_id: "channel-agent:review"})})
    assert.equal(wrongChannel.status, 403)
    const ack = await fetch(`${base}/v1/receipts/ack`, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${TOKEN}`}, body})
    assert.equal(ack.status, 200)
    const ackBody = await ack.json() as {delivery_id: string; status: string}
    assert.equal(ackBody.status, "delivered")
    assert.equal(store.listDeliveries()[0]?.status, "delivered")
    const again = await fetch(`${base}/v1/receipts/ack`, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${TOKEN}`}, body})
    assert.equal(again.status, 200)
    assert.equal((await again.json() as any).delivery_id, ackBody.delivery_id)
    assert.equal(store.listDeliveries()[0]?.status, "delivered")
  } finally {
    await server.close()
    store.close()
    await rm(directory, {recursive: true, force: true})
  }
})

test("receipt acknowledgement is unavailable without a configured daemon token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-http-no-token-"))
  const store = createDaemonStore({file: join(directory, "daemon.sqlite")})
  const server = createDaemonServer({store, port: 0})
  const address = await server.listen()
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v1/receipts/ack`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"})
    assert.equal(response.status, 503)
  } finally {
    await server.close()
    store.close()
    await rm(directory, {recursive: true, force: true})
  }
})
