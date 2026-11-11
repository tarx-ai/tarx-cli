import assert from "node:assert/strict"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {createDaemonServer} from "../src/http.ts"
import {createDaemonStore} from "../src/store.ts"

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
